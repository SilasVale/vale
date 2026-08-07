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

const DEFAULT_ORIGIN = "https://api.saisi.online";
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

/**
 * Consume the device's SSE terminal stream. EventSource can't set request
 * headers, so read the stream with fetch + ReadableStream and authenticate to
 * the gateway with the plugin token in the Authorization header. Reconnects
 * like EventSource would (3s backoff), surfacing the state in the status line.
 */
function attachStream(sid, term) {
  let closed = false;

  const connect = async () => {
    if (closed) return;
    try {
      const res = await fetch(`${proxy}/api/events/term`, {
        headers: { authorization: `Bearer ${pairing.token}` },
      });
      if (res.status === 401) {
        if (activeSid === sid) setStatus("not paired / invalid token", true);
      } else if (!res.ok) {
        if (activeSid === sid) setStatus(`stream error ${res.status}`, true);
      } else {
        if (activeSid === sid && statusEl.textContent === "reconnecting…") setStatus("");
      }
      if (!res.ok || !res.body) {
        setTimeout(connect, 3000);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!closed) {
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
            // One stream carries every session's output — keep only ours.
            // `{lagged:true}` frames have no session_id and are dropped here.
            if (frame.session_id !== sid) continue;
            if (Array.isArray(frame.data)) term.write(new Uint8Array(frame.data));
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      if (activeSid === sid) setStatus("reconnecting…");
    }
    // Stream dropped or rejected → reconnect, matching EventSource behavior.
    setTimeout(connect, 3000);
  };

  connect();
  return { close: () => { closed = true; } };
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
      background: "#ffffff",
      foreground: "#1a1c20",
      cursor: "#5b6cf0",
      cursorAccent: "#ffffff",
      selectionBackground: "rgba(91,108,240,.2)",
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
