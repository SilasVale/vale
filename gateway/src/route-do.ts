/**
 * RouteDO — Durable Object storing per-user model route selections.
 *
 * Single global instance ("global") holds all users' routes in SQLite.
 * Replaces the KV-based route storage that suffered from cross-isolate
 * eventual consistency (model=auto requests on different isolates read
 * stale values).
 *
 * Storage: `route:{uid}` → model string (e.g. "cm/deepseek/deepseek-v4.1-flash")
 *
 * HTTP API (called via stub.fetch):
 *   GET    /route?uid=xxx       → { model: "..." | null }
 *   PUT    /route               → body { uid, model }   → { ok: true }
 *   DELETE /route?uid=xxx       → { ok: true }
 */

import { safeEq } from "./auth.ts";

/**
 * DO external-address defense-in-depth, shared by every DO class (BreakerDO
 * and RouteDO used to each carry a byte-identical copy). A Durable Object
 * has its own external address even with workers_dev:false + no routes, so
 * the main router's auth is not the last line. FAIL CLOSED (Auth-core audit
 * MED-2): an unconfigured DO_AUTH must DENY every caller — never wave the
 * gate open. Constant-time compare on the x-do-auth header.
 *
 * Truth table (pinned in route-do.test.mjs):
 *   expected empty → false ALWAYS (even when the header is also absent —
 *     this is what makes it fail-closed rather than a plain equality);
 *   header missing / wrong length / wrong value → false;
 *   header equals expected → true.
 *
 * SOLID Round-8 (DRY/DIP): the comparison itself is auth.ts's `safeEq`
 * primitive — that module's header mandates reaching for its primitives
 * instead of re-implementing them, and this gate previously hand-rolled a
 * second copy of the same loop. The fail-closed empty-secret guard stays
 * HERE (it is gate policy, not comparison semantics — `safeEq("","")`
 * is true, which would wave an unconfigured gate open).
 */
export function authorizeDoRequest(request: Request, expectedSecret: string): boolean {
  const expected = expectedSecret || "";
  if (!expected) return false;
  const got = request.headers.get("x-do-auth") || "";
  return safeEq(got, expected);
}

/**
 * Shared DO skeleton: state/env plumbing + the authorized() gate. RouteDO
 * and BreakerDO used to each carry byte-identical copies of this head —
 * only their fetch bodies differ.
 */
export class DoAuthBase {
  state: any;
  env: any;
  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
  }

  // Defense-in-depth: a Durable Object has its own external address even
  // with workers_dev:false + no routes, so the main router's auth is NOT the
  // last line. FAIL CLOSED — when DO_AUTH is unset, authorized() denies
  // every caller (constant-time compare).
  authorized(request: Request): boolean {
    return authorizeDoRequest(request, this.env?.DO_AUTH || "");
  }
}

export class RouteDO extends DoAuthBase {
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
