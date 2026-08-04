// Vale Command UI — IPC layer
//
// Desktop (Tauri): plugin tools route through the generic `call_tool` command
// (single dispatch via PluginRegistry); a few window-level commands have no
// plugin equivalent and stay direct. Headless: REST panel at /api/*.
//
// Headless API calls carry an Authorization: Bearer header (token stored in
// localStorage). A 401 response triggers a token overlay.

const TOKEN_KEY = 'vale_command_token';

// Single token source — transport.js and the SSE/poll paths read it here too.
// Exported once at the bottom of the file.
function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
}
function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {} }

// ── Token overlay ──

let _tokenCallback = null;

function showTokenPrompt() {
  // Reuse conn-modal style but with a simple token entry field
  const self = document.createElement('div');
  self.className = 'modal-overlay show';
  self.id = 'token-modal';
  self.innerHTML =
    '<div class="modal-card token-card">' +
      '<div class="modal-head"><h3>API Token Required</h3></div>' +
      '<div class="modal-body">' +
        '<p class="token-note">A token is required to access the Vale Command API. It was printed on the server console at startup.</p>' +
        '<input id="token-input" type="text" placeholder="Paste token here" class="token-input" autofocus>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn-cancel" id="token-cancel">Cancel</button>' +
        '<button class="btn-connect" id="token-submit">Connect</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(self);

  const submit = () => {
    const val = document.getElementById('token-input').value.trim();
    if (!val) return;
    setToken(val);
    self.remove();
    if (_tokenCallback) { const cb = _tokenCallback; _tokenCallback = null; cb(); }
  };
  document.getElementById('token-submit').onclick = submit;
  document.getElementById('token-cancel').onclick = () => { self.remove(); self._resolve(null); };
  document.getElementById('token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  return new Promise((resolve) => { self._resolve = resolve; });
}

// ── Routing table ──

const TOOL_ROUTES = {
  // Browser — same names as MCP tools
  browser_navigate: 'browser_navigate',
  browser_snapshot: 'browser_snapshot',
  browser_click: 'browser_click',
  browser_type: 'browser_type',
  browser_press_key: 'browser_press_key',
  browser_screenshot: 'browser_screenshot',
  browser_evaluate: 'browser_evaluate',
  browser_wait_for: 'browser_wait_for',
  browser_scroll: 'browser_scroll',
  browser_tab_new: 'browser_tab_new',
  browser_tab_list: 'browser_tab_list',
  browser_tab_select: 'browser_tab_select',
  browser_tab_close: 'browser_tab_close',
  // Terminal — UI shorthand → MCP names
  term_open: 'terminal_open',
  term_write: 'terminal_write',
  term_close: 'terminal_close',
  term_select: 'terminal_select',
  term_resize: 'terminal_resize',
  term_list: 'terminal_list',
  term_read: 'terminal_read',
  term_execute: 'terminal_execute',
  list_serial_ports: 'terminal_list_ports',
  // Keychain secrets
  secret_set: 'secret_set',
  secret_get: 'secret_get',
  secret_delete: 'secret_delete',
};

// Commands with a dedicated Tauri handler and no plugin equivalent.
const TAURI_ONLY = new Set([
  'get_status', 'events_poll', 'log_diag',
  'browser_cmd_show', 'browser_cmd_hide', 'browser_cmd_set_rect',
]);

const NAV_CMDS = { browser_back: 'back', browser_forward: 'forward', browser_reload: 'reload' };

function tauriInvoke() {
  const t = window.__TAURI__;
  return (t && t.core && t.core.invoke) ? t.core.invoke.bind(t.core) : null;
}

async function invoke(cmd, args) {
  const inv = tauriInvoke();

  if (inv) {
    // ── Desktop mode — Tauri IPC, no token needed ──
    try {
      if (TAURI_ONLY.has(cmd)) {
        return await inv(cmd, args || {});
      }
      if (NAV_CMDS[cmd]) {
        return await inv('browser_nav_cmd', { action: NAV_CMDS[cmd] });
      }
      const tool = TOOL_ROUTES[cmd];
      if (tool) {
        return await inv('call_tool', { tool, params: args || {} });
      }
      return { ok: false, error: `unknown command: ${cmd}` };
    } catch (e) {
      console.error('vale-command: invoke ' + cmd + ' error:', e);
      return { ok: false, error: String(e) };
    }
  }

  // ── Headless mode — REST panel ──
  return await fetchApi(cmd, args);
}

// ── Headless API fetcher (token-bearing) ──

async function apiFetch(path, opts = {}) {
  const h = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) h['Authorization'] = 'Bearer ' + token;
  h['Cache-Control'] = 'no-cache';
  const r = await fetch(path, { ...opts, headers: h });
  if (r.status === 401) {
    // Token missing or wrong — prompt once, then retry
    await showTokenPrompt();
    const t = getToken();
    if (t) {
      h['Authorization'] = 'Bearer ' + t;
      return await fetch(path, { ...opts, headers: h });
    }
    return { ok: false, status: 401 };
  }
  return r;
}

async function fetchApi(cmd, args) {
  // Direct API endpoints
  if (cmd === 'get_status') {
    try {
      const r = await apiFetch('/api/status');
      return r.ok ? await r.json() : { ok: false };
    } catch (_) { return { ok: false }; }
  }
  if (cmd === 'events_poll') {
    const after = (args && args.after) || 0;
    const token = getToken();
    const qs = token ? `after=${after}&token=${token}` : `after=${after}`;
    try {
      const r = await apiFetch(`/api/events/poll?${qs}`);
      return r.ok ? await r.json() : { ok: false, events: [] };
    } catch (_) { return { ok: false, events: [] }; }
  }
  if (cmd === 'log_diag') {
    if (args && args.msg) console.log('[vale-command]', args.msg);
    return { ok: true };
  }
  // Window/webview control has no meaning headless — honest error
  if (TAURI_ONLY.has(cmd)) {
    return { ok: false, error: `${cmd} is desktop-only` };
  }
  // Nav — headless uses the plugin tools directly
  if (NAV_CMDS[cmd]) {
    return await callToolViaApi(cmd, args || {});
  }
  const tool = TOOL_ROUTES[cmd];
  if (!tool) return { ok: false, error: `no headless route for ${cmd}` };
  return await callToolViaApi(tool, args || {});
}

async function callToolViaApi(name, params) {
  try {
    const r = await apiFetch(`/api/tools/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const j = await r.json();
    if (j.ok) return { ok: true, result: j.result };
    return { ok: false, error: j.error };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export { invoke, callToolViaApi, getToken };
