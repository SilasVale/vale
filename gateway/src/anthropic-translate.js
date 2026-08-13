/**
 * Anthropic <-> OpenAI translation layer (og channel) - pure data transforms,
 * zero env dependency. Extracted from index.js (2026-08-12 refactor).
 */

export function toOpenAIRequest(req, model) {
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
      if (typeof content === "string") {
        if (content) messages.push({ role: "user", content });
      } else {
        // Keep text and image parts together as an OpenAI content array, so the
        // og/ translation forwards images (vision models) instead of dropping them.
        const parts = [];
        let textBuf = [];
        const flush = () => { if (textBuf.length) { parts.push({ type: "text", text: textBuf.join("\n") }); textBuf = []; } };
        for (const b of content) {
          if (b.type === "tool_result") {
            flush();
            const toolText =
              typeof b.content === "string" ? b.content : (b.content || []).map((c) => c.text || c.thinking || "").join("\n");
            messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolText });
          } else if (b.type === "text") {
            textBuf.push(b.text);
          } else if (b.type === "image") {
            flush();
            const mediaType = b.source?.media_type || "image/png";
            const data = b.source?.data || "";
            if (data) parts.push({ type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } });
          }
        }
        flush();
        if (parts.length) messages.push({ role: "user", content: parts });
      }
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

  const out = { model, messages, stream: !!req.stream };
  if (req.max_tokens) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => {
      // OpenAI function tools require parameters to be a JSON Schema object.
      // Claude Code may send an empty/absent input_schema for server-side tools
      // like web_search, which some backends (opencode zen) reject. Normalize it.
      const raw = t.input_schema && typeof t.input_schema === "object" ? t.input_schema : {};
      const parameters = raw.type ? raw : { type: "object", properties: raw.properties || {} };
      return { type: "function", function: { name: t.name, description: t.description || "", parameters } };
    });
    if (req.tool_choice) {
      const tc = req.tool_choice;
      if (tc.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
      else if (tc.type === "any") out.tool_choice = "required";
      else out.tool_choice = "auto";
    }
  }
  return out;
}



export function toAnthropicResponse(up, model) {
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
  return {
    id: up.id, type: "message", role: "assistant", model,
    content: blocks,
    stop_reason: STREAM_STOP_MAP[choice?.finish_reason] || "end_turn", stop_sequence: null,
    usage: {
      input_tokens: up.usage?.prompt_tokens || 0,
      output_tokens: up.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      // zen reports prompt cache hits as usage.prompt_tokens_details.cached_tokens
      // (OpenAI naming), not prompt_cache_hit_tokens — read both so cache hits
      // surface to the client instead of always showing 0.
      cache_read_input_tokens:
        up.usage?.prompt_cache_hit_tokens || up.usage?.prompt_tokens_details?.cached_tokens || 0,
    },
  };
}

/* ---------------- True streaming: OpenAI SSE chunks → Anthropic SSE ---------------- */
// The og/ route used to request zen with stream:false, buffer the entire response,
// then flush it as one Anthropic SSE blob. That made long thinking look frozen and
// could time out on big generations. Instead we stream:true upstream and translate
// each OpenAI chunk to an Anthropic incremental event as it arrives.

const STREAM_STOP_MAP = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens" };

/**
 * Convert an OpenAI chat.completion.chunk stream into an Anthropic message event
 * stream. `upstreamBody` is a ReadableStream of OpenAI SSE (`data: {...}\n\n`,
 * terminated by `data: [DONE]`). Returns a ReadableStream emitting Anthropic SSE.
 */
/**
 * Wrap a passthrough SSE body with the idle watchdog (round-57): a relay
 * that stops sending bytes WITHOUT closing the stream would hang the client
 * forever (the old passthrough had no per-read timeout once headers landed).
 * Any byte resets the 60s clock; a stall re-emits the torn-stream error so
 * the client can retry. Returns a new ReadableStream.
 */
export function withIdleWatchdog(upstreamBody, idleMs = 60_000) {
  const reader = upstreamBody.getReader();
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      let chunk;
      let timer;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            // round-58: hold the timer handle so a completed read clears it —
            // an un-cleared timer kept the isolate alive 60s per idle-hit.
            timer = setTimeout(() => reject(Object.assign(new Error("stream idle"), { name: "IdleError" })), idleMs);
          }),
        ]);
        clearTimeout(timer);
      } catch (e) {
        clearTimeout(timer);
        if (e.name === "IdleError") {
          // Same error-frame shape as the translate path (round-58): the
          // passthrough previously emitted a bare data: frame with no
          // event: error header — clients keyed on the event type missed it.
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream stream idle (no bytes for 60s)" } })}\n\n`));
          // Stop pulling from the dead upstream (round-58): without cancel
          // its bytes kept flowing into the closed controller.
          reader.cancel().catch(() => {});
        }
        controller.close();
        return;
      }
      const { done, value } = chunk;
      if (done) { controller.close(); return; }
      controller.enqueue(value);
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
}

export function streamOgToAnthropic(upstreamBody, clientModel, upstreamModel) {
  const encoder = new TextEncoder();
  const encoderStream = new AnthropicStreamEncoder(clientModel, upstreamModel);

  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readStream = new ReadableStream({
    async pull(controller) {
      while (true) {
        // Emit any pending Anthropic events already queued by the last chunk.
        const pending = encoderStream.take();
        if (pending.length) {
          controller.enqueue(encoder.encode(pending));
          return;
        }
        // Otherwise pull the next upstream bytes. An upstream that dies
        // mid-stream (network drop, 5xx body cut) must end the Anthropic SSE
        // gracefully — close open blocks and emit message_stop instead of
        // leaving the client hanging on a torn stream.
        // Idle watchdog (round-57, dsh idleWatchdog): a relay that stops
        // sending bytes WITHOUT closing the stream would hang the request
        // forever (the old code had no per-read timeout once headers
        // landed). Any byte resets the 60s clock; a stall → error event.
        let chunk;
        let timer;
        try {
          chunk = await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
              // Hold the handle (round-59, aligning with withIdleWatchdog):
              // a completed read must clear it or the isolate is kept alive
              // up to 60s per read.
              timer = setTimeout(() => reject(Object.assign(new Error("stream idle"), { name: "IdleError" })), 60_000);
            }),
          ]);
          clearTimeout(timer);
        } catch (e) {
          clearTimeout(timer);
          // Stop pulling from the dead upstream (round-59): without cancel
          // its bytes kept flowing into the closed controller.
          await reader.cancel().catch(() => {});
          if (e.name === "IdleError") {
            if (buffer || encoderStream.started) {
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream stream idle (no bytes for 60s)" } })}\n\n`));
            }
            const tail = encoderStream.finish(buffer);
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.close();
            return;
          }
          // Mid-stream upstream death AFTER content was emitted must NOT be
          // fabricated into a clean completed message — emit an error event
          // so the client retries instead of showing an empty turn.
          if (buffer || encoderStream.started) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream stream died mid-response" } })}\n\n`));
          }
          const tail = encoderStream.finish(buffer);
          if (tail) controller.enqueue(encoder.encode(tail));
          controller.close();
          return;
        }
        const { done, value } = chunk;
        if (done) {
          const tail = encoderStream.finish(buffer);
          if (tail) controller.enqueue(encoder.encode(tail));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines; a data line may be split across
        // read chunks, so only consume complete events.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (payload === "[DONE]") continue;
          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; }
          encoderStream.push(chunk);
          const events = encoderStream.take();
          if (events.length) {
            controller.enqueue(encoder.encode(events));
            return;
          }
        }
      }
    },
  });
  return readStream;
}

/**
 * Stateful translator from OpenAI stream deltas to Anthropic SSE events.
 * Accumulates tool-call arguments by index and tracks which content block is open.
 */
export class AnthropicStreamEncoder {
  constructor(clientModel, upstreamModel) {
    this.clientModel = clientModel;
    this.upstreamModel = upstreamModel;
    this.started = false;
    this.finished = false;
    this.blockIndex = -1;
    this.blockType = null;      // "thinking" | "text" | "tool_use"
    this.toolIdx = undefined;   // current OpenAI tool index (parallel calls)
    this.nextToolBlockIdx = 0;  // running content-block index for tool blocks
    this.toolBlockIdxMap = {};  // tool index → its content-block index
    this.openToolInputs = {};   // tool index → accumulated arguments string
    this.pending = [];
    this.lastStopReason = "end_turn";
    this.id = "";
    this.usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  }

  push(chunk) {
    if (this.finished) return;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (!this.id && chunk.id) this.id = chunk.id;
    if (chunk.usage) {
      this.usage.input_tokens = chunk.usage.prompt_tokens || 0;
      this.usage.output_tokens = chunk.usage.completion_tokens || 0;
      // zen reports cache hits as usage.prompt_tokens_details.cached_tokens —
      // read both names, same as toAnthropicResponse.
      this.usage.cache_read_input_tokens =
        chunk.usage.prompt_cache_hit_tokens || chunk.usage.prompt_tokens_details?.cached_tokens || 0;
    }
    if (choice.finish_reason) this.lastStopReason = STREAM_STOP_MAP[choice.finish_reason] || "end_turn";

    if (delta.reasoning_content) {
      this.ensureBlock("thinking", { thinking: delta.reasoning_content, signature: "" });
    }
    if (delta.content) {
      this.ensureBlock("text", { text: delta.content });
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      const fn = tc.function || {};
      this.ensureToolBlock(idx, tc.id, fn.name, fn.arguments || "");
    }
  }

  /** Close all open blocks and append message_delta + message_stop. Call once on stream end. */
  finish(tailBuffer = "") {
    if (this.finished) return null;
    this.finished = true;
    if (tailBuffer.trim()) {
      // A trailing partial event (no blank line yet) — best-effort parse.
      const dataLine = tailBuffer.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine) {
        const payload = dataLine.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try { this.push(JSON.parse(payload)); } catch {}
        }
      }
    }
    // The client expects message_start to be the first event.
    if (!this.started) this.emitStart();
    // Close EVERY open tool block (parallel calls leave several open).
    for (const bi of new Set(Object.values(this.toolBlockIdxMap))) {
      this.pending.push(sse("content_block_stop", { type: "content_block_stop", index: bi }));
    }
    this.toolBlockIdxMap = {};
    this.blockIndex = -1;
    this.blockType = null;
    if (this.blockIndex >= 0) this.closeBlock();
    this.pending.push(sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.lastStopReason, stop_sequence: null },
      usage: { output_tokens: this.usage.output_tokens },
    }));
    this.pending.push(sse("message_stop", { type: "message_stop" }));
    return this.take();
  }

  /** Drain queued Anthropic SSE text. */
  take() {
    if (this.pending.length) {
      const out = this.pending.join("");
      this.pending = [];
      return out;
    }
    return "";
  }

  emitStart() {
    if (this.started) return;
    this.started = true;
    this.pending.push(sse("message_start", {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.upstreamModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...this.usage },
      },
    }));
  }

  ensureBlock(type, block) {
    if (!this.started) this.emitStart();
    if (this.blockType !== type) {
      this.closeBlock();
      // Shared index counter — tool blocks allocate from the same sequence so
      // text/thinking and tool blocks never collide on an index.
      this.blockIndex = this.nextToolBlockIdx++;
      this.blockType = type;
      const contentBlock = type === "thinking" ? { ...block, signature: "" } : { ...block };
      this.pending.push(sse("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: contentBlock,
      }));
      if (type === "thinking") {
        this.pending.push(sse("content_block_delta", {
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "thinking_delta", thinking: block.thinking },
        }));
      } else if (type === "text") {
        this.pending.push(sse("content_block_delta", {
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "text_delta", text: block.text },
        }));
      }
    } else if (type === "thinking") {
      this.pending.push(sse("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "thinking_delta", thinking: block.thinking },
      }));
    } else if (type === "text") {
      this.pending.push(sse("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "text_delta", text: block.text },
      }));
    }
  }

  ensureToolBlock(idx, id, name, argsDelta) {
    if (!this.started) this.emitStart();
    // PARALLEL tool calls: OpenAI streams multiple tools with increasing
    // indices (each new tool's first chunk carries its id/name). Each tool
    // gets its OWN content block, indexed by its tool index (a running
    // counter re-emitted duplicate indices on interleaved 0,1,0,1 streams —
    // round-19). text/thinking blocks stay on the running blockIndex and
    // close before a tool block opens.
    if (this.blockType !== null && this.blockType !== "tool_use") this.closeBlock();
    // If this tool already has a block, route to it (interleaved streams
    // return to tool 0 after tool 1 started) — never re-open.
    if (this.toolBlockIdxMap[idx] !== undefined) {
      this.blockIndex = this.toolBlockIdxMap[idx];
      this.blockType = "tool_use";
      if (name) this.toolName = name;
      if (argsDelta) {
        const cur = this.openToolInputs[idx] || "";
        this.openToolInputs[idx] = cur + argsDelta;
        this.pending.push(sse("content_block_delta", {
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "input_json_delta", partial_json: argsDelta },
        }));
      }
      return;
    }
    // A NEW tool index ALWAYS opens a fresh block — even if the current
    // block is another tool_use (interleaved streams switch tools).
    if (this.blockType !== null && this.blockType !== "tool_use") this.closeBlock();
    this.toolIdx = idx;
    // Track this tool's dedicated block index (may interleave with text).
    const toolBlockIdx = this.nextToolBlockIdx++;
    this.toolBlockIdxMap[idx] = toolBlockIdx;
    this.blockIndex = toolBlockIdx;
    this.blockType = "tool_use";
    this.pending.push(sse("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: { type: "tool_use", id: id || "", name: name || "unknown", input: {} },
    }));
    if (name) {
      // zen may repeat the name on later chunks; emit a partial_json delta only for args.
      this.toolName = name;
    }
    if (argsDelta) {
      const cur = this.openToolInputs[idx] || "";
      const next = cur + argsDelta;
      this.openToolInputs[idx] = next;
      // Route the delta to THIS tool's block index (interleaved streams).
      const deltaIdx = this.toolBlockIdxMap[idx] ?? this.blockIndex;
      this.pending.push(sse("content_block_delta", {
        type: "content_block_delta",
        index: deltaIdx,
        delta: { type: "input_json_delta", partial_json: argsDelta },
      }));
    }
  }

  closeBlock() {
    if (this.blockIndex >= 0) {
      this.pending.push(sse("content_block_stop", { type: "content_block_stop", index: this.blockIndex }));
      this.blockIndex = -1;
      this.blockType = null;
    }
  }
}

/* ---------------- Anthropic SSE event stream ---------------- */

export function sse(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function toSSE(res) {
  let out = "";
  out += sse("message_start", { type: "message_start", message: { ...res, content: [], stop_reason: null, stop_sequence: null } });
  res.content.forEach((block, i) => {
    // server_tool_use starts with empty input in Anthropic's wire format; the query
    // arrives via input_json_delta. web_search_tool_result carries its full content
    // array inside content_block_start (matches DeepSeek's stream).
    let startBlock = block;
    if (block.type === "server_tool_use") startBlock = { ...block, input: {} };
    out += sse("content_block_start", { type: "content_block_start", index: i, content_block: startBlock });
    if (block.type === "thinking") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: block.thinking } });
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: block.signature || "" } });
    } else if (block.type === "text") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else if (block.type === "server_tool_use") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) } });
    }
    out += sse("content_block_stop", { type: "content_block_stop", index: i });
  });
  out += sse("message_delta", { type: "message_delta", delta: { stop_reason: res.stop_reason, stop_sequence: null }, usage: { output_tokens: res.usage?.output_tokens || 0 } });
  out += sse("message_stop", { type: "message_stop" });
  return out;
}
