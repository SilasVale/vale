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
        // browser).
        // round-94: the URL predicate was REMOVED — the controlled tab can
        // legitimately sit on any real site (the agent navigated it there,
        // or the user browsed it), and requiring the proxy URL made the
        // reuse path detach a LIVE, valid tab and replace it with a fresh
        // proxy page, destroying the agent's browser session.
        // round-95: reuse-by-tab-id ALONE reopened the round-88 cross-device
        // takeover (attached is a flat per-extension set; controlledTabs is
        // empty exactly in this SW-restart branch, so there was no
        // attribution check at all). Balance both: reuse the attached tab
        // for this device ONLY IF it still looks like this device's tab —
        // the proxy URL, OR it is the tab controlledTabs already knows. A
        // tab on an arbitrary real site with NO device attribution is NOT
        // ours to reuse (leaving it alone is safe — the agent's session on
        // it is gone with the SW; a fresh proxy tab is correct).
        const t = await chrome.tabs.get(candidate);
        const tUrl = t.url || "";
        // round-96: the attribution arm must be THIS device's tab —
        // Object.values(...).includes(candidate) admitted ANY device's
        // controlled tab, so device A's first tool call could take over
        // device B's live tab (round-88 hole, reopened).
        if (tUrl.includes(`/api/devices/${device}/proxy`) || state.controlledTabs[device] === candidate) {
          tabId = candidate;
        }
      } catch { /* tab gone — detach it below */ }
    }
    if (!tabId) {
      // round-96: this block previously detached EVERY attached tab that
      // wasn't this device's — so the first device to call after an SW
      // restart could kill OTHER devices' still-live controlled tabs
      // (debugger attachment survives the SW restart by design). Only
      // detach tabs that are actually GONE (chrome.tabs.get threw in the
      // reuse attempt above / tab closed); a live tab we merely refuse to
      // reuse stays attached — its owner device still uses it.
      const stale = [...attached].filter((id) => {
        try { chrome.tabs.get(id); return false; } catch { return true; }
      });
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
    // round-97: a FRESH tab for this device means the old controlled tab
    // (if any) is abandoned — it sits on some real site, still
    // debugger-attached, with no device attribution (SW restart lost
    // controlledTabs). Detach those zombies so they don't accumulate and
    // block reuse ([...attached][0] would otherwise keep picking a zombie
    // that the predicate refuses, forcing a new tab every call).
    // round-98: the skip guard ALSO protects tabs recoverable by ANY
    // device's proxy URL — in the SW-restart case controlledTabs is empty,
    // so the old guard detached OTHER devices' still-live controlled tabs
    // (the exact hazard R96 fixed). A tab still on a proxy URL belongs to
    // that device and is live; only unattributed, non-recoverable tabs are
    // zombies.
    for (const id of [...attached]) {
      if (id === tabId || Object.values(state.controlledTabs).includes(id)) continue;
      let recoverable = false;
      try {
        const t = await chrome.tabs.get(id);
        recoverable = !!(t.url && t.url.includes("/api/devices/") && t.url.includes("/proxy"));
      } catch { /* tab gone — detach below */ }
      if (recoverable) continue;
      try { await chrome.debugger.detach({ tabId: id }); } catch {}
      attached.delete(id);
    }
    await persistAttached();
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
  } else {
    // round-88: the reuse path (SW-restart / query-hit) skipped the scrub —
    // ?token= survived the exact 'SW idled out mid-load' case the R84 fix
    // targeted. Scrub immediately on the reused tab too.
    const scrubExpr = `history.replaceState(null, "", location.pathname + location.search.replace(/([?&])token=[^&]*/, "$1").replace(/[?&]$/, ""))`;
    chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: scrubExpr }).catch(() => {});
  }
  return tabId;
}

export async function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/** Detach + forget a device's controlled tab (unpair/revoke cleanup —
 *  round-99: an unpaired device's proxy tab stayed attached forever, since
 *  the R98 URL-recoverable guard treats its proxy URL as live). */
export async function releaseDeviceTab(device) {
  const tabId = state.controlledTabs[device];
  if (tabId && attached.has(tabId)) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
    attached.delete(tabId);
    await persistAttached();
  }
  delete state.controlledTabs[device];
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
