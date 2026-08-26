// /api/zen → proxies to multiple upstreams (US egress), preserving the path
// ?target=og|ds|qw|or picks the upstream; /v1/messages and /v1/chat/completions
// are forwarded as-is.
const TARGETS = {
  og: "https://opencode.ai/zen/go",
  ds: "https://api.deepseek.com",
  qw: "https://token-plan.ap-southeast-1.maas.aliyuncs.com",
  or: "https://openrouter.ai/api",
};
const SAFE = ["accept","accept-encoding","accept-language","anthropic-version","content-type","user-agent"];
export const config = { runtime: "edge" };
export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, {headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"*","Access-Control-Allow-Headers":"*"}});
  try {
    const url = new URL(request.url);
    const target = url.searchParams.get("target") || "og";
    const base = TARGETS[target] || TARGETS.og;
    const path = url.searchParams.get("path") || "/v1/messages";
    const upstream = base + path;
    const h = new Headers();
    for (const n of SAFE) { const v = request.headers.get(n); if (v) h.set(n, v); }
    // Strip any existing "Bearer " prefix (x-api-key has none, authorization
    // does), then prepend a single Bearer, avoiding a "Bearer Bearer sk-..."
    // double prefix.
    let clientAuth = (request.headers.get("x-api-key") || request.headers.get("authorization") || "").trim();
    if (clientAuth.startsWith("Bearer ")) clientAuth = clientAuth.slice(7);
    if (target === "og") {
      // zen's two endpoints authenticate differently: /v1/messages accepts
      // x-api-key, chat/completions accepts Authorization: Bearer — send both,
      // zen picks the one it recognizes.
      h.set("x-api-key", clientAuth);
      h.set("Authorization", `Bearer ${clientAuth}`);
    } else {
      h.set("Authorization", `Bearer ${clientAuth}`);
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
