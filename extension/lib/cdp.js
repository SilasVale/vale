import { state } from "./state.js";

// TabIds we attached chrome.debugger to ourselves. Duplicate attach throws
// "Another debugger is already attached to this tab", so track our own attach
// state: attach once per tab, re-attach only after an onDetach. The set is
// persisted in chrome.storage.session: a debugger session outlives a
// service-worker restart, so a cold SW must still know which tabs it owns
// (otherwise the next ensureTab re-attaches to a still-attached tab and
// errors with no recovery).
const ATTACHED_KEY = "attachedTabs";
const attached = new Set();
let hydrated = null; // hydration promise — runs once, on first use

async function hydrateAttached() {
  if (!hydrated) {
    hydrated = (async () => {
      attached.clear();
      try {
        const stored = await chrome.storage.session.get(ATTACHED_KEY);
        for (const id of stored[ATTACHED_KEY] || []) {
          try { await chrome.tabs.get(id); attached.add(id); }
          catch { /* tab gone — drop it */ }
        }
      } catch {}
    })();
  }
  return hydrated;
}
async function persistAttached() {
  await chrome.storage.session.set({ [ATTACHED_KEY]: [...attached] });
}

// Attach debugger to a tab (create if needed) and enable the domains we use.
export async function ensureTab(device, proxyUrl) {
  await hydrateAttached();
  let tabId = state.controlledTabs[device];
  if (!tabId) {
    const tabs = await chrome.tabs.query({ url: `*://*/api/devices/${device}/proxy/*` });
    tabId = tabs[0]?.id;
  }
  if (!tabId) {
    const tab = await chrome.tabs.create({ url: proxyUrl });
    tabId = tab.id;
  }
  state.controlledTabs[device] = tabId;
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      const s = String(e);
      if (s.includes("No tab with given id")) {
        // User closed the controlled tab — start a fresh one.
        attached.delete(tabId);
        delete state.controlledTabs[device];
        const tab = await chrome.tabs.create({ url: proxyUrl });
        tabId = tab.id;
        state.controlledTabs[device] = tabId;
        state.error = null; // stale detach error from the closed tab
        await chrome.debugger.attach({ tabId }, "1.3");
      } else if (s.includes("Another debugger is already attached")) {
        throw new Error("DevTools or another extension is attached to the controlled tab — close DevTools on it");
      } else {
        throw new Error(`debugger attach failed: ${e}`);
      }
    }
    attached.add(tabId);
    await persistAttached();
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  }
  return tabId;
}

export async function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function deviceForTab(tabId) {
  for (const [d, id] of Object.entries(state.controlledTabs)) if (id === tabId) return d;
  return null;
}

// Registered at module load (background imports this via tools.js). Never
// re-attach here: the next ensureTab() re-attaches, or fails with an
// actionable error if DevTools took over the tab.
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  attached.delete(tabId);
  persistAttached().catch(() => {});
  if (deviceForTab(tabId)) state.error = `debugger detached: ${reason}`;
});
