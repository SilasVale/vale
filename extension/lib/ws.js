// WS client for the gateway PluginHubDO — one socket per device, ping every
// 20s, exponential backoff reconnect. Frames: {type: "hello"|"ping"|"pong"|
// "request"|"response", ...} — see gateway/src/plugin-hub.js.
import { state, loadPairing } from "./state.js";

let ws = null;
let backoffMs = 1000;
let heartbeat = null;
let requestSeq = 0;
const pending = new Map(); // id → {resolve, reject}

export function wsSend(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// Direct extension → gateway tool call (reserved; the primary path is
// gateway → extension requests via the hub). Kept for parity with /call.
export function callPlugin(tool, params) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${requestSeq++}`;
    pending.set(id, { resolve, reject });
    wsSend({ id, type: "request", tool, params });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("gateway timeout"));
      }
    }, 65_000);
  });
}

export async function connect() {
  const pairing = state.pairedDevice || (await loadPairing());
  if (!pairing) return;
  // Close any existing socket first — the hub has single-connection semantics
  // and replaces an old socket anyway; closing it here avoids a reconnect
  // churn (the replaced socket's onclose would otherwise schedule another
  // connect that replaces this one, forever).
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
    try { ws.close(1000, "reconnect"); } catch {}
    // Mark it stale right away: while we await the ticket fetch below, `ws`
    // must not still point at the closing socket, or its onclose would see
    // `ws === sock` and schedule a spurious reconnect + duplicate fetch.
    ws = null;
  }
  const consoleOrigin = (await chrome.storage.local.get("consoleOrigin")).consoleOrigin || "https://ai.saisi.online";
  let ticket;
  try {
    // Trade the plugin token for a one-time WS ticket.
    const res = await fetch(`${consoleOrigin}/api/plugins/ws-ticket`, { headers: { Authorization: `Bearer ${pairing.token}` } });
    const j = await res.json().catch(() => ({}));
    if (!state.pairedDevice) return; // unpaired while fetching the ticket
    if (!j.ticket) {
      state.error = `ws-ticket failed (${res.status}${j.error ? ": " + j.error : ""})`;
      scheduleReconnect();
      return;
    }
    ticket = j.ticket;
  } catch (e) {
    if (!state.pairedDevice) return; // unpaired while fetching the ticket
    state.error = String(e);
    scheduleReconnect();
    return;
  }
  try {
    const url = `wss://${new URL(consoleOrigin).host}/api/plugins/ws?device=${encodeURIComponent(pairing.device)}&ticket=${encodeURIComponent(ticket)}`;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) { try { sock.close(); } catch {} return; } // replaced while connecting
      if (!state.pairedDevice) { try { sock.close(); } catch {} return; } // unpaired while connecting
      backoffMs = 1000;
      state.wsState = "connected";
      state.error = null;
      wsSend({ type: "hello", device: pairing.device });
      startHeartbeat();
    };
    sock.onmessage = (ev) => {
      try { handleFrame(JSON.parse(ev.data)); } catch {}
    };
    sock.onclose = () => {
      if (ws !== sock) return; // stale socket replaced by a newer connect()
      ws = null;
      state.wsState = "disconnected";
      stopHeartbeat();
      scheduleReconnect();
    };
    sock.onerror = () => { try { sock.close(); } catch {} };
  } catch (e) {
    state.error = String(e);
    scheduleReconnect();
  }
}

// Close the socket for good (unpair): no reconnect until the next connect().
export function disconnect() {
  stopHeartbeat();
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
    try { ws.close(1000, "unpair"); } catch {}
  }
  ws = null;
  state.wsState = "disconnected";
}

function handleFrame(frame) {
  if (frame.type === "pong") return;
  if (frame.type === "request") {
    handleToolRequest(frame).then((result) => wsSend({ id: frame.id, type: "response", ok: true, result }))
      .catch((err) => wsSend({ id: frame.id, type: "response", ok: false, error: String(err?.message || err) }));
  }
}
function startHeartbeat() { heartbeat = setInterval(() => wsSend({ type: "ping", t: Date.now() }), 20_000); }
function stopHeartbeat() { if (heartbeat) clearInterval(heartbeat); heartbeat = null; }
function scheduleReconnect() {
  setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30_000) + Math.floor(Math.random() * 1000);
}

// Dispatch a request frame to the tools layer (defined in background.js).
let handler = null;
export function setRequestHandler(fn) { handler = fn; }
async function handleToolRequest(frame) { if (!handler) throw new Error("no handler"); return handler(frame.tool, frame.params); }
