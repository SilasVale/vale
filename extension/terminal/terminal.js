// Terminal page — full-screen xterm for the paired device's terminal sessions.
//
// Transport (all through the gateway reverse proxy; the gateway injects the
// device Bearer server-side — the page only needs to authenticate TO the
// gateway with the plugin token it was paired with):
//   down: fetch-read SSE on /api/events/term → TermOutput frames {session_id,
//         data:number[]} → xterm.write(new Uint8Array(data))
//   up:   POST /api/tools/terminal_write   → per keystroke
//         POST /api/tools/terminal_open    → new PTY session
//         POST /api/tools/terminal_list    → existing sessions (re-attach)
//         POST /api/tools/terminal_resize  → rows/cols after fit
//
// One session per tab: each session owns an xterm + SSE reader (the device
// SSE stream carries every session, frames are filtered by session_id). The
// page is cross-site to the console (SameSite=Lax cookie never attaches), so
// every request carries `Authorization: Bearer <pluginToken>`. EventSource
// can't set headers — the SSE stream is read via fetch + ReadableStream and
// reconnects like EventSource would.
import { loadPairing } from "../lib/state.js";
import { idbPut, idbGet, idbGetAll, idbDelete } from "./idb.js";

const DEFAULT_ORIGIN = "https://api.saisi.online";
// Light xterm theme with the FULL ANSI palette — same as the agent panel's
// TERM_THEME. Without the 16 colors xterm falls back to dark Tango brights
// (bright green #8ae234 etc.) which are nearly invisible on white
// (1.2-1.6:1). Foreground uses the brand ink #1d1d1f, not #1a1c20.
const TERM_THEME = {
  background: "#ffffff",
  foreground: "#1d1d1f",
  cursor: "#0b7a6e",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(14,147,132,.2)",
  black: "#1d1d1f", red: "#b91c1c", green: "#166534", yellow: "#854d0e",
  blue: "#1d4ed8", magenta: "#7c3aed", cyan: "#0f766e", white: "#44403c",
  brightBlack: "#4b5563", brightRed: "#dc2626", brightGreen: "#15803d",
  brightYellow: "#a16207", brightBlue: "#2563eb", brightMagenta: "#9333ea",
  brightCyan: "#0f766e", brightWhite: "#6e6e73",
};
const PTY_TARGET = "powershell"; // device runs Windows
const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 100;
const POLL_MS = 2500; // discovery cadence for sessions opened by the AI agent
const SYNC_MS = 5000; // byte-offset sync cadence (missed-output recovery)
const HISTORY_POLL_MS = 10000; // closed-session discovery cadence
const FLUSH_LINE_THRESHOLD = 512; // lines before forcing an IndexedDB flush
const FLUSH_IDLE_MS = 60000; // max delay before an idle session is flushed

const $ = (id) => document.getElementById(id);
const deviceSelect = $("device-select");
const tabsEl = $("tabs");
const termContainer = $("term-container");
const newSessionBtn = $("new-session");
const exportAllBtn = $("export-all");
const statusEl = $("status");
const sessionCountEl = $("session-count");
const emptyStateEl = $("empty-state");
const toastEl = $("toast");

const pairing = await loadPairing();
const origin = String(((await chrome.storage.local.get("consoleOrigin")).consoleOrigin || DEFAULT_ORIGIN)).replace(/\/+$/, "");
if (!pairing) {
  statusEl.textContent = "Not paired — open the popup and pair first.";
  statusEl.classList.add("error");
  throw new Error("not paired");
}

const proxy = `${origin}/api/devices/${encodeURIComponent(pairing.device)}/proxy`;

// session_id → { term, fit, es, container, observer, resizeTimer }
const sessions = new Map();
let activeSid = null;
let lastKnown = new Set(); // sids present in the previous poll snapshot
let polling = false;       // re-entrancy guard: never stack polls

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

/** Transient feedback (round-54): same pattern as the console — the CSS
 *  animation handles slide-in/stay/fade; just re-trigger on repeat calls. */
function toast(msg) {
  toastEl.hidden = false;
  toastEl.textContent = msg;
  toastEl.style.animation = "none";
  void toastEl.offsetWidth; // restart the animation
  toastEl.style.animation = "";
  setTimeout(() => { toastEl.hidden = true; }, 3300);
}

/** Bottom-bar session count + empty-state card (round-54): the terminal
 *  page previously had neither — no way to see how many sessions exist at a
 *  glance, and a blank area with no affordance when every tab is closed. */
function updateChrome() {
  const live = [...sessions.values()].filter((s) => !s.savedOnly);
  sessionCountEl.textContent = live.length
    ? `${live.length} session${live.length === 1 ? "" : "s"}`
    : "";
  emptyStateEl.hidden = sessions.size !== 0;
}

/** POST /api/tools/<name> through the proxy; returns the `result` field. */
async function callTool(name, body = {}) {
  const res = await fetch(`${proxy}/api/tools/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pairing.token}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error("not paired / invalid token");
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${name}: ${j.error || "unknown error"}`);
  return j.result;
}

function scheduleResize(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  clearTimeout(s.resizeTimer);
  // Debounce: a window drag fires many observer callbacks; each POST is a
  // WAN round trip. Send at most one per 150ms.
  s.resizeTimer = setTimeout(() => doResize(sid), 150);
}

/** fit the xterm to its container, then tell the device the new size. */
async function doResize(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  try { s.fit.fit(); } catch {}
  callTool("terminal_resize", {
    session_id: sid,
    rows: s.term.rows || DEFAULT_ROWS,
    cols: s.term.cols || DEFAULT_COLS,
  }).catch(() => {});
}

// ── Export (timestamped session logs) ──────────────────────────

/** Local time → "YYYY-MM-DD HH:mm:ss" (seconds granularity). */
function fmtTs(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Trigger a .txt download. */
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

/** Header + timestamped lines for one session. */
function sessionLogText(s, sid) {
  const head = `=== session ${sid} (${s.kind || "?"}${s.label ? ", " + s.label : ""}) ` +
               `${s.openedAt ? fmtTs(s.openedAt) : "?"} → ${s.closedAt ? fmtTs(s.closedAt) : "open"} ===\n`;
  const body = s.lines.map((l) => `[${fmtTs(l.t)}] ${l.text}`).join("\n");
  return head + body + (body ? "\n" : "") + `=== end ${sid} ===\n`;
}

async function exportSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  if (!s.closed) {
    try { await syncSession(sid); } catch {} // freshest tail for live sessions
    try { await flushSession(s); } catch {}
  }
  const text = sessionLogText(s, sid);
  download(`vale-term-${sid}.txt`, text);
  toast("Session exported");
}

async function exportAll() {
  const parts = [];
  for (const [sid, s] of sessions) {
    if (!s.closed) {
      try { await syncSession(sid); } catch {}
      try { await flushSession(s); } catch {}
    }
    parts.push(sessionLogText(s, sid));
  }
  const stamp = fmtTs(Date.now()).replace(/[-: ]/g, "");
  download(`vale-terminal-log-${stamp}.txt`, parts.join("\n"));
  toast(`Exported ${sessions.size} session${sessions.size === 1 ? "" : "s"}`);
}

function renderTab(sid, label, kind) {
  const tab = document.createElement("button");
  tab.className = "tab";
  tab.dataset.sid = sid;
  tab.title = sid;
  tab.addEventListener("click", (e) => {
    if (e.target.closest(".tab-export")) { exportSession(sid); return; }
    if (e.target.closest(".tab-close")) { closeSession(sid); return; }
    activate(sid);
  });
  // Session-kind dot (round-54): teal = PTY, lane colors for ssh/serial —
  // same semantics as the panel's tab dots.
  const dot = document.createElement("span");
  dot.className = "tab-dot";
  if (kind) dot.dataset.kind = kind;
  tab.appendChild(dot);
  // Name is a child span so per-tab actions can update it without nuking
  // the dot/export/close children (markClosed previously overwrote
  // textContent and lost the structure).
  const name = document.createElement("span");
  name.className = "tab-name";
  name.textContent = label || sid;
  tab.appendChild(name);
  // Per-tab export icon (⤓) — visible on hover via CSS.
  const ex = document.createElement("span");
  ex.className = "tab-export";
  ex.textContent = "⤓";
  ex.title = "Export this session";
  tab.appendChild(ex);
  // Per-tab close (✕) — closes the session on the device and drops the tab.
  const cl = document.createElement("span");
  cl.className = "tab-close";
  cl.textContent = "✕";
  cl.title = "Close this session";
  tab.appendChild(cl);
  tabsEl.appendChild(tab);
  return tab;
}

/** Close a session on the device and drop its tab (round-54: the extension
 *  terminal previously had no close affordance at all — tabs only died when
 *  the device side closed them). The device close is best-effort: a session
 *  already dead on the device reports the error, but the tab still goes. */
async function closeSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  try {
    await callTool("terminal_close", { session_id: sid });
  } catch { /* already closed on the device — dropping the tab is enough */ }
  if (s.es) s.es.close();
  try { s.term.dispose(); } catch {}
  sessions.delete(sid);
  s.tab.remove();
  if (activeSid === sid) {
    const next = [...sessions.keys()].pop() || null;
    activeSid = null;
    if (next) activate(next);
  }
  updateChrome();
}

function highlightTabs() {
  for (const tab of tabsEl.children) {
    tab.classList.toggle("active", tab.dataset.sid === activeSid);
  }
}

function activate(sid) {
  const s = sessions.get(sid);
  if (!s || sid === activeSid) return;
  activeSid = sid;
  for (const [id, sess] of sessions) {
    sess.container.classList.toggle("active", id === sid);
  }
  highlightTabs();
  // Fit + resize after the container is visible (hidden containers measure 0).
  // Double-rAF: a single rAF can run before the browser has painted the
  // newly-shown container, so fit() measures 0 and the terminal stays at the
  // default 80x24 grid with blank space — the "half screen" bug the agent
  // panel fixed the same way (panel.js:389-394). Saved/history sessions have
  // no ResizeObserver (adoptHistorySession sets observer:null), so this is
  // their ONLY fit — it must be correct.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    doResize(sid);
    try { s.term.focus(); } catch {}
  }));
}

/**
 * Consume the device's SSE terminal stream. EventSource can't set request
 * headers, so read the stream with fetch + ReadableStream and authenticate to
 * the gateway with the plugin token in the Authorization header. Reconnects
 * like EventSource would (3s backoff), surfacing the state in the status line.
 */
// ONE shared SSE stream carries ALL sessions, dispatched by session_id —
// a per-session connection multiplied sockets for no benefit (the server
// broadcasts every frame to every subscriber; round-49: N sessions = N
// sockets each receiving all frames, N× uplink + CPU). attachStream(sid)
// just subscribes the session to the shared stream; a `close` marks the
// session closed so the shared dispatcher skips it.
let streamStarted = false;
function attachStream(sid) {
  if (!streamStarted) {
    streamStarted = true;
    startSharedStream();
  }
  return { close: () => { const s = sessions.get(sid); if (s) s.streamClosed = true; } };
}

async function startSharedStream() {
  const connect = async () => {
    // Streams UTF-8 bytes to text WITHOUT emitting replacement chars for
    // multi-byte chars split across frames (stream:true holds partial state).
    const lineDecoders = new Map(); // per-session persistent decoder
    try {
      const res = await fetch(`${proxy}/api/events/term`, {
        headers: { authorization: `Bearer ${pairing.token}` },
      });
      if (res.status === 401) {
        if (activeSid) setStatus("not paired / invalid token", true);
      } else if (!res.ok) {
        if (activeSid) setStatus(`stream error ${res.status}`, true);
      } else {
        if (activeSid && statusEl.textContent === "reconnecting…") setStatus("");
      }
      if (!res.ok || !res.body) {
        setTimeout(connect, 3000);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE events are separated by blank lines; a data line may be split
          // across read chunks, so only consume complete events.
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            let frame;
            try { frame = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
            // Dispatch to every live session. `{lagged:true}` frames have no
            // session_id → every session needs a sync to recover the gap.
            if (!frame.session_id) {
              for (const s of sessions.values()) if (!s.closed) s.needSync = true;
              continue;
            }
            const s = sessions.get(frame.session_id);
            if (!s || s.closed || s.streamClosed || !s.term) continue;
            if (Array.isArray(frame.data)) {
              s.term.write(new Uint8Array(frame.data));
              s.renderedBytes += frame.data.length; // absolute byte coverage
              s.sseDirty = true;
              // Persistent per-session decoder: a fresh TextDecoder per frame
              // destroyed multi-byte UTF-8 split across frame boundaries.
              if (!lineDecoders.has(frame.session_id)) lineDecoders.set(frame.session_id, new TextDecoder());
              ingestLines(s, lineDecoders.get(frame.session_id).decode(new Uint8Array(frame.data), { stream: true }));
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      for (const s of sessions.values()) if (!s.closed) s.needSync = true;
    }
    // Stream dropped or rejected → reconnect, matching EventSource behavior.
    setTimeout(connect, 3000);
  };
  connect();
}

/** Create the xterm + tab for a session and wire it to the device.
 *  Idempotent: re-adopting a live session is a no-op; re-adopting a closed
 *  one (vale-agent restarted and reused term-N) resurrects the tab. */
function adoptSession(sid, label, idbRec = null) {
  const existing = sessions.get(sid);
  if (existing && !existing.closed) return; // dedup — never duplicate tabs
  if (existing) {
    // Resurrection: vale-agent restarted and reused term-N. Reuse the tab
    // and xterm rather than hiding the new session behind the tombstone.
    existing.closed = false;
    existing.complete = false;
    existing.closedAt = null;
    existing.savedOnly = false;
    if (existing.tab) {
      existing.tab.classList.remove("closed");
      existing.tab.textContent = label;
      existing.tab.title = sid;
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
    theme: TERM_THEME,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);

  // Keystrokes up: POST terminal_write. The xterm only receives input while
  // focused, so writes are naturally scoped to this session.
  term.onData((data) => {
    callTool("terminal_write", { session_id: sid, data }).catch(() => {});
  });

  const observer = new ResizeObserver(() => scheduleResize(sid));
  observer.observe(container);

  const s = {
    sid, term, fit, es: null, container, observer, resizeTimer: null,
    tab: null, closed: false, streamClosed: false, label,
    // Byte-offset sync model: `renderedBytes` is the single source of truth
    // for "how much of this session's byte stream has been written to the
    // xterm". It only ever advances by raw spans — SSE frame.data.length and
    // terminal_read's `end` — never by clean-text length.
    renderedBytes: 0,
    lines: [],        // [{t: ms, text}] receipt-timestamped clean lines
    pendingLine: "",
    persistedSeq: 0,  // s.lines.length at last IndexedDB flush
    openedAt: Date.now(),
    closedAt: null,
    complete: false,
    savedOnly: false,
    kind,
    syncInFlight: false,
    sseDirty: false,
    needSync: false,
    flushTimer: null,
  };
  sessions.set(sid, s); // before any await — activate() and the poll guard see it immediately
  s.tab = renderTab(sid, label, s.kind);
  callTool("terminal_diag_write", { line: `adopt: ${sid} (${s.kind}:${label})` }).catch(() => {});
  updateChrome();
  backfillAndAttach(sid, s, null);
}

/** History backfill, then live SSE attach — in that order, so old output
 *  never renders below new output. If `idbRec` (an IndexedDB record) is given,
 *  its persisted lines render first (restored from a previous panel session),
 *  then the backend tail is fetched from `renderedBytes` — no double render.
 *  The read uses an explicit offset so the AI agent's cursor is untouched. */
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
    const hist = await callTool("terminal_read", { session_id: sid, offset: s.renderedBytes, clean: true });
    if (hist && typeof hist.text === "string") {
      if (Number(hist.start) > s.renderedBytes) {
        s.term.write(`\r\n[dropped ${Number(hist.start) - s.renderedBytes} bytes of output — missed while offline]\r\n`);
      }
      if (hist.text) {
        s.term.write(hist.text);
        s.renderedBytes = Number(hist.end) || s.renderedBytes;
        ingestLines(s, hist.text);
        scheduleFlush(s);
      }
    }
  } catch {
    // No history (brand-new session, or buffer already released) — attach live.
  }
  if (!s.closed) s.es = attachStream(sid);
}

/** Render the session's accumulated `lines` into the xterm (IDB restore /
 *  resurrection). Newlines are appended because lines are stored split. */
function renderLines(s) {
  for (const l of s.lines) {
    s.term.write(`${l.text}\r\n`);
  }
}

/** A session vanished from terminal_list (closed on the device). Keep the tab
 *  as a visible tombstone: greyed, "[closed]" suffix, input disabled, SSE
 *  reconnect loop stopped. */
function markClosed(sid) {
  const s = sessions.get(sid);
  if (!s || s.closed) return;
  s.closed = true;
  if (s.es) s.es.close(); // stop the 3s reconnect loop
  s.term.options.disableStdin = true; // typing into a dead session is pointless
  if (s.tab) {
    s.tab.classList.add("closed");
    const name = s.tab.querySelector(".tab-name");
    if (name) name.textContent = `${s.label || sid} [closed]`;
    s.tab.title = `${sid} (closed on device)`;
  }
  if (sid === activeSid) setStatus("session closed");
  updateChrome();
}

// ── Line ingestion + IndexedDB flush ────────────────────────────

/** Split text into clean lines with receipt timestamps, merging a trailing
 *  partial line into `pendingLine` (it completes when the next chunk ends in
 *  a newline). Receipt time is the panel's local clock — the accepted
 *  approximation (backend-precise timestamps are a non-goal). */
function ingestLines(s, text) {
  if (!text) return;
  const chunks = text.split("\n");
  for (let i = 0; i < chunks.length; i++) {
    let line = chunks[i];
    if (i === 0 && s.pendingLine !== "") {
      line = s.pendingLine + line;
      s.pendingLine = "";
    }
    if (i < chunks.length - 1) {
      // Skip empty lines (terminal blank lines carry no log value and would
      // bloat the export with bare `[]` timestamps).
      if (line !== "") s.lines.push({ t: Date.now(), text: line });
    } else if (line !== "") {
      s.pendingLine = line; // partial — wait for the rest
    }
  }
  scheduleFlush(s);
}

function scheduleFlush(s) {
  clearTimeout(s.flushTimer);
  if (s.lines.length - s.persistedSeq >= FLUSH_LINE_THRESHOLD) {
    flushSession(s);
    return;
  }
  s.flushTimer = setTimeout(() => flushSession(s), FLUSH_IDLE_MS);
}

async function flushSession(s) {
  clearTimeout(s.flushTimer);
  if (s.flushTimer !== undefined) s.flushTimer = null;
  if (s.persistedSeq === s.lines.length) return; // nothing new
  try {
    await idbPut({
      sid: s.sid,
      kind: s.kind || "",
      label: s.label || "",
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      complete: s.complete,
      endAbs: s.renderedBytes,
      persistedSeq: s.lines.length,
      lines: s.lines,
    });
    s.persistedSeq = s.lines.length;
  } catch { /* IDB unavailable — memory-only mode is fine */ }
}

// ── Byte-offset sync (missed-output recovery) ──────────────────

/** Fetch ONLY the output the panel hasn't rendered yet (from `renderedBytes`)
 *  and append it. Runs on a cadence + when SSE was lagged/dropped. */
async function syncSession(sid) {
  const s = sessions.get(sid);
  if (!s || s.closed || s.savedOnly || s.syncInFlight) return;
  if (!s.needSync && !s.sseDirty) return; // nothing new since last sync
  s.syncInFlight = true;
  try {
    const r = await callTool("terminal_read", { session_id: sid, offset: s.renderedBytes, clean: true });
    if (r && typeof r.text === "string" && r.text) {
      if (Number(r.start) > s.renderedBytes) {
        s.term.write(`\r\n[dropped ${Number(r.start) - s.renderedBytes} bytes of output — missed while offline]\r\n`);
      }
      s.term.write(r.text);
      s.renderedBytes = Number(r.end) || s.renderedBytes;
      ingestLines(s, r.text);
      scheduleFlush(s);
    }
    s.needSync = false;
    s.sseDirty = false;
  } catch {
    s.needSync = true; // network blip → retry next cycle
  } finally {
    s.syncInFlight = false;
  }
}

async function syncAll() {
  for (const sid of [...sessions.keys()]) {
    await syncSession(sid);
  }
}

/** Session vanished from terminal_list — final tail read, persist, mark closed. */
async function finalizeSession(sid) {
  const s = sessions.get(sid);
  if (!s || s.closed || s.savedOnly) return;
  try { await syncSession(sid); } catch {} // final tail — works post-close via history
  s.closedAt = Date.now();
  s.complete = true;
  markClosed(sid); // updates tab styling; sets s.closed = true
  try { await flushSession(s); } catch {}
}

/** Discover closed sessions retained in history (adopt as read-only [saved]
 *  tabs so the panel can load a session closed before it opened). */
async function pollHistory() {
  try {
    const list = await callTool("terminal_history").catch(() => null);
    if (!Array.isArray(list)) return;
    for (const h of list) {
      if (h.status !== "closed") continue; // live handled by pollSessions
      if (sessions.has(h.id)) continue;
      const idbRec = await idbGet(h.id).catch(() => null);
      adoptHistorySession(h, idbRec);
    }
  } finally {
    setTimeout(pollHistory, HISTORY_POLL_MS);
  }
}

/** Adopt a closed session as a read-only tab: IDB lines (if any) + backend tail. */
async function adoptHistorySession(h, idbRec) {
  const container = document.createElement("div");
  container.className = "term-session";
  termContainer.appendChild(container);

  const term = new window.Terminal({
    convertEol: true,
    cursorBlink: false,
    disableStdin: true,
    scrollback: 20000,
    fontSize: 13,
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace',
    theme: TERM_THEME,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);

  const s = {
    sid: h.id, term, fit, es: null, container, observer: null, resizeTimer: null,
    tab: null, closed: true, streamClosed: true, savedOnly: true,
    renderedBytes: 0, lines: [], pendingLine: "", persistedSeq: 0,
    openedAt: idbRec?.openedAt || Date.now(), closedAt: idbRec?.closedAt || Date.now(),
    complete: true, kind: h.kind || "", label: h.label || h.id,
    syncInFlight: false, sseDirty: false, needSync: false, flushTimer: null,
  };
  sessions.set(h.id, s); // before any await
  s.tab = renderTab(h.id, `${s.label} [saved]`, h.kind);
  s.tab.classList.add("closed");
  await backfillAndAttach(h.id, s, idbRec);
}

/** Discover sessions the AI agent opened (or closed) on the device. Silent on
 *  errors — next tick retries. Stale-marking only applies to sids that were in
 *  the PREVIOUS snapshot, so a session created while a poll was in flight is
 *  never wrongly marked closed. */
async function pollSessions() {
  if (polling) return;
  polling = true;
  try {
    const list = await callTool("terminal_list").catch((e) => {
      console.error("[vale-term] terminal_list failed:", e);
      callTool("terminal_diag_write", { line: `poll ERROR: ${String(e && e.message || e)}` }).catch(() => {});
      return null;
    });
    console.log("[vale-term] poll terminal_list:", list ? list.map(s => `${s.id}(${s.kind}:${s.label})`) : "NULL/FAILED");
    if (!Array.isArray(list)) return; // network blip → silent retry
    callTool("terminal_diag_write", {
      line: `poll ok: ${list.map(s => `${s.id}(${s.kind})`).join(",") || "(empty)"} | sessions=${[...sessions.keys()].join(",") || "(none)"}`,
    }).catch(() => {});
    const current = new Set();
    // Fetch saved records in parallel — a serial await per session would stall
    // the poll on slow IDB.
    const recs = await Promise.all(
      list.map((s) => idbGet(s.id).catch(() => null))
    );
    list.forEach((s, i) => {
      current.add(s.id);
      // idempotent — no pre-check needed. Pass the saved record if any, so a
      // session that was saved then reopened continues its old log.
      adoptSession(s.id, s.label || s.kind || s.id, recs[i]);
    });
    for (const sid of lastKnown) {
      if (!current.has(sid)) {
        finalizeSession(sid); // tail read + persist + mark closed (fire-and-forget)
      }
    }
    lastKnown = current;
  } finally {
    polling = false;
    setTimeout(pollSessions, POLL_MS);
  }
}

/** Open a new PTY on the device and attach a tab to it. */
async function openSession(label) {
  setStatus("Opening PTY…");
  let sid;
  try {
    sid = await callTool("terminal_open", {
      kind: "pty",
      target: PTY_TARGET,
      rows: DEFAULT_ROWS,
      cols: DEFAULT_COLS,
    });
  } catch (e) {
    setStatus(String(e && e.message ? e.message : e), true);
    return null;
  }
  if (typeof sid !== "string" || !sid) {
    setStatus("terminal_open returned no session id", true);
    return null;
  }
  adoptSession(sid, label || "shell");
  activeSid = null; // force activate
  activate(sid);
  setStatus("");
  return sid;
}

async function init() {
  // Client-liveness heartbeat FIRST (round-51/52): the agent's idle sweeper
  // force-closes any session with no OUTPUT for 15 min. Installed at the top
  // so the late-return paths (no live sessions, no saved) can't skip it —
  // a session auto-opened by the empty-state path would otherwise die
  // unwatched. Pings EVERY open live session (round-55): H3 (round-54)
  // stopped the drainer touching sessions on output, so pinging only the
  // active session reaped any other session the user was watching (a long
  // build in tab B while tab A was focused) after 15min of quiet. This
  // terminal is a device-level viewer: every live session has a tab. Skips
  // closed/savedOnly (a dead session needs no keepalive); never mutates
  // activeSid (round-53).
  setInterval(() => {
    const live = [...sessions.values()].filter((x) => !x.closed && !x.savedOnly);
    for (const s of live) {
      callTool("terminal_select", { session_id: s.sid }).catch(() => {});
    }
  }, 30000);

  // The pairing fixes one device; the select exists for future multi-device.
  const opt = document.createElement("option");
  opt.value = pairing.device;
  opt.textContent = pairing.device;
  deviceSelect.appendChild(opt);

  // Restore previously saved sessions from IndexedDB (read-only [saved] tabs),
  // then re-attach to live sessions on the device. A live session with the
  // same sid as a saved one resurrects it (the adoptSession dedup is a no-op
  // for live; savedOnly entries are replaced by the live adoption).
  const saved = await idbGetAll().catch(() => []);
  pruneIdb(saved);
  for (const rec of saved) {
    if (sessions.has(rec.sid)) continue;
    await adoptHistorySession({ id: rec.sid, kind: rec.kind || "", label: rec.label || "" }, rec);
  }

  let list;
  try {
    list = await callTool("terminal_list");
  } catch (e) {
    setStatus(String(e && e.message ? e.message : e), true);
    return;
  }
  const existing = Array.isArray(list) ? list : [];
  if (!existing.length) {
    // Only auto-open a shell if there are no saved sessions to show.
    if (!saved.length) await openSession("shell");
    return;
  }
  for (const s of existing) {
    // If a saved record exists for this sid, pass it to backfill so the live
    // adoption continues the old log instead of starting from scratch.
    const idbRec = saved.find((r) => r.sid === s.id) || null;
    adoptSession(s.id, s.label || s.kind || s.id, idbRec);
  }
  // Activate the most recently opened session (or the first saved tab).
  const last = existing[existing.length - 1]?.id || [...sessions.keys()][0];
  activeSid = null;
  activate(last);
}

/** Bound the IndexedDB store: drop the oldest-closed records beyond caps. */
function pruneIdb(records) {
  const MAX_RECORDS = 40;
  const MAX_LINES = 300000;
  const sorted = records.slice().sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  const dropped = [];
  let lines = sorted.reduce((n, r) => n + (r.lines?.length || 0), 0);
  while (sorted.length - dropped.length > MAX_RECORDS || lines > MAX_LINES) {
    const rec = sorted[dropped.length];
    if (!rec) break;
    dropped.push(rec.sid);
    lines -= rec.lines?.length || 0;
  }
  for (const sid of dropped) idbDelete(sid).catch(() => {});
}

newSessionBtn.addEventListener("click", () => openSession("shell"));
exportAllBtn.addEventListener("click", () => exportAll());
$("empty-new").addEventListener("click", () => openSession("shell"));

init();
// Start discovery after init's adopt pass; the dedup guard in adoptSession
// covers any overlap between init's terminal_list and the first poll.
setTimeout(pollSessions, POLL_MS);
setTimeout(pollHistory, HISTORY_POLL_MS); // closed sessions retained in history
// Byte-offset sync loop: recovers SSE gaps (lagged frames, reconnects,
// pre-attach output). setTimeout-chained, never stacked.
(function syncLoop() {
  setTimeout(async () => {
    await syncAll();
    syncLoop();
  }, SYNC_MS);
})();
// Flush everything to IndexedDB when the tab goes hidden / unloads — a crash
// can lose at most the lines since the last snapshot (≤ FLUSH_IDLE_MS of output).
// Debounced refit of all sessions — shared by visibilitychange + resize.
let refitTimer = null;
function refitAll() {
  for (const [sid, s] of sessions) {
    if (s.term) { try { s.fit.fit(); } catch {} }
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    for (const s of sessions.values()) flushSession(s);
  } else {
    // Returning to the tab: the container may have been resized or the layout
    // reflowed while hidden — refit every session so xterm fills the window.
    clearTimeout(refitTimer);
    refitTimer = setTimeout(refitAll, 200);
  }
});
window.addEventListener("pagehide", () => {
  for (const s of sessions.values()) flushSession(s);
});
// Window resize (browser zoom, maximized toggle): debounce and refit all
// sessions — otherwise a saved/history session (no ResizeObserver) keeps its
// old cell grid and leaves white space or clips content (panel.js refitAll).
window.addEventListener("resize", () => {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(refitAll, 150);
});
