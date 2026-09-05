/**
 * HTTP helpers shared across the gateway: CORS headers, JSON responses,
 * and the readJson() body-parsing helper (replaces the repeated
 * `let body = {}; try { body = await request.json(); } catch {}` pattern).
 * Extracted from index.js (2026-08-12).
 */

// CORS allowlist: the console origins used in this repo —
//   https://ai.saisi.online + https://api.saisi.online (CONSOLE_HOST in wrangler.jsonc),
//   https://dsh.saisi.online (extension/manifest.json host_permissions),
// plus http(s) loopback for local `wrangler dev`. Any other Origin gets NO
// Access-Control-Allow-Origin header (default-closed). Non-browser clients
// (Claude Code, curl, gateway server-side) are unaffected by CORS.
// (Mirrors proxies/zen-go-proxy/src/index.js.)
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  "https://ai.saisi.online",
  "https://api.saisi.online",
  "https://dsh.saisi.online",
]);

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export function isAllowedOrigin(origin: string, requestHost?: string): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Loopback origins are a `wrangler dev` affordance, not a production grant:
  // a request to http://localhost:<port> whose Origin is also loopback is
  // local dev; the SAME Origin arriving at the deployed console host is just
  // a foreign local page and gets NO ACAO. (Pre-fix, production reflected
  // any localhost origin — audit P2.)
  return isLoopbackOrigin(origin) && !!requestHost && isLoopbackHost(requestHost);
}

function requestOrigin(request?: Request | null): string {
  try {
    return request?.headers?.get?.("origin") || "";
  } catch {
    return "";
  }
}

function requestHost(request?: Request | null): string {
  try {
    return new URL(request?.url || "").hostname;
  } catch {
    return "";
  }
}

// Base CORS headers shared by every response. Deliberately NO
// Access-Control-Allow-Origin here — the origin is reflected per request
// (corsHeadersFor / stampCors / withCors below), otherwise a static `*`
// would ride along on every merge of this constant.
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS,DELETE,PUT",
  "Access-Control-Allow-Headers": "*",
};

/** Per-request CORS headers: reflect-if-allowlisted + Vary, else no ACAO. */
export function corsHeadersFor(request?: Request | null): Record<string, string> {
  const headers: Record<string, string> = { ...CORS_HEADERS };
  const origin = requestOrigin(request);
  if (isAllowedOrigin(origin, requestHost(request))) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

/** Stamp (or strip) ACAO on a mutable Headers object, per request origin. */
export function stampCors(request: Request | null | undefined, headers: Headers): void {
  const origin = request ? requestOrigin(request) : "";
  if (isAllowedOrigin(origin, requestHost(request))) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  } else {
    headers.delete("Access-Control-Allow-Origin");
  }
}

/**
 * Rebuild an already-built response with per-request CORS (reflect-if-
 * allowlisted, Vary: Origin, no ACAO otherwise). WebSocket upgrades (101 /
 * webSocket) carry no mutable headers — returned untouched.
 */
export function withCors(request: Request | null | undefined, response: Response): Response {
  const r = response as Response & { webSocket?: unknown };
  if (r.status === 101 || r.webSocket) return response;
  const headers = new Headers(response.headers);
  stampCors(request, headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonOk(data: any, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

export function jsonError(
  status: number,
  message: string,
  type: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

/** Parse a request body as JSON, tolerating empty/invalid input. */
export async function readJson(request: Request): Promise<any> {
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* empty body */
  }
  return body;
}
