// /api/zen → proxies to multiple upstreams (US egress), preserving the path
// ?target=og|ds|qw|or|cm picks the upstream; /v1/messages and /v1/chat/completions
// are forwarded as-is.
const TARGETS = {
  og: "https://opencode.ai/zen/go",
  ds: "https://api.deepseek.com",
  qw: "https://token-plan.ap-southeast-1.maas.aliyuncs.com",
  or: "https://openrouter.ai/api",
  cm: "https://api.commandcode.ai/provider",
};
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
// Allowlist-relative upstream path: must stay a plain absolute path on the
// chosen target's host. Rejects traversal (..), backslashes (WHATWG URL
// parsers treat \ as / for https:, so \\host escapes the origin),
// absolute URIs / schemes, and control bytes. Returns the safe path or null.
function normalizeUpstreamPath(p) {
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/")) return null;
  if (decoded.includes("\\")) return null;
  if (decoded.includes("://")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded.slice(1))) return null;
  if (decoded.includes("\0") || /[\r\n]/.test(decoded)) return null;
  if (decoded.split("/").includes("..")) return null;
  return decoded;
}
export const config = { runtime: "edge" };
export default async function handler(request) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    // Caller gate (same BYOK rule as /api/proxy): the caller MUST supply
    // their own upstream key via x-api-key or Authorization. Anonymous relay
    // is refused — default-closed. The gateway always forwards the user's
    // own key (x-api-key for og/amd, Bearer otherwise), so legit flows pass.
    // Strip any existing "Bearer " prefix (x-api-key has none, authorization
    // does), then reuse the single stripped credential below, avoiding a
    // "Bearer Bearer sk-..." double prefix.
    let callerKey = (request.headers.get("x-api-key") || request.headers.get("authorization") || "").trim();
    if (callerKey.toLowerCase().startsWith("bearer ")) callerKey = callerKey.slice(7).trim();
    if (!callerKey) {
      return new Response(JSON.stringify({ error: "caller key required (x-api-key or Authorization)" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const url = new URL(request.url);
    // Explicit target allowlist — unknown targets are rejected (no silent
    // fallback to og; an unlisted target must never ride zen's key).
    const target = url.searchParams.get("target") || "og";
    if (!Object.hasOwn(TARGETS, target)) {
      return new Response(JSON.stringify({ error: `unknown target: ${target}` }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const base = TARGETS[target];
    const rawPath = url.searchParams.get("path") || "/v1/messages";
    const path = normalizeUpstreamPath(rawPath);
    if (path === null) {
      return new Response(JSON.stringify({ error: "invalid path" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const upstream = base + path;
    const h = new Headers();
    for (const n of SAFE) { const v = request.headers.get(n); if (v) h.set(n, v); }
    if (target === "og") {
      // zen's two endpoints authenticate differently — send exactly ONE key,
      // chosen by path: /v1/messages takes x-api-key, chat/completions takes
      // Authorization: Bearer. (Previously both were sent and zen picked one;
      // single-key avoids leaking the credential in the unused scheme and
      // matches each endpoint's documented auth.)
      // NOTE (needs live verification): the per-path split has not yet been
      // verified against the live upstream — confirm both paths still auth.
      if (path.includes("chat/completions")) {
        h.set("Authorization", `Bearer ${callerKey}`);
      } else if (path.startsWith("/v1/messages")) {
        h.set("x-api-key", callerKey);
      } else {
        // Non-AI paths (e.g. /v1/models): zen's native scheme is x-api-key.
        h.set("x-api-key", callerKey);
      }
    } else {
      h.set("Authorization", `Bearer ${callerKey}`);
    }
    if (!h.has("anthropic-version")) h.set("anthropic-version", "2023-06-01");
    h.set("Content-Type", "application/json");
    const r = await fetch(upstream, {
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
    console.error(`[vercel-zen] handler error: ${e?.stack || e}`);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers: { "Content-Type": "application/json", ...cors } });
  }
}
