/**
 * PluginHubDO — per-device WebSocket hub for the browser extension.
 * One DO instance per device name (idFromName). Uses WebSocket Hibernation:
 * the DO sleeps between messages; `acceptWebSocket` + `webSocketMessage` keep
 * the connection alive across hibernate cycles. Dead-peer detection uses a
 * storage alarm (timers don't run while hibernating): the extension pings
 * every 20s; the alarm fires 65s after the last message and closes a stale WS.
 */
export class PluginHubDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.device = state.id?.name || "unknown";
    this.pending = new Map(); // requestId → {resolve, timeout}
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return this.handleWs(request, url);
    }
    if (url.pathname === "/call") {
      const { tool, params, requestId } = await request.json();
      return this.callPlugin(tool, params, requestId);
    }
    if (url.pathname === "/status") {
      const sockets = this.state.getWebSockets?.() || [];
      return Response.json({ online: sockets.length > 0 });
    }
    return new Response("not found", { status: 404 });
  }

  async handleWs(request, url) {
    const device = url.searchParams.get("device");
    if (device !== this.device) return new Response("wrong DO", { status: 400 });
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    // Single-connection semantics: close any previous socket for this device.
    for (const ws of this.state.getWebSockets()) {
      if (ws !== pair[1]) ws.close(4000, "replaced");
    }
    this.state.storage.setAlarm(Date.now() + 65_000);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async callPlugin(tool, params, requestId) {
    const sockets = this.state.getWebSockets() || [];
    if (sockets.length === 0) {
      return Response.json({ error: "extension_offline" }, { status: 503 });
    }
    const ws = sockets[0];
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId); // late responses must not leak the entry
        resolve({ error: "timeout" });
      }, 60_000);
      this.pending.set(requestId, (msg) => { clearTimeout(timeout); resolve(msg); });
      ws.send(JSON.stringify({ id: requestId, type: "request", tool, params }));
    });
    return Response.json(result);
  }

  async webSocketMessage(ws, message) {
    this.state.storage.setAlarm(Date.now() + 65_000);
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
    if (msg.type === "hello") { this.state.storage.put("lastSeen", Date.now()); return; }
    if (msg.type === "response" && msg.id) {
      const resolve = this.pending.get(msg.id);
      if (resolve) { this.pending.delete(msg.id); resolve(msg); }
    }
  }

  async webSocketClose(ws, code, reason) {
    // Reject all in-flight calls so /call returns a clear error, not a hang.
    const err = { error: "extension_disconnected" };
    for (const [id, resolve] of this.pending) { resolve(err); this.pending.delete(id); }
  }

  async alarm() {
    const sockets = this.state.getWebSockets() || [];
    for (const ws of sockets) ws.close(4001, "idle timeout");
  }
}
