// Vale Command UI — boot & delegated listeners

import state from './state.js';
import { invoke } from './ipc.js';
import { listenEvents } from './transport.js';
import { switchTabUI } from './view.js';
import { selectTab, newTab, closeTab, showBrowser, hideBrowser,
         browserNav, browserBack, browserForward, browserReload, syncBrowserRect } from './browser.js';

// Expose browser overlay helpers for view.js switchTabUI
window._showBrowser = showBrowser;
window._hideBrowser = hideBrowser;
import { termSelect, termClose, listenTermOutput } from './term.js';
import { showConnDialog, closeConnDialog, switchConnType,
         quickConnect, doConnect, deleteSavedConn } from './conn.js';

// ── Delegated click handler ──
// Replaces all inline onclick handlers

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  switch (action) {
    // View
    case 'switchTab': switchTabUI(btn.dataset.tab); break;
    case 'switchConnType': switchConnType(btn.dataset.kind); break;

    // Browser
    case 'selectTab': selectTab(btn.dataset.tab); break;
    case 'newTab': newTab(); break;
    case 'closeTab': closeTab(btn.dataset.tab); break;
    case 'browserNav': browserNav(); break;
    case 'browserBack': browserBack(); break;
    case 'browserForward': browserForward(); break;
    case 'browserReload': browserReload(); break;

    // Connection
    case 'showConnDialog': showConnDialog(); break;
    case 'closeConnDialog': closeConnDialog(); break;
    case 'doConnect': doConnect(); break;
    case 'quickConnect': quickConnect(parseInt(btn.dataset.idx)); break;
    case 'quickConnectSerial': {
      switchConnType('serial');
      document.getElementById('field-target').value = btn.dataset.port;
      break;
    }
    case 'deleteSavedConn': deleteSavedConn(parseInt(btn.dataset.idx)); break;

    // Terminal
    case 'termSelect': termSelect(btn.dataset.sid); break;
    case 'termClose': termClose(btn.dataset.sid); break;
  }
});

// ── Keydown handlers ──

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'browser-url' && e.key === 'Enter') {
    browserNav();
  }
});

// ── Resize handler ──

window.addEventListener('resize', () => {
  if (state.activeTab !== 'browser') return;
  if (state._resizeTimer) clearTimeout(state._resizeTimer);
  state._resizeTimer = setTimeout(() => syncBrowserRect(), 100);
});

// Use ResizeObserver on #browser-area for layout changes without window resize
// (rAF-coalesced — layout animations must not flood set_rect IPC)
const browserArea = document.getElementById('browser-area');
if (browserArea) {
  let rectRaf = 0;
  new ResizeObserver(() => {
    if (state.activeTab !== 'browser' || rectRaf) return;
    rectRaf = requestAnimationFrame(() => { rectRaf = 0; syncBrowserRect(); });
  }).observe(browserArea);
}

// ── Pinned mode ──
// When user interacts (mouse/key in the window), auto-view-switching is suppressed
// for a cooldown period so MCP events don't steal the user's view.

let pinTimer = null;
const PIN_COOLDOWN = 3000; // 3 seconds of inactivity before auto-switch resumes

document.addEventListener('mousedown', () => {
  state.pinned = true;
  if (pinTimer) clearTimeout(pinTimer);
  pinTimer = setTimeout(() => { state.pinned = false; }, PIN_COOLDOWN);
});
document.addEventListener('keydown', () => {
  state.pinned = true;
  if (pinTimer) clearTimeout(pinTimer);
  pinTimer = setTimeout(() => { state.pinned = false; }, PIN_COOLDOWN);
});

// ── Init ──

try {
  listenEvents();
  listenTermOutput();
  document.getElementById('conn-text').textContent = 'Initialized';
  // Ensure webview is positioned over #browser-area at startup
  showBrowser();
} catch (e) {
  invoke('log_diag', { msg: 'Init error: ' + String(e).substring(0, 60) });
}
