// Gateway reliability unit tests — pure local, no Cloudflare calls.
//
// Covers the 2026-08-04 og/ incident hardening: upstream timeouts (slow
// failures are not retried), the per-channel circuit breaker, the CJK-aware
// count_tokens estimate, and zen's cache-hit usage field mapping.
import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithTimeout,
  fetchZenWithRetry,
  estimateTokens,
  BreakerDO,
  toAnthropicResponse,
  AnthropicStreamEncoder,
} from "../src/index.js";

// ── fetch mocking ───────────────────────────────────────────────

let fetchCalls = 0;
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetchCalls++; return handler(...args); };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

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

// ── fetchZenWithRetry: slow failures are NOT retried ────────────

test("timeout: single attempt, no retry, detail says timeout", async () => {
  await withFetch(never, async () => {
    fetchCalls = 0;
    const { response, detail } = await fetchZenWithRetry("https://zen.example", reqInit, { timeoutMs: 30 });
    assert.equal(response, null);
    assert.match(detail, /^timeout after 30ms$/);
    assert.equal(fetchCalls, 1); // slow failure → no retry
  });
});

test("network error: single attempt, no retry", async () => {
  await withFetch(async () => { throw new TypeError("fetch failed"); }, async () => {
    fetchCalls = 0;
    const { response, detail } = await fetchZenWithRetry("https://zen.example", reqInit, { timeoutMs: 1000 });
    assert.equal(response, null);
    assert.match(detail, /^network error: /);
    assert.equal(fetchCalls, 1);
  });
});

test("fast 500 ×3: retried, detail says retried 3/3", async () => {
  await withFetch(async () => ok(500, { error: { message: "Internal server error" } }), async () => {
    fetchCalls = 0;
    const { response, detail } = await fetchZenWithRetry("https://zen.example", reqInit, { timeoutMs: 1000 });
    assert.equal(response.status, 500);
    assert.match(detail, /upstream 500 \(retried 3\/3\)/);
    assert.equal(fetchCalls, 3);
  });
});

test("500 then 200: retry succeeds, no detail", async () => {
  let n = 0;
  await withFetch(async () => (++n === 1 ? ok(500) : ok(200, { id: "x" })), async () => {
    fetchCalls = 0;
    const { response, detail } = await fetchZenWithRetry("https://zen.example", reqInit, { timeoutMs: 1000 });
    assert.equal(response.status, 200);
    assert.equal(detail, "");
    assert.equal(fetchCalls, 2);
  });
});

test("429 counts as retryable", async () => {
  await withFetch(async () => ok(429), async () => {
    fetchCalls = 0;
    const { response } = await fetchZenWithRetry("https://zen.example", reqInit, { timeoutMs: 1000 });
    assert.equal(response.status, 429);
    assert.equal(fetchCalls, 3);
  });
});

test("fetchWithTimeout throws TimeoutError on abort", async () => {
  await withFetch(never, async () => {
    await assert.rejects(() => fetchWithTimeout("https://x", {}, 20), (e) => e.name === "TimeoutError" && /timeout after 20ms/.test(e.message));
  });
});

// ── Circuit breaker (Durable Object — shared, strongly consistent) ──

test("BreakerDO: trip → check open, expires after 60s, clear resets", async () => {
  const storage = {
    _m: new Map(),
    async get(k) { return this._m.get(k); },
    async put(k, v) { this._m.set(k, v); },
    async delete(k) { this._m.delete(k); },
  };
  const do_ = new BreakerDO({ storage }, {});
  const realNow = Date.now;
  try {
    assert.equal(await (await do_.fetch(new Request("https://breaker/check"))).text(), "0");
    await do_.fetch(new Request("https://breaker/trip"));
    assert.equal(await (await do_.fetch(new Request("https://breaker/check"))).text(), "1");
    Date.now = () => realNow() + 61 * 1000; // degrade window over
    assert.equal(await (await do_.fetch(new Request("https://breaker/check"))).text(), "0");
    await do_.fetch(new Request("https://breaker/clear"));
    await do_.fetch(new Request("https://breaker/trip"));
    assert.equal(await (await do_.fetch(new Request("https://breaker/check"))).text(), "1");
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
