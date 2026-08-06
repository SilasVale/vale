// Terminal page — full-screen xterm for the paired device's terminal sessions.
//
// Transport (all through the gateway reverse proxy; the gateway injects the
// device Bearer server-side, so the page needs no token):
//   down: EventSource on /api/events/term  → TermOutput frames {session_id,
//         data:number[]} → xterm.write(new Uint8Array(data))
//   up:   POST /api/tools/terminal_write   → per keystroke
//         POST /api/tools/terminal_open    → new PTY session
//         POST /api/tools/terminal_list    → existing sessions (re-attach)
//         POST /api/tools/terminal_resize  → rows/cols after fit
//
// One session per tab: each session owns an xterm + EventSource (the device
// SSE stream carries every session, frames are filtered by session_id).
// EventSource reconnects automatically on drop.
import { loadPairing } from "../lib/state.js";

const DEFAULT_ORIGIN = "https://console.saisi.online";
const PTY_TARGET = "powershell"; // device runs Windows
const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 100;

const $ = (id) => document.getElementById(id);
const deviceSelect = $("device-select");
const tabsEl = $("tabs");
const termContainer = $("term-container");
const newSessionBtn = $("new-session");
const statusEl = $("status");

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

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

/** POST /api/tools/<name> through the proxy; returns the `result` field. */
async function callTool(name, body = {}) {
  const res = await fetch(`${proxy}/api/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

function renderTab(sid, label) {
  const tab = document.createElement("button");
  tab.className = "tab";
  tab.dataset.sid = sid;
  tab.textContent = label || sid;
  tab.title = sid;
  tab.addEventListener("click", () => activate(sid));
  tabsEl.appendChild(tab);
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
  requestAnimationFrame(() => {
    doResize(sid);
    try { s.term.focus(); } catch {}
  });
}

function attachStream(sid, term) {
  const es = new EventSource(`${proxy}/api/events/term`);
  es.onopen = () => {
    if (activeSid === sid && statusEl.textContent === "reconnecting…") setStatus("");
  };
  es.onerror = () => {
    // EventSource retries automatically; just surface the state for the
    // active session.
    if (activeSid === sid) setStatus("reconnecting…");
  };
  es.onmessage = (ev) => {
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    // One stream carries every session's output — keep only ours.
    // `{lagged:true}` frames have no session_id and are dropped here.
    if (frame.session_id !== sid) return;
    if (Array.isArray(frame.data)) term.write(new Uint8Array(frame.data));
  };
  return es;
}

/** Create the xterm + tab for a session and wire it to the device. */
function adoptSession(sid, label) {
  const container = document.createElement("div");
  container.className = "term-session";
  termContainer.appendChild(container);

  const term = new window.Terminal({
    convertEol: true,
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'monospace',
    theme: {
      background: "#0f1115",
      foreground: "#d6d8de",
      cursor: "#5b8cff",
      cursorAccent: "#0f1115",
      selectionBackground: "rgba(91,140,255,.25)",
    },
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

  const es = attachStream(sid, term);
  sessions.set(sid, { term, fit, es, container, observer, resizeTimer: null });
  renderTab(sid, label);
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
  // The pairing fixes one device; the select exists for future multi-device.
  const opt = document.createElement("option");
  opt.value = pairing.device;
  opt.textContent = pairing.device;
  deviceSelect.appendChild(opt);

  // Re-attach to sessions still alive on the device (e.g. after the page was
  // closed and reopened).
  let list;
  try {
    list = await callTool("terminal_list");
  } catch (e) {
    setStatus(String(e && e.message ? e.message : e), true);
    return;
  }
  const existing = Array.isArray(list) ? list : [];
  if (!existing.length) {
    await openSession("shell");
    return;
  }
  for (const s of existing) {
    adoptSession(s.id, s.label || s.kind || s.id);
  }
  // Activate the most recently opened session.
  activeSid = null;
  activate(existing[existing.length - 1].id);
}

newSessionBtn.addEventListener("click", () => openSession("shell"));

init();
