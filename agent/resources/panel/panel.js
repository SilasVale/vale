// Vale Agent — terminal panel (Web page, no extension).
//
// Opens a URL and shows every terminal session on a vale-agent device in
// real time (PTY / SSH / serial), driven by the device's own SSE + events —
// no browser extension, no pairing, no polling for sessions.
//
//   down (live): GET /api/events/term  SSE → TermOutput frames {session_id, data}
//   down (discovery): GET /api/events/poll?after=lastSeq → SerialOpen/SshConnect
//   up:   POST /api/tools/terminal_write / terminal_open / terminal_resize
//   hist: POST /api/tools/terminal_read  (absolute offsets + start/end)
//   diag: POST /api/tools/terminal_diag_write
//
// Credentials (hostname + bearer token) are entered once and stored in
// localStorage; every request carries Authorization: Bearer <token>.

const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 100;
const PTY_TARGET = "powershell";
const POLL_EVENTS_MS = 2000;   // event-driven discovery cadence (session opens)
const POLL_LIST_MS = 10000;    // low-frequency full re-list (safety net)
const SYNC_MS = 5000;          // byte-offset sync cadence (missed-output recovery)
const FLUSH_LINE_THRESHOLD = 512;
const FLUSH_IDLE_MS = 60000;
const LS_HOST = "valePanelHost";
const LS_TOKEN = "valePanelToken";

// Dark terminal with the teal brand accent — unified across live + saved.
const TERM_THEME = {
  background: "#1a1c20",
  foreground: "#e8eaed",
  cursor: "#0e9384",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(14,147,132,.35)",
  black: "#1a1c20", red: "#f07178", green: "#7bd88f", yellow: "#ffd479",
  blue: "#82aaff", magenta: "#c792ea", cyan: "#0e9384", white: "#e8eaed",
};

const $ = (id) => document.getElementById(id);
const hostInput = $("host");
const tokenInput = $("token");
const saveBtn = $("save");
const deviceSelect = $("device-select");
const tabsEl = $("tabs");
const termContainer = $("term-container");
const newSessionBtn = $("new-session");
const exportAllBtn = $("export-all");
const statusEl = $("status");
const connForm = $("conn-form");
const panelMain = $("panel-main");

let hostname = "";
let token = "";
let lastSeq = 0;
let lastKnown = new Set();
let polling = false;
let booted = false; // init() ran once — guards double-boot from loadConfig + saveConfig
let sessions = new Map(); // sid → session record
let activeSid = null;

// ── Auth / config ───────────────────────────────────────────────

function loadConfig() {
  // Same-origin mode: served by vale-agent at /panel/ — hostname is this
  // device's own domain. The token is injected by the backend as
  // window.__PANEL_TOKEN__ (zero-config; safe because the API no longer
  // sends Access-Control-Allow-Origin: *, so a third-party page cannot read
  // it). A stored token is still honored when present (hostname + token from
  // a previous session).
  const sameOrigin = location.pathname.startsWith("/panel");
  if (sameOrigin) {
    hostname = location.host;
    hostInput.value = hostname;
    hostInput.disabled = true;
    // The injected token is the device's CURRENT token — always prefer it
    // over a localStorage one, which may be stale (an old device token or a
    // previous manual entry) and would 401 every request.
    const injected = window.__PANEL_TOKEN__ || "";
    const stored = localStorage.getItem(LS_TOKEN) || "";
    token = injected || stored;
    if (injected && injected !== stored) {
      localStorage.setItem(LS_TOKEN, injected); // refresh the stale copy
    }
    if (token) {
      tokenInput.value = token;
      connForm.classList.add("hidden");
      panelMain.classList.remove("hidden");
      if (!booted) { booted = true; init(); } // boot the session discovery +
                                              // SSE loops (previously init()
                                              // only ran on the Connect click)
      return true;
    }
    setStatus("enter the device token (C:\\vale-agent\\config.yaml)");
    return false;
  }
  // Standalone mode: full hostname + token.
  hostname = localStorage.getItem(LS_HOST) || "";
  token = localStorage.getItem(LS_TOKEN) || "";
  if (hostname && token) {
    hostInput.value = hostname;
    tokenInput.value = token;
    connForm.classList.add("hidden");
    panelMain.classList.remove("hidden");
    if (!booted) { booted = true; init(); }
    return true;
  }
  return false;
}

function saveConfig() {
  hostname = String(hostInput.value || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  token = String(tokenInput.value || "").trim();
  if (!hostname || !token) { setStatus("hostname + token required", true); return; }
  localStorage.setItem(LS_HOST, hostname);
  localStorage.setItem(LS_TOKEN, token);
  connForm.classList.add("hidden");
  panelMain.classList.remove("hidden");
  // init() already ran at load (loadConfig boots the discovery loops when a
  // token is present); if the user is filling this form the loops haven't
  // started yet — boot them now. Guard against double-boot.
  if (!booted) { booted = true; init(); }
}

// ── Transport ───────────────────────────────────────────────────

/** Fetch a path on the device with the bearer token. Returns parsed JSON. */
async function callApi(path, init = {}) {
  const res = await fetch(`https://${hostname}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) { setStatus("unauthorized — check token", true); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
}

/** POST /api/tools/<name>; returns the `result` field. */
async function callTool(name, body = {}) {
  const res = await callApi(`/api/tools/${name}`, { method: "POST", body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${name}: ${j.error || "unknown error"}`);
  return j.result;
}

function diag(line) {
  callTool("terminal_diag_write", { line }).catch(() => {});
}

function setStatus(text, isError = false) {
  // Before the main panel is shown, errors belong in the connection form
  // (the statusbar is hidden then); afterwards they go to the bottom bar.
  const el = panelMain.classList.contains("hidden") ? $("conn-status") : statusEl;
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// ── Empty-state visibility ──────────────────────────────────────

function refreshEmpty() {
  const hasAny = [...sessions.values()].some((s) => !s.savedOnly);
  $("#empty-state").classList.toggle("hidden", hasAny);
}

// ── Session management (adopt / close / tab) ────────────────────

function renderTab(sid, label) {
  const tab = document.createElement("button");
  tab.className = "tab";
  tab.dataset.sid = sid;
  tab.title = sid;
  // Kind dot (PTY=teal, SSH=blue, Serial=orange) + label + close + export.
  const kindDot = document.createElement("span");
  kindDot.className = "tab-dot";
  kindDot.dataset.kind = kindOf(sid);
  tab.appendChild(kindDot);
  const nameSpan = document.createElement("span");
  nameSpan.className = "tab-name";
  nameSpan.textContent = label || sid;
  tab.appendChild(nameSpan);
  const ex = document.createElement("span");
  ex.className = "tab-export";
  ex.textContent = "⤓";
  ex.title = "Export this session";
  tab.appendChild(ex);
  const close = document.createElement("span");
  close.className = "tab-close";
  close.textContent = "✕";
  close.title = "Close this session";
  close.addEventListener("click", (e) => { e.stopPropagation(); closeSession(sid); });
  tab.appendChild(close);
  tab.addEventListener("click", (e) => {
    if (e.target.closest(".tab-export")) { exportSession(sid); return; }
    activate(sid);
  });
  // Double-click to rename (updates the label; kept in the session record).
  tab.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    const s = sessions.get(sid);
    const cur = (s && s.label) || sid;
    const next = prompt("Rename session:", cur);
    if (next && next.trim()) {
      if (s) s.label = next.trim();
      nameSpan.textContent = next.trim();
    }
  });
  tabsEl.appendChild(tab);
  return tab;
}

/** Guess the session kind from the label (ssh/serial/shell) for the tab dot. */
function kindOf(sid) {
  const s = sessions.get(sid);
  const label = (s && s.label) || sid || "";
  if (/^ssh\b|@/.test(label)) return "ssh";
  if (/^serial\b|^COM|^\/dev\/tty/.test(label)) return "serial";
  return "pty";
}

/** Close a live session (backend) — NOT just detach. */
async function closeSession(sid) {
  const s = sessions.get(sid);
  if (!s || s.savedOnly) return;
  setStatus("closing…");
  try { await callTool("terminal_close", { session_id: sid }); } catch {}
  markClosed(sid);
  setStatus("");
}

function activate(sid) {
  const s = sessions.get(sid);
  if (!s || sid === activeSid) return;
  activeSid = sid;
  for (const [id, sess] of sessions) {
    sess.container.classList.toggle("active", id === sid);
    sess.tab.classList.toggle("active", id === sid);
  }
  // Fit after the container is displayed (display:none → block) AND laid out.
  // A single rAF can run before the browser has painted the newly-shown
  // container, so fit() measures 0 → the terminal renders at default size and
  // leaves blank space. Double-rAF guarantees the layout is final.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { s.fit.fit(); } catch {}
    // Focus the newly activated session so keystrokes go straight to it —
    // without this the first keystroke can land nowhere (no focused terminal).
    try { s.term.focus(); } catch {}
  }));
}

function adoptSession(sid, label, idbRec = null) {
  const existing = sessions.get(sid);
  if (existing && !existing.closed) return; // dedup
  if (existing) {
    // Resurrection (vale-agent restarted, sid reused)
    existing.closed = false;
    existing.complete = false;
    existing.closedAt = null;
    if (existing.tab) {
      existing.tab.classList.remove("closed");
      existing.tab.textContent = label;
    }
    existing.term.reset();
    existing.term.options.disableStdin = false;
    renderLines(existing);
    backfillAndAttach(sid, existing, idbRec);
    return;
  }
  const container = document.createElement("div");
  container.className = "term-session";
  termContainer.appendChild(container);

  const term = new window.Terminal({
    convertEol: true,
    cursorBlink: true,
    scrollback: 20000,
    fontSize: 13,
    fontFamily: 'monospace',
    disableStdin: false, // live sessions are writable — don't inherit the
                         // saved-session default of true
    theme: TERM_THEME,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);

  term.onData((data) => {
    callTool("terminal_write", { session_id: sid, data }).catch(() => {});
  });
  // Sync the backend pty size whenever xterm re-fits (window resize, tab
  // switch, zoom). Without this the pty keeps its initial rows×cols (e.g.
  // 30×100) and clips the session to that grid — the "not full screen" bug.
  // Debounced: fit() can fire multiple times per resize.
  let resizeTimer = null;
  term.onResize(({ cols, rows }) => {
    if (resizeTimer) return; // in flight — next onResize picks up the latest
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      try { callTool("terminal_resize", { session_id: sid, rows, cols }).catch(() => {}); } catch {}
    }, 150);
  });
  // Clicking anywhere in the session focuses the terminal, so typing works
  // right away instead of requiring a precise click on the xterm viewport.
  container.addEventListener("pointerdown", () => { try { term.focus(); } catch {} });

  const s = {
    sid, term, fit, container, tab: null,
    closed: false, savedOnly: false, label,
    renderedBytes: 0, lines: [], pendingLine: "", persistedSeq: 0,
    openedAt: Date.now(), closedAt: null, complete: false,
    syncInFlight: false, sseDirty: false, needSync: false, flushTimer: null,
  };
  sessions.set(sid, s); // before any await
  s.tab = renderTab(sid, label);
  diag(`adopt: ${sid} (${label})`);
  refreshEmpty();
  // Activate the first adopted session so its container is visible (the
  // .term-session is display:none until .active) — otherwise fit() on a
  // hidden container computes 0 dimensions and the session is invisible.
  if (activeSid === null) activate(sid);
  // Fit after the container is laid out (double requestAnimationFrame) so the
  // xterm canvas fills the whole session area — a single rAF can still run
  // before the container is displayed, rendering the terminal at default size.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { s.fit.fit(); } catch {}
  }));
  backfillAndAttach(sid, s, idbRec);
}

function markClosed(sid) {
  const s = sessions.get(sid);
  if (!s || s.closed) return;
  s.closed = true;
  if (s.es) s.es.close();
  s.term.options.disableStdin = true;
  if (s.tab) {
    s.tab.classList.add("closed");
    const name = s.tab.querySelector(".tab-name");
    if (name) name.textContent = `${s.label || sid} [closed]`;
  }
  if (sid === activeSid) setStatus("session closed");
  refreshEmpty();
}

// ── History backfill + live SSE ─────────────────────────────────

function renderLines(s) {
  for (const l of s.lines) s.term.write(`${l.text}\r\n`);
}

async function backfillAndAttach(sid, s, idbRec) {
  if (idbRec) {
    s.lines = idbRec.lines || [];
    s.openedAt = idbRec.openedAt || s.openedAt;
    s.closedAt = idbRec.closedAt || null;
    s.persistedSeq = idbRec.persistedSeq || s.lines.length;
    s.renderedBytes = idbRec.endAbs || 0;
    renderLines(s);
  }
  try {
    const hist = await callTool("terminal_read", { session_id: sid, offset: s.renderedBytes, clean: false });
    if (hist && typeof hist.text === "string") {
      if (Number(hist.start) > s.renderedBytes) {
        s.term.write(`\r\n[dropped ${Number(hist.start) - s.renderedBytes} bytes — missed while offline]\r\n`);
      }
      if (hist.text) {
        s.term.write(hist.text); // raw bytes — xterm renders PSReadLine's
                                 // cursor-rewrite sequences correctly
        s.renderedBytes = Number(hist.end) || s.renderedBytes;
        ingestLines(s, stripAnsi(hist.text)); // clean text for export/storage
      }
    }
  } catch { /* brand-new session → attach live */ }
  if (!s.closed) s.es = attachStream(sid);
}

/** SSE byte stream — one stream carries all sessions, filter by sid. */
function attachStream(sid) {
  let closed = false;
  const lineDecoder = new TextDecoder("utf-8");

  const connect = async () => {
    if (closed) return;
    const s = sessions.get(sid);
    if (!s) { closed = true; return; }
    try {
      const res = await fetch(`https://${hostname}/api/events/term`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        if (activeSid === sid) setStatus("unauthorized — check token", true);
      } else if (!res.ok) {
        if (activeSid === sid) setStatus(`stream error ${res.status}`, true);
      }
      if (!res.ok || !res.body) { setTimeout(connect, 3000); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            let frame;
            try { frame = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
            if (!frame.session_id) { s.needSync = true; continue; }
            if (frame.session_id !== sid) continue;
            if (Array.isArray(frame.data)) {
              s.term.write(new Uint8Array(frame.data));
              s.renderedBytes += frame.data.length;
              s.sseDirty = true;
              ingestLines(s, lineDecoder.decode(new Uint8Array(frame.data), { stream: true }));
            }
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch {
      if (closed) return;
      if (activeSid === sid) setStatus("reconnecting…");
      s.needSync = true;
    }
    if (!closed) setTimeout(connect, 3000);
  };

  connect();
  return { close: () => { closed = true; } };
}

// ── Line ingestion + local persistence (localStorage, no IDB needed) ──

/// Strip ANSI/VT escape sequences — for export/localStorage line records.
/// (The terminal display itself gets the RAW stream so xterm can render
/// PSReadLine's cursor-rewrite sequences correctly; stripping them there is
/// what left broken fragments like stray prompt pieces in the panel.)
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function ingestLines(s, text) {
  if (!text) return;
  const chunks = text.split("\n");
  for (let i = 0; i < chunks.length; i++) {
    let line = chunks[i];
    if (i === 0 && s.pendingLine !== "") { line = s.pendingLine + line; s.pendingLine = ""; }
    if (i < chunks.length - 1) {
      if (line !== "") s.lines.push({ t: Date.now(), text: line });
    } else if (line !== "") {
      s.pendingLine = line;
    }
  }
  scheduleFlush(s);
}

function scheduleFlush(s) {
  clearTimeout(s.flushTimer);
  if (s.lines.length - s.persistedSeq >= FLUSH_LINE_THRESHOLD) { flushSession(s); return; }
  s.flushTimer = setTimeout(() => flushSession(s), FLUSH_IDLE_MS);
}

async function flushSession(s) {
  clearTimeout(s.flushTimer);
  if (s.persistedSeq === s.lines.length) return;
  try {
    localStorage.setItem(`valePanel:${s.sid}`, JSON.stringify({
      sid: s.sid, label: s.label, openedAt: s.openedAt, closedAt: s.closedAt,
      complete: s.complete, endAbs: s.renderedBytes,
      persistedSeq: s.lines.length, lines: s.lines,
    }));
    s.persistedSeq = s.lines.length;
  } catch { /* quota — memory-only is fine */ }
}

function loadSaved(sid) {
  try {
    const raw = localStorage.getItem(`valePanel:${sid}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Sync (missed-output recovery) ───────────────────────────────

async function syncSession(sid) {
  const s = sessions.get(sid);
  if (!s || s.closed || s.savedOnly || s.syncInFlight) return;
  if (!s.needSync && !s.sseDirty) return;
  s.syncInFlight = true;
  try {
    const r = await callTool("terminal_read", { session_id: sid, offset: s.renderedBytes, clean: false });
    if (r && typeof r.text === "string" && r.text) {
      if (Number(r.start) > s.renderedBytes) {
        s.term.write(`\r\n[dropped ${Number(r.start) - s.renderedBytes} bytes — missed while offline]\r\n`);
      }
      s.term.write(r.text);
      s.renderedBytes = Number(r.end) || s.renderedBytes;
      ingestLines(s, stripAnsi(r.text));
    }
    s.needSync = false;
    s.sseDirty = false;
  } catch { s.needSync = true; }
  finally { s.syncInFlight = false; }
}

async function syncAll() {
  for (const sid of [...sessions.keys()]) await syncSession(sid);
}

async function finalizeSession(sid) {
  const s = sessions.get(sid);
  if (!s || s.closed || s.savedOnly) return;
  try { await syncSession(sid); } catch {}
  s.closedAt = Date.now();
  s.complete = true;
  markClosed(sid);
  try { await flushSession(s); } catch {}
}

// ── Discovery: event-driven + safety-net list ───────────────────

async function pollEvents() {
  if (polling) return;
  polling = true;
  try {
    const res = await callApi(`/api/events/poll?after=${lastSeq}`).catch((e) => {
      diag(`events poll ERROR: ${String(e && e.message || e)}`);
      return null;
    });
    if (!res) return;
    const j = await res.json().catch(() => ({}));
    const events = Array.isArray(j.events) ? j.events : [];
    if (j.last_seq !== undefined) lastSeq = Number(j.last_seq) || lastSeq;
    for (const ev of events) {
      const e = ev.event || {};
      if (e.session_id && (e.type === "SerialOpen" || e.type === "SshConnect")) {
        const label = e.port || e.host || e.type;
        diag(`event: ${e.type} ${e.session_id} (${label})`);
        try { adoptSession(e.session_id, label); } catch (err) {
          diag(`adopt FAILED: ${e.session_id} — ${String(err && err.message || err)}`);
        }
      }
    }
  } finally { polling = false; }
}

async function pollList() {
  try {
    const list = await callTool("terminal_list").catch((e) => {
      diag(`list ERROR: ${String(e && e.message || e)}`);
      return null;
    });
    if (!Array.isArray(list)) return;
    const current = new Set();
    for (const s of list) {
      current.add(s.id);
      try { adoptSession(s.id, s.label || s.kind || s.id, loadSaved(s.id)); } catch (err) {
        diag(`adopt FAILED: ${s.id} — ${String(err && err.message || err)}`);
      }
    }
    for (const sid of lastKnown) {
      if (!current.has(sid)) finalizeSession(sid);
    }
    lastKnown = current;
  } catch {}
}

// ── Export ──────────────────────────────────────────────────────

function fmtTs(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function download(name, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sessionLogText(s, sid) {
  const head = `=== session ${sid} (${s.label || "?"}) ${s.openedAt ? fmtTs(s.openedAt) : "?"} → ${s.closedAt ? fmtTs(s.closedAt) : "open"} ===\n`;
  const body = s.lines.map((l) => `[${fmtTs(l.t)}] ${l.text}`).join("\n");
  return head + body + (body ? "\n" : "") + `=== end ${sid} ===\n`;
}

async function exportSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  if (!s.closed) { try { await syncSession(sid); } catch {} try { await flushSession(s); } catch {} }
  download(`vale-term-${sid}.txt`, sessionLogText(s, sid));
}

async function exportAll() {
  const parts = [];
  for (const [sid, s] of sessions) {
    if (!s.closed) { try { await syncSession(sid); } catch {} try { await flushSession(s); } catch {} }
    parts.push(sessionLogText(s, sid));
  }
  const stamp = fmtTs(Date.now()).replace(/[-: ]/g, "");
  download(`vale-terminal-log-${stamp}.txt`, parts.join("\n"));
}

// ── New session ─────────────────────────────────────────────────

async function openSession() {
  setStatus("Opening PTY…");
  try {
    const sid = await callTool("terminal_open", { kind: "pty", target: PTY_TARGET, rows: DEFAULT_ROWS, cols: DEFAULT_COLS });
    if (typeof sid !== "string" || !sid) { setStatus("terminal_open returned no sid", true); return; }
    adoptSession(sid, "shell");
    activeSid = null;
    activate(sid);
    setStatus("");
  } catch (e) { setStatus(String(e && e.message ? e.message : e), true); }
}

// ── SSH / Serial creation modal ─────────────────────────────────

let modalKind = "ssh"; // "ssh" | "serial"

function showModal(kind) {
  modalKind = kind;
  const title = kind === "ssh" ? "New SSH" : "New Serial";
  $("#modal-title").textContent = title;
  // Rebuild fields: ssh = host/port/user/pass; serial = port name.
  const fields = $("#modal-fields");
  fields.innerHTML = "";
  const mk = (label, id, placeholder, value = "") => {
    const l = document.createElement("label");
    l.textContent = label;
    fields.appendChild(l);
    const i = document.createElement("input");
    i.id = id;
    i.placeholder = placeholder;
    i.value = value;
    i.autocomplete = "off";
    fields.appendChild(i);
  };
  if (kind === "ssh") {
    mk("Host", "ssh-host", "host.example.com");
    mk("Port", "ssh-port", "22", "22");
    mk("Username", "ssh-user", "user");
    mk("Password (optional)", "ssh-pass", "leave empty for keychain");
    $("#ssh-pass").type = "password";
  } else {
    mk("Port", "serial-port", "COM3 or /dev/ttyUSB0");
    mk("Baud rate", "serial-baud", "115200", "115200");
  }
  $("#conn-modal").classList.remove("hidden");
  const first = fields.querySelector("input");
  if (first) setTimeout(() => first.focus(), 50);
  $("#modal-status").textContent = "";
}

function hideModal() { $("#conn-modal").classList.add("hidden"); }

async function connectModal() {
  const status = $("#modal-status");
  try {
    if (modalKind === "ssh") {
      const host = $("#ssh-host").value.trim();
      const port = $("#ssh-port").value.trim() || "22";
      const user = $("#ssh-user").value.trim();
      const pass = $("#ssh-pass").value;
      if (!host || !user) { status.textContent = "host + username required"; status.classList.add("error"); return; }
      status.textContent = "Connecting SSH…";
      status.classList.remove("error");
      const target = `${user}@${host}:${port}`;
      const sid = await callTool("terminal_open", { kind: "ssh", target, password: pass, rows: DEFAULT_ROWS, cols: DEFAULT_COLS });
      if (typeof sid !== "string" || !sid) throw new Error("terminal_open returned no sid");
      hideModal();
      adoptSession(sid, `ssh ${user}@${host}`);
      activeSid = null;
      activate(sid);
      setStatus("");
    } else {
      const port = $("#serial-port").value.trim();
      const baud = $("#serial-baud").value.trim() || "115200";
      if (!port) { status.textContent = "port required"; status.classList.add("error"); return; }
      status.textContent = "Opening serial…";
      status.classList.remove("error");
      const sid = await callTool("terminal_open", { kind: "serial", target: `${port}?baud=${baud}`, rows: DEFAULT_ROWS, cols: DEFAULT_COLS });
      if (typeof sid !== "string" || !sid) throw new Error("terminal_open returned no sid");
      hideModal();
      adoptSession(sid, `serial ${port}`);
      activeSid = null;
      activate(sid);
      setStatus("");
    }
  } catch (e) {
    status.textContent = String(e && e.message ? e.message : e);
    status.classList.add("error");
  }
}

// Modal button handlers
$("new-ssh").addEventListener("click", () => showModal("ssh"));
$("new-serial").addEventListener("click", () => showModal("serial"));
$("modal-cancel").addEventListener("click", hideModal);
$("modal-connect").addEventListener("click", connectModal);
$("conn-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) hideModal(); });

// ── Boot ────────────────────────────────────────────────────────

async function init() {
  const opt = document.createElement("option");
  opt.value = hostname;
  opt.textContent = hostname;
  deviceSelect.appendChild(opt);

  // Restore saved sessions from localStorage.
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("valePanel:")) {
      const sid = k.slice("valePanel:".length);
      const rec = loadSaved(sid);
      if (rec && !sessions.has(sid)) {
        const s = mkSavedSession(sid, rec);
        sessions.set(sid, s);
        s.tab = renderTab(sid, `${s.label || sid} [saved]`);
        s.tab.classList.add("closed");
      }
    }
  }

  // Live sessions on the device (safety-net discovery also runs periodically).
  await pollList();

  // Event-driven discovery + sync + export loops.
  setInterval(pollEvents, POLL_EVENTS_MS);
  setInterval(pollList, POLL_LIST_MS);
  setInterval(syncAll, SYNC_MS);
  window.addEventListener("pagehide", () => { for (const s of sessions.values()) flushSession(s); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") for (const s of sessions.values()) flushSession(s);
    // Returning to the tab: the container may have been resized or the layout
    // reflowed while hidden — refit every session so xterm fills the window.
    else { clearTimeout(refitTimer); refitTimer = setTimeout(refitAll, 200); }
  });
  // Window resize (browser zoom, maximized toggle, sidebar hide): debounce and
  // refit all sessions. Without this xterm keeps its old cell grid and leaves
  // white space or clips content until the next session switch.
  window.addEventListener("resize", () => { clearTimeout(refitTimer); refitTimer = setTimeout(refitAll, 150); });
}

let refitTimer = null;
function refitAll() {
  for (const [sid, s] of sessions) {
    if (s.term && !s.complete) {
      try { s.fit.fit(); } catch {}
    }
  }
}

function mkSavedSession(sid, rec) {
  const container = document.createElement("div");
  container.className = "term-session";
  termContainer.appendChild(container);
  const term = new window.Terminal({
    convertEol: true, disableStdin: true, scrollback: 20000, fontSize: 13,
    fontFamily: 'monospace',
    theme: TERM_THEME,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { fit.fit(); } catch {}
  }));
  const s = {
    sid, term, fit, container, tab: null, closed: true, savedOnly: true,
    label: rec.label || sid, renderedBytes: rec.endAbs || 0,
    lines: rec.lines || [], pendingLine: "", persistedSeq: rec.persistedSeq || 0,
    openedAt: rec.openedAt || Date.now(), closedAt: rec.closedAt || Date.now(),
    complete: true, syncInFlight: false, sseDirty: false, needSync: false, flushTimer: null,
  };
  renderLines(s);
  return s;
}

saveBtn.addEventListener("click", saveConfig);
newSessionBtn.addEventListener("click", openSession);
exportAllBtn.addEventListener("click", exportAll);
$("empty-pty").addEventListener("click", openSession);
$("empty-ssh").addEventListener("click", () => showModal("ssh"));
$("empty-serial").addEventListener("click", () => showModal("serial"));

// Keyboard shortcuts: Ctrl/Cmd+N new PTY, Ctrl/Cmd+E export, Ctrl/Cmd+Shift+E
// export all, Ctrl/Cmd+1..9 switch tab, Esc close modal, Ctrl/Cmd+W close tab.
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "n") { e.preventDefault(); openSession(); }
  else if (k === "e") { e.preventDefault(); if (e.shiftKey) exportAll(); else if (activeSid) exportSession(activeSid); }
  else if (/^[1-9]$/.test(k)) {
    const tabs = [...tabsEl.querySelectorAll(".tab")];
    const t = tabs[Number(k) - 1];
    if (t) activate(t.dataset.sid);
  } else if (k === "w" && activeSid) { e.preventDefault(); closeSession(activeSid); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideModal();
});

if (!loadConfig()) {
  setStatus("enter device hostname + token to connect");
}
