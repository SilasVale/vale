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
  BreakerDO,
  retryPolicyFor,
  GLM_LOTTERY_MODEL,
} from "../src/reliability.ts";
import { estimateTokens } from "../src/body-scan.ts";
import { toAnthropicResponse, AnthropicStreamEncoder } from "../src/anthropic-translate.ts";

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

// ── Retry pacing: honor Retry-After + the or/ retry502 contract ──
// Evidence 2026-08-24: OpenRouter's free pool (Decart serving glm-5.2:free)
// answers 429 with `Retry-After: 5` — the old fixed ladder (0.75s/1.5s) re-hit
// INSIDE that cooldown so every retry failed identically.

const ra = (seconds) =>
  new Response(JSON.stringify({ error: { message: "rate limited" } }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(seconds) },
  });

test("429 honors Retry-After: second attempt waits out the cooldown", async () => {
  let n = 0;
  await withFetch(async () => (++n === 1 ? ra(1) : ok(200, { id: "x" })), async () => {
    const t0 = Date.now();
    const { response, detail } = await fetchWithRetry("https://zen.example", reqInit, {
      timeoutMs: 1000,
      backoffMs: 10, // ladder must NOT dominate — the header should
    });
    const elapsed = Date.now() - t0;
    assert.equal(response.status, 200);
    assert.equal(detail, "");
    assertFetchCalls(2);
    assert.ok(elapsed >= 950, `waited ${elapsed}ms — Retry-After:1 was ignored`);
  });
});

test("Retry-After is clamped by maxWaitMs (a huge header can't stall the request)", async () => {
  let n = 0;
  await withFetch(async () => (++n === 1 ? ra(600) : ok(200)), async () => {
    const t0 = Date.now();
    const { response } = await fetchWithRetry("https://zen.example", reqInit, {
      timeoutMs: 1000,
      backoffMs: 10,
      maxWaitMs: 300,
    });
    const elapsed = Date.now() - t0;
    assert.equal(response.status, 200);
    assertFetchCalls(2);
    assert.ok(elapsed < 3000, `clamped wait took ${elapsed}ms — maxWaitMs ignored`);
  });
});

test("free-pool lottery mode: ignoreRetryAfter beats the header, rapid spacing", async () => {
  // glm-5.2:free evidence: ~9th rapid knock wins where paced retries all fail.
  let n = 0;
  await withFetch(async () => (++n === 1 ? ra(5) : ok(200, { id: "x" })), async () => {
    const t0 = Date.now();
    const { response, detail } = await fetchWithRetry("https://openrouter.example", reqInit, {
      timeoutMs: 1000,
      backoffMs: 30,
      attempts: 8,
      ignoreRetryAfter: true,
    });
    const elapsed = Date.now() - t0;
    assert.equal(response.status, 200);
    assert.equal(detail, "");
    assertFetchCalls(2); // second attempt landed — no forced 5s cooldown
    assert.ok(elapsed < 2000, `lottery retry took ${elapsed}ms — Retry-After still honored?`);
  });
});

test("or/ contract: 502 retried when retry502 is set (pre-processing overload)", async () => {
  let n = 0;
  await withFetch(async () => (++n === 1 ? ok(502, { error: { code: 502 } }) : ok(200, { id: "x" })), async () => {
    const { response, detail } = await fetchWithRetry("https://openrouter.example", reqInit, {
      timeoutMs: 1000,
      backoffMs: 5,
      retry502: true,
    });
    assert.equal(response.status, 200);
    assert.equal(detail, "");
    assertFetchCalls(2);
  });
});

test("billing guard intact: 502 NOT retried when retry502 unset and not idempotent", async () => {
  await withFetch(async () => ok(502, { error: { code: 502 } }), async () => {
    const { response, detail } = await fetchWithRetry("https://zen.example", reqInit, {
      timeoutMs: 1000,
    });
    assert.equal(response.status, 502);
    assert.match(detail, /not retried/);
    assertFetchCalls(1);
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
  return new BreakerDO({ storage }, { DO_AUTH: "sekret" });
}
const check = async (do_) => (await (await do_.fetch(new Request("https://breaker/check", { headers: { "x-do-auth": "sekret" } }))).text());

test("BreakerDO: single trip does NOT open (needs 3 consecutive failures)", async () => {
  const do_ = breakerDO();
  await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
  assert.equal(await check(do_), "0");
  await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
  assert.equal(await check(do_), "0"); // still closed at 2
  await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
  assert.equal(await check(do_), "1"); // 3rd consecutive failure trips
});

test("BreakerDO: reset clears the failure count, no trip on later single failure", async () => {
  const do_ = breakerDO();
  await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
  await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
  // round-55: ONE success must not zero the count (a channel alternating
  // fail/success would never accumulate the 3 consecutive failures the
  // breaker needs) — two consecutive successes clear it.
  await do_.fetch(new Request("https://breaker/reset", { headers: { "x-do-auth": "sekret" } })); // success #1 — count kept
  await do_.fetch(new Request("https://breaker/reset", { headers: { "x-do-auth": "sekret" } })); // success #2 — count cleared
  assert.equal(await check(do_), "0");
  await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
  assert.equal(await check(do_), "0"); // count restarted, 1/3
});

test("BreakerDO: trips after threshold, expires after 60s, clear resets count too", async () => {
  const do_ = breakerDO();
  const realNow = Date.now;
  try {
    for (let i = 0; i < 3; i++) await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    assert.equal(await check(do_), "1");
    Date.now = () => realNow() + 61 * 1000; // degrade window over
    assert.equal(await check(do_), "0");
    await do_.fetch(new Request("https://breaker/clear", { headers: { "x-do-auth": "sekret" } }));
    for (let i = 0; i < 3; i++) await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    assert.equal(await check(do_), "1");
  } finally {
    Date.now = realNow;
  }
});

test("BreakerDO: unknown action → 404", async () => {
  const do_ = new BreakerDO({ storage: { get: async () => null, put: async () => {}, delete: async () => {} } }, { DO_AUTH: "sekret" });
  const res = await do_.fetch(new Request("https://breaker/nope", { headers: { "x-do-auth": "sekret" } }));
  assert.equal(res.status, 404);
});

// ── F5 FIX: cumulative-fail-time trip ──────────────────────────
// The breaker trips on ≥2 failures within BREAKER_MAX_FAIL_MS (45 s), so a
// channel that times out twice back-to-back opens in ~half the old worst
// case (3 × 120 s = 360 s).
test("BreakerDO: cumulative-fail-time trips after ≥2 failures within 45s (F5 fix)", async () => {
  const do_ = breakerDO();
  const realNow = Date.now;
  try {
    await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    assert.equal(await check(do_), "0"); // 1 failure: no trip
    // Advance 46 s (>45s threshold) and trip again — must OPEN.
    Date.now = () => realNow() + 46 * 1000;
    await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    assert.equal(await check(do_), "1", "2 failures within the fail-time window must open the circuit");
  } finally {
    Date.now = realNow;
  }
});

test("BreakerDO: a single failure NEVER trips regardless of elapsed time", async () => {
  const do_ = breakerDO();
  const realNow = Date.now;
  try {
    await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    // Even after a long time, 1 failure must not trip.
    Date.now = () => realNow() + 10 * 60 * 1000;
    assert.equal(await check(do_), "0", "a single failure must never trip the circuit");
  } finally {
    Date.now = realNow;
  }
});

test("BreakerDO: half-open probe re-trips on ONE failure (round-118)", async () => {
  // The opened-state 'fail' record is KEPT (not deleted) so that after the
  // 60s window a still-dead channel re-opens on a single probe failure —
  // without this a dead channel needs 3 fresh full-timeout probes (~6 min
  // of 120s hangs) to re-trip.
  const do_ = breakerDO();
  const realNow = Date.now;
  try {
    for (let i = 0; i < 3; i++) await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    assert.equal(await check(do_), "1");
    Date.now = () => realNow() + 61 * 1000; // window over → half-open
    assert.equal(await check(do_), "0");
    await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    assert.equal(await check(do_), "1", "one probe failure must re-open a still-dead channel");
  } finally {
    Date.now = realNow;
  }
});

test("BreakerDO: failures outside the 10-min window restart the count", async () => {
  const do_ = breakerDO();
  const realNow = Date.now;
  try {
    await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    assert.equal(await check(do_), "0"); // 2/3, still closed
    Date.now = () => realNow() + 11 * 60 * 1000; // stale window — re-anchor
    await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    assert.equal(await check(do_), "0", "stale count must not combine with fresh failures");
    await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
    assert.equal(await check(do_), "1", "3 fresh failures still trip");
  } finally {
    Date.now = realNow;
  }
});

test("BreakerDO: storage throw → 500, never a hang", async () => {
  const bad = {
    async get() { throw new Error("kv down"); },
    async put() { throw new Error("kv down"); },
    async delete() { throw new Error("kv down"); },
  };
  const do_ = new BreakerDO({ storage: bad }, { DO_AUTH: "sekret" });
  const res = await do_.fetch(new Request("https://breaker/trip", { headers: { "x-do-auth": "sekret" } }));
  assert.equal(res.status, 500);
  assert.match(await res.text(), /breaker error/);
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

// round-484 (coverage-driven): the reasoning-source arms + tool_use arms
// of toAnthropicResponse had ZERO pins.
test("toAnthropicResponse: reasoning string / reasoning_details segments → thinking block", () => {
  const reason = { id: "1", choices: [{ message: { content: "done", reasoning: "plain reason" } }], usage: {} };
  assert.deepEqual(toAnthropicResponse(reason, "m").content[0], { type: "thinking", thinking: "plain reason", signature: "" });
  const details = {
    id: "1",
    choices: [{ message: { content: "done", reasoning_details: ["a", { text: "b" }, 42] } }],
    usage: {},
  };
  assert.equal(toAnthropicResponse(details, "m").content[0].thinking, "ab");
});

test("toAnthropicResponse: tool_calls → tool_use; malformed args fall back to {}", () => {
  const up = {
    id: "1",
    choices: [{
      message: {
        content: "",
        tool_calls: [
          { id: "c1", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
          { id: "c2", function: { name: "bash", arguments: "{oops" } },
          { id: "c3" },
        ],
      },
    }],
    usage: {},
  };
  const blocks = toAnthropicResponse(up, "m").content;
  assert.deepEqual(blocks[0], { type: "tool_use", id: "c1", name: "bash", input: { cmd: "ls" } });
  assert.deepEqual(blocks[1], { type: "tool_use", id: "c2", name: "bash", input: {} });
  assert.deepEqual(blocks[2], { type: "tool_use", id: "c3", name: "unknown", input: {} });
});

// round-519 (coverage-driven): the toSSE server_tool_use arm had ZERO pins.
test("toSSE: server_tool_use block emits input_json_delta (input defaults to {})", async () => {
  const { toSSE } = await import("../src/anthropic-translate.ts");
  const out = toSSE({
    type: "message",
    content: [{ type: "server_tool_use", id: "s1", name: "web_search" }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  assert.match(out, /"type":"input_json_delta","partial_json":"\{\}"/);
});

// round-520 (coverage-driven): the mid-stream death arm had ZERO pins — a
// torn upstream must emit an error event, not a clean completed message.
test("streamOgToAnthropic: upstream death after content emits an error event", async () => {
  const { streamOgToAnthropic } = await import("../src/anthropic-translate.ts");
  const enc = new TextEncoder();
  let n = 0;
  const dying = new ReadableStream({
    pull(c) {
      if (n++ === 0) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n'));
      } else {
        c.error(new Error("torn"));
      }
    },
  });
  const out = streamOgToAnthropic(dying, "og/m", "m");
  const text = await new Response(out).text();
  assert.match(text, /upstream stream died mid-response/);
  assert.match(text, /event: error/);
});

// round-521 (coverage-driven): the stream cancel arm had ZERO pins (the F7
// disconnect path must stop the upstream reader, not drain it).
test("streamOgToAnthropic: cancelling the output stops the upstream reader", async () => {
  const { streamOgToAnthropic } = await import("../src/anthropic-translate.ts");
  let cancelled = false;
  const src = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const out = streamOgToAnthropic(src, "og/m", "m");
  await out.cancel();
  assert.equal(cancelled, true);
});

// round-528 (coverage-driven): the malformed-frame catch had ZERO pins — a
// garbage frame must be skipped, not kill the stream.
test("streamOgToAnthropic: malformed JSON frame is skipped, valid chunks flow", async () => {
  const { streamOgToAnthropic } = await import("../src/anthropic-translate.ts");
  const enc = new TextEncoder();
  const src = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode("data: not-json{{{\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"Yo\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n"));
      c.close();
    },
  });
  const text = await new Response(streamOgToAnthropic(src, "og/m", "m")).text();
  assert.match(text, /"text":"Yo"/);
  assert.match(text, /message_stop/);
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

// round-494 (coverage-driven): the late id/name backfill arm had ZERO pins
// (round-116: id/name arriving AFTER the first args chunk must not stick
// the client with id:""/name:"unknown").
test("stream encoder: late-arriving tool id/name backfills the delayed start", async () => {
  const { AnthropicStreamEncoder } = await import("../src/anthropic-translate.ts");
  const enc = new AnthropicStreamEncoder("og/m", "m");
  const tc = (index, id, name, args) => ({ choices: [{ index, delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] });
  enc.push(tc(0, undefined, undefined, '{"c'));
  enc.push(tc(0, "toolu_0", "bash", 'md":"ls"}'));
  const sseOut = enc.finish();
  assert.match(sseOut, /"id":"toolu_0"/);
  assert.match(sseOut, /"name":"bash"/);
  assert.ok(!sseOut.includes('"unknown"'), "no unknown-name tool_use emitted");
});

// ── streamOgToAnthropic: upstream dies mid-stream → graceful close ──

// round-492 (coverage-driven): the encoder mid-stream error arm + the
// finish() tail-parse arm had ZERO pins.
test("stream encoder: mid-stream chunk error → terminal error event, no double-fire", async () => {
  const { AnthropicStreamEncoder } = await import("../src/anthropic-translate.ts");
  const enc = new AnthropicStreamEncoder("og/m", "m");
  enc.push({ error: { message: "boom" } });
  const first = enc.take();
  assert.match(first, /upstream mid-stream error: boom/);
  assert.equal(enc.take(), "", "terminal: nothing queued after the error");
  const tail = enc.finish();
  assert.ok(!String(tail || "").includes("empty/non-SSE"), "started suppresses the done-branch error");
});

test("stream encoder: finish() parses a trailing partial data frame", async () => {
  const { AnthropicStreamEncoder } = await import("../src/anthropic-translate.ts");
  const enc = new AnthropicStreamEncoder("og/m", "m");
  const tail = enc.finish('data: {"choices":[{"index":0,"delta":{"content":"tail-word"}}]}\n');
  assert.match(String(tail || ""), /tail-word/);
});

// round-486 (coverage-driven): the empty/non-SSE-stream error arm had ZERO
// pins (only the mid-stream-death arm was covered).
test("stream: empty upstream → explicit empty-stream error event, no fabricated message", async () => {
  const { streamOgToAnthropic } = await import("../src/anthropic-translate.ts");
  const empty = new ReadableStream({
    start(controller) { controller.close(); },
  });
  const out = streamOgToAnthropic(empty, "auto", "deepseek-v4-flash");
  const reader = out.getReader();
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }
  const text = chunks.join("");
  assert.match(text, /upstream returned an empty\/non-SSE stream/);
  assert.ok(!text.includes("message_start"), "no message_start for zero upstream bytes");
});

// round-493 (coverage-driven): the toSSE thinking + server_tool_use
// emission arms had ZERO pins (toSSE itself had zero direct tests).
test("toSSE: thinking block emits thinking_delta + signature_delta, start stays empty", async () => {
  const { toSSE } = await import("../src/anthropic-translate.ts");
  const out = toSSE({ content: [{ type: "thinking", thinking: "hmm", signature: "sig1" }] });
  assert.match(out, /"thinking_delta"/);
  assert.match(out, /"thinking":"hmm"/);
  assert.match(out, /"signature_delta"/);
  // round-96: start initializes the block EMPTY (no double-emit).
  const start = out.split("\n\n").find((e) => e.includes("content_block_start"));
  assert.ok(start && !start.includes("hmm"), "start block carries no thinking text");
});

test("toSSE: server_tool_use emits input_json_delta with its input", async () => {
  const { toSSE } = await import("../src/anthropic-translate.ts");
  const out = toSSE({ content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } }] });
  assert.match(out, /"input_json_delta"/);
  assert.match(out, /\\"query\\":\\"x\\"/);
});

test("stream: upstream throw closes the stream gracefully (no hang)", async () => {
  const { streamOgToAnthropic } = await import("../src/anthropic-translate.ts");
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

// ── F5 (closed): the breaker's failure classifier, extracted to
// isChannelDownFailure so the timeout-DOS answer is provable at unit level.
test("isChannelDownFailure: network errors + FULL timeouts feed the breaker", async () => {
  const { isChannelDownFailure } = await import("../src/reliability.ts");
  assert.equal(isChannelDownFailure("network error: connection refused"), true);
  assert.equal(isChannelDownFailure("timeout after 120000ms"), true); // DoS-by-timeout class: COUNTS
  assert.equal(isChannelDownFailure("upstream 429"), false); // absorbed by retries
  assert.equal(isChannelDownFailure("upstream 500"), false); // zen's intermittent 500s must not cut the channel
  assert.equal(isChannelDownFailure(undefined), false);
});

// ── Degraded-cache contract (round-403: 5s TTL, trip invalidation,
// fail-open had zero direct pins) ──

function breakerEnv(handler) {
  const calls = [];
  const stub = {
    async fetch(url, init) {
      calls.push(String(url));
      return handler(String(url), init);
    },
  };
  return {
    calls,
    env: { BREAKER: { idFromName: (n) => n, get: () => stub }, DO_AUTH: "sekret" },
  };
}

test("isChannelDegraded: caches the DO verdict for 5s, then re-checks", async () => {
  const { isChannelDegraded, __clearDegradedCache } = await import("../src/reliability.ts");
  __clearDegradedCache();
  const { calls, env } = breakerEnv(() => new Response("1"));
  const realNow = Date.now;
  try {
    assert.equal(await isChannelDegraded(env), true);
    assert.equal(await isChannelDegraded(env), true);
    assert.equal(calls.length, 1, "second call inside TTL must not hit the DO");
    Date.now = () => realNow() + 6000;
    assert.equal(await isChannelDegraded(env), true);
    assert.equal(calls.length, 2, "past the TTL the verdict is re-read");
  } finally {
    Date.now = realNow;
    __clearDegradedCache();
  }
});

test("isChannelDegraded: closed channel reads false; DO error fails open (false)", async () => {
  const { isChannelDegraded, __clearDegradedCache } = await import("../src/reliability.ts");
  __clearDegradedCache();
  const closed = breakerEnv(() => new Response("0"));
  assert.equal(await isChannelDegraded(closed.env), false);
  __clearDegradedCache();
  const broken = breakerEnv(() => {
    throw new Error("do down");
  });
  const origErr = console.error;
  console.error = () => {};
  try {
    assert.equal(await isChannelDegraded(broken.env), false);
  } finally {
    console.error = origErr;
    __clearDegradedCache();
  }
});

test("recordChannelFailure trips the DO and invalidates the 5s cache at once", async () => {
  const { isChannelDegraded, recordChannelFailure, __clearDegradedCache } = await import("../src/reliability.ts");
  __clearDegradedCache();
  let open = false;
  const { calls, env } = breakerEnv((url) => {
    if (url.endsWith("/trip")) open = true;
    return new Response(open ? "1" : "0");
  });
  const origErr = console.error;
  console.error = () => {};
  try {
    assert.equal(await isChannelDegraded(env), false);
    await recordChannelFailure(env);
    assert.ok(calls.some((u) => u.endsWith("/trip")), "must call the DO trip endpoint");
    // No stale 5s "ok": the very next read sees the trip without waiting.
    assert.equal(await isChannelDegraded(env), true);
  } finally {
    console.error = origErr;
    __clearDegradedCache();
  }
});

test("recordChannelSuccess hits the DO reset endpoint (never throws)", async () => {
  const { recordChannelSuccess } = await import("../src/reliability.ts");
  const { calls, env } = breakerEnv(() => new Response("ok"));
  const origErr = console.error;
  console.error = () => {};
  try {
    await recordChannelSuccess(env);
    assert.ok(calls.some((u) => u.endsWith("/reset")));
    await recordChannelSuccess({}); // no BREAKER binding: must not throw
  } finally {
    console.error = origErr;
  }
});

// round-481 (coverage-driven): the breaker-trip-failure swallow arm had
// ZERO pins. (The billing-guard arm was already pinned below — an earlier
// duplicate was removed.)
test("recordChannelFailure swallows a DO trip throw (never throws)", async () => {
  const { recordChannelFailure } = await import("../src/reliability.ts");
  const { env } = breakerEnv(() => { throw new Error("do down"); });
  const origErr = console.error;
  console.error = () => {};
  try {
    await recordChannelFailure(env); // must not throw
  } finally {
    console.error = origErr;
  }
});

test("upstreamTimeoutMs: default 30s, env override wins, invalid falls back", async () => {
  const { upstreamTimeoutMs } = await import("../src/reliability.ts");
  assert.equal(upstreamTimeoutMs({}), 30000);
  assert.equal(upstreamTimeoutMs({ UPSTREAM_TIMEOUT_MS: "45000" }), 45000);
  assert.equal(upstreamTimeoutMs({ UPSTREAM_TIMEOUT_MS: "0" }), 30000);
  assert.equal(upstreamTimeoutMs({ UPSTREAM_TIMEOUT_MS: "junk" }), 30000);
});

// ── toOpenAIRequest pure transforms (round-480: zero direct pins — only
// indirect route exercise; the system-array, tool_result-array, thinking /
// tool_use, and tool_choice arms were uncovered) ──

test("toOpenAIRequest: system array blocks + tool_result array content", async () => {
  const { toOpenAIRequest } = await import("../src/anthropic-translate.ts");
  const out = toOpenAIRequest({
    system: [{ type: "text", text: "be nice" }, { type: "other", text: "dropped" }],
    messages: [{
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: [{ text: "r1" }, { thinking: "h1" }] }],
    }],
  }, "m");
  assert.deepEqual(out.messages[0], { role: "system", content: "be nice" });
  assert.deepEqual(out.messages[1], { role: "tool", tool_call_id: "t1", content: "r1\nh1" });
});

test("toOpenAIRequest: assistant thinking + tool_use → reasoning_content + tool_calls", async () => {
  const { toOpenAIRequest } = await import("../src/anthropic-translate.ts");
  const out = toOpenAIRequest({
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "here" },
        { type: "tool_use", id: "c1", name: "bash", input: { cmd: "ls" } },
      ],
    }],
  }, "m");
  const a = out.messages[0];
  assert.equal(a.content, "here");
  assert.equal(a.reasoning_content, "hmm");
  assert.deepEqual(a.tool_calls, [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }]);
});

test("toOpenAIRequest: tools normalize + tool_choice mapping", async () => {
  const { toOpenAIRequest } = await import("../src/anthropic-translate.ts");
  const base = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "web_search", description: "search" }], // no input_schema → object default
  };
  const auto = toOpenAIRequest({ ...base, tool_choice: { type: "tool", name: "web_search" } }, "m");
  assert.deepEqual(auto.tools[0].function.parameters, { type: "object", properties: {} });
  assert.deepEqual(auto.tool_choice, { type: "function", function: { name: "web_search" } });
  const any = toOpenAIRequest({ ...base, tool_choice: { type: "any" } }, "m");
  assert.equal(any.tool_choice, "required");
  const other = toOpenAIRequest({ ...base, tool_choice: { type: "auto" } }, "m");
  assert.equal(other.tool_choice, "auto");
});

// ── fetchWithRetry inspect hook (round-483: zero pins — rejecting counts
// as a failed attempt, a throwing inspect is a rejection, an accepted
// inspect can swap the response) ──

test("inspect: reject-then-accept retries within budget; always-reject reports in-band", async () => {
  const origErr = console.error;
  console.error = () => {};
  try {
    let n = 0;
    await withFetch(async () => ok(200, { id: "x" }), async () => {
      const r = await fetchWithRetry("https://zen.example", reqInit, {
        timeoutMs: 1000,
        backoffMs: 1,
        inspect: async () => (++n === 1 ? { accepted: false, detail: "empty stream" } : { accepted: true }),
      });
      assert.equal(r.response.status, 200);
      assert.equal(r.detail, "");
      assertFetchCalls(2);
    });
    await withFetch(async () => ok(200, { id: "x" }), async () => {
      const r = await fetchWithRetry("https://zen.example", reqInit, {
        timeoutMs: 1000,
        backoffMs: 1,
        attempts: 1,
        inspect: async () => ({ accepted: false, status: 502, detail: "empty stream" }),
      });
      assert.equal(r.response, null);
      assert.match(r.detail, /in-band upstream error 502: empty stream/);
      assert.deepEqual(r.inspectFailure, { status: 502 });
    });
  } finally {
    console.error = origErr;
  }
});

test("inspect: a throwing inspect is a rejection, never a throw", async () => {
  const origErr = console.error;
  console.error = () => {};
  try {
    await withFetch(async () => ok(200, { id: "x" }), async () => {
      const r = await fetchWithRetry("https://zen.example", reqInit, {
        timeoutMs: 1000,
        backoffMs: 1,
        attempts: 1,
        inspect: async () => { throw new Error("inspector down"); },
      });
      assert.equal(r.response, null);
      assert.match(r.detail, /inspection failed: inspector down/);
    });
  } finally {
    console.error = origErr;
  }
});

test("inspect: accepted inspect can swap the response", async () => {
  await withFetch(async () => ok(200, { id: "x" }), async () => {
    const swapped = ok(200, { id: "swapped" });
    const r = await fetchWithRetry("https://zen.example", reqInit, {
      timeoutMs: 1000,
      inspect: async () => ({ accepted: true, response: swapped }),
    });
    assert.equal(await r.response.json().then((j) => j.id), "swapped");
    assert.equal(r.detail, "");
    assertFetchCalls(1);
  });
});

// SOLID Round-77: the retry-policy table (one definition shared by the
// chat, messages-native and count arms — previously copy-pasted ternaries
// with comments trying to sync them). Timeout base rides through
// untouched; the table owns only the retry shape.
test("retryPolicyFor: bursty kinds retry, glm lottery paces, rest plain", () => {
  const T = 4242;
  assert.deepEqual(retryPolicyFor("nvidia", "m", T), { timeoutMs: T, attempts: 4, retry502: true });
  assert.deepEqual(retryPolicyFor("gmi", "m", T), { timeoutMs: T, attempts: 4, retry502: true });
  assert.deepEqual(retryPolicyFor("openrouter", GLM_LOTTERY_MODEL, T), {
    timeoutMs: T,
    attempts: 10,
    backoffMs: 300,
    retry502: true,
    ignoreRetryAfter: true,
  });
  assert.deepEqual(retryPolicyFor("openrouter", "other-model", T), { timeoutMs: T, attempts: 4, retry502: true });
  for (const kind of ["deepseek", "opencode", "commandgoat", "qwen", "amd"]) {
    assert.deepEqual(retryPolicyFor(kind, "m", T), { timeoutMs: T }, `${kind} rides the plain budget`);
  }
});
