// translate.ts pure-unit pins (SOLID Round-27 — four helpers exported
// additively; the live /v1 path calls them identically). These sit on
// every request yet had zero direct pins: a wrong route flag misroutes
// silently, a wrong key map 502s a channel, a wrong reasoning gate
// overrides clients, and the rate limiter is the Free-plan quota guard.
// Module maps (__rlMin/__rlDay) are per-test-file-process; fresh r27-
// tokens isolate every case without sleeps.
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectRoute,
  extractByokKeys,
  oxAlphaReasoningDefault,
  checkRateLimit,
  openAIUpstreamToAnthropicResponse,
  keyMissingError,
  sseResponse,
  relayUpstreamResult,
} from "../src/plugins/translate.ts";
import { pickRoute } from "../src/upstream.ts";

test("detectRoute: one flag per POST shape, none otherwise", () => {
  assert.deepEqual(detectRoute("POST", "/v1/messages"), {
    isCount: false,
    isMessages: true,
    isChatCompletions: false,
    isResponses: false,
  });
  assert.deepEqual(detectRoute("POST", "/v1/chat/completions"), {
    isCount: false,
    isMessages: false,
    isChatCompletions: true,
    isResponses: false,
  });
  assert.deepEqual(detectRoute("POST", "/v1/responses"), {
    isCount: false,
    isMessages: false,
    isChatCompletions: false,
    isResponses: true,
  });
  assert.deepEqual(detectRoute("POST", "/v1/messages/count_tokens"), {
    isCount: true,
    isMessages: false,
    isChatCompletions: false,
    isResponses: false,
  });
  assert.deepEqual(detectRoute("GET", "/v1/messages"), {
    isCount: false,
    isMessages: false,
    isChatCompletions: false,
    isResponses: false,
  });
  assert.deepEqual(detectRoute("GET", "/v1/models"), {
    isCount: false,
    isMessages: false,
    isChatCompletions: false,
    isResponses: false,
  });
});

test("extractByokKeys: eight keys mapped, unset normalized to null", () => {
  assert.deepEqual(
    extractByokKeys({
      DEEPSEEK_API_KEY: "sk-ds",
      OPENCODE_GO_API_KEY: "sk-og",
      OPENROUTER_API_KEY: "sk-or",
      QWEN_API_KEY: "sk-qw",
      NVAPI_KEY: "sk-nv",
      GMI_API_KEY: "sk-gmi",
      CMD_API_KEY: "sk-cm",
      AMD_API_KEY: "sk-amd",
      WHATEVER_ELSE: "ignored",
    }),
    {
      deepseek: "sk-ds",
      opencodeGo: "sk-og",
      openRouter: "sk-or",
      qwen: "sk-qw",
      nv: "sk-nv",
      gmi: "sk-gmi",
      cmd: "sk-cm",
      amd: "sk-amd",
    },
  );
  assert.deepEqual(extractByokKeys({}), {
    deepseek: null,
    opencodeGo: null,
    openRouter: null,
    qwen: null,
    nv: null,
    gmi: null,
    cmd: null,
    amd: null,
  });
  assert.equal(extractByokKeys({ DEEPSEEK_API_KEY: "" }).deepseek, null, "blank normalizes to null");
});

test("oxAlphaReasoningDefault: only openrouter+stealth/ox-alpha without reasoning", () => {
  const bare = '{"model":"or/stealth/ox-alpha"}';
  const withDefault = oxAlphaReasoningDefault("openrouter", "stealth/ox-alpha", bare);
  assert.ok(withDefault.includes('"reasoning":{"effort":"max"}'), withDefault);
  const kept = '{"model":"x","reasoning":{"effort":"low"}}';
  assert.equal(oxAlphaReasoningDefault("openrouter", "stealth/ox-alpha", kept), kept);
  assert.equal(oxAlphaReasoningDefault("opencode", "stealth/ox-alpha", bare), bare, "kind gate");
  assert.equal(oxAlphaReasoningDefault("openrouter", "other-model", bare), bare, "model gate");
});

test("checkRateLimit: non-gated traffic always passes", async () => {
  const kv = { KEYS: {} };
  assert.equal(checkRateLimit({}, "POST", "/v1/messages", "r27-a"), null, "no KEYS → pass");
  assert.equal(checkRateLimit(kv, "GET", "/v1/messages", "r27-b"), null, "GET → pass");
  assert.equal(checkRateLimit(kv, "POST", "/v1/models", "r27-c"), null, "non-v1 path → pass");
  assert.equal(
    checkRateLimit(kv, "POST", "/v1/messages/count_tokens", "r27-d"),
    null,
    "count path excluded",
  );
});

test("checkRateLimit: 48/minute per token, then 429 (fresh token, no sleeps)", async () => {
  const kv = { KEYS: {} };
  for (let i = 0; i < 48; i++) {
    assert.equal(checkRateLimit(kv, "POST", "/v1/messages", "r27-min"), null, `sight ${i + 1} passes`);
  }
  const limited = checkRateLimit(kv, "POST", "/v1/messages", "r27-min");
  assert.ok(limited instanceof Response);
  assert.equal(limited.status, 429);
  assert.equal(checkRateLimit(kv, "POST", "/v1/messages", "r27-min-other"), null, "other token unaffected");
});

test("checkRateLimit: 4096-bucket cap evicts oldest, retains newest (both sides)", async () => {
  // SOLID Round-49: pinning ONLY the evicted side is vacuous — a recount
  // from 0 looks identical to a first sight with or without the cap. The
  // distinguishing case is a HIGH-count bucket old enough to be evicted:
  // with the cap it recounts (null); without it stays blocked (429).
  const kv = { KEYS: {} };
  for (let i = 0; i < 48; i++) {
    checkRateLimit(kv, "POST", "/v1/messages", "r49-old");
  }
  for (let i = 0; i < 4097; i++) {
    checkRateLimit(kv, "POST", "/v1/messages", `r49-fill-${i}`);
  }
  // 4098 distinct buckets > 4096 cap → r49-old (oldest) evicted.
  assert.equal(
    checkRateLimit(kv, "POST", "/v1/messages", "r49-old"),
    null,
    "evicted high-count bucket recounts from 0 (cap works)",
  );
  for (let i = 0; i < 48; i++) {
    checkRateLimit(kv, "POST", "/v1/messages", "r49-new");
  }
  const retained = checkRateLimit(kv, "POST", "/v1/messages", "r49-new");
  assert.ok(retained instanceof Response, "newest high-count bucket still blocked");
  assert.equal(retained.status, 429);
});

// SOLID Round-57: the stream/oneshot/error-envelope decision tree had zero
// direct pins — only incidental exercise through live translate flows. A
// 200-wrapped error surfacing as an empty assistant message is the silent
// failure this tree exists to prevent. Fully deterministic: stub Responses,
// no network.
const chatJson = (obj) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });

test("response tree: one-shot JSON translates; error envelopes 502, never empty", async () => {
  const ok = await openAIUpstreamToAnthropicResponse(
    chatJson({ choices: [{ message: { role: "assistant", content: "hello" } }] }),
    {},
    "m",
    "m",
  );
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.content[0].text, "hello");

  const wrapped = await openAIUpstreamToAnthropicResponse(
    chatJson({ error: { message: "overloaded" } }),
    {},
    "m",
    "m",
  );
  assert.equal(wrapped.status, 502);
  assert.match((await wrapped.json()).error.message, /overloaded/);

  const empty = await openAIUpstreamToAnthropicResponse(chatJson({ choices: [] }), {}, "m", "m");
  assert.equal(empty.status, 502, "empty choices never become an empty message");

  const garbage = await openAIUpstreamToAnthropicResponse(
    new Response("not-json{{{", { status: 200, headers: { "content-type": "application/json" } }),
    {},
    "m",
    "m",
  );
  assert.equal(garbage.status, 502);
});

test("response tree: stream:true answered with JSON becomes one-shot SSE", async () => {
  const r = await openAIUpstreamToAnthropicResponse(
    chatJson({ choices: [{ message: { role: "assistant", content: "streamed?" } }] }),
    { stream: true },
    "m",
    "m",
  );
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /streamed\?/, "answer survives instead of an empty message");
  assert.match(text, /data:/, "SSE framing");

  const errEnvelope = await openAIUpstreamToAnthropicResponse(
    chatJson({ error: { message: "bad key" } }),
    { stream: true },
    "m",
    "m",
  );
  assert.equal(errEnvelope.status, 502);
  assert.match((await errEnvelope.json()).error.message, /bad key/);
});

test("response tree: true SSE streams through translated", async () => {
  const sseIn = [
    'data: {"choices":[{"delta":{"content":"hel"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const r = await openAIUpstreamToAnthropicResponse(
    new Response(sseIn, { status: 200, headers: { "content-type": "text/event-stream" } }),
    { stream: true },
    "m",
    "m",
  );
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  const text = await r.text();
  assert.match(text, /data:/, "Anthropic SSE frames out");
});

// SOLID Round-58: every live route kind must have a missing-key message —
// keyMissingError returns null for unknown kinds (callers cast to Response),
// so a new channel without a table row would crash the key gate instead of
// 502ing. Derived from the REAL router output, not a hardcoded kind list.
test("keyMissingError covers every pickRoute kind", async () => {
  const kinds = new Set();
  for (const prefix of ["or", "ds", "qw", "og", "nv", "gmi", "cm", "amd"]) {
    kinds.add(pickRoute(prefix, {}, null, "/v1/messages").kind);
  }
  assert.ok(kinds.size >= 8, "router yields a nontrivial kind set");
  for (const kind of kinds) {
    const r = keyMissingError(kind);
    assert.ok(r instanceof Response, `${kind} has a missing-key message row`);
    assert.equal(r.status, 502);
    assert.match((await r.json()).error.message, new RegExp(kind === "commandgoat" ? "CMD_API_KEY" : "API_KEY"), "names its key");
  }
});

test("sseResponse: event-stream envelope with no-cache", async () => {
  const r = sseResponse("data: x\n\n");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  assert.equal(await r.text(), "data: x\n\n", "body passes through untouched");
});

// SOLID Round-81: the breaker recording matrix had zero direct pins — only
// incidental exercise through live flows (a missed record leaves the
// circuit closed on a dead channel; a spurious one degrades a live one).
// Fully deterministic: stub BREAKER records /trip vs /reset calls.
function relayBreakerEnv() {
  const calls = [];
  const stub = {
    async fetch(url) {
      calls.push(String(url));
      return new Response("0");
    },
  };
  return {
    calls,
    env: { BREAKER: { idFromName: (n) => n, get: () => stub } },
  };
}
const relayReq = () =>
  new Request("https://x/v1/messages", {
    method: "POST",
    // Allowlisted console origin: stampCors echoes it (no Origin → no ACAO).
    headers: { origin: "https://ai.saisi.online" },
  });
async function quiet(fn) {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

test("relay: null upstream 502s; only opencode trips the breaker", async () => {
  for (const [kind, wantTrip] of [["opencode", true], ["deepseek", false]]) {
    const { calls, env } = relayBreakerEnv();
    const r = await quiet(() =>
      relayUpstreamResult(env, relayReq(), kind, null, "timeout after 120000ms", undefined, {}, true),
    );
    assert.equal(r.status, 502);
    assert.equal(
      calls.some((u) => u.endsWith("/trip")),
      wantTrip,
      `${kind}: trip iff opencode`,
    );
  }
});

test("relay: !ok records only for opencode + down-shaped + flag", async () => {
  const bad = () =>
    new Response(JSON.stringify({ error: { message: "boom" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  const cases = [
    ["opencode", "timeout after 120000ms", true, true, "down body + flag → trip"],
    ["opencode", "timeout after 120000ms", false, false, "flag off → no trip (flag meaning)"],
    ["opencode", "upstream 500", true, false, "non-down detail → no trip"],
    ["deepseek", "network error: dial", true, false, "non-og kind never trips"],
  ];
  for (const [kind, detail, flag, wantTrip, why] of cases) {
    const { calls, env } = relayBreakerEnv();
    const r = await quiet(() => relayUpstreamResult(env, relayReq(), kind, bad(), detail, undefined, {}, flag));
    assert.equal(r.status, 500, why);
    assert.equal(
      calls.some((u) => u.endsWith("/trip")),
      wantTrip,
      why,
    );
  }
});

test("relay: ok relays body + CORS + generation id; opencode resets", async () => {
  const okResp = () =>
    new Response("hello", {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-generation-id": "gen-1" },
    });
  for (const [kind, wantReset] of [["opencode", true], ["deepseek", false]]) {
    const { calls, env } = relayBreakerEnv();
    const ctx = {};
    const r = await quiet(() => relayUpstreamResult(env, relayReq(), kind, okResp(), "", undefined, ctx, true));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "hello", "body streams untouched");
    assert.equal(ctx.generationId, "gen-1", "generation id captured");
    assert.equal(
      r.headers.get("access-control-allow-origin"),
      "https://ai.saisi.online",
      "allowlisted origin echoed",
    );
    assert.equal(
      calls.some((u) => u.endsWith("/reset")),
      wantReset,
      `${kind}: reset iff opencode`,
    );
  }
});
