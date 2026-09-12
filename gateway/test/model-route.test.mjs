// isModelUsable key-rule matrix (SOLID Round-26 — the per-prefix chain is
// now the CHANNEL_KEY_RULES table; these pins fix the semantics the table
// must preserve: user-key vs env-key vs pure-BYOK (nv/gmi ignore env),
// whitelist-first, og breaker last. Distinct uids per case: getUserKeys
// caches ukeys:<uid> module-wide. og cases need the BREAKER stub.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isModelUsable,
  CHANNEL_KEY_RULES,
  registerChannelKey,
} from "../src/plugins/model-route.ts";
import { __clearDegradedCache } from "../src/reliability.ts";
import { MODELS } from "../src/channels.ts";
import { USER_KEY_NAMES } from "../src/store.ts";

function envFor({ ukeys = {}, uid, breakerOpen = false, extra = {} } = {}) {
  const kv = new Map([[`ukeys:${uid}`, JSON.stringify(ukeys)]]);
  return {
    KEYS: {
      async get(k) {
        return kv.has(k) ? kv.get(k) : null;
      },
      async put(k, v) {
        kv.set(k, String(v));
      },
      async delete(k) {
        kv.delete(k);
      },
    },
    BREAKER: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response(breakerOpen ? "1" : "0") }),
    },
    ...extra,
  };
}

test("non-whitelisted models are never usable (before any key lookup)", async () => {
  assert.equal(await isModelUsable({}, "xx/ghost", "mr-none"), false);
  assert.equal(await isModelUsable({}, "", "mr-empty"), false);
});

test("shared-key channels: user key, env key, or neither", async () => {
  // ds/ and amd/ left the catalog with the V4 retirement (2026-09-10), and
  // isModelUsable refuses anything outside MODELS — so the shared-key cases
  // ride the live channels.
  const cases = [
    ["qw/qwen3.8-flash", "QWEN_API_KEY"],
    ["or/z-ai/glm-5.2:free", "OPENROUTER_API_KEY"],
    ["cm/deepseek/deepseek-v4.1-flash", "CMD_API_KEY"],
    ["og/deepseek-v4.1-flash", "OPENCODE_GO_API_KEY"],
  ];
  let i = 0;
  for (const [model, key] of cases) {
    const u = `mr-shared-${i++}`;
    assert.equal(
      await isModelUsable(envFor({ ukeys: { [key]: "sk-u" }, uid: u }), model, u),
      true,
      `${model} with user key`,
    );
    const v = `mr-shared-${i++}`;
    assert.equal(
      await isModelUsable(envFor({ uid: v, extra: { [key]: "sk-e" } }), model, v),
      true,
      `${model} with env key`,
    );
    const w = `mr-shared-${i++}`;
    assert.equal(await isModelUsable(envFor({ uid: w }), model, w), false, `${model} keyless`);
  }
});

test("pure BYOK (nv/gmi): env key never substitutes", async () => {
  assert.equal(
    await isModelUsable(envFor({ ukeys: { NVAPI_KEY: "sk-u" }, uid: "mr-nv-u" }), "nv/moonshotai/kimi-k3", "mr-nv-u"),
    true,
  );
  assert.equal(
    await isModelUsable(envFor({ uid: "mr-nv-e", extra: { NVAPI_KEY: "sk-e" } }), "nv/moonshotai/kimi-k3", "mr-nv-e"),
    false,
    "nv ignores env keys",
  );
  assert.equal(
    await isModelUsable(envFor({ ukeys: { GMI_API_KEY: "sk-u" }, uid: "mr-gmi-u" }), "gmi/MiniMaxAI/MiniMax-M3", "mr-gmi-u"),
    true,
  );
  assert.equal(
    await isModelUsable(envFor({ uid: "mr-gmi-e", extra: { GMI_API_KEY: "sk-e" } }), "gmi/MiniMaxAI/MiniMax-M3", "mr-gmi-e"),
    false,
    "gmi ignores env keys",
  );
});

test("og: key first, breaker last", async () => {
  // The breaker verdict caches 5s in-isolate: clear between flips, else the
  // open case reads the closed verdict cached above (reliability.ts hook).
  __clearDegradedCache();
  assert.equal(
    await isModelUsable(
      envFor({ ukeys: { OPENCODE_GO_API_KEY: "sk-u" }, uid: "mr-og-ok" }),
      "og/deepseek-v4.1-flash",
      "mr-og-ok",
    ),
    true,
    "key + closed breaker",
  );
  __clearDegradedCache();
  assert.equal(
    await isModelUsable(
      envFor({ ukeys: { OPENCODE_GO_API_KEY: "sk-u" }, uid: "mr-og-open", breakerOpen: true }),
      "og/deepseek-v4.1-flash",
      "mr-og-open",
    ),
    false,
    "key + open breaker degrades",
  );
  assert.equal(
    await isModelUsable(envFor({ uid: "mr-og-none" }), "og/deepseek-v4.1-flash", "mr-og-none"),
    false,
    "keyless og",
  );
});

test("registerChannelKey: new prefixes register without editing the gate", () => {
  assert.equal(CHANNEL_KEY_RULES["zz-test-ocp"], undefined, "temp prefix starts absent");
  registerChannelKey("zz-test-ocp", { userKey: "ZZ_KEY", envKey: null });
  try {
    assert.deepEqual(CHANNEL_KEY_RULES["zz-test-ocp"], { userKey: "ZZ_KEY", envKey: null });
  } finally {
    delete CHANNEL_KEY_RULES["zz-test-ocp"];
  }
  assert.equal(CHANNEL_KEY_RULES["zz-test-ocp"], undefined, "temp prefix cleaned up");
});

// SOLID Round-53: every MODELS prefix needs a key rule — without one, its
// models fall through as usable-without-key and 502 on every request.
test("CHANNEL_KEY_RULES covers every MODELS prefix", () => {
  const prefixes = new Set(MODELS.map((m) => m.id.split("/")[0]));
  for (const p of prefixes) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(CHANNEL_KEY_RULES, p),
      `${p}/ models need a key rule`,
    );
  }
});

// SOLID Round-59: every console-managed key must be routable — a key the
// console lets users save but no channel rule reads is a dead credential
// (saved, never usable, confusingly reported as configured).
test("CHANNEL_KEY_RULES userKeys cover every USER_KEY_NAMES entry", () => {
  const wired = new Set(Object.values(CHANNEL_KEY_RULES).map((r) => r.userKey));
  for (const name of USER_KEY_NAMES) {
    assert.ok(wired.has(name), `managed key ${name} has no routing rule`);
  }
});
