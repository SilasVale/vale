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
    // needsRepair: the device name survived (storage.local) but the token
    // (storage.session) was lost on browser restart — the pairing is gone
    // but the user shouldn't think it's a fresh install.
    const needsRepair = !state.pairedDevice?.token
      && (await chrome.storage.local.get("valePlugin"))?.valePlugin?.device;
    // pairedDeviceName: the device name survives in storage.local even after
    // a browser restart clears the session token — the popup shows the
    // paired card + Terminal (the 30-day cookie authenticates) instead of
    // forcing a re-pair.
    const pairedDeviceName = state.pairedDevice?.device
      || (await chrome.storage.local.get("valePlugin"))?.valePlugin?.device;
    sendResponse({
      wsState: state.wsState,
      device: state.pairedDevice?.device,
      pairedDeviceName,
      controlledTabs: Object.keys(state.controlledTabs),
      error: state.error,
      needsRepair: !!needsRepair,
    });
    return false;
  }
  if (msg.type === "openTab") {
    const d = state.pairedDevice?.device;
    if (!d) { sendResponse({ ok: false, error: "not paired" }); return false; }
    (async () => {
      chrome.tabs.create({ url: `${await consoleOrigin()}/api/devices/${d}/proxy/` });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "unpair") {
    (async () => {
      try {
        // Revoke the token server-side FIRST (local-only unpair left a
        // 30-day device-control credential valid), then clear locally.
        const paired = state.pairedDevice;
        if (paired?.token) {
          await fetch(`${await consoleOrigin()}/api/plugins/revoke`, {
            method: "POST",
            headers: { authorization: `Bearer ${paired.token}` },
          }).catch(() => {});
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
