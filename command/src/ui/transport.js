// Vale Command UI — event transport (Tauri listen / SSE / polling)
//
// Chooses the best channel at boot: Tauri events when available, SSE with a
// polling fallback otherwise. All channels funnel into events.js addEvent.
// The chain self-heals: any listen failure falls back to SSE, and SSE errors
// fall back to polling.

import state from './state.js';
import { invoke, getToken } from './ipc.js';
import { addEvent } from './events.js';
import { autoSwitchView } from './view.js';

let eventSource = null; // SSE for headless mode

export function listenEvents() {
  setReady();
  refreshVersion();
  try {
    window.__TAURI__.event.listen('agent-event', (ev) => {
      const p = ev.payload || {};
      const payload = p.event || p; // seq envelope {seq, event}; legacy fallback
      addEvent(payload, p.seq);
      if (!state.pinned) autoSwitchView(payload);
    });
    invoke('log_diag', { msg: 'Events: listen OK' });
  } catch (e) {
    invoke('log_diag', { msg: 'Events: listen fail: ' + String(e).substring(0, 60) });
    // Any listen failure (no Tauri, or Tauri event plugin error) → SSE/poll fallback.
    // In desktop mode SSE fails fast under tauri://localhost and pollEvents uses the
    // events_poll Tauri command, so the chain self-heals.
    tryHeadlessEvents();
  }
}

function refreshVersion() {
  // get_status is the single version source — index.html shows a neutral
  // placeholder until the boot correction lands (works headless too).
  invoke('get_status').then(r => {
    if (r && r.ok && r.version) {
      state.version = 'v' + r.version;
      const el = document.getElementById('version-text');
      if (el) el.textContent = 'v' + r.version;
    }
  }).catch(() => {});
}

function tryHeadlessEvents() {
  // Try SSE first (web.rs serves /api/events; auth via ?token= since
  // EventSource cannot set headers)
  const token = getToken();
  eventSource = new EventSource('/api/events' + (token ? '?token=' + token : ''));
  eventSource.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.lagged !== undefined) {
        // Subscriber fell behind the broadcast ring — catch up from last seq
        pollEvents();
        return;
      }
      if (msg.event) addEvent(msg.event, msg.seq); // {seq, event} envelope
      else addEvent(msg); // legacy tolerance
    } catch (_) {}
  };
  eventSource.onerror = () => {
    // SSE failed — fall back to polling
    eventSource.close();
    eventSource = null;
    pollEvents();
  };
}

function pollEvents() {
  invoke('events_poll', { after: state.lastSeq || 0 }).then(r => {
    if (r && r.ok && r.events) {
      for (const se of r.events) {
        if (se && se.event) addEvent(se.event, se.seq);
      }
    }
    setTimeout(pollEvents, 1000);
  }).catch(() => {
    setTimeout(pollEvents, 2000);
  });
}

function setReady() {
  const led = document.getElementById('conn-led');
  if (led) led.classList.remove('off'); // default .led state is the lit green
  document.getElementById('conn-text').textContent = 'Ready';
}
