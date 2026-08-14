// WS client for the gateway PluginHubDO — one socket per device, ping every
// 20s, exponential backoff reconnect. Frames: {type: "hello"|"ping"|"pong"|
// "request"|"response", ...} — see gateway/src/plugin-hub.js.
import { state, loadPairing, setStateError } from "./state.js";

let ws = null;
let backoffMs = 1000;
let heartbeat = null;
let requestSeq = 0;
let connecting = false; // single-flight: no parallel reconnect chains
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
  // Single-flight: the keepalive alarm + every failure path call connect();
  // without this guard they spawned parallel reconnect chains and duplicate
  // sockets (the hub replaces the old socket, whose onclose then schedules
  // ANOTHER connect — unbounded churn).
  if (connecting) return;
  connecting = true;
  try {
    await connectInner();
  } finally {
    connecting = false;
  }
}

async function connectInner() {
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
    // ALSO stop the heartbeat — the old socket's onclose is a no-op (ws
    // already nulled), so its interval was never cleared (leak per reconnect).
    stopHeartbeat();
    ws = null;
  }
  const consoleOrigin = (await chrome.storage.local.get("consoleOrigin")).consoleOrigin || "https://api.saisi.online";
  // Defensive: never send the plugin token over plaintext HTTP or to a
  // non-origin value (a typo'd/spoofed consoleOrigin would exfiltrate it).
  let originOk = false;
  try { originOk = new URL(consoleOrigin).protocol === "https:"; } catch {}
  if (!originOk) {
    setStateError("consoleOrigin must be https:// — refusing to send the token");
    scheduleReconnect();
    return;
  }
  let ticket;
  try {
    // Trade the plugin token for a one-time WS ticket.
    // round-112: a blackholed network hung this fetch forever, blocking the
    // whole reconnect chain behind the single-flight flag. Bound it.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch(`${consoleOrigin}/api/plugins/ws-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${pairing.token}` },
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
    const j = await res.json().catch(() => ({}));
    if (!state.pairedDevice) return; // unpaired while fetching the ticket
    if (!j.ticket) {
      setStateError(`ws-ticket failed (${res.status}${j.error ? ": " + j.error : ""})`);
      scheduleReconnect();
      return;
    }
    ticket = j.ticket;
  } catch (e) {
    if (!state.pairedDevice) return; // unpaired while fetching the ticket
    // Do NOT overwrite a pending revoke-failure: the reconnect storm after a
    // network drop would otherwise replace "revoke failed — unpair not
    // completed" with "Failed to fetch" within seconds, and onopen would
    // then clear it (its guard only preserves /revoke failed/i) — the user
    // loses the one message that says the old credential is still live.
    setStateError(String(e));
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
      // Do NOT unconditionally clear state.error — a pending revoke-failure
      // ("revoke failed — unpair not completed") must survive a reconnect
      // when the network recovers (the popup shows it via the 2s refresh);
      // clearing it here would wipe the message exactly when the user needs
      // it. Only connection errors clear it (set on the failure path).
      setStateError(null);
      // round-88: carry the plugin token so the hub's alarm can re-validate
      // the link (30-day TTL) on the LIVE socket.
      wsSend({ type: "hello", device: pairing.device, token: pairing.token });
      startHeartbeat();
    };
    sock.onmessage = (ev) => {
      try { handleFrame(JSON.parse(ev.data)); } catch {}
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return; // stale socket replaced by a newer connect()
      ws = null;
      state.wsState = "disconnected";
      stopHeartbeat();
      console.error(`[vale-ext] WS closed: code=${ev?.code} reason=${ev?.reason} wasClean=${ev?.wasClean}`);
      scheduleReconnect();
    };
    sock.onerror = (ev) => {
      console.error("[vale-ext] WS error:", ev?.error || ev?.message || ev, "url:", url);
      try { sock.close(); } catch {}
    };
  } catch (e) {
    setStateError(String(e));
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
  if (frame.type === "pong") { lastPong = Date.now(); return; }
  if (frame.type === "request") {
    handleToolRequest(frame).then((result) => wsSend({ id: frame.id, type: "response", ok: true, result }))
      .catch((err) => wsSend({ id: frame.id, type: "response", ok: false, error: String(err?.message || err) }));
    return;
  }
  // round-97: callPlugin (extension → hub request) sends {type:"request"}
  // and awaits the hub's {type:"response"} frame — this branch was missing,
  // so every callPlugin timed out at 65s. Resolve the pending promise.
  if (frame.type === "response" && frame.id && pending.has(frame.id)) {
    const { resolve } = pending.get(frame.id);
    pending.delete(frame.id);
    resolve(frame);
  }
}
// round-84: dead-peer detection — a half-open TCP path (WiFi drop, laptop
// sleep, firewall DROP) never fires onclose, so the old code pings into the
// void forever with wsState stuck 'connected' and no reconnect ever. Track
// the last pong; if the hub stops answering for 60s (3 missed pings), force
// a close so the reconnect path runs.
let lastPong = 0;
function startHeartbeat() {
  lastPong = Date.now();
  heartbeat = setInterval(() => {
    wsSend({ type: "ping", t: Date.now() });
    if (Date.now() - lastPong > 60_000) {
      const sock = ws;
      try { sock && sock.close(4000, "pong timeout"); } catch {}
    }
  }, 20_000);
}
function stopHeartbeat() { if (heartbeat) clearInterval(heartbeat); heartbeat = null; }
function scheduleReconnect() {
  setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30_000) + Math.floor(Math.random() * 1000);
}

// Dispatch a request frame to the tools layer (defined in background.js).
let handler = null;
export function setRequestHandler(fn) { handler = fn; }
async function handleToolRequest(frame) { if (!handler) throw new Error("no handler"); return handler(frame.tool, frame.params); }
