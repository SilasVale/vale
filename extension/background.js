import { connect, disconnect, setRequestHandler } from "./lib/ws.js";
import { state, loadPairing, savePairing, clearPairing } from "./lib/state.js";
import { runTool, setConsoleOrigin } from "./lib/tools.js";

const DEFAULT_ORIGIN = "https://api.saisi.online";
async function consoleOrigin() {
  return (await chrome.storage.local.get("consoleOrigin")).consoleOrigin || DEFAULT_ORIGIN;
}

async function init() {
  await loadPairing();
  setConsoleOrigin(await consoleOrigin());
  setRequestHandler(async (tool, params) => {
    if (tool.startsWith("browser_")) return runTool(tool, params);
    throw new Error(`terminal tools go through the device proxy, not the extension: ${tool}`);
  });
  connect();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("consoleOrigin", (r) => {
    if (!r.consoleOrigin) chrome.storage.local.set({ consoleOrigin: DEFAULT_ORIGIN });
  });
  chrome.alarms.create("keepalive", { periodInMinutes: 4 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && state.wsState === "disconnected") connect();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Sender gate: only the extension's OWN pages (popup/options) may drive
  // these privileged actions (pairing, opening controlled tabs). Any future
  // content-script or externally_connectable addition would otherwise let a
  // webpage drive the debugger.
  const own = sender?.id === chrome.runtime.id;
  if (!own) return;
  if (msg.type === "pair") {
    // { code } → claim against the gateway, then connect the WS.
    (async () => {
      try {
        const res = await fetch(`${await consoleOrigin()}/api/plugins/pair/claim`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: msg.code }),
        });
        const j = await res.json().catch(() => ({}));
        if (j.token) {
          await savePairing({ device: j.device, token: j.token });
          connect();
          sendResponse({ ok: true, device: j.device });
        } else {
          sendResponse({ ok: false, error: j.error || `claim failed (${res.status})` });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // async sendResponse
  }
  if (msg.type === "status") {
    // NOTE: the listener itself is NOT async — `await` here would be a
    // SyntaxError (V8) that kills the whole service worker (round-30
    // regression). Wrap the async work in an IIFE and return true so the
    // message channel stays open until sendResponse fires.
    (async () => {
      try {
        const local = await chrome.storage.local.get("valePlugin");
        const name = local?.valePlugin?.device || "";
        // needsRepair: the device name survived (storage.local) but the
        // token (storage.session) was lost on browser restart — the pairing
        // is gone but the user shouldn't think it's a fresh install.
        const needsRepair = !state.pairedDevice?.token && !!name;
        // pairedDeviceName: the device name survives in storage.local even
        // after a browser restart clears the session token — the popup
        // shows the paired card + Terminal (the 30-day cookie
        // authenticates) instead of forcing a re-pair.
        const pairedDeviceName = state.pairedDevice?.device || name;
        sendResponse({
          wsState: state.wsState,
          device: state.pairedDevice?.device,
          pairedDeviceName,
          controlledTabs: Object.keys(state.controlledTabs),
          error: state.error,
          needsRepair,
        });
      } catch (e) {
        sendResponse({ wsState: state.wsState, device: state.pairedDevice?.device, pairedDeviceName: "", controlledTabs: [], error: String(e), needsRepair: false });
      }
    })();
    return true; // async sendResponse
  }
  if (msg.type === "openTab") {
    (async () => {
      try {
        // After a restart the device name survives in storage.local even
        // though state.pairedDevice is null (token is gone) — the paired
        // card now shows, so Open tab must work in that state too.
        const d = state.pairedDevice?.device
          || (await chrome.storage.local.get("valePlugin"))?.valePlugin?.device;
        if (!d) { sendResponse({ ok: false, error: "not paired" }); return; }
        chrome.tabs.create({ url: `${await consoleOrigin()}/api/devices/${d}/proxy/` });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: String(e) }); }
    })();
    return true;
  }
  if (msg.type === "unpair") {
    (async () => {
      try {
        // Revoke the token server-side FIRST (local-only unpair left a
        // 30-day device-control credential valid), then clear locally.
        // After a browser restart state.pairedDevice is null (session token
        // cleared) but the local record now carries the token too (state.js
        // savePairing) — so the revoke always has a credential to send, and
        // a failed revoke is REPORTED (never silently swallowed: a network
        // error or 5xx leaves the 30-day plugin link + vale_pt cookie live,
        // and telling the user "unpaired" would be a lie).
        const paired = state.pairedDevice;
        let revokeToken = paired?.token;
        if (!revokeToken) {
          try { revokeToken = (await chrome.storage.local.get("valePlugin"))?.valePlugin?.token || ""; } catch {}
        }
        if (revokeToken) {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 10000); // bounded — a blackholed origin must not hang Unpair
          let res;
          try {
            res = await fetch(`${await consoleOrigin()}/api/plugins/revoke`, {
              method: "POST",
              headers: { authorization: `Bearer ${revokeToken}` },
              signal: ctl.signal,
            });
          } catch (e) {
            clearTimeout(timer);
            // Revoke FAILED (network/abort) — keep the local pairing so the
            // user can retry; report instead of fake success. Set state.error
            // so the popup's 2s status refresh does NOT wipe the message.
            state.error = `revoke failed: ${String(e && e.message || e)} — unpair not completed`;
            sendResponse({ ok: false, error: state.error });
            return;
          }
          clearTimeout(timer);
          if (!res.ok) {
            state.error = `revoke failed (HTTP ${res.status}) — unpair not completed`;
            sendResponse({ ok: false, error: state.error });
            return;
          }
        }
        await clearPairing();
        disconnect();
        state.error = null;
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: String(e) }); }
    })();
    return true;
  }
  if (msg.type === "optionsChanged") {
    // consoleOrigin edited in options — refresh tools + re-auth the WS.
    (async () => {
      setConsoleOrigin(await consoleOrigin());
      connect();
      sendResponse({ ok: true });
    })();
    return true;
  }
});

init();
