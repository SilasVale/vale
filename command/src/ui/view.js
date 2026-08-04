// Vale Command UI — view switching & activity filtering
//
// Pure DOM state transitions: which top-level tab is active, which toolbar
// row is visible, and which event rows are shown. No transport, no IPC.

import state from './state.js';

export function autoSwitchView(ev) {
  const tab = tabForEvent(ev);
  if (tab && tab !== state.activeTab) {
    switchTabUI(tab);
  }
}

export function switchTabUI(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.stage-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.ctx-toolbar').forEach(el => {
    if (tab === 'browser' && (el.id === 'toolbar-browser' || el.id === 'toolbar-url')) {
      el.classList.add('active');
    } else if (tab === 'terminal' && el.id === 'toolbar-terminal') {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });
  document.querySelectorAll('.ctx-content').forEach(el => {
    el.classList.toggle('active', el.id === 'content-' + tab);
  });
  // Manage native webview overlay visibility
  if (tab === 'browser') {
    if (window._showBrowser) window._showBrowser();
  } else {
    if (window._hideBrowser) window._hideBrowser();
  }
  filterEvents();
}

export function filterEvents() {
  const tab = state.activeTab === 'browser' ? 'browser' : 'terminal';
  document.querySelectorAll('.event-row').forEach(row => {
    row.style.display = row.dataset.evtab === tab ? '' : 'none';
  });
}

export function updateActivityTitle() {
  const title = document.getElementById('activity-title');
  const tcount = Object.keys(state.terms).length;
  if (state.activeTab === 'browser') {
    title.textContent = 'Browser Activity';
  } else {
    title.textContent = state.activeTermId
      ? `Terminal — ${state.terms[state.activeTermId]?.label || state.activeTermId}`
      : `Terminal (${tcount} sessions)`;
  }
}

export function tabForEvent(ev) {
  return ev.type.startsWith('Browser') ? 'browser' : 'terminal';
}

// ── Observation follow toggle ──

export function setFollow(on) {
  state.follow = on;
  const btn = document.getElementById('btn-follow');
  if (btn) {
    btn.classList.toggle('active', on);
    btn.textContent = on ? 'Follow' : 'Manual';
    btn.title = on ? 'Automatically follow AI actions' : 'Manually choose the view';
  }
}

// ── AI status line (topbar) — humanize the latest agent event ──

export function updateAiStatus(ev) {
  const el = document.getElementById('ai-status-text');
  if (!el || !ev || !ev.type) return;
  el.textContent = humanizeEvent(ev);
  const pulse = document.getElementById('ai-pulse');
  if (pulse) {
    pulse.classList.remove('flash');
    void pulse.offsetWidth; // restart the CSS animation
    pulse.classList.add('flash');
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return url; }
}

function humanizeEvent(ev) {
  switch (ev.type) {
    case 'BrowserNavigate': return 'AI → ' + (ev.url ? hostOf(ev.url) : 'page');
    case 'BrowserTabNew': return 'AI opened a new tab';
    case 'BrowserTabSelect': return 'AI switched tab';
    case 'BrowserTabClose': return 'AI closed a tab';
    case 'BrowserClick': return 'AI → click ' + (ev.selector || '');
    case 'BrowserType': return 'AI → type ' + (ev.text || '');
    case 'BrowserEvaluate': return 'AI ran browser JS';
    case 'BrowserScreenshot': return 'AI took a screenshot';
    case 'BrowserScroll': return 'AI scrolled ' + (ev.direction || '');
    case 'BrowserWaitFor': return 'AI waiting for ' + (ev.selector || '');
    case 'SshConnect': return 'AI → ssh ' + (ev.host || '');
    case 'SshDisconnect': return 'AI closed ssh session';
    case 'SerialOpen': return 'AI → serial ' + (ev.port || '');
    case 'SerialClose': return 'AI closed serial port';
    case 'ShellExec': return 'AI → ' + (ev.command || 'command');
    case 'TermClose': return 'AI closed terminal session';
    default: return 'AI is working…';
  }
}
