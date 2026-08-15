// zen-us-proxy — Cloudflare Worker 美国出口代理 → opencode zen
//
// 与 openrouter-proxy 同一机制:绑定 D1(us-proxy-db)强制计算节点移出亚洲,
// 从美国/欧洲边缘出口访问 opencode.ai/zen/go —— 让 zen 看到美国来源,
// 路由到不拥堵的实例,从而稳定 og/deepseek-v4-flash 的延迟。
//
// 原生透传:deepseek-v4-flash 在 zen 上是 Anthropic 原生格式,直接转发
// /v1/messages,不翻译。密钥用 OPENCODE_GO_API_KEY(x-api-key)。

const VERIFY_PATH = "/v1/messages";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // GET /v1/models — 透传上游模型列表
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      const up = await fetch("https://opencode.ai/zen/go/v1/models", {
        headers: { "x-api-key": env.OPENCODE_GO_API_KEY },
      });
      return new Response(up.body, {
        status: up.status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    if (!(request.method === "POST" && url.pathname.endsWith(VERIFY_PATH))) {
      return jsonError(404, "Not Found", "not_found_error");
    }

    // 原生 Anthropic 透传:转发原始请求 + 透传上游流
    const upstream = await fetch("https://opencode.ai/zen/go" + VERIFY_PATH, {
      method: "POST",
      headers: {
        "x-api-key": env.OPENCODE_GO_API_KEY,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: request.body,
    });
    if (!upstream.ok) {
      let message = `Upstream ${upstream.status}`;
      try {
        const err = await upstream.json();
        message = err.error?.message || message;
      } catch {}
      return jsonError(upstream.status, message, "api_error");
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...CORS_HEADERS },
    });
  },
};

function jsonError(status, message, type) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
