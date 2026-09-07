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
// Endpoints:
//   - POST /v1/messages   — native Anthropic passthrough (deepseek-v4-flash),
//                           upstream key = env.OPENCODE_GO_API_KEY (x-api-key),
//                           caller gate = CLIENT_KEY.
//   - POST /v1/responses  — OpenAI Responses API passthrough (muse-spark
//                           Contributor ONLY on zen). BYOK like the Vercel
//                           zen exit: the caller MUST send their own upstream
//                           key as `Authorization: Bearer <key>` (no
//                           CLIENT_KEY gate — a missing/blank caller key is
//                           refused, but the key itself is the caller's own,
//                           exactly the Vercel /api/zen security model).
//                           This endpoint exists because muse-spark is forced
//                           through the US exit (Meta Geographic Use Policy)
//                           and the previous Vercel exit (v.saisi.online)
//                           capped long streams at ~30 s
//                           (FUNCTION_INVOCATION_TIMEOUT / truncated SSE);
//                           Cloudflare Workers have NO duration limit on
//                           HTTP-triggered streaming (CPU time is not wall
//                           time), so long muse generations survive here.
//
// The /v1/messages caller gate stays CLIENT_KEY (that endpoint spends the
// worker's own paid OPENCODE_GO_API_KEY, so it must stay default-closed).

// zen/go requires a stable per-conversation x-opencode-session header on
// every request (2026-09-05+; 400 "Request is missing x-opencode-session"
// otherwise — the muse-spark breakage). The /v1/responses BYOK relay must
// forward the caller's conversation id under the name zen expects; the
// gateway and DSH both send one of these spellings on og requests.
const SESSION_SOURCE_HEADERS = [
  "x-opencode-session",
  "x-client-request-id",
  "session_id",
  "x-session-id",
];

const VERIFY_PATH = "/v1/messages";
const RESPONSES_PATH = "/v1/responses";

// Timeout budget for waiting on the upstream's response HEADERS only. The
// 30 s AbortSignal.timeout on the whole fetch is deliberately NOT applied to
// the streaming paths: once headers arrive, the SSE body may run for minutes
// (muse-spark long generations) and must not be cut by a signal that would
// abort mid-stream. Cloudflare Workers do not impose a wall-clock duration
// limit on HTTP-triggered requests, so header-timeout + untimed body is the
// right shape here. (Vercel's edge runtime DID cut the body at ~30 s — see
// the /v1/responses note above.)
const HEADER_TIMEOUT_MS = 30000;

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

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function requestHost(request) {
  try {
    return new URL(request.url).hostname;
  } catch {
    return "";
  }
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
  // Loopback origins are a local-dev affordance, not a production grant
  // (mirrors gateway/src/http.ts isAllowedOrigin; autonomous copy per
  // ADR 0003 — satellite workers stay autonomous, no shared package): a
  // loopback Origin is reflected only when the request host is itself
  // loopback, so the deployed proxy never reflects a foreign page's
  // http://localhost Origin.
  if (ALLOWED_ORIGINS.has(origin) || (isLoopbackOrigin(origin) && isLoopbackHost(requestHost(request)))) {
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

// Fetch the upstream and wait for response HEADERS with a timeout, but keep
// the returned Response's body stream UNTIMED — the caller forwards
// `upstream.body` straight to the client and that stream may run for
// minutes. AbortSignal.timeout on the whole fetch would also abort the body
// mid-stream once the budget expires (the Vercel bug this worker avoids).
async function fetchUpstreamHeaders(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEADER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const cors = corsHeaders(request);

    try {
      const url = new URL(request.url);

      // GET /v1/models — passthrough upstream model list
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        const clientKey = request.headers.get("x-api-key") || "";
        if (!env.CLIENT_KEY || !(await safeEq(clientKey, env.CLIENT_KEY))) {
          return jsonError(401, "Missing or invalid x-api-key", "authentication_error", cors);
        }
        const up = await fetch("https://opencode.ai/zen/go/v1/models", {
          headers: { "x-api-key": env.OPENCODE_GO_API_KEY },
          signal: AbortSignal.timeout(HEADER_TIMEOUT_MS),
        });
        return new Response(up.body, {
          status: up.status,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }

      // POST /v1/responses — OpenAI Responses API BYOK passthrough
      // (og/muse-spark-* Contributor; zen serves these on /v1/responses
      // only). The caller carries their OWN zen key as Bearer — this worker
      // never substitutes its paid key here, so no CLIENT_KEY gate: the
      // credential is the caller's and the endpoint is a pure relay (same
      // model as the Vercel /api/zen BYOK paths). Blank/absent key → 401.
      if (request.method === "POST" && url.pathname.endsWith(RESPONSES_PATH)) {
        const auth = (request.headers.get("authorization") || "").trim();
        const callerKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (!callerKey) {
          return jsonError(
            401,
            "caller key required (Authorization: Bearer <opencode zen key>)",
            "authentication_error",
            cors,
          );
        }
        const upstream = await fetchUpstreamHeaders(
          "https://opencode.ai/zen/go/v1/responses",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${callerKey}`,
              "Content-Type": "application/json",
              // zen/go per-conversation session header — forward the
              // caller's session id (see SESSION_SOURCE_HEADERS).
              ...sessionHeader(request),
            },
            body: request.body,
          },
        );
        if (!upstream.ok) {
          let message = `Upstream ${upstream.status}`;
          try {
            const err = await upstream.json();
            message = err.error?.message || err.message || message;
          } catch {}
          return jsonError(upstream.status, message, "api_error", cors);
        }
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            ...cors,
          },
        });
      }

      // POST /v1/messages — native Anthropic passthrough. Caller gate:
      // x-api-key must match env.CLIENT_KEY (same style as zen-go-proxy).
      // Default-CLOSED — when CLIENT_KEY is unset every request is refused;
      // never fall through to the paid OPENCODE_GO_API_KEY.
      if (!(request.method === "POST" && url.pathname.endsWith(VERIFY_PATH))) {
        return jsonError(404, "Not Found", "not_found_error", cors);
      }

      const clientKey = request.headers.get("x-api-key") || "";
      if (!env.CLIENT_KEY || !(await safeEq(clientKey, env.CLIENT_KEY))) {
        return jsonError(401, "Missing or invalid x-api-key", "authentication_error", cors);
      }

      const upstream = await fetchUpstreamHeaders(
        "https://opencode.ai/zen/go" + VERIFY_PATH,
        {
          method: "POST",
          headers: {
            "x-api-key": env.OPENCODE_GO_API_KEY,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: request.body,
        },
      );
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
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          ...cors,
        },
      });
    } catch (error) {
      // Never leak internal detail — generic client text, full detail in log.
      console.error(`[zen-us] handler error: ${error?.stack || error}`);
      return jsonError(500, "Internal error", "api_error", cors);
    }
  },
};

// Pick the caller's conversation-id header (in zen/go preference order) for
// forwarding as x-opencode-session. Empty → {} so the spread adds nothing.
function sessionHeader(request) {
  for (const n of SESSION_SOURCE_HEADERS) {
    const v = (request.headers.get(n) || "").trim();
    if (v) return { "x-opencode-session": v };
  }
  return {};
}

function jsonError(status, message, type, cors = {}) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
