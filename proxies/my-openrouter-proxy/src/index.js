// openrouter-proxy — proxy to OpenRouter
// BYOK-only: the caller MUST supply their own OpenRouter key via
// Authorization. The built-in OPENROUTER_API_KEY secret is never spent on
// anonymous callers — requests without a caller key get 401 (default-closed).
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "*",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    try {
      const openRouterUrl = "https://openrouter.ai/api/v1/messages";

      const safeHeaders = [
        "accept", "accept-encoding", "accept-language",
        "anthropic-version", "content-type", "user-agent",
      ];
      const headers = new Headers();
      for (const name of safeHeaders) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      // BYOK: forward the caller's own OpenRouter key; refuse anonymous
      // callers instead of spending the built-in secret on them.
      const clientAuth = request.headers.get("authorization");
      if (!clientAuth) {
        return new Response(JSON.stringify({ error: "caller Authorization required (BYOK)" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      headers.set("Authorization", clientAuth);
      headers.set("Content-Type", "application/json");
      if (!headers.has("anthropic-version")) {
        headers.set("anthropic-version", "2023-06-01");
      }

      const response = await fetch(openRouterUrl, {
        method: request.method,
        headers: headers,
        body: request.body,
      });

      const modifiedHeaders = new Headers(response.headers);
      modifiedHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(response.body, {
        status: response.status,
        headers: modifiedHeaders,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  },
};
