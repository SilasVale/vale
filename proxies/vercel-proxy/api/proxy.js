// /api/proxy → 直接代理到 OpenRouter
// BYOK：优先使用请求方传入的 Authorization（ai-gateway 透传各用户自己的 OpenRouter key），
// 无 Authorization 时回退到 OPENROUTER_API_KEY 环境变量（Vercel env 注入，不硬编码）。
const OPENROUTER_URL = "https://openrouter.ai/api/v1/messages";
const SAFE = ["accept","accept-encoding","accept-language","anthropic-version","content-type","user-agent"];

export const config = { runtime: "edge" };

export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, {headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"*","Access-Control-Allow-Headers":"*"}});
  try {
    const h = new Headers();
    for (const n of SAFE) { const v = request.headers.get(n); if (v) h.set(n, v); }
    // 透传调用方自己的 OpenRouter key；没有则用内置 env key（未配置时 401）
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
