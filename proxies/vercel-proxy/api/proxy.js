// /api/proxy → proxies directly to OpenRouter
// BYOK-only: the caller MUST supply their own OpenRouter key via the
// Authorization header. There is no built-in env key to spend — requests
// without a caller key get 401 (default-closed).
const OPENROUTER_URL = "https://openrouter.ai/api/v1/messages";
const SAFE = ["accept","accept-encoding","accept-language","anthropic-version","content-type","user-agent"];

// Upstream fetch budget: fail fast instead of hanging a client.
const UPSTREAM_TIMEOUT_MS = 30000;

// CORS allowlist: the console origins used in this repo plus loopback for
// local dev (same closed set as the CF zen proxies). Any other Origin gets
// NO Access-Control-Allow-Origin header (default-closed). Non-browser
// clients (gateway server-side) are unaffected by CORS.
const ALLOWED_ORIGINS = new Set([
  "https://ai.saisi.online",
  "https://api.saisi.online",
  "https://dsh.saisi.online",
]);

function isLoopbackOrigin(origin) {
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

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
  if (ALLOWED_ORIGINS.has(origin) || isLoopbackOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

export const config = { runtime: "edge" };

export default async function handler(request) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const h = new Headers();
    for (const n of SAFE) { const v = request.headers.get(n); if (v) h.set(n, v); }
    // Forward the caller's own OpenRouter key; refuse anonymous callers
    // instead of spending any built-in env key on them.
    const clientAuth = request.headers.get("authorization");
    if (!clientAuth) {
      return new Response(JSON.stringify({ error: "caller Authorization required (BYOK)" }), { status: 401, headers: { "Content-Type": "application/json", ...cors } });
    }
    h.set("Authorization", clientAuth);
    h.set("Content-Type", "application/json");
    if (!h.has("anthropic-version")) h.set("anthropic-version", "2023-06-01");
    const r = await fetch(OPENROUTER_URL, {
      method: request.method,
      headers: h,
      // GET/HEAD carry no body: passing request.body there throws on some
      // runtimes. Only methods with a body send one.
      body: ["POST", "PUT", "PATCH"].includes(request.method) ? request.body : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const rh = new Headers(r.headers);
    for (const [k, v] of Object.entries(cors)) rh.set(k, v);
    return new Response(r.body, { status: r.status, headers: rh });
  } catch (e) {
    // Never leak internal detail — generic client text, full detail in log.
    console.error(`[vercel-proxy] handler error: ${e?.stack || e}`);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers: { "Content-Type": "application/json", ...cors } });
  }
}
