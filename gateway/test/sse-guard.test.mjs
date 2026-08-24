// SSE in-band error guard — or/ (OpenRouter) passthrough resilience.
//
// OpenRouter sometimes accepts the request (HTTP 200, SSE headers) and THEN
// fails: the stream's first meaningful frame is `data: {"error":{...}}`
// ("Provider returned error"). Today that frame is forwarded verbatim, the
// client sees an error message with no status digits (DSH classifies it
// PI_AI_ERROR — non-retryable) and the session pauses. The guard peeks the
// first decisive frame BEFORE forwarding: an error frame before any content
// counts as a failed attempt (retried by fetchWithRetry), and only leaks out
// as a proper HTTP failure carrying status digits once retries are exhausted.
//
// store.js keeps a module-level 24h cache, so every test uses a distinct token/user.
import test from "node:test";
import assert from "node:assert/strict";
import { handleGateway } from "../src/index.ts";
import { __clearCaches } from "../src/store.ts";
import { peekSseOutcome } from "../src/sse-guard.ts";

let uidSeq = 0;
function gwEnv({ keys = {} } = {}) {
  const uid = `u${++uidSeq}`;
  const token = `tok-${uid}`;
  const kv = new Map([
    [`token:${token}`, uid],
    [`user:${uid}`, JSON.stringify({ id: uid, username: uid, role: "user", enabled: true, token })],
    [`ukeys:${uid}`, JSON.stringify({
      DEEPSEEK_API_KEY: "sk-ds", OPENCODE_GO_API_KEY: "sk-og",
      OPENROUTER_API_KEY: "sk-or", QWEN_API_KEY: "sk-qw", NVAPI_KEY: "sk-nv", ...keys,
    })],
  ]);
  const breaker = {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => new Response("0") }),
  };
  const routeDo = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () => new Response(JSON.stringify({ model: null })),
    }),
  };
  return {
    env: {
      KEYS: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async () => {}, delete: async () => {} },
      BREAKER: breaker,
      ROUTE: routeDo,
      UPSTREAM_TIMEOUT_MS: 1000,
      OG_TIMEOUT_MS: 1000,
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

const postChat = (env, token, body) =>
  handleGateway(
    new Request("https://g/v1/chat/completions", {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    new URL("https://g/v1/chat/completions"),
  );

const postMessages = (env, token, body) =>
  handleGateway(
    new Request("https://g/v1/messages", {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    new URL("https://g/v1/messages"),
  );

const OX_BODY = {
  model: "or/stealth/ox-alpha",
  max_tokens: 1,
  messages: [{ role: "user", content: "hi" }],
};

const sseResponse = (frames, { status = 200 } = {}) =>
  new Response(
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n",
    { status, headers: { "content-type": "text/event-stream" } },
  );

const DELTA = {
  id: "gen-x", object: "chat.completion.chunk", created: 1,
  model: "stealth/ox-alpha", provider: "Stealth",
  choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
};
const ERROR_FRAME = { error: { message: "Provider returned error", code: 502 } };
const OK_TAIL = {
  id: "gen-x", object: "chat.completion.chunk", created: 1,
  model: "stealth/ox-alpha", provider: "Stealth",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
};

// ── unit: peekSseOutcome ─────────────────────────────────────────────────────

test("peek: comments + deltas + done → passthrough, replayed bytes intact", async () => {
  const raw = ": OPENROUTER PROCESSING\n\ndata: " + JSON.stringify(DELTA) + "\n\n" +
    ": OPENROUTER PROCESSING\n\ndata: " + JSON.stringify(OK_TAIL) + "\n\ndata: [DONE]\n\n";
  const body = new Response(raw, { headers: { "content-type": "text/event-stream" } }).body;
  const peeked = await peekSseOutcome(body);
  assert.equal(peeked.kind, "passthrough");
  const text = await new Response(peeked.stream).text();
  assert.equal(text, raw); // byte-identical, including leading comments
});

test("peek: first frame is an error object → in-band-error with message and code", async () => {
  const body = sseResponse([ERROR_FRAME]).body;
  const peeked = await peekSseOutcome(body);
  assert.equal(peeked.kind, "in-band-error");
  assert.equal(peeked.status, 502);
  assert.equal(peeked.message, "Provider returned error");
});

test("peek: error AFTER content started → passthrough (cannot retract bytes)", async () => {
  const raw = "data: " + JSON.stringify(DELTA) + "\n\ndata: " + JSON.stringify(ERROR_FRAME) + "\n\n";
  const body = new Response(raw).body;
  const peeked = await peekSseOutcome(body);
  assert.equal(peeked.kind, "passthrough");
  const text = await new Response(peeked.stream).text();
  assert.equal(text, raw);
});

test("peek: stream closes after only comments → closed-empty", async () => {
  const body = new Response(": OPENROUTER PROCESSING\n\n: OPENROUTER PROCESSING\n\n").body;
  const peeked = await peekSseOutcome(body);
  assert.equal(peeked.kind, "closed-empty");
});

test("peek: non-SSE guard skips nothing here — plain JSON body is caller's concern", async () => {
  // peekSseOutcome itself only sees a stream; the CONTENT-TYPE gate lives at
  // the call site. A JSON body parses as one non-"data:" line → passthrough.
  const body = new Response('{"choices":[]}').body;
  const peeked = await peekSseOutcome(body);
  assert.equal(peeked.kind, "passthrough");
});

test("peek: huge comment preamble past the cap → passthrough (defensive)", async () => {
  const pad = ":" + "x".repeat(4096) + "\n\n";
  const raw = pad.repeat(80); // ~320KB of comments, no decisive frame
  const body = new Response(raw).body;
  const peeked = await peekSseOutcome(body);
  assert.equal(peeked.kind, "passthrough");
});

// ── integration: or/ /v1/chat/completions absorbs the in-band failure ────────

test("or/ chat/completions: first attempt errors in-band, second succeeds → client sees 200 SSE", async () => {
  __clearCaches();
  const { env, token } = gwEnv({});
  const calls = [];
  const good = sseResponse([DELTA, OK_TAIL]);
  const res = await withFetch(async (url, init) => {
    calls.push(String(url));
    return calls.length === 1 ? sseResponse([ERROR_FRAME]) : good;
  }, () => postChat(env, token, OX_BODY));
  assert.ok(calls.length >= 2, `expected the in-band failure to be retried, got ${calls.length} upstream call(s)`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"hello"/);
  assert.doesNotMatch(text, /Provider returned error/);
});

test("or/ chat/completions: persistent in-band errors → HTTP 502 whose message carries the status digits", async () => {
  __clearCaches();
  const { env, token } = gwEnv({});
  let calls = 0;
  const res = await withFetch(async () => {
    calls++;
    return sseResponse([ERROR_FRAME]);
  }, () => postChat(env, token, OX_BODY));
  assert.equal(res.status, 502);
  const out = await res.json();
  const message = out.error?.message || "";
  assert.match(message, /\b502\b/, `surfaced message must carry status digits, got: ${message}`);
  assert.match(message, /Provider returned error/);
  assert.ok(calls >= 2, `expected retries before giving up, got ${calls}`);
});

// ── integration: or/ /v1/messages (Anthropic entry, Claude Code) same guard ──

test("or/ /v1/messages: in-band error absorbed across attempts → 200 SSE", async () => {
  __clearCaches();
  const { env, token } = gwEnv({});
  const calls = [];
  const anthropicOk = new Response(
    'event: message_start\ndata: {"type":"message_start","message":{}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  const res = await withFetch(async (url, init) => {
    calls.push(String(url));
    return calls.length === 1 ? sseResponse([ERROR_FRAME]) : anthropicOk;
  }, () => postMessages(env, token, {
    model: "or/stealth/ox-alpha",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.ok(calls.length >= 2, `messages path must retry in-band failures too, got ${calls.length}`);
  assert.equal(res.status, 200);
});

// ── regression guards: untouched paths stay untouched ─────────────────────────

test("non-openrouter passthrough (nv/) has no SSE guard — single upstream call even on odd bodies", async () => {
  __clearCaches();
  const { env, token } = gwEnv({});
  let calls = 0;
  const res = await withFetch(async () => {
    calls++;
    return sseResponse([ERROR_FRAME]);
  }, () => postChat(env, token, {
    model: "nv/moonshotai/kimi-k3",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.equal(calls, 1);
  assert.equal(res.status, 200); // forwarded verbatim, guard not engaged
});
