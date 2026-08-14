import { state, setStateError } from "./state.js";

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
// round-84: concurrent tool calls (parallel MCP) both hit the create path
// and made two proxy tabs (one orphaned). Serialize per-device ensures.
const ensureInFlight = new Map();

export async function ensureTab(device, proxyUrl) {
  if (ensureInFlight.has(device)) return ensureInFlight.get(device);
  const p = ensureTabInner(device, proxyUrl).finally(() => ensureInFlight.delete(device));
  ensureInFlight.set(device, p);
  return p;
}

async function ensureTabInner(device, proxyUrl) {
  await hydrateAttached();
  let tabId = state.controlledTabs[device];
  if (!tabId) {
    const tabs = await chrome.tabs.query({ url: `*://*/api/devices/${device}/proxy/*` });
    tabId = tabs[0]?.id;
  }
  if (!tabId && attached.size) {
    // round-84: after an MV3 SW restart, `attached` (persisted in
    // chrome.storage.session) still holds the LIVE controlled tab — the
    // extension OWNS its debugger session (survives the SW restart). The old
    // code detached it (killing the agent's browser session mid-task) and
    // created a fresh proxy tab. Reuse the attached tab instead: it is
    // exactly the controlled tab, still attached, still on the page the
    // agent was working on.
    const candidate = [...attached][0];
    if (candidate !== undefined) {
      try {
        // round-88: reuse ONLY the tab belonging to THIS device — a blind
        // first-attached reuse handed a new device an old device's controlled
        // tab (cross-device session takeover: the agent drove the wrong
        // browser). Verify the URL still points at this device's proxy.
        const t = await chrome.tabs.get(candidate);
        if (t.url && t.url.includes(`/api/devices/${device}/proxy`)) {
          tabId = candidate;
        }
      } catch { /* tab gone — detach it below */ }
    }
    if (!tabId) {
      // A tab we attached to navigated AWAY (or was closed) — detach our own
      // stale attachments for this device before creating fresh.
      const stale = [...attached].filter((id) => id !== state.controlledTabs[device]);
      for (const id of stale) {
        try { await chrome.debugger.detach({ tabId: id }); } catch {}
        attached.delete(id);
      }
      await persistAttached();
    }
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
        setStateError(null); // stale detach error from the closed tab
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
    // Scrub the ?token= out of the address bar/history (round-84): the old
    // one-shot loadEventFired listener could be permanently missed — a fast
    // load fires before the listener registers, an error page never fires,
    // or the SW idles out mid-load. Scrub IMMEDIATELY (the tab may already
    // be on the proxy URL with the token) AND re-scrub on every load.
    const scrubExpr = `history.replaceState(null, "", location.pathname + location.search.replace(/([?&])token=[^&]*/, "$1").replace(/[?&]$/, ""))`;
    chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: scrubExpr }).catch(() => {});
    chrome.debugger.onEvent.addListener(function scrubOnLoad(source, method) {
      if (source.tabId !== tabId || method !== "Page.loadEventFired") return;
      chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: scrubExpr }).catch(() => {});
    });
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
  if (deviceForTab(tabId)) setStateError(`debugger detached: ${reason}`);
});
