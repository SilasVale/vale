// Vale Command UI — terminal sessions & xterm integration

import state from './state.js';
import { invoke } from './ipc.js';
import { terminalHandlers, navHandlers } from './events.js';
import { switchTabUI } from './view.js';
import { renderTabItem, highlightTabItem, removeTabItem, updateCloseButtons } from './tabs.js';
import { svgIcons } from './icons.js';

// ── Xterm loader (lazy, local vendor, shared promise) ──

let _xtermPromise = null;

function loadXterm() {
  if (state.xtermLoaded) return Promise.resolve(true);
  if (!_xtermPromise) {
    _xtermPromise = Promise.all([
      loadScript('/vendor/xterm.min.js'),
      loadScript('/vendor/xterm-addon-fit.min.js'),
    ]).then(() => {
      loadCss('/vendor/xterm.css');
      state.xtermLoaded = true;
      return true;
    }).catch(e => {
      console.error('xterm load failed:', e);
      invoke('log_diag', { msg: 'xterm load fail: ' + String(e).substring(0, 50) });
      _xtermPromise = null; // allow retry on next attempt
      return false;
    });
  }
  return _xtermPromise;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('script: ' + src));
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}

// ── Terminal setup — split so doTermOpen can reuse its measured instance ──

function createTerminal(container) {
  const Terminal = window.Terminal;
  const FitAddon = window.FitAddon;
  if (!Terminal || !FitAddon) return null;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'var(--mono, "JetBrains Mono", monospace)',
    theme: { background: '#ffffff', foreground: '#131314', cursor: '#5b6cf0', selectionBackground: 'rgba(91,108,240,.15)' },
    allowProposedApi: true,
    cols: 80, rows: 24,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);
  return { term, fit };
}

function attachSession(sid, container, term, fit) {
  // Flush any bytes buffered before xterm was ready
  if (state.termBuf[sid]) {
    for (const chunk of state.termBuf[sid]) term.write(new Uint8Array(chunk.data));
    delete state.termBuf[sid];
  }

  requestAnimationFrame(() => {
    try { fit.fit(); } catch (_) {}
    syncSize(sid, term);
  });

  const observer = new ResizeObserver(() => {
    try { fit.fit(); } catch (_) {}
    syncSize(sid, term);
  });
  observer.observe(container);

  term.onData(data => {
    invoke('term_write', { session_id: sid, data });
  });

  return { term, fit, observer };
}

function syncSize(sid, term) {
  const rows = term.rows || 24;
  const cols = term.cols || 80;
  invoke('term_resize', { session_id: sid, rows, cols });
}

// ── Tab rendering ──

export function renderTermTab(sid, label, pre = null) {
  const existing = state.terms[sid];
  if (existing) {
    // Pending placeholder from doTermOpen racing an event — adopt the terminal
    if (existing.pending && pre) {
      const t = attachSession(sid, pre.container, pre.term, pre.fit);
      Object.assign(existing, t, { pending: false });
      if (!state.activeTermId || state.activeTermId === sid) termSelect(sid);
    }
    return;
  }

  const bar = document.getElementById('term-tab-bar');
  renderTabItem({ bar, key: sid, keyAttr: 'sid', label: label || sid, selectAction: 'termSelect', closeAction: 'termClose', icon: svgIcons.close, title: 'Close session' });

  const container = pre ? pre.container : document.createElement('div');
  if (!pre) {
    container.style.cssText = 'display:none;flex:1;';
    document.getElementById('terminal-out').appendChild(container);
  }

  // Mark pending IMMEDIATELY so a racing SshConnect/SerialOpen event (or a
  // double doTermOpen) can't create a second tab element while xterm loads.
  state.terms[sid] = { label, pending: true, container };

  if (pre) {
    const t = attachSession(sid, container, pre.term, pre.fit);
    Object.assign(state.terms[sid], t, { pending: false });
  } else {
    // Event-driven creation — xterm may still be loading
    loadXterm().then(ok => {
      const entry = state.terms[sid];
      if (!ok || !entry) return;
      const made = createTerminal(container);
      if (made) {
        const t = attachSession(sid, container, made.term, made.fit);
        Object.assign(entry, t, { pending: false });
        if (!state.activeTermId || state.activeTermId === sid) termSelect(sid);
      } else {
        entry.pending = false;
      }
    });
  }

  if (!state.activeTermId) state.activeTermId = sid;
  highlightTermTab(sid);
}

export function termSelect(sid) {
  const entry = state.terms[sid];
  if (!entry) {
    renderTermTab(sid, 'term');
    return;
  }
  // Show this container, hide others
  Object.values(state.terms).forEach(e => { e.container.style.display = 'none'; });
  entry.container.style.display = '';
  state.activeTermId = sid;
  highlightTermTab(sid);
  requestAnimationFrame(() => {
    if (entry.fit) { try { entry.fit.fit(); } catch (_) {} }
  });
  switchTabUI('terminal');
}

export function termClose(sid, { fromEvent = false } = {}) {
  // Idempotent: user-close → backend TermClose event → termClose again must no-op
  if (state.closedTerms.has(sid) && !state.terms[sid]) return;
  state.closedTerms.add(sid);
  // Only user-initiated closes call the backend; event-driven ones already happened there
  if (!fromEvent) invoke('term_close', { session_id: sid });

  const entry = state.terms[sid];
  if (entry) {
    if (entry.observer) entry.observer.disconnect();
    if (entry.term) { try { entry.term.dispose(); } catch (_) {} }
    if (entry.container) entry.container.remove();
    removeTabItem({ bar: document.getElementById('term-tab-bar'), key: sid, keyAttr: 'sid' });
    delete state.terms[sid];
  }

  // Select adjacent
  const entries = Object.entries(state.terms);
  if (entries.length) {
    termSelect(entries[0][0]);
  } else {
    state.activeTermId = null;
  }
}

function highlightTermTab(sid) {
  const bar = document.getElementById('term-tab-bar');
  highlightTabItem({ bar, key: sid, keyAttr: 'sid' });
  updateCloseButtons(bar);
}

// ── Connection ──

export async function doTermOpen(kind, target, password) {
  const ok = await loadXterm();
  if (!ok) return { ok: false, error: 'xterm not loaded' };

  // Measure with a REAL Terminal placed in the actual layout (invisible but
  // laid out at full area), then REUSE that instance as the session terminal.
  // This replaces the old create/destroy off-screen probe on every connect.
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;inset:0;visibility:hidden;';
  document.getElementById('terminal-out').appendChild(container);
  const made = createTerminal(container);
  if (!made) {
    container.remove();
    return { ok: false, error: 'xterm unavailable' };
  }
  try { made.fit.fit(); } catch (_) {}
  const rows = made.term.rows || 24;
  const cols = made.term.cols || 80;

  const r = await invoke('term_open', { kind, target, password: password || '', rows, cols });
  if (r.ok && r.result) {
    const sid = typeof r.result === 'string' ? r.result : r.result.session_id;
    if (sid) {
      state.closedTerms.delete(sid); // allow re-opening a previously closed id
      const label = kind === 'pty' ? 'shell' : kind === 'ssh' ? 'ssh:' + target.split('@').pop() : 'serial:' + target;
      container.style.cssText = 'display:none;flex:1;'; // becomes a normal pane
      renderTermTab(sid, label, { container, term: made.term, fit: made.fit });
      switchTabUI('terminal');
      return { ok: true, session_id: sid };
    }
  }
  // Failed — dispose the measured terminal
  try { made.term.dispose(); } catch (_) {}
  container.remove();
  return r.ok ? { ok: false, error: 'no session id returned' } : r;
}

// ── Event handlers ──

// Handlers read `_sid` only — addEvent normalizes session_id/port_id at the
// boundary (SerialClose payloads carry port_id, whose value is the session id).

terminalHandlers.SshConnect = (ev) => {
  if (ev._sid) renderTermTab(ev._sid, `ssh:${ev.host || ev._sid}`);
};

terminalHandlers.SerialOpen = (ev) => {
  if (ev._sid) renderTermTab(ev._sid, `serial:${ev.port || ev._sid}`);
};

terminalHandlers.ShellExec = (ev) => {
  // Shell exec events are informational — session already exists
};

terminalHandlers.TermClose = (ev) => {
  if (ev._sid) termClose(ev._sid, { fromEvent: true });
};

terminalHandlers.SshDisconnect = (ev) => {
  if (ev._sid) termClose(ev._sid, { fromEvent: true });
};

terminalHandlers.SerialClose = (ev) => {
  if (ev._sid) termClose(ev._sid, { fromEvent: true });
};

// ── Activity-row click navigation ──

navHandlers.terminal = (sid) => termSelect(sid);

// ── Term-output listener ──

export function listenTermOutput() {
  try {
    window.__TAURI__?.event?.listen('term-output', (ev) => {
      const payload = ev.payload;
      const sid = payload.session_id;
      if (!sid || state.closedTerms.has(sid)) return;

      if (!state.terms[sid]) renderTermTab(sid, 'term');
      const entry = state.terms[sid];
      if (entry && entry.term) {
        // Flush buffer first
        if (state.termBuf[sid]) {
          for (const chunk of state.termBuf[sid]) {
            entry.term.write(new Uint8Array(chunk.data));
          }
          delete state.termBuf[sid];
        }
        entry.term.write(new Uint8Array(payload.data || []));
      } else {
        // Buffer until xterm is ready
        if (!state.termBuf[sid]) state.termBuf[sid] = [];
        state.termBuf[sid].push(payload);
      }
      if (state.activeTab !== 'terminal' && !state.pinned) switchTabUI('terminal');
    });
  } catch (_) {}
}
