// Gateway reliability unit tests — pure local, no Cloudflare calls.
//
// Covers the 2026-08-04 og/ incident hardening: upstream timeouts (slow
// failures are not retried), the per-channel circuit breaker, the CJK-aware
// count_tokens estimate, and zen's cache-hit usage field mapping.
import test from "node:test";
import assert from "node:assert/strict";
import { withFetch, assertFetchCalls } from "./helpers.mjs";
import {
  fetchWithTimeout,
  fetchWithRetry,
  ogTimeoutMs,
  passthroughTimeoutMs,
  upstreamTimeoutMs,
  estimateTokens,
  BreakerDO,
  toAnthropicResponse,
  AnthropicStreamEncoder,
} from "../src/index.js";

const ok = (status = 200, body = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// A fetch that hangs until the caller's AbortController fires — like a real
// fetch would (real fetch listens to the signal; a bare `new Promise(() => {})`
// never settles and would leave the event loop idle).
const never = (url, init) => new Promise((_, reject) => {
  init?.signal?.addEventListener("abort", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    reject(e);
  });
});
const reqInit = { method: "POST", body: "{}" };

// ── fetchWithRetry: slow failures are NOT retried ────────────

test("timeout: single attempt, no retry, detail says timeout", async () => {
  await withFetch(never, async () => {
    const { response, detail } = await fetchWithRetry("https://zen.example", reqInit, { timeoutMs: 30 });
    assert.equal(response, null);
    assert.match(detail, /^timeout after 30ms$/);
    assertFetchCalls(1); // slow failure → no retry
  });
});

test("network error: single attempt, no retry", async () => {
  await withFetch(async () => { throw new TypeError("fetch failed"); }, async () => {
    const { response, detail } = await fetchWithRetry("https://zen.example", reqInit, { timeoutMs: 1000 });
    assert.equal(response, null);
    assert.match(detail, /^network error: /);
    assertFetchCalls(1);
  });
});

test("fast 500 ×3 with idempotent: retried, detail says retried 3/3", async () => {
  await withFetch(async () => ok(500, { error: { message: "Internal server error" } }), async () => {
    const { response, detail } = await fetchWithRetry("https://zen.example", reqInit, { timeoutMs: 1000, idempotent: true });
    assert.equal(response.status, 500);
    assert.match(detail, /upstream 500 \(retried 3\/3\)/);
    assertFetchCalls(3);
  });
});

test("500 ×3 NON-idempotent (billable POST): NOT retried — single attempt", async () => {
  await withFetch(async () => ok(500, { error: { message: "Internal server error" } }), async () => {
    const { response, detail } = await fetchWithRetry("https://zen.example", reqInit, { timeoutMs: 1000 });
    assert.equal(response.status, 500);
    assert.match(detail, /not retried — POST may have been billed/);
    assertFetchCalls(1);
  });
});

test("500 then 200 with idempotent: retry succeeds, no detail", async () => {
  let n = 0;
  await withFetch(async () => (++n === 1 ? ok(500) : ok(200, { id: "x" })), async () => {
    const { response, detail } = await fetchWithRetry("https://zen.example", reqInit, { timeoutMs: 1000, idempotent: true });
    assert.equal(response.status, 200);
    assert.equal(detail, "");
    assertFetchCalls(2);
  });
});

test("429 counts as retryable (not processed — safe)", async () => {
  await withFetch(async () => ok(429), async () => {
    const { response } = await fetchWithRetry("https://zen.example", reqInit, { timeoutMs: 1000 });
    assert.equal(response.status, 429);
    assertFetchCalls(3);
  });
});

test("fetchWithTimeout throws TimeoutError on abort", async () => {
  await withFetch(never, async () => {
    await assert.rejects(() => fetchWithTimeout("https://x", {}, 20), (e) => e.name === "TimeoutError" && /timeout after 20ms/.test(e.message));
  });
});

// ── og upstream timeout: 120s default absorbs max-thinking requests ──

test("ogTimeoutMs: default 120s, env override wins", () => {
  assert.equal(ogTimeoutMs({}), 120000);
  assert.equal(ogTimeoutMs({ OG_TIMEOUT_MS: "180000" }), 180000);
  assert.equal(ogTimeoutMs({ OG_TIMEOUT_MS: "0" }), 120000); // invalid → default
});

// ── passthrough timeout: og-native must use the 120s og budget, not the 30s
// generic one (deepseek-v4-flash native passthrough hit 30s 502s on zen's
// 40-54s max-thinking; the 120s only protected the translate path) ──

test("passthroughTimeoutMs: og-native gets the 120s og budget, others 30s generic", () => {
  // og → ogTimeoutMs (120s default)
  assert.equal(passthroughTimeoutMs({}, "opencode"), ogTimeoutMs({}));
  // non-og → upstreamTimeoutMs (30s default)
  assert.equal(passthroughTimeoutMs({}, "deepseek"), upstreamTimeoutMs({}));
  assert.equal(passthroughTimeoutMs({}, "qwen"), upstreamTimeoutMs({}));
  assert.equal(passthroughTimeoutMs({}, "openrouter"), upstreamTimeoutMs({}));
  // env overrides still win
  assert.equal(passthroughTimeoutMs({ OG_TIMEOUT_MS: "180000" }, "opencode"), 180000);
  assert.equal(passthroughTimeoutMs({ UPSTREAM_TIMEOUT_MS: "45000" }, "deepseek"), 45000);
});

// ── Circuit breaker (Durable Object — shared, strongly consistent) ──

function breakerDO() {
  const storage = {
    _m: new Map(),
    async get(k) { return this._m.get(k); },
    async put(k, v) { this._m.set(k, v); },
    async delete(k) { this._m.delete(k); },
  };
  return new BreakerDO({ storage }, {});
}
const check = async (do_) => (await (await do_.fetch(new Request("https://breaker/check"))).text());

test("BreakerDO: single trip does NOT open (needs 3 consecutive failures)", async () => {
  const do_ = breakerDO();
  await do_.fetch(new Request("https://breaker/trip"));
  assert.equal(await check(do_), "0");
  await do_.fetch(new Request("https://breaker/trip"));
  assert.equal(await check(do_), "0"); // still closed at 2
  await do_.fetch(new Request("https://breaker/trip"));
  assert.equal(await check(do_), "1"); // 3rd consecutive failure trips
});

test("BreakerDO: reset clears the failure count, no trip on later single failure", async () => {
  const do_ = breakerDO();
  await do_.fetch(new Request("https://breaker/trip"));
  await do_.fetch(new Request("https://breaker/trip"));
  // round-55: ONE success must not zero the count (a channel alternating
  // fail/success would never accumulate the 3 consecutive failures the
  // breaker needs) — two consecutive successes clear it.
  await do_.fetch(new Request("https://breaker/reset")); // success #1 — count kept
  await do_.fetch(new Request("https://breaker/reset")); // success #2 — count cleared
  assert.equal(await check(do_), "0");
  await do_.fetch(new Request("https://breaker/trip"));
  assert.equal(await check(do_), "0"); // count restarted, 1/3
});

test("BreakerDO: trips after threshold, expires after 60s, clear resets count too", async () => {
  const do_ = breakerDO();
  const realNow = Date.now;
  try {
    for (let i = 0; i < 3; i++) await do_.fetch(new Request("https://breaker/trip"));
    assert.equal(await check(do_), "1");
    Date.now = () => realNow() + 61 * 1000; // degrade window over
    assert.equal(await check(do_), "0");
    await do_.fetch(new Request("https://breaker/clear"));
    for (let i = 0; i < 3; i++) await do_.fetch(new Request("https://breaker/trip"));
    assert.equal(await check(do_), "1");
  } finally {
    Date.now = realNow;
  }
});

test("BreakerDO: unknown action → 404", async () => {
  const do_ = new BreakerDO({ storage: { get: async () => null, put: async () => {}, delete: async () => {} } }, {});
  const res = await do_.fetch(new Request("https://breaker/nope"));
  assert.equal(res.status, 404);
});

// ── count_tokens estimate ───────────────────────────────────────

test("estimateTokens: ascii ~4 chars/token", () => {
  assert.equal(estimateTokens('"hi"'), 1); // 4 chars incl quotes → ceil(4/4)
  assert.equal(estimateTokens("abcdefgh"), 2); // 8/4
});

test("estimateTokens: CJK weighted ~1.8 per char", () => {
  assert.equal(estimateTokens("你好"), 4); // 2 × 1.8 = 3.6 → ceil 4
  const mixed = estimateTokens(JSON.stringify({ messages: [{ role: "user", content: "请帮我查一下这个网关为什么没响应" }] }));
  assert.ok(mixed > 10, `mixed estimate too low: ${mixed}`);
});

// ── zen usage cache mapping ─────────────────────────────────────

test("toAnthropicResponse: reads prompt_tokens_details.cached_tokens", () => {
  const up = {
    id: "1",
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 248, completion_tokens: 16, prompt_tokens_details: { cached_tokens: 192 } },
  };
  const res = toAnthropicResponse(up, "deepseek-v4-flash");
  assert.equal(res.usage.cache_read_input_tokens, 192);
  assert.equal(res.usage.input_tokens, 248);
});

test("toAnthropicResponse: prompt_cache_hit_tokens wins when both present", () => {
  const up = {
    id: "1",
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 100, prompt_tokens_details: { cached_tokens: 192 } },
  };
  assert.equal(toAnthropicResponse(up, "m").usage.cache_read_input_tokens, 100);
});

test("stream encoder: cache hits from last chunk surface in message_start", () => {
  const enc = new AnthropicStreamEncoder("og/m", "m");
  enc.push({
    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 271, completion_tokens: 32, prompt_tokens_details: { cached_tokens: 192 } },
  });
  const sseOut = enc.finish();
  assert.match(sseOut, /"cache_read_input_tokens":192/);
  assert.match(sseOut, /"input_tokens":271/);
});

test("stream encoder: PARALLEL tool calls each get their own block, args not concatenated", () => {
  const enc = new AnthropicStreamEncoder("og/m", "m");
  // OpenAI's documented interleaved parallel-tool pattern (0,1,0,1): each
  // tool's arguments arrive as split fragments.
  const tc = (index, id, name, args) => ({ choices: [{ index, delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] });
  enc.push(tc(0, "toolu_0", "bash", '{"c'));
  enc.push(tc(1, "toolu_1", "read", '{"p'));
  enc.push(tc(0, undefined, undefined, 'md":"ls"}'));
  enc.push(tc(1, undefined, undefined, 'ath":"/etc"}'));
  const sseOut = enc.finish();
  // Exactly two tool_use blocks (count the EVENT line, not the type field —
  // "content_block_start" appears twice per event: event name + type).
  const starts = (sseOut.match(/event: content_block_start/g) || []).length;
  assert.equal(starts, 2);
  // Each tool's block carries its own name and a stop.
  assert.match(sseOut, /"name":"bash"/);
  assert.match(sseOut, /"name":"read"/);
  assert.equal((sseOut.match(/event: content_block_stop/g) || []).length, 2);
  // The concatenated args are separate per tool, not merged: parse the
  // input_json_delta events and rebuild each tool's accumulated arguments.
  const byTool = { 0: "", 1: "" };
  for (const ev of sseOut.split("\n\n").filter((e) => e.includes("input_json_delta"))) {
    const d = JSON.parse(ev.replace(/^event: [^\n]+\n/, "").replace(/^data: /, ""));
    byTool[d.index] += d.delta.partial_json;
  }
  assert.equal(byTool[0], '{"cmd":"ls"}');   // tool 0's fragments joined alone
  assert.equal(byTool[1], '{"path":"/etc"}'); // tool 1's fragments joined alone
});

// ── streamOgToAnthropic: upstream dies mid-stream → graceful close ──

test("stream: upstream throw closes the stream gracefully (no hang)", async () => {
  const { streamOgToAnthropic } = await import("../src/anthropic-translate.js");
  // A body whose reader.read() throws once.
  const failing = new ReadableStream({
    start(controller) { controller.error(new Error("upstream died")); },
  });
  const out = streamOgToAnthropic(failing, "auto", "deepseek-v4-flash");
  const reader = out.getReader();
  const chunks = [];
  let done = false;
  while (!done) {
    try {
      const { value, done: d } = await reader.read();
      if (d) { done = true; break; }
      chunks.push(new TextDecoder().decode(value));
    } catch { done = true; } // must not throw out of the stream
  }
  const text = chunks.join("");
  // The graceful close emits message_stop even with zero upstream bytes.
  assert.match(text, /message_stop/);
});
