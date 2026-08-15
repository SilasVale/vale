// /api/zen → 代理到多个上游(美国出口),路径保留转发
// ?target=og|ds|qw|or 选上游;/v1/messages、/v1/chat/completions 原样转发。
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
    // 剥掉可能已有的 "Bearer " 前缀(x-api-key 没有,authorization 有),
    // 再统一拼 Bearer,避免 "Bearer Bearer sk-..." 双重前缀。
    let clientAuth = (request.headers.get("x-api-key") || request.headers.get("authorization") || "").trim();
    if (clientAuth.startsWith("Bearer ")) clientAuth = clientAuth.slice(7);
    if (target === "og") {
      // zen 的两个端点认证不同:/v1/messages 认 x-api-key,chat/completions
      // 认 Authorization: Bearer —— 两个都带,zen 挑它认的那个。
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
