/**
 * Anthropic <-> OpenAI translation layer (og channel) - pure data transforms,
 * zero env dependency. Extracted from index.js (2026-08-12 refactor).
 */

export function toOpenAIRequest(req: any, model: string): any {
  const messages = [];
  if (req.system) {
    const text = Array.isArray(req.system)
      ? req.system
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n")
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
        let textBuf: any[] = [];
        const flush = () => {
          if (textBuf.length) {
            parts.push({ type: "text", text: textBuf.join("\n") });
            textBuf = [];
          }
        };
        for (const b of content) {
          if (b.type === "tool_result") {
            flush();
            const toolText =
              typeof b.content === "string"
                ? b.content
                : (b.content || []).map((c: any) => c.text || c.thinking || "").join("\n");
            messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolText });
          } else if (b.type === "text") {
            textBuf.push(b.text);
          } else if (b.type === "image") {
            flush();
            const mediaType = b.source?.media_type || "image/png";
            const data = b.source?.data || "";
            if (data)
              parts.push({
                type: "image_url",
                image_url: { url: `data:${mediaType};base64,${data}` },
              });
          }
        }
        flush();
        if (parts.length) messages.push({ role: "user", content: parts });
      }
    } else if (m.role === "assistant") {
      const msg: any = { role: "assistant", content: null };
      const content = typeof m.content === "string" ? m.content : m.content || [];
      const textParts = [],
        thinkParts = [],
        toolCalls = [];
      if (typeof content === "string") textParts.push(content);
      else {
        for (const b of content) {
          if (b.type === "thinking") thinkParts.push(b.thinking);
          else if (b.type === "text") textParts.push(b.text);
          else if (b.type === "tool_use") {
            toolCalls.push({
              id: b.id,
              type: "function",
              function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
            });
          }
        }
      }
      if (textParts.length) msg.content = textParts.join("\n");
      if (thinkParts.length) msg.reasoning_content = thinkParts.join("\n");
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      messages.push({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
    }
  }

  const out: any = { model, messages, stream: !!req.stream };
  if (req.max_tokens) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.tools?.length) {
    out.tools = req.tools.map((t: any) => {
      // OpenAI function tools require parameters to be a JSON Schema object.
      // Claude Code may send an empty/absent input_schema for server-side tools
      // like web_search, which some backends (opencode zen) reject. Normalize it.
      const raw = t.input_schema && typeof t.input_schema === "object" ? t.input_schema : {};
      const parameters = raw.type ? raw : { type: "object", properties: raw.properties || {} };
      return {
        type: "function",
        function: { name: t.name, description: t.description || "", parameters },
      };
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

export function toAnthropicResponse(up: any, model: string): any {
  const choice = up.choices?.[0];
  const msg = choice?.message || {};
  const blocks = [];
  if (msg.reasoning_content)
    blocks.push({ type: "thinking", thinking: msg.reasoning_content, signature: "" });
  if (msg.content) blocks.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      /* malformed args */
    }
    blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name || "unknown", input });
  }
  return {
    id: up.id,
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: STREAM_STOP_MAP[choice?.finish_reason] || "end_turn",
    stop_sequence: null,
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

const STREAM_STOP_MAP: Record<string, string> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
};

/**
 * Convert an OpenAI chat.completion.chunk stream into an Anthropic message event
 * stream. `upstreamBody` is a ReadableStream of OpenAI SSE (`data: {...}\n\n`,
 * terminated by `data: [DONE]`). Returns a ReadableStream emitting Anthropic SSE.
 */
export function streamOgToAnthropic(
  upstreamBody: ReadableStream,
  clientModel: string,
  upstreamModel: string,
): ReadableStream {
  const encoder = new TextEncoder();
  const encoderStream = new AnthropicStreamEncoder(clientModel, upstreamModel);

  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Consume every COMPLETE event in `buffer` (SSE events end at a blank line;
  // a trailing partial frame stays buffered for the next read). Shared by the
  // live path and the closing branches — the done/died branches MUST drain
  // too: the final read can deliver whole events (a single-segment body), and
  // anything left unparsed there was silently dropped from the answer's tail.
  const parseBuffered = (): void => {
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        encoderStream.push(JSON.parse(payload));
      } catch {
        /* malformed JSON frame */
      }
    }
  };

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
        // Idle watchdog REMOVED (round-61): the 60s per-read timeout aborted
        // legitimate slow streams (long model thinking / network jitter >60s
        // without bytes) and injected an api_error frame → client "API error".
        // The "dead relay hangs forever" case it guarded was never observed;
        // per the no-defensive-programming rule the stream is untimed again.
        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          // Mid-stream upstream death AFTER content was emitted must NOT be
          // fabricated into a clean completed message — emit an error event
          // so the client retries instead of showing an empty turn.
          // Same drain as the done branch: complete events buffered before
          // the stream died still belong in the client's answer.
          parseBuffered();
          // round-126: skip when finished — an error FRAME already emitted
          // the terminal error; a read-throw after it must not double-report
          // a contradictory "died mid-response".
          if ((buffer || encoderStream.started) && !encoderStream.finished) {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream stream died mid-response" } })}\n\n`,
              ),
            );
          }
          const tail = encoderStream.finish(buffer);
          if (tail) controller.enqueue(encoder.encode(tail));
          controller.close();
          return;
        }
        const { done, value } = chunk;
        if (done) {
          // Drain complete events the final read delivered BEFORE closing —
          // without this they were dropped (finish()'s tail-parse only sees an
          // unterminated fragment, and the live loop never got another turn).
          parseBuffered();
          // round-99: a 200 SSE body with ZERO parseable frames (dead
          // backend, wrong content-type) yielded a silent empty assistant
          // message AND recorded a breaker success. Surface it.
          // round-100: the empty check alone missed a one-line non-SSE body
          // ('Internal Server Error', no \n\n) — buffer was non-empty, no
          // data: line ever parsed, finish() still emitted an empty turn.
          // Any leftover buffer with no data: line is the same failure.
          const hasDataLine = buffer.split("\n").some((l) => l.startsWith("data:"));
          // round-101: `!hasDataLine` alone missed an SSE-shaped body whose
          // data: lines carried no parseable event (empty choices / empty
          // delta / [DONE] only) — started stays false and finish() emitted
          // a silent empty turn. Any stream that never produced a single
          // content event is the same failure class.
          if (!encoderStream.started) {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream returned an empty/non-SSE stream" } })}\n\n`,
              ),
            );
            controller.close();
            return;
          }
          void hasDataLine;
          const tail = encoderStream.finish(buffer);
          if (tail) controller.enqueue(encoder.encode(tail));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines; a data line may be split across
        // read chunks, so only consume complete events.
        // round-116: the old parser split ONLY on "\n\n" — an SSE-compliant
        // CRLF stream (separators "\r\n\r\n", which several upstreams use)
        // never matched, so no event ever parsed and the whole response
        // became "upstream returned an empty/non-SSE stream" (or a merged
        // mid-answer drop on mixed line endings). Normalize CRLF → LF first.
        buffer = buffer.replace(/\r\n/g, "\n");
        parseBuffered();
        const events = encoderStream.take();
        if (events.length) {
          // round-116: real backpressure. The old `await Promise.resolve()`
          // after each enqueue did NOT pace the consumer — pull() is not
          // re-entered while an enqueued item is unconsumed at the default
          // HWM=1, but the loop kept draining the WHOLE upstream buffer
          // into the stream queue in one pull, so a slow client let one
          // pull() buffer the entire upstream response in memory. Emit one
          // event batch per pull() and RETURN — the stream's desiredSize
          // gates the next pull, pacing the reader.
          controller.enqueue(encoder.encode(events));
          return;
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
  clientModel: string;
  upstreamModel: string;
  started = false;
  finished = false;
  blockIndex = -1;
  blockType: string | null = null; // "thinking" | "text" | "tool_use"
  toolIdx: number | undefined = undefined; // current OpenAI tool index (parallel calls)
  nextToolBlockIdx = 0; // running content-block index for tool blocks
  toolBlockIdxMap: Record<number, number> = {}; // tool index → its content-block index
  toolMeta: Record<number, { id: string; name: string }> = {}; // tool index → real id/name (round-116)
  startedBlocks: Set<number> = new Set(); // content-block indices whose start was emitted (round-116)
  openToolInputs: Record<number, string> = {}; // tool index → accumulated arguments string
  // round-96: content-block indices already stopped by a type-switch close —
  // finish() must NOT emit a duplicate content_block_stop for them, but the
  // toolBlockIdxMap entry must SURVIVE (an interleaved stream can resume the
  // tool's input_json_delta after a text block; deleting the entry made the
  // resume open a bogus second tool_use block).
  stoppedToolBlocks: Set<number> = new Set();
  pending: string[] = [];
  lastStopReason = "end_turn";
  id = "";
  usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  declare toolName?: string; // assigned only in ensureToolBlock (write-only in the original JS)

  constructor(clientModel: string, upstreamModel: string) {
    this.clientModel = clientModel;
    this.upstreamModel = upstreamModel;
    this.started = false;
    this.finished = false;
    this.blockIndex = -1;
    this.blockType = null; // "thinking" | "text" | "tool_use"
    this.toolIdx = undefined; // current OpenAI tool index (parallel calls)
    this.nextToolBlockIdx = 0; // running content-block index for tool blocks
    this.toolBlockIdxMap = {}; // tool index → its content-block index
    this.openToolInputs = {}; // tool index → accumulated arguments string
    this.pending = [];
    this.lastStopReason = "end_turn";
    this.id = "";
    this.usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }

  push(chunk: any): void {
    if (this.finished) return;
    // round-116: capture usage BEFORE the choice guard — OpenAI streams end
    // with a usage-only chunk ({choices:[], usage:{...}}) that the old
    // `if (!choice) return` dropped entirely, so the client never received
    // input/cache token counts (message_start fired with zeros).
    if (chunk.usage) {
      this.usage.input_tokens = chunk.usage.prompt_tokens || 0;
      this.usage.output_tokens = chunk.usage.completion_tokens || 0;
      // zen reports cache hits as usage.prompt_tokens_details.cached_tokens —
      // read both names, same as toAnthropicResponse.
      this.usage.cache_read_input_tokens =
        chunk.usage.prompt_cache_hit_tokens ||
        chunk.usage.prompt_tokens_details?.cached_tokens ||
        0;
    }
    // round-123/124: a mid-stream upstream error frame (OpenAI shape
    // {"error":{...}}) was silently dropped by the choices guard below — the
    // client got a complete-looking TRUNCATED answer with no error, no
    // retry, and the breaker never learned. Surface it as a TERMINAL error
    // event: the error frame ends the stream (no message_delta/message_stop
    // after it, no further chunks translated), and the done-branch's
    // empty-stream check is skipped (started is set so it won't double-fire
    // with a misleading second error).
    if (chunk.error) {
      const msg = chunk.error?.message || "upstream stream error";
      this.pending.push(
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `upstream mid-stream error: ${msg}` } })}\n\n`,
      );
      this.started = true; // suppress the done-branch empty-stream error
      this.finished = true;
      return;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (!this.id && chunk.id) this.id = chunk.id;
    if (choice.finish_reason)
      this.lastStopReason = STREAM_STOP_MAP[choice.finish_reason] || "end_turn";

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
  finish(tailBuffer: string = ""): string | null {
    if (this.finished) return null;
    if (tailBuffer.trim()) {
      // A trailing partial event (no blank line yet) — best-effort parse.
      // Must run BEFORE finished=true: push() early-returns once finished, so
      // the old order made this parse dead code and dropped the tail frame.
      const dataLine = tailBuffer.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine) {
        const payload = dataLine.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            this.push(JSON.parse(payload));
          } catch {
            /* malformed JSON */
          }
        }
      }
    }
    this.finished = true;
    // The client expects message_start to be the first event.
    if (!this.started) this.emitStart();
    // round-116: emit any DELAYED content_block_start (the new-tool branch
    // waits for the id/name chunk; a stream that ended before it arrived
    // would otherwise close a block that was never opened — protocol error).
    for (const [idx, bi] of Object.entries(this.toolBlockIdxMap)) {
      const meta = this.toolMeta[Number(idx)];
      if (!meta || this.stoppedToolBlocks.has(bi) || this.startedBlocks.has(bi)) continue;
      this.pending.push(
        sse("content_block_start", {
          type: "content_block_start",
          index: bi,
          content_block: {
            type: "tool_use",
            id: meta.id || "",
            name: meta.name || "unknown",
            input: {},
          },
        }),
      );
    }
    // Close EVERY still-open tool block (parallel calls leave several open).
    // round-96: skip blocks already stopped by a type-switch (they'd get a
    // duplicate content_block_stop — the round-95 bug).
    for (const bi of new Set(Object.values(this.toolBlockIdxMap))) {
      if (this.stoppedToolBlocks.has(bi)) continue;
      this.pending.push(sse("content_block_stop", { type: "content_block_stop", index: bi }));
    }
    // round-68: close the open TEXT/THINKING block before resetting — the
    // old order reset blockIndex to -1 first, so the final text block never
    // got content_block_stop (every plain chat reply ended with an
    // unterminated block; strict clients read it as truncated). Tool blocks
    // were already closed above (the toolBlockIdxMap loop), so skip them —
    // re-closing a finished tool block would emit a spurious stop.
    if (this.blockType !== null && this.blockType !== "tool_use") this.closeBlock();
    this.toolBlockIdxMap = {};
    this.blockIndex = -1;
    this.blockType = null;
    this.pending.push(
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: this.lastStopReason, stop_sequence: null },
        // round-116: the old delta carried ONLY output_tokens — input and
        // cache-read were dropped, so the client's cache-hit tracking read 0%
        // and its usage accounting was wrong (the non-stream path delivers
        // all three). The usage-only final chunk is now captured in push()
        // and reported here.
        usage: { ...this.usage },
      }),
    );
    this.pending.push(sse("message_stop", { type: "message_stop" }));
    return this.take();
  }

  /** Drain queued Anthropic SSE text. */
  take(): string {
    if (this.pending.length) {
      const out = this.pending.join("");
      this.pending = [];
      return out;
    }
    return "";
  }

  emitStart(): void {
    if (this.started) return;
    this.started = true;
    this.pending.push(
      sse("message_start", {
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
      }),
    );
  }

  ensureBlock(type: string, block: any): void {
    if (!this.started) this.emitStart();
    if (this.blockType !== type) {
      this.closeBlock();
      // Shared index counter — tool blocks allocate from the same sequence so
      // text/thinking and tool blocks never collide on an index.
      this.blockIndex = this.nextToolBlockIdx++;
      this.blockType = type;
      // round-96: content_block_start must hold the block's INITIAL state,
      // not the first chunk — the same chunk was also emitted as the first
      // delta below, so clients got the first chunk twice (the Anthropic SDK
      // seeds the block from start, then appends deltas). Start with an empty
      // content block; the deltas carry everything.
      const contentBlock =
        type === "thinking"
          ? // round-97: keep the `signature` field (empty) — strict client
            // parsers hard-fail on its absence (claude-agent-sdk-python
            // KeyError 'signature'; anthropic-sdk-csharp threw on eager access).
            { type: "thinking", thinking: "", signature: "" }
          : type === "text"
            ? { type: "text", text: "" }
            : { type: "tool_use", id: block.id || "", name: block.name || "unknown", input: {} };
      this.pending.push(
        sse("content_block_start", {
          type: "content_block_start",
          index: this.blockIndex,
          content_block: contentBlock,
        }),
      );
      if (type === "thinking") {
        this.pending.push(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: this.blockIndex,
            delta: { type: "thinking_delta", thinking: block.thinking },
          }),
        );
      } else if (type === "text") {
        this.pending.push(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: this.blockIndex,
            delta: { type: "text_delta", text: block.text },
          }),
        );
      }
    } else if (type === "thinking") {
      this.pending.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "thinking_delta", thinking: block.thinking },
        }),
      );
    } else if (type === "text") {
      this.pending.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "text_delta", text: block.text },
        }),
      );
    }
  }

  ensureToolBlock(idx: number, id: string, name: string, argsDelta: string): void {
    if (!this.started) this.emitStart();
    // PARALLEL tool calls: OpenAI streams multiple tools with increasing
    // indices (each new tool's first chunk carries its id/name). Each tool
    // gets its OWN content block, indexed by its tool index (a running
    // counter re-emitted duplicate indices on interleaved 0,1,0,1 streams —
    // round-19). text/thinking blocks stay on the running blockIndex and
    // close before a tool block opens.
    if (this.blockType !== null && this.blockType !== "tool_use") this.closeBlock();
    // round-116: track the tool's real id/name on the map — an upstream
    // (or the exit proxy) can stream {index, function:{arguments}} FIRST and
    // the id/name on a LATER chunk. The old code emitted content_block_start
    // with id:""/name:"unknown" on that first chunk and then DROPPED the
    // late id (map-hit branch ignored it) / stored the name in a write-only
    // field — the client saw a tool_use named "unknown" with an empty id and
    // could never match the tool_result round-trip. The start is now
    // DELAYED until a chunk carries the id or name (or until finish()).
    const meta = this.toolBlockIdxMap[idx] !== undefined;
    if (meta && (id || name))
      this.toolMeta[idx] = {
        id: id || this.toolMeta[idx]?.id || "",
        name: name || this.toolMeta[idx]?.name || "",
      };
    // If this tool already has a block, route to it (interleaved streams
    // return to tool 0 after tool 1 started) — never re-open.
    if (this.toolBlockIdxMap[idx] !== undefined) {
      this.blockIndex = this.toolBlockIdxMap[idx];
      // round-97: resuming a block that was stopped by a type-switch
      // re-opens it — it MUST be re-stopped at finish(). Remove it from
      // stoppedToolBlocks so finish()'s loop emits content_block_stop again
      // (the mirror of the R96 fix: the old code kept it stopped, so the
      // resumed block never got its stop and the tool_use was unterminated
      // at message_stop).
      this.stoppedToolBlocks.delete(this.blockIndex);
      this.blockType = "tool_use";
      if (name) this.toolName = name;
      if (argsDelta) {
        const cur = this.openToolInputs[idx] || "";
        this.openToolInputs[idx] = cur + argsDelta;
        this.pending.push(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: this.blockIndex,
            delta: { type: "input_json_delta", partial_json: argsDelta },
          }),
        );
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
    // round-116: remember this tool's real id/name even when they arrive on
    // a LATER chunk — used to re-open with the correct name at finish() if
    // the start went out as "unknown".
    if (id || name)
      this.toolMeta[idx] = { id: id || "", name: name || this.toolMeta[idx]?.name || "" };
    // round-116: delay content_block_start until the id or name is known —
    // an upstream streaming {index, arguments} first would otherwise lock
    // the block to id:""/name:"unknown" forever (the map-hit branch dropped
    // the late id). The args accumulate in openToolInputs meanwhile; the
    // start (with the real id/name) is emitted on the first chunk that
    // carries them, or at finish() with whatever arrived.
    const haveMeta = !!(id || name || this.toolMeta[idx]?.name);
    if (haveMeta) {
      const m = this.toolMeta[idx] || { id: "", name: "" };
      this.pending.push(
        sse("content_block_start", {
          type: "content_block_start",
          index: this.blockIndex,
          content_block: {
            type: "tool_use",
            id: m.id || id || "",
            name: m.name || name || "unknown",
            input: {},
          },
        }),
      );
      this.startedBlocks.add(this.blockIndex);
      if (name) this.toolName = name;
    }
    if (argsDelta) {
      const cur = this.openToolInputs[idx] || "";
      const next = cur + argsDelta;
      this.openToolInputs[idx] = next;
      // Route the delta to THIS tool's block index (interleaved streams).
      const deltaIdx = this.toolBlockIdxMap[idx] ?? this.blockIndex;
      this.pending.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: deltaIdx,
          delta: { type: "input_json_delta", partial_json: argsDelta },
        }),
      );
    }
  }

  closeBlock(): void {
    if (this.blockIndex >= 0) {
      this.pending.push(
        sse("content_block_stop", { type: "content_block_stop", index: this.blockIndex }),
      );
      // round-95: a block closed here (type switch mid-stream) must not be
      // stopped AGAIN by finish()'s toolBlockIdxMap loop — that emitted a
      // duplicate content_block_stop for an already-stopped index (protocol
      // violation strict clients read as a corrupted stream).
      // round-96: record the stopped index instead of deleting the map entry
      // — an interleaved upstream stream can resume this tool's
      // input_json_delta after the text block, and deleting the entry made
      // the resume open a bogus second tool_use block (name "unknown").
      if (this.blockType === "tool_use") this.stoppedToolBlocks.add(this.blockIndex);
      this.blockIndex = -1;
      this.blockType = null;
    }
  }
}

/* ---------------- Anthropic SSE event stream ---------------- */

export function sse(name: string, data: any): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function toSSE(res: any): string {
  let out = "";
  out += sse("message_start", {
    type: "message_start",
    message: { ...res, content: [], stop_reason: null, stop_sequence: null },
  });
  res.content.forEach((block: any, i: number) => {
    // server_tool_use starts with empty input in Anthropic's wire format; the query
    // arrives via input_json_delta. web_search_tool_result carries its full content
    // array inside content_block_start (matches DeepSeek's stream).
    // round-96: content_block_start initializes the block EMPTY — the full
    // content was also emitted as the first delta below (double-emit).
    const startBlock = { ...block, text: "", thinking: "", input: {} };
    out += sse("content_block_start", {
      type: "content_block_start",
      index: i,
      content_block: startBlock,
    });
    if (block.type === "thinking") {
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "thinking_delta", thinking: block.thinking },
      });
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "signature_delta", signature: block.signature || "" },
      });
    } else if (block.type === "text") {
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "text_delta", text: block.text },
      });
    } else if (block.type === "tool_use") {
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    } else if (block.type === "server_tool_use") {
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) },
      });
    }
    out += sse("content_block_stop", { type: "content_block_stop", index: i });
  });
  out += sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: res.stop_reason, stop_sequence: null },
    usage: { output_tokens: res.usage?.output_tokens || 0 },
  });
  out += sse("message_stop", { type: "message_stop" });
  return out;
}
