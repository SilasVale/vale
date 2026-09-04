// /api/proxy → proxies directly to OpenRouter
// BYOK-only: the caller MUST supply their own OpenRouter key via the
// Authorization header. The OPENROUTER_API_KEY env var is never spent on
// anonymous callers — requests without a caller key get 401 (default-closed).
const OPENROUTER_URL = "https://openrouter.ai/api/v1/messages";
const SAFE = ["accept","accept-encoding","accept-language","anthropic-version","content-type","user-agent"];

export const config = { runtime: "edge" };

export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, {headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"*","Access-Control-Allow-Headers":"*"}});
  try {
    const h = new Headers();
    for (const n of SAFE) { const v = request.headers.get(n); if (v) h.set(n, v); }
    // Forward the caller's own OpenRouter key; refuse anonymous callers
    // instead of spending the built-in env key on them.
    const clientAuth = request.headers.get("authorization");
    if (!clientAuth) {
      return new Response(JSON.stringify({ error: "caller Authorization required (BYOK)" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    h.set("Authorization", clientAuth);
    h.set("Content-Type", "application/json");
    if (!h.has("anthropic-version")) h.set("anthropic-version", "2023-06-01");
    const r = await fetch(OPENROUTER_URL, { method: request.method, headers: h, body: request.body });
    const rh = new Headers(r.headers);
    rh.set("Access-Control-Allow-Origin", "*");
    return new Response(r.body, { status: r.status, headers: rh });
  } catch (e) {
    return new Response(JSON.stringify({error:e.message}), {status:500,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
  }
}
