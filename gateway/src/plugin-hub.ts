/**
 * PluginHubDO — per-device WebSocket hub for the browser extension.
 * One DO instance per device name (idFromName). Uses WebSocket Hibernation:
 * the DO sleeps between messages; `acceptWebSocket` + `webSocketMessage` keep
 * the connection alive across hibernate cycles. Dead-peer detection uses a
 * storage alarm (timers don't run while hibernating): the extension pings
 * every 20s; the alarm fires 65s after the last message and closes a stale WS.
 */
import { getPluginByToken } from "./store.ts";

export class PluginHubDO {
  state: DurableObjectState;
  env: any;
  device: string;
  pending: Map<string, (msg: any) => void>;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    this.device = state.id?.name || "unknown";
    this.pending = new Map(); // requestId → {resolve, timeout}
  }

  /**
   * Internal auth: the main worker forwards with a shared secret header
   * (env.DO_AUTH). A Durable Object has its own external address even with
   * workers_dev:false, so the pairing/ticket checks in the main worker's
   * router are NOT sufficient — anyone addressing this DO directly could
   * drive browser_* tools without a pairing code.
   */
  authorized(request: Request) {
    const expected = this.env.DO_AUTH || "";
    if (!expected) return true; // unconfigured: match legacy behavior
    const got = request.headers.get("x-do-auth") || "";
    if (got.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0; // constant-time compare
  }

  async fetch(request: Request) {
    if (!this.authorized(request)) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return this.handleWs(request, url);
    }
    if (url.pathname === "/call") {
      const { tool, params, requestId } = await request.json() as { tool?: string; params?: any; requestId?: string };
      return this.callPlugin(tool || "", params, requestId || "");
    }
    if (url.pathname === "/close-all") {
      // round-84: the main worker calls this when a plugin link is revoked —
      // close every live WS so a revoked link cannot keep browser_* control.
      const sockets = this.state.getWebSockets() || [];
      for (const ws of sockets) ws.close(4001, "revoked");
      return Response.json({ ok: true, closed: sockets.length });
    }
    if (url.pathname === "/status") {
      const sockets = this.state.getWebSockets?.() || [];
      return Response.json({ online: sockets.length > 0 });
    }
    return new Response("not found", { status: 404 });
  }

  async handleWs(request: Request, url: URL) {
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

  async callPlugin(tool: any, params: any, requestId: string) {
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

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    this.state.storage.setAlarm(Date.now() + 65_000);
    let msg: any;
    try { msg = JSON.parse(message as string); } catch { return; }
    // round-94: the round-92 re-validation only ran on 'hello'/'request'
    // frames — but the extension sends 'hello' once per socket and NEVER
    // sends 'request' (callPlugin is unused); its whole post-connect traffic
    // is 20s 'ping's and 'response' answers to /call, both of which skipped
    // the check. A live, pinging socket therefore kept browser_* control
    // past the 30-day link TTL (the exact hole round-92 claimed to close).
    // Validate the bound token on EVERY frame now — pings included.
    // round-105: a socket with NO bound token (hello never carried one, or
    // the DO restarted and the storage key was lost) skipped validation
    // entirely — a 30-day-TTL bypass for any socket that connected without
    // a token. Close it: every legit socket binds a token at hello.
    if (msg.type !== "hello") {
      const tok = await this.state.storage.get(`ws-token:${(ws as any).id || ""}`);
      if (!tok) { ws.close(4001, "no bound token"); return; }
      const link = await getPluginByToken(this.env, String(tok)).catch(() => null);
      if (!link) { ws.close(4001, "link expired"); return; }
    }
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
    if (msg.type === "hello") {
      this.state.storage.put("lastSeen", Date.now());
      // round-88: remember the plugin TOKEN bound to this socket (the round-84
      // ws-device: key was never read — dead code). The alarm re-validates
      // the link: a 30-day-expired link must not keep browser_* control over
      // a live socket.
      this.state.storage.put(`ws-token:${(ws as any).id || ""}`, String(msg.token || "")).catch(() => {});
      return;
    }
    if (msg.type === "response" && msg.id) {
      const resolve = this.pending.get(msg.id);
      if (resolve) { this.pending.delete(msg.id); resolve(msg); }
      return;
    }
    // round-98: extension → hub tool request (callPlugin's path). The hub
    // has no tool executor (tools run in the main worker's /mcp); the
    // previous behavior dropped the frame and callPlugin hung until its 65s
    // timeout. Reply with a clear error so the caller fails fast instead of
    // hanging — this direction (extension-initiated calls) is not supported;
    // the supported direction is hub → extension (/call → request frame).
    if (msg.type === "request" && msg.id) {
      ws.send(JSON.stringify({ id: msg.id, type: "response", ok: false, error: "extension-initiated calls not supported — use the gateway /mcp instead" }));
      return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // Reject all in-flight calls so /call returns a clear error, not a hang.
    const err = { error: "extension_disconnected" };
    for (const [id, resolve] of this.pending) { resolve(err); this.pending.delete(id); }
  }

  async alarm() {
    const sockets = this.state.getWebSockets() || [];
    for (const ws of sockets) {
      // round-88: re-validate the plugin link bound to this socket — an
      // expired (30-day TTL) link must not keep browser_* control.
      try {
        const tok = await this.state.storage.get(`ws-token:${(ws as any).id || ""}`);
        if (tok) {
          const link = await getPluginByToken(this.env, String(tok));
          if (!link) { ws.close(4001, "link expired"); continue; }
        }
      } catch { /* validation failure → idle-close below */ }
      ws.close(4001, "idle timeout");
    }
  }
}
