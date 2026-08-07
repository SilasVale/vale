// Full-path /v1/messages gateway tests — mock KV + stubbed fetch, no Cloudflare calls.
//
// Exercises handleGateway's routing for the og/ channel. As of 2026-08-07 the
// native-Anthropic passthrough (zen/go/v1/messages) is DISABLED — zen rejects
// both Bearer and x-api-key there with this user's key, while chat/completions
// works. So every og model goes through the OpenAI translate path. The passthrough
// gate (OG_NATIVE_ANTHROPIC) stays as a one-line switch for when zen's messages
// endpoint becomes usable.
//
// store.js keeps a module-level 24h cache, so every test uses a distinct token/user.
import test from "node:test";
import assert from "node:assert/strict";
import { handleGateway, scanTopLevelModel, rawWithModel, estimateTokens } from "../src/index.js";

let uidSeq = 0;
function gwEnv({ keys = {}, breakerOpen = false, trips = null, timeout = 30 } = {}) {
  const uid = `u${++uidSeq}`;
  const token = `tok-${uid}`;
  const kv = new Map([
    [`token:${token}`, uid],
    [`user:${uid}`, JSON.stringify({ id: uid, username: uid, role: "user", enabled: true, token })],
    [`ukeys:${uid}`, JSON.stringify({
      DEEPSEEK_API_KEY: "sk-ds", OPENCODE_GO_API_KEY: "sk-og",
      OPENROUTER_API_KEY: "sk-or", QWEN_API_KEY: "sk-qw", ...keys,
    })],
  ]);
  const breaker = {
    idFromName: () => ({}),
    get: () => ({
      // isChannelDegraded / recordChannelFailure call the stub with a plain URL
      // string, not a Request — handle both.
      fetch: async (req) => {
        const u = typeof req === "string" ? req : String(req?.url || "");
        if (u.endsWith("/trip")) trips?.push(u);
        return new Response(breakerOpen ? "1" : "0");
      },
    }),
  };
  return {
    env: {
      KEYS: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async () => {}, delete: async () => {} },
      BREAKER: breaker,
      UPSTREAM_TIMEOUT_MS: timeout,
    },
    token,
  };
}

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const post = (env, token, body, path = "/v1/messages") =>
  handleGateway(
    new Request(`https://g${path}`, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    new URL(`https://g${path}`),
  );

// ── og models all use the translate path (native passthrough disabled) ──

test("og/deepseek-v4-flash goes to chat/completions with the OpenCode Go key", async () => {
  const { env, token } = gwEnv();
  let seen;
  const res = await withFetch(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); }, () =>
    post(env, token, { model: "og/deepseek-v4-flash", max_tokens: 10, stream: false, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/chat/completions");
  // The translate branch passes a plain-object header (not a Headers instance).
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-og");
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "deepseek-v4-flash"); // og/ prefix stripped
  assert.equal(sent.stream, false);
  const body = await res.json();
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "ok");
});

test("og/minimax-m3 also goes to chat/completions (translate path)", async () => {
  const { env, token } = gwEnv();
  let seen;
  const res = await withFetch(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); }, () =>
    post(env, token, { model: "og/minimax-m3", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(JSON.parse(seen.init.body).model, "minimax-m3");
  assert.equal(res.status, 200);
});

test("og/mimo-v2.5 keeps the translate path (chat/completions, Anthropic JSON out)", async () => {
  const { env, token } = gwEnv();
  let seen;
  const res = await withFetch(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); }, () =>
    post(env, token, { model: "og/mimo-v2.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/chat/completions");
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-og");
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "mimo-v2.5");
  assert.equal(sent.stream, false);
  const body = await res.json();
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "ok");
});

// ── count_tokens for og (translate route estimates, never hits upstream) ──

test("og count_tokens estimates without any upstream call", async () => {
  const { env, token } = gwEnv();
  let calls = 0;
  const res = await withFetch(async () => { calls++; return new Response("{}", { status: 200 }); }, () =>
    post(env, token, { model: "og/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }, "/v1/messages/count_tokens"),
  );
  assert.equal(calls, 0); // translate route never hits upstream for count_tokens
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Number.isInteger(body.input_tokens) && body.input_tokens > 0);
});

// ── reliability on the translate path ──────────────────────────

// A fetch that hangs until the caller's AbortController fires — like a real
// fetch would (a bare `new Promise(() => {})` never settles and would leave the
// event loop idle).
const never = (url, init) => new Promise((_, reject) => {
  init?.signal?.addEventListener("abort", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    reject(e);
  });
});

test("og translate timeout: 502, breaker NOT tripped (slow ≠ dead)", async () => {
  const trips = [];
  const { env, token } = gwEnv({ trips });
  const res = await withFetch(never, () =>
    post(env, token, { model: "og/mimo-v2.5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /timeout/);
  assert.equal(trips.length, 0); // timeout is zen's normal slow behavior — must NOT trip
});

test("og translate network error: 502 and trips the breaker exactly once", async () => {
  const trips = [];
  const { env, token } = gwEnv({ trips });
  const res = await withFetch(async () => { throw new TypeError("fetch failed"); }, () =>
    post(env, token, { model: "og/mimo-v2.5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /network error/);
  assert.equal(trips.length, 1); // unreachable → trip
});

test("og translate fast 500: retried via fetchZenWithRetry, breaker NOT tripped", async () => {
  const trips = [];
  const { env, token } = gwEnv({ trips, timeout: 1000 });
  let n = 0;
  const res = await withFetch(async () => (++n === 1 ? new Response("boom", { status: 500 }) : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })), () =>
    post(env, token, { model: "og/mimo-v2.5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(n, 2);
  assert.equal(trips.length, 0);
  assert.equal(res.status, 200);
});

// ── web_search on an og model ──────────────────────────────────

test("og web_search: search via DeepSeek, answer via zen chat/completions", async () => {
  const { env, token } = gwEnv();
  const calls = [];
  const res = await withFetch(async (url, init) => {
    calls.push(String(url));
    if (calls.length === 1) {
      assert.ok(String(url).includes("api.deepseek.com/anthropic"), "search must go through DeepSeek official");
      return new Response(JSON.stringify({
        type: "message",
        content: [{ type: "web_search_tool_result", content: [{ title: "A", url: "https://a" }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.equal(String(url), "https://opencode.ai/zen/go/v1/chat/completions");
    return new Response(JSON.stringify({ choices: [{ message: { content: "search answer" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }, () =>
    post(env, token, {
      model: "og/mimo-v2.5", max_tokens: 100, stream: false,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "tool", name: "web_search" },
      messages: [{ role: "user", content: "query: what's new" }],
    }),
  );
  assert.equal(calls.length, 2);
  assert.equal(res.status, 200);
  const body = await res.json();
  const text = body.content.find((b) => b.type === "text");
  assert.equal(text.text, "search answer");
});

// ── scanTopLevelModel / rawWithModel (CPU-safe model extraction) ──

test("scanTopLevelModel: extracts top-level model", () => {
  const raw = JSON.stringify({ model: "og/deepseek-v4-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  const { model } = scanTopLevelModel(raw);
  assert.equal(model, "og/deepseek-v4-flash");
});

test("scanTopLevelModel: ignores model inside messages content", () => {
  const raw = JSON.stringify({ max_tokens: 5, messages: [{ role: "user", content: "hi", model: "inside" }] });
  assert.equal(scanTopLevelModel(raw).model, null);
});

test("scanTopLevelModel: ignores model in nested tool_use input", () => {
  const raw = JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "tool_use", input: { model: "x" } }] }] });
  assert.equal(scanTopLevelModel(raw).model, null);
});

test("scanTopLevelModel: model-like string inside escaped content", () => {
  const raw = '{"model":"auto","messages":[{"content":"\\"model\\":\\"x\\""}]}';
  const { model } = scanTopLevelModel(raw);
  assert.equal(model, "auto");
});

test("scanTopLevelModel: no model field → null", () => {
  assert.equal(scanTopLevelModel("{}").model, null);
});

test("rawWithModel: swaps only the top-level model value", () => {
  const raw = JSON.stringify({ model: "ds/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });
  const out = rawWithModel(raw, "qw/qwen3.8-max-preview");
  const parsed = JSON.parse(out);
  assert.equal(parsed.model, "qw/qwen3.8-max-preview");
  assert.equal(parsed.messages.length, 1);
});

test("rawWithModel: missing model returns body unchanged", () => {
  const raw = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(rawWithModel(raw, "qw/qwen"), raw);
});

test("estimateTokens: large body approximates instead of walking", () => {
  // A 2M-char body must not be char-walked (Free plan CPU budget) — the
  // approximation path returns a positive estimate quickly.
  const big = "x".repeat(2_000_000);
  assert.ok(estimateTokens(big) > 0);
});

test("scanTopLevelModel: model after system/tools (Claude Code field order)", () => {
  // Claude Code sends system + tools BEFORE model — the scanner must not let
  // earlier fields break top-level key detection (regression: model → null,
  // request silently routed to the default ds channel).
  const raw = JSON.stringify({
    system: [{ type: "text", text: "You are a coding agent." }],
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    model: "og/deepseek-v4-flash",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(scanTopLevelModel(raw).model, "og/deepseek-v4-flash");
  const out = rawWithModel(raw, "ds/deepseek-v4-flash");
  assert.equal(JSON.parse(out).model, "ds/deepseek-v4-flash");
});
