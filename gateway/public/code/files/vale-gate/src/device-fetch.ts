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
  const hostErr = deviceHostError(upstream.hostname);
  if (hostErr) {
    return { status: 400, ok: false, resp: undefined, error: hostErr };
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
    resp = await fetchWithTimeout(
      upstream.toString(),
      { ...init, headers },
      init.method === "POST" ? 60000 : 15000,
    );
  } catch (e) {
    return { status: 502, ok: false, error: `Device unreachable: ${(e as Error).message}` };
  }
  return { status: resp.status, ok: resp.ok, resp };
}

/**
 * SSRF hostname guard shared by deviceFetch and the MCP browser bridge
 * (mcp.ts keeps its own long-timeout raw fetch, so it calls this directly
 * instead of routing through deviceFetch). Returns an error string when the
 * hostname must not be dialed with device credentials, else null.
 */
export function deviceHostError(hostname: string): string | null {
  // stage-n SSRF audit (HIGH): reject private/link-local/internal IPs — an
  // attacker who registers a device with hostname "169.254.169.254" (cloud
  // metadata) or "127.0.0.1" makes the gateway dial it with the device token.
  const hostLower = String(hostname).toLowerCase();
  // Decimal/hex/octal IPv4 need no extra rules — the WHATWG parser in
  // deviceFetch already normalizes them (2130706433/0x7f.0.0.1/0177.0.0.1 all
  // parse to 127.0.0.1 and hit the 127. block). What it does NOT normalize
  // away: 0.0.0.0, the cloud metadata IP, and IPv4-mapped IPv6 (::ffff:/96
  // can smuggle 127.0.0.1 past every v4 rule — bracketed or bare).
  // 172.16/12 is ONLY second-octet 16-31 (numeric) — a blanket
  // startsWith("172.") also blocked public 172.15.x.x / 172.32+.x.x.
  // The fc/fd/fe80 unique-local/link-local prefixes must be actual address
  // forms (contain ':': hostnames never do) — otherwise a hostname STRING
  // like 'fc.example.com' false-positives. Bracketed/bare loopback +
  // mapped forms below are unreachable with brackets anyway (WHATWG
  // hostname strips them and the equality gate above rejects the mismatch),
  // but stay as belt-and-suspenders.
  let is172Private = false;
  if (hostLower.startsWith("172.")) {
    const second = Number(hostLower.split(".")[1]);
    is172Private = Number.isInteger(second) && second >= 16 && second <= 31;
  }
  const isV6Private = hostLower.includes(":") &&
    (hostLower.startsWith("fc") ||
      hostLower.startsWith("fd") ||
      hostLower.startsWith("fe80"));
  if (
    hostLower === "localhost" ||
    hostLower.startsWith("127.") ||
    hostLower.startsWith("10.") ||
    hostLower.startsWith("192.168.") ||
    is172Private ||
    hostLower === "::1" ||
    hostLower === "[::1]" ||
    isV6Private ||
    hostLower === "0.0.0.0" ||
    hostLower === "[::]" ||
    hostLower === "169.254.169.254" ||
    hostLower.startsWith("::ffff:") ||
    hostLower.startsWith("[::ffff:")
  ) {
    return "device hostname resolves to a private/internal address";
  }
  return null;
}
