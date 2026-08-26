// /api/proxy → proxies directly to OpenRouter
// BYOK: prefer the caller-supplied Authorization header (ai-gateway forwards
// each user's own OpenRouter key); fall back to the OPENROUTER_API_KEY env var
// when no Authorization is present (injected via Vercel env, never hardcoded).
const OPENROUTER_URL = "https://openrouter.ai/api/v1/messages";
const SAFE = ["accept","accept-encoding","accept-language","anthropic-version","content-type","user-agent"];

export const config = { runtime: "edge" };

export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, {headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"*","Access-Control-Allow-Headers":"*"}});
  try {
    const h = new Headers();
    for (const n of SAFE) { const v = request.headers.get(n); if (v) h.set(n, v); }
    // Forward the caller's own OpenRouter key; otherwise use the built-in env
    // key (401 when unset)
    const clientAuth = request.headers.get("authorization");
    const fallbackKey = process.env.OPENROUTER_API_KEY || "";
    if (!clientAuth && !fallbackKey) {
      return new Response(JSON.stringify({ error: "no OpenRouter key configured" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    h.set("Authorization", clientAuth || `Bearer ${fallbackKey}`);
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
