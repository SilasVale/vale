// zen-us-proxy — Cloudflare Worker US egress proxy → opencode zen
//
// Same mechanism as openrouter-proxy: bind D1 (us-proxy-db) to force compute
// nodes out of Asia, egress from US/Europe edges to opencode.ai/zen/go — so
// zen sees a US origin, routes to uncongested instances, and stabilizes
// og/deepseek-v4-flash latency.
//
// Native passthrough: deepseek-v4-flash speaks Anthropic natively on zen, so
// /v1/messages is forwarded untranslated. Key: OPENCODE_GO_API_KEY (x-api-key).

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

    // GET /v1/models — passthrough upstream model list
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

    // Native Anthropic passthrough: forward the raw request + stream the upstream body
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
