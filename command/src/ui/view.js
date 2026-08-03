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
  document.querySelectorAll('#tabs .tab').forEach(el => {
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
