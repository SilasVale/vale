/**
 * opencode-go-proxy — Cloudflare Worker
 * Dedicated to OpenCode Go: translates Claude Code's Anthropic protocol to
 * zen/go's OpenAI protocol.
 * (The unified gateway's og/ translation logic has been folded into
 * ai-gateway; this worker remains the dedicated direct entry point for
 * opencode.saisi.online)
 *
 * Keys: OPENCODE_GO_API_KEY (upstream), CLIENT_KEY (client gate, any
 * non-empty value when set)
 */

const VERIFY_PATH = "/v1/messages";
const COUNT_PATH = "/v1/messages/count_tokens";

// Upstream fetch budget: fail fast instead of hanging a client for minutes.
const UPSTREAM_TIMEOUT_MS = 30000;
// Largest request body accepted on the JSON POST paths (10MB). Bodies are
// parsed with request.json() (fully buffered), so bound memory explicitly.
const MAX_JSON_BYTES = 10 * 1024 * 1024;

// CORS allowlist: the console origins used in this repo —
//   https://ai.saisi.online + https://api.saisi.online (gateway CONSOLE_HOST),
//   https://dsh.saisi.online (extension/manifest.json host_permissions),
// plus loopback for local `wrangler dev`. Any other Origin gets NO
// Access-Control-Allow-* headers (default-closed). Non-browser clients
// (Claude Code, gateway server-side) are unaffected by CORS.
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

// Reject oversized JSON bodies BEFORE buffering them with request.json().
// Missing content-length (chunked) passes through to the normal parse path.
function jsonTooLarge(request) {
  const n = Number(request.headers.get("content-length"));
  return Number.isFinite(n) && n > MAX_JSON_BYTES;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const cors = corsHeaders(request);

    try {
      // Default-CLOSED: when CLIENT_KEY is unset every request is refused —
      // a missing gate secret must never pass callers through to the paid key.
      const clientKey = request.headers.get("x-api-key") || "";
      if (!env.CLIENT_KEY || !(await safeEq(clientKey, env.CLIENT_KEY))) {
        return jsonError(401, "Missing or invalid x-api-key", "authentication_error", cors);
      }

      // GET /v1/models — passthrough upstream model list.
      // NOTE (needs live verification): auth header changed from
      // `Authorization: Bearer` to `x-api-key` for consistency with
      // zen-us-proxy; not yet verified against the live upstream.
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

      // POST /v1/messages/count_tokens — estimate
      if (request.method === "POST" && url.pathname.endsWith(COUNT_PATH)) {
        if (jsonTooLarge(request)) {
          return jsonError(413, "Request body too large", "invalid_request_error", cors);
        }
        const body = await request.json();
        return jsonOk({ input_tokens: Math.ceil(JSON.stringify(body.messages || []).length / 4) }, cors);
      }

      if (!(request.method === "POST" && url.pathname.endsWith(VERIFY_PATH))) {
        return jsonError(404, "Not Found", "not_found_error", cors);
      }

      if (jsonTooLarge(request)) {
        return jsonError(413, "Request body too large", "invalid_request_error", cors);
      }
      const anthropicReq = await request.json();
      const model = anthropicReq.model || "deepseek-v4-flash";
      // deepseek-v4-flash is Anthropic-native on zen/go/v1/messages — forward
      // the raw request (no OpenAI translation) so the response is a true
      // Anthropic SSE stream. Other models keep the translate path below.
      const NATIVE = new Set(["deepseek-v4-flash"]);
      const native = NATIVE.has(model);
      const upstream = await fetch(
        native ? "https://opencode.ai/zen/go/v1/messages" : "https://opencode.ai/zen/go/v1/chat/completions",
        {
          method: "POST",
          headers: native
            ? { "x-api-key": env.OPENCODE_GO_API_KEY, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }
            : { Authorization: `Bearer ${env.OPENCODE_GO_API_KEY}`, "Content-Type": "application/json" },
          body: native ? JSON.stringify(anthropicReq) : JSON.stringify(toOpenAIRequest(anthropicReq, model)),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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
          console.error(`[zen-go] upstream 5xx: ${detail}`);
          return jsonError(upstream.status, "Upstream unavailable", "api_error", cors);
        }
        let message = `Upstream ${upstream.status}`;
        try {
          const err = await upstream.json();
          message = err.error?.message || message;
        } catch {}
        return jsonError(upstream.status, message, "api_error", cors);
      }

      // Native passthrough: stream the upstream body straight through.
      if (native) {
        if (anthropicReq.stream) {
          return new Response(upstream.body, {
            headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...cors },
          });
        }
        return new Response(upstream.body, {
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
      const anthropicRes = toAnthropicResponse(await upstream.json(), model);
      if (anthropicReq.stream) {
        return new Response(toSSE(anthropicRes), {
          headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...cors },
        });
      }
      return jsonOk(anthropicRes, cors);
    } catch (error) {
      // Never leak internal detail (key fragments, stack, upstream body) —
      // generic client text, full detail in the worker log.
      console.error(`[zen-go] handler error: ${error?.stack || error}`);
      return jsonError(500, "Internal error", "api_error", cors);
    }
  },
};

/* ---------------- Anthropic → OpenAI ---------------- */

function toOpenAIRequest(req, model) {
  const messages = [];
  if (req.system) {
    const text = Array.isArray(req.system)
      ? req.system.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : req.system;
    if (text) messages.push({ role: "system", content: text });
  }
  for (const m of req.messages || []) {
    if (m.role === "user") {
      const content = typeof m.content === "string" ? m.content : m.content || [];
      let textParts = [];
      if (typeof content === "string") textParts.push(content);
      else {
        for (const b of content) {
          if (b.type === "tool_result") {
            const toolText =
              typeof b.content === "string" ? b.content : (b.content || []).map((c) => c.text || c.thinking || "").join("\n");
            messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolText });
          } else if (b.type === "text") textParts.push(b.text);
        }
      }
      if (textParts.length) messages.push({ role: "user", content: textParts.join("\n") });
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: null };
      const content = typeof m.content === "string" ? m.content : m.content || [];
      const textParts = [], thinkParts = [], toolCalls = [];
      if (typeof content === "string") textParts.push(content);
      else {
        for (const b of content) {
          if (b.type === "thinking") thinkParts.push(b.thinking);
          else if (b.type === "text") textParts.push(b.text);
          else if (b.type === "tool_use") {
            toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
          }
        }
      }
      if (textParts.length) msg.content = textParts.join("\n");
      if (thinkParts.length) msg.reasoning_content = thinkParts.join("\n");
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      messages.push({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
    }
  }

  const out = { model, messages, stream: false };
  if (req.max_tokens) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || {} },
    }));
    if (req.tool_choice) {
      const tc = req.tool_choice;
      if (tc.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
      else if (tc.type === "any") out.tool_choice = "required";
      else out.tool_choice = "auto";
    }
  }
  return out;
}

/* ---------------- OpenAI → Anthropic ---------------- */

function toAnthropicResponse(up, model) {
  const choice = up.choices?.[0];
  const msg = choice?.message || {};
  const blocks = [];
  if (msg.reasoning_content) blocks.push({ type: "thinking", thinking: msg.reasoning_content, signature: "" });
  if (msg.content) blocks.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
    blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name || "unknown", input });
  }
  const stopMap = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens" };
  return {
    id: up.id, type: "message", role: "assistant", model,
    content: blocks,
    stop_reason: stopMap[choice?.finish_reason] || "end_turn", stop_sequence: null,
    usage: {
      input_tokens: up.usage?.prompt_tokens || 0,
      output_tokens: up.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: up.usage?.prompt_cache_hit_tokens || 0,
    },
  };
}

/* ---------------- Anthropic SSE ---------------- */

function sse(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function toSSE(res) {
  let out = "";
  out += sse("message_start", { type: "message_start", message: { ...res, content: [], stop_reason: null, stop_sequence: null } });
  res.content.forEach((block, i) => {
    out += sse("content_block_start", { type: "content_block_start", index: i, content_block: { ...block } });
    if (block.type === "thinking") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: block.thinking } });
    } else if (block.type === "text") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    out += sse("content_block_stop", { type: "content_block_stop", index: i });
  });
  out += sse("message_delta", { type: "message_delta", delta: { stop_reason: res.stop_reason, stop_sequence: null }, usage: { output_tokens: res.usage.output_tokens } });
  out += sse("message_stop", { type: "message_stop" });
  return out;
}

/* ---------------- Utilities ---------------- */

function jsonOk(data, cors = {}) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...cors } });
}

function jsonError(status, message, type, cors = {}) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
