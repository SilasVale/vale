// openrouter-proxy — proxy to OpenRouter
// BYOK: prefer the caller's (ai-gateway) Authorization = each user's own OpenRouter key;
// fall back to the built-in secret when no Authorization is provided.
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
      // BYOK: pass through the caller's Authorization (= the user's own OpenRouter key);
      // fall back to the built-in secret when absent.
      const clientAuth = request.headers.get("authorization");
      headers.set("Authorization", clientAuth || `Bearer ${env.OPENROUTER_API_KEY}`);
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
