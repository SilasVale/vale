// Vale Command UI — activity feed (rendering + dispatch)
//
// Transport (Tauri listen / SSE / polling) lives in transport.js; view
// switching lives in view.js. This module owns the event ring, the feed
// rows, the handler registries, and shared feed helpers.

import state from './state.js';
import { svgIcons } from './icons.js';
import { filterEvents, tabForEvent, updateActivityTitle } from './view.js';

const MAX_EVENTS = 50;

export function addEvent(ev, seq) {
  if (!ev || !ev.type) return;

  // Normalize legacy payload field names at the boundary — handlers from
  // here on read only `_sid` (session id) and `tab_id`.
  if (ev._sid === undefined) ev._sid = ev.session_id || ev.port_id || null;

  // Seq dedup — catch-up polling may redeliver events already seen
  if (seq && state.lastSeq && seq <= state.lastSeq) return;

  // Dedup BrowserNavigate
  if (ev.type === 'BrowserNavigate') {
    if (state.events.length && state.events[0].type === 'BrowserNavigate' && state.events[0].url === ev.url) {
      return;
    }
  }

  if (seq) state.lastSeq = Math.max(state.lastSeq, seq);
  state.evCount = seq ? state.lastSeq : state.evCount + 1;
  state.events.unshift(ev);
  if (state.events.length > MAX_EVENTS) state.events.pop();

  renderRow(ev);
  dispatchBrowser(ev);
  dispatchTerminal(ev);
  updateActivityTitle();
  document.getElementById('ev-count').textContent = state.evCount;
  document.getElementById('status-ev').textContent = 'EV:' + state.evCount;
}

function renderRow(ev) {
  const feed = document.getElementById('activity-feed');
  if (feed.querySelector('.empty')) feed.querySelector('.empty').remove();

  const icons = {
    BrowserNavigate: svgIcons.globe, BrowserTabNew: svgIcons.plus, BrowserTabSelect: svgIcons.forward, BrowserTabClose: svgIcons.close,
    SshConnect: svgIcons.ssh, SshDisconnect: svgIcons.ssh,
    SerialOpen: svgIcons.serial, SerialClose: svgIcons.serial,
    ShellExec: svgIcons.terminal, TermClose: svgIcons.close,
  };
  const color = {
    Browser: 'b', Ssh: 's', Serial: 'd', Shell: 't', Term: 't',
  };

  const icon = icons[ev.type] || svgIcons.shell;
  const cls = color[Object.keys(color).find(k => ev.type.startsWith(k)) || ''] || 'b';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const detail = (ev.url || ev.command || ev.host || ev._sid || ev.label || '').toString().substring(0, 80);
  const tab = tabForEvent(ev);

  const row = document.createElement('div');
  row.className = 'event-row';
  row.dataset.evtab = tab;
  row.innerHTML =
    `<span class="icon-circle ${cls}">${icon}</span>` +
    `<span class="time-col">${time}</span>` +
    `<span class="msg-col"><span class="title">${ev.type}</span><br><span class="detail">${escapeHtml(detail)}</span></span>`;
  row.addEventListener('click', () => {
    if (tab === 'browser') {
      if (navHandlers.browser) navHandlers.browser(ev);
    } else {
      if (ev._sid && navHandlers.terminal) navHandlers.terminal(ev._sid);
    }
  });

  feed.insertBefore(row, feed.firstChild);
  requestAnimationFrame(filterEvents);
}

function dispatchBrowser(ev) {
  if (!ev.type.startsWith('Browser')) return;
  // Delegate to browser module handlers
  const handler = browserHandlers[ev.type];
  if (handler) handler(ev);
}

function dispatchTerminal(ev) {
  const terminalTypes = ['SshConnect', 'SshDisconnect', 'SerialOpen', 'SerialClose', 'TermClose', 'ShellExec'];
  if (!terminalTypes.includes(ev.type)) return;
  const handler = terminalHandlers[ev.type];
  if (handler) handler(ev);
}

// Handler registries — filled by browser.js and term.js
export const browserHandlers = {};
export const terminalHandlers = {};
// Activity-row click navigation — filled by browser.js (browser) and term.js (terminal)
export const navHandlers = { browser: null, terminal: null };

// ── Toast helper (shared by browser/term/conn modules) ──

export function toast(msg, duration = 3000) {
  const el = document.getElementById('conn-text');
  if (el) {
    el.textContent = msg;
    el.style.color = 'var(--red)';
    clearTimeout(el._toastTimer);
    el._toastTimer = setTimeout(() => {
      el.style.color = '';
      el.textContent = 'Ready';
    }, duration);
  }
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
