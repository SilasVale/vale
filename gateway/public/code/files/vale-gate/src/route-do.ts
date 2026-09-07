/**
 * RouteDO — Durable Object storing per-user model route selections.
 *
 * Single global instance ("global") holds all users' routes in SQLite.
 * Replaces the KV-based route storage that suffered from cross-isolate
 * eventual consistency (model=auto requests on different isolates read
 * stale values).
 *
 * Storage: `route:{uid}` → model string (e.g. "ds/deepseek-v4-flash")
 *
 * HTTP API (called via stub.fetch):
 *   GET    /route?uid=xxx       → { model: "..." | null }
 *   PUT    /route               → body { uid, model }   → { ok: true }
 *   DELETE /route?uid=xxx       → { ok: true }
 */

/**
 * DO external-address defense-in-depth, shared by every DO class (BreakerDO
 * and RouteDO used to each carry a byte-identical copy). A Durable Object
 * has its own external address even with workers_dev:false + no routes, so
 * the main router's auth is not the last line. FAIL CLOSED (Auth-core audit
 * MED-2): an unconfigured DO_AUTH must DENY every caller — never wave the
 * gate open. Constant-time compare on the x-do-auth header.
 */
export function authorizeDoRequest(request: Request, expectedSecret: string): boolean {
  const expected = expectedSecret || "";
  if (!expected) return false;
  const got = request.headers.get("x-do-auth") || "";
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export class RouteDO {
  state: any;
  env: any;
  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
  }

  // Defense-in-depth: a Durable Object has its own
  // external address even with workers_dev:false + no routes, so the main
  // router's auth is NOT the last line. When DO_AUTH is configured, any
  // request without the shared secret is rejected (constant-time compare).
  authorized(request: Request): boolean {
    return authorizeDoRequest(request, this.env?.DO_AUTH || "");
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.authorized(request)) return new Response("unauthorized", { status: 401 });
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/route") {
        if (request.method === "GET") {
          const uid = url.searchParams.get("uid");
          if (!uid) return jsonErr(400, "missing uid");
          const model = (await this.state.storage.get(`route:${uid}`)) || null;
          return Response.json({ model });
        }
        if (request.method === "PUT") {
          const body: any = await request.json();
          const { uid, model } = body || {};
          if (!uid) return jsonErr(400, "missing uid");
          if (model != null) {
            await this.state.storage.put(`route:${uid}`, String(model));
          } else {
            await this.state.storage.delete(`route:${uid}`);
          }
          return Response.json({ ok: true });
        }
        if (request.method === "DELETE") {
          const uid = url.searchParams.get("uid");
          if (!uid) return jsonErr(400, "missing uid");
          await this.state.storage.delete(`route:${uid}`);
          return Response.json({ ok: true });
        }
      }
      return new Response("not found", { status: 404 });
    } catch (e: any) {
      return jsonErr(500, `route-do: ${e.message}`);
    }
  }
}

function jsonErr(status: number, message: string) {
  return Response.json({ error: message }, { status });
}
