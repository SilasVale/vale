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

// Light terminal — white background, dark ink — per the confirmed Apple-style
// design spec ("xterm 白底墨字保留", docs/superpowers/specs/2026-08-11-
// apple-style-unification-design.md). A dark block on the light panel was a
// spec deviation introduced in a later commit; revert to the confirmed theme.
//
// The bright palette (8-15) MUST be set: xterm draws bold text with index<8
// at index+8 (drawBoldTextInBrightColors default true) and falls back to the
// dark Tango bright colors when they are unset — bright green #8ae234 etc.
// are nearly invisible on white (1.2-1.6:1 contrast).
const TERM_THEME = {
  background: "#ffffff",
  foreground: "#1d1d1f",
  cursor: "#0b7a6e",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(14,147,132,.2)",
  black: "#1d1d1f", red: "#b91c1c", green: "#166534", yellow: "#854d0e",
  blue: "#1d4ed8", magenta: "#7c3aed", cyan: "#0f766e", white: "#44403c",
  // Brights tuned for white bg: >=4.5:1 (WCAG AA) against #ffffff.
  brightBlack: "#4b5563", brightRed: "#dc2626", brightGreen: "#15803d",
  brightYellow: "#a16207", brightBlue: "#2563eb", brightMagenta: "#9333ea",
  brightCyan: "#0f766e", brightWhite: "#6e6e73",
};

// getElementById takes a bare id — a leading "#" (used by several callers)
// made it return null and threw TypeError inside refreshEmpty()/showModal()
// at runtime ("Cannot read properties of null (reading 'classList')"), which
// aborted adoptSession BEFORE activate() — sessions rendered into a
// display:none container (blank terminal) and were never activated again
// (dedup kept skipping them). Strip the "#" so both spellings work.
const $ = (id) => document.getElementById(String(id).replace(/^#/, ""));
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
let lastEpoch = 0; // agent boot epoch — reset the cursor when it changes
let lastKnown = new Set();
let polling = false;
let booted = false; // init() ran once — guards double-boot from loadConfig + saveConfig
let sessions = new Map(); // sid → session record
let activeSid = null;
let modalConnecting = false; // single-flight for the SSH/serial modal submit

// ── Auth / config ───────────────────────────────────────────────

function loadConfig() {
  // Same-origin mode: served by vale-agent at /panel/ — hostname is this
  // device's own domain. The token is injected by the backend as
  // window.__PANEL_TOKEN__ (zero-config; safe because the API no longer
  // sends Access-Control-Allow-Origin: *, so a third-party page cannot read
  // it). A stored token is still honored when present (hostname + token from
  // a previous session).
  // PROXY mode: served through the console at
  // /api/devices/<name>/proxy/panel/?token=<pluginToken> (the browser
  // extension's Terminal button). The gateway authenticates Bearer <plugin
  // token> on every proxied API call, so the token comes from the URL query
  // and hostname is the console's own domain. The sameOrigin gate previously
  // only matched "/panel" and missed this pathname — the page fell into
  // standalone mode, asked for credentials, and froze (SSE 404).
  const sameOrigin = location.pathname.startsWith("/panel")
    || /\/proxy\/panel/.test(location.pathname);
  if (sameOrigin) {
    hostname = location.host;
    hostInput.value = hostname;
    hostInput.disabled = true;
    // PROXY mode: this page is served through the console at
    // /api/devices/<name>/proxy/panel/. The gateway authenticates every
    // proxied request with the PER-DEVICE vale_pt_<name> cookie (set on the
    // bootstrap navigation; HttpOnly — the cookie rides along on every
    // same-origin fetch, so the panel needs NO JS-visible token here).
    // window.__PANEL_TOKEN__ would be the DEVICE token (the agent injects
    // it because the proxy strips the Host header) — sending it as Bearer
    // would 401 (the gateway only accepts plugin tokens on /proxy/*), and
    // a stale localStorage value from a previous console-origin visit is
    // likewise a device token: ignore both in proxy mode.
    const isProxy = /\/proxy\/panel/.test(location.pathname);
    const urlToken = new URLSearchParams(location.search).get("token") || "";
    const injected = (isProxy ? "" : window.__PANEL_TOKEN__) || "";
    // Token precedence (DIRECT mode): injected (agent-served, always fresh)
    // > URL ?token= > stored (localStorage, may be stale after rotation).
    // Proxy mode: urlToken on the first navigation only; the cookie is the
    // credential and the panel boots with an EMPTY token (the gateway falls
    // back to the cookie when no Authorization header is sent).
    const stored = localStorage.getItem(LS_TOKEN) || "";
    token = isProxy ? (urlToken || "") : (injected || urlToken || stored);
    // A ?token= in the address bar is a live plugin token — strip it from
    // history/address bar so a later screenshot, tab restore or history sync
    // cannot leak device control. (The gateway only accepts ?token= on a
    // top-level navigation, and this panel was just that navigation.)
    if (urlToken) {
      try {
        history.replaceState(null, "", location.pathname);
      } catch {}
    }
    // Boot in proxy mode EVEN with no JS-visible token: the per-device
    // cookie authenticates every request (the gateway's auth fallback).
    // A dead-end "enter the device token" form here could never succeed —
    // the gateway only accepts plugin tokens on /proxy/*.
    if (isProxy) {
      tokenInput.value = "";
      connForm.classList.add("hidden");
      panelMain.classList.remove("hidden");
      if (!booted) { booted = true; init(); }
      // The gateway may 401 if the per-device cookie died (expired/evicted)
      // — the panel then shows the impossible "unauthorized" form. Re-open
      // the terminal via the extension (which re-pins the cookie).
      // (A typed device token would SHADOW the cookie in the gateway's
      // auth || qToken || cookie chain — never send it in proxy mode.)
      token = "";
      return true;
    }
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
    // round-59: a hung tool call (agent busy/stalled) would otherwise leave
    // syncInFlight set forever → output frozen until manual refresh. 30s hard
    // timeout → the existing catch → needSync retry path recovers.
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error("unauthorized");
  }
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

function onUnauthorized() {
  setStatus("unauthorized — check token", true);
  // Reveal the escape hatch: #conn-form is display:none in booted state, so
  // the button inside it was unreachable — a stale/rotated token previously
  // 401-looped with NO recovery UI.
  const form = $("conn-form");
  if (form) form.classList.remove("hidden");
  const f = $("forget-creds");
  if (f) f.classList.remove("hidden");
}

function setStatus(text, isError = false) {
  // Before the main panel is shown, errors belong in the connection form
  // (the statusbar is hidden then); afterwards they go to the bottom bar.
  // Null-guard: panelMain/statusEl/conn-status can be absent when the page
  // is mid-boot or a proxy-mode load failed — setStatus must never throw
  // (a thrown setStatus inside a closeSession catch replaced the real error
  // with "Cannot read properties of null (reading 'classList')").
  if (!panelMain || !statusEl) return;
  const el = panelMain.classList.contains("hidden") ? ($("conn-status") || statusEl) : statusEl;
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// ── Empty-state + statusbar visibility ──────────────────────────

function refreshEmpty() {
  const hasAny = [...sessions.values()].some((s) => !s.savedOnly);
  $("#empty-state").classList.toggle("hidden", hasAny);
}

function refreshStatusbar() {
  const live = [...sessions.values()].filter((s) => !s.savedOnly && !s.closed).length;
  // Saved-only history records are NOT 'closed' sessions — exclude them.
  const closed = [...sessions.values()].filter((s) => s.closed && !s.savedOnly).length;
  const el = $("#session-count");
  if (live + closed === 0) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.textContent = `${live} live · ${closed} closed`;
}

// ── Session management (adopt / close / tab) ────────────────────

function renderTab(sid, label) {
  const tab = document.createElement("button");
  tab.className = "tab";
  tab.dataset.sid = sid;
  tab.title = sid;
  // ARIA tablist contract (round-56): tabs are keyboard/screen-reader
  // navigable; aria-selected tracks the active session.
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", "false");
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
      if (s) {
        s.label = next.trim();
        s.renamed = true; // force the next flush to persist (flushSession
                          // early-returns when lines are unchanged)
        flushSession(s);
      }
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
  if (!s) return;
  // Saved-only records (localStorage history) have no backend session — the
  // ✕ on a [saved] tab previously did NOTHING (early return), leaving
  // unremovable tabs. "Close" dismisses the record: tab + stored lines.
  if (s.savedOnly) { removeSession(sid); return; }
  // Already closed (backend gone) — the ✕ removes the UI remnants.
  if (s.closed) { removeSession(sid); return; }
  setStatus("closing…");
  try {
    await callTool("terminal_close", { session_id: sid });
    markClosed(sid);
    setStatus("");
  } catch (e) {
    const msg = String(e && e.message || e);
    // "session not found" means it is ALREADY gone (the idle sweeper reaped
    // it, the shell exited, or a double-clicked ✕ — the second close). That
    // is a success, not an error: remove the UI remnants.
    if (/not found|unknown session/i.test(msg)) {
      removeSession(sid);
      setStatus("");
      return;
    }
    // A genuine failure must NOT mark the session closed — pollList would
    // resurrect it and the tab flickers between [closed] and live forever
    // (the "cannot close" bug). Surface the failure instead.
    setStatus(`close failed: ${msg} — session still open`, true);
  }
}

/** Drop a session from the UI entirely (tab + container + storage). */
function removeSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  if (s.tab) s.tab.remove();
  if (s.container) s.container.remove();
  if (s.es) { try { s.es.close(); } catch {} }
  try { localStorage.removeItem(`valePanel:${sid}`); } catch {}
  // If the removed session was active, move focus to another live session
  // (or back to the empty state) — otherwise the container shows nothing.
  if (activeSid === sid) {
    activeSid = null;
    const next = [...sessions.values()].find((x) => !x.savedOnly && !x.closed)
      || [...sessions.values()][0];
    if (next) activate(next.sid);
  }
  refreshEmpty();
  refreshStatusbar();
}

function activate(sid) {
  const s = sessions.get(sid);
  if (!s || sid === activeSid) return;
  activeSid = sid;
  for (const [id, sess] of sessions) {
    sess.container.classList.toggle("active", id === sid);
    sess.tab.classList.toggle("active", id === sid);
    // ARIA (round-56): aria-selected mirrors the active tab.
    sess.tab.setAttribute("aria-selected", id === sid ? "true" : "false");
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
    // A restored saved-only record must become LIVE again — otherwise it is
    // excluded from SSE + sync forever and the session freezes on reload.
    existing.savedOnly = false;
    if (existing.tab) {
      existing.tab.classList.remove("closed");
      const existingName = existing.tab.querySelector(".tab-name");
      if (existingName) existingName.textContent = label; else existing.tab.textContent = label;
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
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace',
    disableStdin: false, // live sessions are writable — don't inherit the
                         // saved-session default of true
    // Reflow the buffer when the viewport resizes: a session adopted while
    // its container is hidden (display:none) opens at the default 80×24; when
    // it is activated and fit() grows the viewport, WITHOUT this the text
    // stays in the top-left — the "half screen" bug. xterm defaults it false.
    reflowOnResize: true,
    theme: TERM_THEME,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);

  term.onData((data) => {
    callTool("terminal_write", { session_id: sid, data })
      .catch(() => { if (activeSid === sid) setStatus("write failed — session may be closed", true); });
  });
  // Sync the backend pty size whenever xterm re-fits (window resize, tab
  // switch, zoom). Without this the pty keeps its initial rows×cols (e.g.
  // 30×100) and clips the session to that grid — the "not full screen" bug.
  // Debounced trailing-edge: keep the LATEST dims (a first-event-wins
  // debounce dropped the final size of a resize burst, leaving a stale grid).
  let resizeTimer = null;
  let resizePending = null;
  term.onResize(({ cols, rows }) => {
    resizePending = { cols, rows };
    if (resizeTimer) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      const dims = resizePending;
      resizePending = null;
      if (dims) {
        try { callTool("terminal_resize", { session_id: sid, rows: dims.rows, cols: dims.cols }).catch(() => {}); } catch {}
      }
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
  refreshStatusbar();
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
  refreshStatusbar();
}

// ── History backfill + live SSE ─────────────────────────────────

function renderLines(s) {
  for (const l of s.lines) s.term.write(`${l.text}\r\n`);
}

async function backfillAndAttach(sid, s, idbRec) {
  if (idbRec) {
    // Boot-epoch guard (round-56): the agent restarts and mints NEW sessions
    // with REUSED sids (per-boot prefix rotates, but a same-prefix session
    // id can repeat across boots). Old records seeding the new session's
    // cursor would render a stale log; the read below would then start from
    // a byte offset that no longer corresponds. Keep the lines as reference
    // but reset the byte cursor to 0 — the read re-fetches from scratch.
    // Three-state compare (round-57): lastEpoch is 0 until the first pollEvents
    // lands — every backfill before that would look stale and show a false
    // "[agent restarted]" banner + reset the cursor. Only judge when BOTH
    // sides are known.
    const staleEpoch = lastEpoch !== 0 && idbRec.epoch && idbRec.epoch !== lastEpoch;
    s.lines = idbRec.lines || [];
    s.openedAt = idbRec.openedAt || s.openedAt;
    s.closedAt = idbRec.closedAt || null;
    s.persistedSeq = idbRec.persistedSeq || s.lines.length;
    s.renderedBytes = staleEpoch ? 0 : (idbRec.endAbs || 0);
    if (staleEpoch) s.term.write(`\r\n[agent restarted — session history reset]\r\n`);
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
  if (!s.closed) s.es = subscribeStream(sid);
}

/**
 * Shared SSE byte stream — ONE connection carries ALL sessions, distributed
 * by session_id. Previously every session opened its own /api/events/term
 * connection (N sessions = N SSE sockets, plus a 3s reconnect each) — the
 * server broadcasts to all subscribers, so this multiplied connections for
 * no benefit. subscribeStream(sid) returns an unsubscribe handle.
 */
let streamStarted = false;

function subscribeStream(sid) {
  // Shared SSE stream — ONE connection carries all sessions, dispatched by
  // session_id inside startSharedStream. Per-session subscribes just make
  // sure the shared stream is started; the frame dispatch there is the only
  // writer (the old per-session onFrame here was dead code).
  const ensure = () => {
    if (!streamStarted) { streamStarted = true; startSharedStream(); }
  };
  ensure();
  return { close: () => { /* shared stream — nothing to tear down */ } };
}

async function startSharedStream() {
  // Jittered exponential backoff (round-59): a fixed 3s reconnect had every
  // open tab lockstep-bombing a restarting agent (10 tabs = 20 streams ×
  // every 3s). Base ×2 capped at 30s, ±50% jitter, reset on a successful
  // frame (all tabs desync naturally).
  let attempt = 0;
  const backoff = () => {
    const base = Math.min(3000 * Math.pow(2, attempt), 30000);
    attempt += 1;
    return base * (0.5 + Math.random() * 0.5);
  };
  const connect = async () => {
    try {
      const res = await fetch(`https://${hostname}/api/events/term`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        onUnauthorized();
      } else if (!res.ok) {
        setStatus(`stream error ${res.status}`, true);
      }
      if (!res.ok || !res.body) { setTimeout(connect, backoff()); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // First bytes received → connection healthy → reset the backoff.
          attempt = 0;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            // Any frame (incl. the 60s `: ping` heartbeat) proves the stream
            // is alive (round-60).
            setStreamDown(false);
            // SSE spec: an event may carry MULTIPLE data: lines which must be
            // joined. The server emits single lines today, but joining is
            // spec-compliant and future-proof (round-59).
            const dataText = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
            if (!dataText.trim()) continue;
            let frame;
            try { frame = JSON.parse(dataText.trim()); } catch { continue; }
            // Dispatch to every live session.
            for (const s of sessions.values()) {
              if (s.closed || s.savedOnly || !s.term) continue;
              if (!frame.session_id) { s.needSync = true; continue; }
              if (frame.session_id !== s.sid) continue;
              if (Array.isArray(frame.data)) {
                // Dedup vs terminal_read: the server attaches the frame's
                // absolute start offset; if a concurrent sync/backfill read
                // already delivered these bytes (renderedBytes advanced past
                // it), skip — otherwise the same bytes render twice.
                if (typeof frame.start === "number" && frame.start < s.renderedBytes) continue;
                s.term.write(new Uint8Array(frame.data));
                s.renderedBytes += frame.data.length;
                s.sseDirty = true;
                // Persistent per-session decoder: a fresh TextDecoder per frame
                // destroyed multi-byte UTF-8 split across frame boundaries
                // (CJK → U+FFFD garbage in stored/exported lines).
                if (!s.decoder) s.decoder = new TextDecoder();
                ingestLines(s, s.decoder.decode(new Uint8Array(frame.data), { stream: true }));
              }
            }
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch {
      setStreamDown(true);
      for (const s of sessions.values()) if (!s.closed) s.needSync = true;
    }
    setTimeout(connect, backoff());
  };
  connect();
}

// SSE connection state (round-60): a dedicated flag rendered as a fixed
// status element — "reconnecting…" via setStatus was one line of text that
// any later setStatus overwrote, and nothing cleared it on reconnect. Any
// frame (incl. the 60s `: ping` heartbeat) clears it.
let streamDown = false;
function setStreamDown(v) {
  if (streamDown === v) return;
  streamDown = v;
  const el = $("sse-status");
  if (!el) return;
  el.classList.toggle("hidden", !v);
  el.textContent = v ? "reconnecting…" : "";
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
  // Normalize EVERY arrival path (live SSE previously bypassed stripAnsi):
  // strip ANSI/VT escapes + normalize \r\n → \n so stored/exported lines are
  // clean regardless of how the bytes arrived.
  text = stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
  if (s.persistedSeq === s.lines.length && !s.renamed) return;
  s.renamed = false;
  // Bound what we persist: a single unbounded record could exceed the 5MB
  // localStorage quota and silently kill persistence for EVERY session.
  // Cap at the most recent 2000 lines per session (exports still read from
  // the in-memory s.lines, which is unbounded).
  const MAX_PERSIST_LINES = 2000;
  const tail = s.lines.slice(-MAX_PERSIST_LINES);
  // Mark truncation so a reloaded session shows the user history was capped
  // (silent truncation hid pre-tail lines with no marker).
  const truncated = s.lines.length > tail.length;
  try {
    localStorage.setItem(`valePanel:${s.sid}`, JSON.stringify({
      sid: s.sid, label: s.label, openedAt: s.openedAt, closedAt: s.closedAt,
      complete: s.complete, endAbs: s.renderedBytes,
      persistedSeq: s.lines.length, lines: tail, truncated,
      epoch: lastEpoch, // round-56: agent boot epoch — stale records reset the cursor
    }));
    s.persistedSeq = s.lines.length;
  } catch (e) {
    // Quota — shrink further and retry once; if that still fails, skip
    // persistence but keep the in-memory session (exports unaffected).
    try {
      localStorage.setItem(`valePanel:${s.sid}`, JSON.stringify({
        sid: s.sid, label: s.label, openedAt: s.openedAt, closedAt: s.closedAt,
        complete: s.complete, endAbs: s.renderedBytes,
        persistedSeq: s.lines.length, lines: tail.slice(-500), truncated: true,
        epoch: lastEpoch, // round-56: agent boot epoch — stale records reset the cursor
      }));
      s.persistedSeq = s.lines.length;
    } catch { /* memory-only is fine */ }
  }
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
    // Snapshot the cursor NOW; SSE frames arriving while the read is in
    // flight carry an absolute `start` and are deduped by it (frame.start <
    // renderedBytes → skip), so the read window below is the authoritative
    // recovery for anything SSE evicted or never delivered. The old
    // covered-cut (assumed in-flight SSE bytes are a contiguous PREFIX of
    // the read window) silently dropped bytes when the broadcast channel
    // evicted the MIDDLE of the window while the connection was down —
    // round-50 High: undelivered bytes were cut and never rendered.
    const from = s.renderedBytes;
    const r = await callTool("terminal_read", { session_id: sid, offset: from, clean: false });
    if (r && typeof r.text === "string" && r.text) {
      if (Number(r.start) > from) {
        s.term.write(`\r\n[dropped ${Number(r.start) - from} bytes — missed while offline]\r\n`);
      }
      const end = Number(r.end) || from;
      s.term.write(r.text);
      s.renderedBytes = Math.max(s.renderedBytes, end);
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
    if (j.last_seq !== undefined) {
      // Epoch change (agent restarted, seq re-seeded to 1): reset the cursor
      // so the first post-restart events are not silently skipped.
      if (j.epoch !== undefined && j.epoch !== lastEpoch) {
        lastEpoch = j.epoch;
        lastSeq = 0;
      } else if (j.first_seq !== undefined && lastSeq > 0 && Number(j.first_seq) > lastSeq + 1) {
        // Gap detection: cursor fell below the ring's oldest retained seq —
        // events were evicted while we were away. Surface it.
        setStatus(`missed ${Number(j.first_seq) - lastSeq - 1} events while disconnected`);
      }
      lastSeq = Number(j.last_seq) || lastSeq;
    }
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
  if (modalConnecting) return; // single-flight — Enter twice created 2 sessions
  modalConnecting = true;
  const connectBtn = $("#modal-connect");
  if (connectBtn) connectBtn.disabled = true;
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
  } finally {
    modalConnecting = false;
    if (connectBtn) connectBtn.disabled = false;
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

  // Restore saved sessions from localStorage — capped at the 20 most recent
  // (records were unbounded; ~20 × 300KB exhausted the 5MB quota silently and
  // killed ALL persistence).
  const savedKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("valePanel:")) savedKeys.push(k);
  }
  savedKeys.sort((a, b) => {
    const ra = loadSaved(a), rb = loadSaved(b);
    return (rb?.openedAt || 0) - (ra?.openedAt || 0);
  });
  for (const k of savedKeys.slice(20)) localStorage.removeItem(k); // prune old
  for (const k of savedKeys.slice(0, 20)) {
    const sid = k.slice("valePanel:".length);
    const rec = loadSaved(sid);
    if (rec && !sessions.has(sid)) {
      const s = mkSavedSession(sid, rec);
      sessions.set(sid, s);
      s.tab = renderTab(sid, `${s.label || sid} [saved]`);
      s.tab.classList.add("closed");
    }
  }

  // Live sessions on the device (safety-net discovery also runs periodically).
  await pollList();

  // Event-driven discovery + sync + export loops.
  setInterval(pollEvents, POLL_EVENTS_MS);
  setInterval(pollList, POLL_LIST_MS);
  setInterval(syncAll, SYNC_MS);
  // Client-liveness heartbeat: the backend's idle sweeper force-closes any
  // session with no OUTPUT for 15 min (last_output only advances on data) —
  // a watched-but-silent session (vim, `sleep 600`, a long quiet build) was
  // killed while the user was looking at it. terminal_select touches the
  // session's last_output.
  // PING EVERY OPEN LIVE SESSION (round-55): H3 (round-54) stopped the
  // drainer touching sessions on output — output activity no longer keeps a
  // session alive. This panel is a device-wide viewer: pollList adopts every
  // live session as a tab, so pinging only the active session reaped any
  // OTHER session the user was watching (a long build in tab B while tab A
  // was focused) after 15min of quiet. Closed/savedOnly tabs are skipped (a
  // dead session needs no keepalive). Do NOT mutate activeSid here
  // (round-53): the UI switch stays with the user (click) or the new-session
  // path.
  setInterval(() => {
    const live = [...sessions.values()].filter((x) => !x.closed && !x.savedOnly);
    for (const s of live) {
      callTool("terminal_select", { session_id: s.sid }).catch(() => {});
    }
  }, 30000);
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
    // Fit EVERY session — saved-only records (complete=true) were skipped,
    // so a [saved] terminal never reflowed on window resize and stayed at
    // its initial grid (the "half screen" issue for history tabs).
    if (s.term) {
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
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace',
    // Same reflow as live sessions: saved records render at the default
    // 80×24 in a hidden container; on activate the viewport grows and the
    // buffer must reflow to fill the whole screen (not half).
    reflowOnResize: true,
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
  if (rec.truncated) {
    s.term.write("\r\n[history truncated to the most recent lines — earlier output is in the live session only]\r\n");
  }
  return s;
}

saveBtn.addEventListener("click", saveConfig);
$("forget-creds").addEventListener("click", () => {
  // Clear the stale credentials and show the form again (401-loop escape).
  try { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_HOST); } catch {}
  token = ""; hostname = "";
  location.reload();
});
newSessionBtn.addEventListener("click", openSession);
exportAllBtn.addEventListener("click", exportAll);
$("empty-pty").addEventListener("click", openSession);
$("empty-ssh").addEventListener("click", () => showModal("ssh"));
$("empty-serial").addEventListener("click", () => showModal("serial"));

// Keyboard shortcuts: Ctrl/Cmd+N new PTY, Ctrl/Cmd+E export, Ctrl/Cmd+Shift+E
// export all, Ctrl/Cmd+1..9 switch tab, Esc close modal, Ctrl/Cmd+W close tab.
// Skip all Ctrl shortcuts while the session modal is open (typing in a field
// must never trigger a session action behind the dialog).
document.addEventListener("keydown", (e) => {
  const modalOpen = !$("conn-modal").classList.contains("hidden");
  if (modalOpen) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "n") { e.preventDefault(); openSession(); }
  else if (k === "e") { e.preventDefault(); if (e.shiftKey) exportAll(); else if (activeSid) exportSession(activeSid); }
  else if (k === "tab") {
    // Ctrl+Tab / Ctrl+Shift+Tab cycle through open tabs (round-56).
    e.preventDefault();
    const tabs = [...tabsEl.querySelectorAll(".tab")];
    if (!tabs.length) return;
    const idx = tabs.findIndex((t) => t.dataset.sid === activeSid);
    const next = e.shiftKey ? (idx <= 0 ? tabs.length - 1 : idx - 1) : (idx + 1) % tabs.length;
    activate(tabs[next].dataset.sid);
  }
  else if (/^[1-9]$/.test(k)) {
    const tabs = [...tabsEl.querySelectorAll(".tab")];
    const t = tabs[Number(k) - 1];
    if (t) activate(t.dataset.sid);
  } else if (k === "w" && activeSid) { e.preventDefault(); closeSession(activeSid); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideModal();
  // Enter in the modal submits — BUT only when the focus is in a text FIELD.
  // Enter on the Cancel/Connect button must let the button's own activation
  // handle it (preventDefault here swallowed Cancel's click and CONNECTED).
  else if (e.key === "Enter" && !$("conn-modal").classList.contains("hidden")
           && e.target && e.target.tagName === "INPUT") {
    e.preventDefault();
    if (!modalConnecting) connectModal();
  }
});

if (!loadConfig()) {
  setStatus("enter device hostname + token to connect");
}
