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
  if (request.method === "OPTIONS") return new Response(null, {headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"*","Access-Control-Allow-Headers":"*"}});
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
      // zen's two endpoints authenticate differently: /v1/messages accepts
      // x-api-key, chat/completions accepts Authorization: Bearer — send both,
      // zen picks the one it recognizes.
      h.set("x-api-key", callerKey);
      h.set("Authorization", `Bearer ${callerKey}`);
    } else {
      h.set("Authorization", `Bearer ${callerKey}`);
    }
    if (!h.has("anthropic-version")) h.set("anthropic-version", "2023-06-01");
    h.set("Content-Type", "application/json");
    const r = await fetch(upstream, { method: request.method, headers: h, body: request.body });
    const rh = new Headers(r.headers);
    rh.set("Access-Control-Allow-Origin", "*");
    return new Response(r.body, { status: r.status, headers: rh });
  } catch (e) {
    return new Response(JSON.stringify({error:e.message}), {status:500,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
  }
}
