import { connect, disconnect, setRequestHandler } from "./lib/ws.js";
import { state, loadPairing, savePairing, clearPairing } from "./lib/state.js";
import { runTool, setConsoleOrigin } from "./lib/tools.js";

const DEFAULT_ORIGIN = "https://console.saisi.online";
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    sendResponse({ wsState: state.wsState, device: state.pairedDevice?.device, controlledTabs: Object.keys(state.controlledTabs), error: state.error });
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
    clearPairing().then(() => {
      disconnect();
      state.error = null;
      sendResponse({ ok: true });
    }).catch((e) => sendResponse({ ok: false, error: String(e) }));
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
