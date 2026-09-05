// zen-us-proxy — Cloudflare Worker US egress proxy → opencode zen
//
// Same mechanism as openrouter-proxy: bind D1 (us-proxy-db) to force compute
// nodes out of Asia, egress from US/Europe edges to opencode.ai/zen/go — so
// zen sees a US origin, routes to uncongested instances, and stabilizes
// og/deepseek-v4-flash latency.
//
// ⚠️ DO NOT REMOVE the D1 binding (wrangler.jsonc `d1_databases`): it is an
// intentional geo-hack, not a data dependency — this worker never queries
// the DB. Binding a D1 database pins execution to regions that host D1
// (US/Europe), keeping egress out of Asia. Unbinding silently re-routes
// through Asian edges and the latency wins disappear. See proxies/README.md.
//
// Native passthrough: deepseek-v4-flash speaks Anthropic natively on zen, so
// /v1/messages is forwarded untranslated. Key: OPENCODE_GO_API_KEY (x-api-key).

const VERIFY_PATH = "/v1/messages";

// Upstream fetch budget: fail fast instead of hanging a client for minutes.
const UPSTREAM_TIMEOUT_MS = 30000;

// CORS allowlist: same closed set as zen-go-proxy (index.js:22-51 pattern) —
// the console origins used in this repo plus loopback for local
// `wrangler dev`. Any other Origin gets NO Access-Control-Allow-* headers
// (default-closed). Non-browser clients (gateway server-side) are
// unaffected by CORS.
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

// Constant-time string equality for the CLIENT_KEY gate (same pattern as
// index/src/index.js safeEq): SHA-256 both sides to fixed 32-byte digests
// first (no length early-exit to leak on), then fold XOR across every byte
// without short-circuiting.
async function safeEq(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  const a8 = new Uint8Array(da);
  const b8 = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < a8.length; i++) diff |= a8[i] ^ b8[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const cors = corsHeaders(request);

    try {
      // Caller gate: x-api-key must match env.CLIENT_KEY (same style as
      // zen-go-proxy). Default-CLOSED — when CLIENT_KEY is unset every request
      // is refused; never fall through to the paid OPENCODE_GO_API_KEY.
      const clientKey = request.headers.get("x-api-key") || "";
      if (!env.CLIENT_KEY || !(await safeEq(clientKey, env.CLIENT_KEY))) {
        return jsonError(401, "Missing or invalid x-api-key", "authentication_error", cors);
      }

      const url = new URL(request.url);

      // GET /v1/models — passthrough upstream model list
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        const up = await fetch("https://opencode.ai/zen/go/v1/models", {
          headers: { "x-api-key": env.OPENCODE_GO_API_KEY },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        return new Response(up.body, {
          status: up.status,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }

      if (!(request.method === "POST" && url.pathname.endsWith(VERIFY_PATH))) {
        return jsonError(404, "Not Found", "not_found_error", cors);
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
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!upstream.ok) {
        // 5xx from upstream: generic client text, detail stays server-side.
        if (upstream.status >= 500) {
          let detail = `Upstream ${upstream.status}`;
          try {
            const err = await upstream.json();
            detail = err.error?.message || detail;
          } catch {}
          console.error(`[zen-us] upstream 5xx: ${detail}`);
          return jsonError(upstream.status, "Upstream unavailable", "api_error", cors);
        }
        let message = `Upstream ${upstream.status}`;
        try {
          const err = await upstream.json();
          message = err.error?.message || message;
        } catch {}
        return jsonError(upstream.status, message, "api_error", cors);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...cors },
      });
    } catch (error) {
      // Never leak internal detail — generic client text, full detail in log.
      console.error(`[zen-us] handler error: ${error?.stack || error}`);
      return jsonError(500, "Internal error", "api_error", cors);
    }
  },
};

function jsonError(status, message, type, cors = {}) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
