// Vale Command UI — browser tab management & overlay sync

import state from './state.js';
import { invoke } from './ipc.js';
import { browserHandlers, toast, navHandlers } from './events.js';
import { switchTabUI } from './view.js';
import { renderTabItem, highlightTabItem, updateCloseButtons } from './tabs.js';
import { svgIcons } from './icons.js';

const tabSel = (tid) => `[data-tab="${CSS.escape(tid)}"]`;

// ── Tab management ──

export async function selectTab(tid) {
  // Highlight first — the IPC round-trip must not gate visual feedback
  state.lastTabId = tid;
  highlightTab(tid);
  switchTabUI('browser');
  showBrowser();
  await invoke('browser_tab_select', { tab_id: tid });
}

export async function newTab() {
  // Optimistic: a pending placeholder appears instantly, removed when the
  // real tab arrives (BrowserTabNew event) or the request fails.
  const bar = document.getElementById('browser-tab-bar');
  const pending = document.createElement('span');
  pending.className = 'tab-item active';
  pending.dataset.pending = '1';
  pending.innerHTML = '<span class="tab-title">…</span>';
  bar.appendChild(pending);

  const r = await invoke('browser_tab_new', { url: 'about:blank' });
  pending.remove();
  if (!r.ok) { toast(r.error || 'New tab failed'); return; }
  // The real tab element is rendered when the BrowserTabNew event arrives
  showBrowser();
}

export async function closeTab(tid) {
  // Optimistic: remove immediately, restore on failure
  const bar = document.getElementById('browser-tab-bar');
  const el = bar.querySelector(tabSel(tid));
  const adjacent = el && (el.nextElementSibling || el.previousElementSibling);
  if (el) el.remove();

  const r = await invoke('browser_tab_close', { tab_id: tid });
  if (!r.ok) {
    toast(r.error || 'Close tab failed');
    if (el) bar.appendChild(el);
    return;
  }
  if (state.lastTabId === tid && adjacent && adjacent.dataset.tab) {
    selectTab(adjacent.dataset.tab);
  }
}

export function renderTab(tabId, label) {
  const bar = document.getElementById('browser-tab-bar');
  renderTabItem({ bar, key: tabId, keyAttr: 'tab', label, selectAction: 'selectTab', closeAction: 'closeTab', icon: svgIcons.close, title: label });
}

export function highlightTab(tid) {
  const bar = document.getElementById('browser-tab-bar');
  highlightTabItem({ bar, key: tid, keyAttr: 'tab' });
  updateCloseButtons(bar);
}

export function removeTab(tid) {
  const el = document.querySelector(`#browser-tab-bar ${tabSel(tid)}`);
  if (!el) return;
  const bar = document.getElementById('browser-tab-bar');
  // Select adjacent
  const next = el.nextElementSibling;
  const prev = el.previousElementSibling;
  el.remove();
  const target = next || prev;
  if (target) {
    selectTab(target.dataset.tab);
  }
}

// ── Overlay sync ──

async function doShowBrowser() {
  const ok = await syncBrowserRect();
  if (ok) await invoke('browser_cmd_show');
}

export function showBrowser() {
  // Leading+trailing throttle: first call acts immediately (fixes the old
  // show/hide asymmetry where hiding was instant but showing lagged 150ms);
  // bursts within the window collapse to one trailing sync.
  if (state.showBrowserTimer) {
    clearTimeout(state.showBrowserTimer);
    state.showBrowserTimer = setTimeout(async () => {
      state.showBrowserTimer = null;
      await doShowBrowser();
    }, 150);
    return;
  }
  state.showBrowserTimer = setTimeout(() => { state.showBrowserTimer = null; }, 150);
  void doShowBrowser();
}

export function hideBrowser() {
  if (state.showBrowserTimer) {
    clearTimeout(state.showBrowserTimer);
    state.showBrowserTimer = null;
  }
  invoke('browser_cmd_hide');
}

export async function syncBrowserRect() {
  const area = document.getElementById('browser-area');
  if (!area) return false;
  const r = area.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  await invoke('browser_cmd_set_rect', {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  });
  return true;
}

// ── Per‑tab history (tabId → {urls: [], pos: Number}) ──
const tabHistory = new Map();

function pushHistory(tabId, url) {
  let h = tabHistory.get(tabId);
  if (!h) { h = { urls: [], pos: -1 }; tabHistory.set(tabId, h); }
  h.urls = h.urls.slice(0, h.pos + 1);
  h.urls.push(url);
  h.pos = h.urls.length - 1;
}

function updateNavButtons() {
  const h = tabHistory.get(state.lastTabId);
  const btnBack = document.getElementById('btn-back');
  const btnForward = document.getElementById('btn-forward');
  if (btnBack) btnBack.disabled = !(h && h.pos > 0);
  if (btnForward) btnForward.disabled = !(h && h.pos < h.urls.length - 1);
}

// ── URL & navigation ──

export async function browserNav() {
  const input = document.getElementById('browser-url');
  let url = input.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const r = await invoke('browser_navigate', { url });
  if (!r.ok) toast(r.error || 'Navigation failed');
  showBrowser();
}

export function setUrlBar(url) {
  const input = document.getElementById('browser-url');
  if (input) input.value = url;
}

export async function browserBack() {
  const h = tabHistory.get(state.lastTabId);
  if (!h || h.pos <= 0) return;
  // URL bar updates optimistically; the nav command is fire-and-forget
  h.pos--; setUrlBar(h.urls[h.pos] || ''); updateNavButtons();
  invoke('browser_back');
  showBrowser();
}

export async function browserForward() {
  const h = tabHistory.get(state.lastTabId);
  if (!h || h.pos >= h.urls.length - 1) return;
  h.pos++; setUrlBar(h.urls[h.pos] || ''); updateNavButtons();
  invoke('browser_forward');
  showBrowser();
}

export async function browserReload() {
  const r = await invoke('browser_reload');
  if (!r.ok) toast(r.error || 'Reload failed');
  showBrowser();
}

// ── Event handlers ──

browserHandlers.BrowserNavigate = (ev) => {
  if (ev.url) {
    state.tabUrls[state.lastTabId] = ev.url;
    setUrlBar(ev.url);
    pushHistory(state.lastTabId, ev.url);
    updateNavButtons();
    const el = document.querySelector(`#browser-tab-bar ${tabSel(state.lastTabId)} .tab-title`);
    if (el) el.textContent = hostFromUrl(ev.url);
  }
  if (state.activeTab === 'browser') showBrowser();
};

browserHandlers.BrowserTabNew = (ev) => {
  const id = ev.tab_id || `tab-${Date.now()}`;
  state.lastTabId = id;
  renderTab(id, hostFromUrl(ev.url) || id);
  highlightTab(id);
  if (state.activeTab === 'browser') showBrowser();
};

browserHandlers.BrowserTabSelect = (ev) => {
  state.lastTabId = ev.tab_id;
  highlightTab(ev.tab_id);
  if (state.tabUrls[ev.tab_id]) setUrlBar(state.tabUrls[ev.tab_id]);
  if (state.activeTab === 'browser') showBrowser();
};

browserHandlers.BrowserTabClose = (ev) => {
  removeTab(ev.tab_id);
};

// ── Activity-row click navigation ──
// (BrowserNavigate carries no tab_id — fall back to the last active tab)

navHandlers.browser = (ev) => {
  selectTab(ev.tab_id || state.lastTabId);
};

// ── Boot: render the seed tab so it gets a close button when count > 1 ──

renderTab('tab-0', 'tab-0');
highlightTab('tab-0');
updateNavButtons();

// ── Helpers ──

function hostFromUrl(url) {
  try { return new URL(url).hostname; } catch (_) { return url; }
}
