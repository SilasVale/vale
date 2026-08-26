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

    try {
      const clientKey = request.headers.get("x-api-key") || "";
      if (!clientKey || (env.CLIENT_KEY && clientKey !== env.CLIENT_KEY)) {
        return jsonError(401, "Missing or invalid x-api-key", "authentication_error");
      }

      // GET /v1/models — passthrough upstream model list
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        const up = await fetch("https://opencode.ai/zen/go/v1/models", {
          headers: { Authorization: `Bearer ${env.OPENCODE_GO_API_KEY}` },
        });
        return new Response(up.body, {
          status: up.status,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      // POST /v1/messages/count_tokens — estimate
      if (request.method === "POST" && url.pathname.endsWith(COUNT_PATH)) {
        const body = await request.json();
        return jsonOk({ input_tokens: Math.ceil(JSON.stringify(body.messages || []).length / 4) });
      }

      if (!(request.method === "POST" && url.pathname.endsWith(VERIFY_PATH))) {
        return jsonError(404, "Not Found", "not_found_error");
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
        },
      );
      if (!upstream.ok) {
        let message = `Upstream ${upstream.status}`;
        try {
          const err = await upstream.json();
          message = err.error?.message || message;
        } catch {}
        return jsonError(upstream.status, message, "api_error");
      }

      // Native passthrough: stream the upstream body straight through.
      if (native) {
        if (anthropicReq.stream) {
          return new Response(upstream.body, {
            headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...CORS_HEADERS },
          });
        }
        return new Response(upstream.body, {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
      const anthropicRes = toAnthropicResponse(await upstream.json(), model);
      if (anthropicReq.stream) {
        return new Response(toSSE(anthropicRes), {
          headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...CORS_HEADERS },
        });
      }
      return jsonOk(anthropicRes);
    } catch (error) {
      return jsonError(500, error.message || "Internal error", "api_error");
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

function jsonOk(data) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

function jsonError(status, message, type) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
