// SSE guard tests — passthrough semantics + peekSseOutcome unit coverage.
//
// The gateway relays upstream SSE byte-for-byte (pure passthrough on every
// channel: og/ds/qw/or/nv/gmi). No in-band stream inspection happens at the
// gateway; an upstream 200-then-{"error":...} frame is forwarded verbatim and
// retry classification belongs to the client (DSH/Claude Code). peekSseOutcome
// remains as the stream-peeking primitive (used by tests and tooling).
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

// ── integration: or/ /v1/chat/completions — pure passthrough (no inspector) ──
// The gateway is a byte-level relay: an in-band error frame after a 200 is
// forwarded verbatim (single upstream call), matching every channel's
// passthrough semantics. Retry classification is the client's job.

test("or/ chat/completions: in-band error frame forwarded verbatim, single upstream call", async () => {
  __clearCaches();
  const { env, token } = gwEnv({});
  let calls = 0;
  const res = await withFetch(async () => {
    calls++;
    return sseResponse([ERROR_FRAME]);
  }, () => postChat(env, token, OX_BODY));
  assert.equal(calls, 1, "pure passthrough must not retry on an in-band error frame");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Provider returned error/); // forwarded verbatim
});

test("or/ /v1/messages: in-band error frame forwarded verbatim, single upstream call", async () => {
  __clearCaches();
  const { env, token } = gwEnv({});
  let calls = 0;
  const res = await withFetch(async () => {
    calls++;
    return sseResponse([ERROR_FRAME]);
  }, () => postMessages(env, token, {
    model: "or/stealth/ox-alpha",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.equal(calls, 1, "messages passthrough is byte-relay too — no inspector retry");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Provider returned error/); // forwarded verbatim
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
