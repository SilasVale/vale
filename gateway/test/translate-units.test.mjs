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
} from "../src/plugins/translate.ts";

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
