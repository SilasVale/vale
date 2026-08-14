/**
 * device-fetch — device reverse-proxy helpers for vale-gate.
 *
 * Holds the pieces of the device module that need to be importable without
 * dragging in all of index.js (keeps index.js ↔ mcp.js imports acyclic).
 */

/**
 * Rebuild a 101 Switching Protocols response carrying the upgraded WebSocket.
 * The old code built `new Response(resp.body, {status:101, headers})` which
 * throws RangeError (101 is only legal with a `webSocket` property), so every
 * WS upgrade through the proxy 500'd. Minimal branch: no header rewriting.
 */
export function build101Response(resp: any) {
  if (resp.status !== 101) return null;
  if (resp.webSocket) {
    try {
      return new Response(null, { status: 101, webSocket: resp.webSocket });
    } catch {
      return resp; // workerd #3047: any repack failure → pass through untouched
    }
  }
  return new Response(resp.body || null, { status: 101, headers: new Headers(resp.headers) });
}

/**
 * Fetch a device panel/MCP path with the Bearer token injected server-side.
 * Shared by proxyDevice (HTTP proxy) and the gateway MCP terminal tools.
 * Behavior is identical to the old inline fetch in proxyDevice (Bearer
 * injection, host/cookie stripped). Returns { status, ok, resp } — resp is
 * undefined when the device is unreachable, with `error` carrying the reason.
 */
import { fetchWithTimeout } from "./reliability.ts";

export async function deviceFetch(env: any, device: any, restPath: string, init: any = {}) {
  const upstream = new URL(`https://${device.hostname}${restPath}`);
  const headers = new Headers(init.headers || {});
  headers.delete("host");
  headers.delete("cookie");
  headers.set("Authorization", `Bearer ${device.token}`);
  let resp;
  try {
    // Read methods are bounded (round-55): a blackholed tunnel hung until
    // the platform's subrequest ceiling. round-56: the bound applies to
    // EVERY non-POST method — a cross-origin Authorization fetch triggers an
    // OPTIONS preflight, and HEAD/OPTIONS on a dead tunnel hung just like
    // GET did. POST (terminal tools, a command) is deliberately unbounded:
    // non-idempotent, retrying would double-execute.
    if (init.method !== "POST") {
      resp = await fetchWithTimeout(upstream.toString(), { ...init, headers }, 15000);
    } else {
      resp = await fetch(upstream.toString(), { ...init, headers });
    }
  } catch (e) {
    return { status: 502, ok: false, error: `Device unreachable: ${(e as Error).message}` };
  }
  return { status: resp.status, ok: resp.ok, resp };
}
