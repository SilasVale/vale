// openrouter-proxy — proxy to OpenRouter
// BYOK-only: the caller MUST supply their own OpenRouter key via
// Authorization. NO built-in secret is spent on any caller — requests
// without a caller key get 401 (default-closed). There is no
// OPENROUTER_API_KEY to configure (see proxies/README.md).
//
// D1 note: this worker carries NO D1 binding — it never needed one (the
// earlier us-proxy-db binding was idle and has been removed). Only
// zen-us-proxy keeps its D1 binding, as an intentional geo-hack.

// Upstream fetch budget: fail fast instead of hanging a client for minutes.
const UPSTREAM_TIMEOUT_MS = 30000;

// CORS allowlist: the console origins used in this repo plus loopback for
// local `wrangler dev` (same closed set as zen-go-proxy). Any other Origin
// gets NO Access-Control-Allow-* headers (default-closed). Non-browser
// clients (gateway server-side) are unaffected by CORS.
const ALLOWED_ORIGINS = new Set([
  "https://ai.saisi.online",
  "https://api.saisi.online",
  "https://dsh.saisi.online",
]);

function isLoopbackOrigin(origin) {
  try {
    const u = new URL(origin);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
  if (ALLOWED_ORIGINS.has(origin) || isLoopbackOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // Method whitelist: only the verbs OpenRouter's Anthropic endpoint needs.
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...cors },
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
      // callers instead of spending any built-in secret on them.
      const clientAuth = request.headers.get("authorization");
      if (!clientAuth) {
        return new Response(JSON.stringify({ error: "caller Authorization required (BYOK)" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...cors },
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
        // GET/HEAD carry no body: passing request.body there throws on some
        // runtimes and confuses upstreams. Only POST sends one.
        body: request.method === "POST" ? request.body : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      const modifiedHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(cors)) modifiedHeaders.set(k, v);

      return new Response(response.body, {
        status: response.status,
        headers: modifiedHeaders,
      });
    } catch (error) {
      // Never leak internal detail — generic client text, full detail in log.
      console.error(`[openrouter] handler error: ${error?.stack || error}`);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  },
};
