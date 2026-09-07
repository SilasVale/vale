// /api/health + /api/vale-probe logic — pure function tests with mocked
// breaker and fetch.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { buildHealth, encodeBase64Utf8, posixInstaller, probeRateLimited, psInstaller, valeProbe } from "../src/index.ts";
import { resolveAutoModel } from "../src/plugins/translate.ts";
import { __clearDegradedCache } from "../src/reliability.ts";

// The in-isolate breaker cache is shared across tests in this file — clear it
// before each so a test that flipped open/closed doesn't poison the next.
test.beforeEach(() => __clearDegradedCache());

// Mock env: breaker reports "open" (degraded) when asked.
const openEnv = {
  BREAKER: {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => new Response("1") }),
  },
};
const closedEnv = {
  BREAKER: {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => new Response("0") }),
  },
};

test("health: og degraded when breaker open, recommended picks qw", async () => {
  const h = await buildHealth(openEnv);
  const og = h.channels.find((c) => c.id === "og");
  assert.equal(og.ok, false);
  assert.equal(og.reason, "circuit open");
  assert.deepEqual(h.recommended, { channel: "qw", model: "qw/qwen3.8-max-preview" });
});

test("health: breaker closed → all channels ok, recommended still qw", async () => {
  const h = await buildHealth(closedEnv);
  assert.ok(h.channels.every((c) => c.ok));
  assert.equal(h.recommended.channel, "qw");
});

test("health: channels cover all prefixes in priority order", async () => {
  const h = await buildHealth(closedEnv);
  assert.deepEqual(h.channels.map((c) => c.id), ["ds", "qw", "qw", "og", "og", "og", "og", "og", "or", "or", "or", "or", "or", "nv", "gmi", "gmi", "cm", "cm", "cm", "amd", "amd"]);
  assert.deepEqual(h.channels.map((c) => c.model), [
    "ds/deepseek-v4-flash",
    "qw/qwen3.8-max-preview",
    "qw/qwen3.8-flash",
    "og/deepseek-v4-flash",
    "og/gpt-5.6-luna",
    "og/mimo-v2.5",
    "og/ox-alpha-free",
    "og/muse-spark-1.3-contributor",
    "or/openai/gpt-5.6-luna:floor[1m]",
    "or/z-ai/glm-5.2:free",
    "or/nvidia/nemotron-3-ultra-550b-a55b:free",
    "or/stealth/ox-alpha",
    "or/deepseek/deepseek-v4-flash-0731",
    "nv/nvidia/nemotron-3-ultra-550b-a55b",
    "gmi/MiniMaxAI/MiniMax-M3",
    "gmi/MiniMaxAI/MiniMax-M2.7",
    "cm/deepseek/deepseek-v4-flash",
    "cm/meituan/LongCat-2.0:free",
    "cm/poolside/laguna-s-2.1-free",
    "amd/DeepSeek-V4-Flash",
    "amd/DeepSeek-V4-Flash-Vision-Exp",
  ]);
  // og and or repeat per model card; the dedup'd set must still cover every
  // priority prefix in order.
  assert.deepEqual([...new Set(h.channels.map((c) => c.id))], ["ds", "qw", "og", "or", "nv", "gmi", "cm", "amd"]);
});

test("installer round-trip: non-ASCII CLI encodes and decodes losslessly", () => {
  const cli = "#!/usr/bin/env node\nconsole.log('你好 ✅ 无法读取');\n";
  const b64 = encodeBase64Utf8(cli);
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), cli);
  const sh = posixInstaller(b64);
  const shMatch = sh.match(/echo "([A-Za-z0-9+/=]+)" \| \(base64 -d 2>\/dev\/null \|\| base64 -D\)/);
  assert.ok(shMatch, "POSIX installer embeds base64");
  assert.equal(Buffer.from(shMatch[1], "base64").toString("utf8"), cli);
  const ps = psInstaller(b64);
  const psMatch = ps.match(/FromBase64String\("([A-Za-z0-9+/=]+)"\)/);
  assert.ok(psMatch, "PowerShell installer embeds base64");
  assert.equal(Buffer.from(psMatch[1], "base64").toString("utf8"), cli);
});

// ── /api/vale-probe ─────────────────────────────────────────────

// Worker env with all provider keys configured.
const keyedEnv = {
  DEEPSEEK_API_KEY: "sk-ds",
  QWEN_API_KEY: "sk-qw",
  OPENROUTER_API_KEY: "sk-or",
  OPENCODE_GO_API_KEY: "sk-og",
  BREAKER: {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => new Response("0") }),
  },
};

async function withFetch(handler, fn) {
  // Must await fn() INSIDE the try: the handler stays installed for the whole
  // async run. Returning fn() directly restores fetch in the same tick, so a
  // fetch deferred past an await (e.g. og's breaker check) hits the real
  // network instead of the stub.
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("valeProbe: og with open breaker short-circuits, no upstream call", async () => {
  let calls = 0;
  const res = await withFetch(async () => { calls++; return new Response("{}", { status: 200 }); }, () =>
    valeProbe({ ...keyedEnv, BREAKER: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("1") }) } }, "og/deepseek-v4-flash"),
  );
  assert.equal(calls, 0);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.detail, "circuit open");
});

test("valeProbe: og flash probes zen chat/completions with Bearer (translate path)", async () => {
  let seen;
  const res = await withFetch(async (url, init) => { seen = { url, init }; return new Response("{}", { status: 200 }); }, () =>
    valeProbe(keyedEnv, "og/deepseek-v4-flash"),
  );
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/chat/completions");
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-og");
  assert.equal(JSON.parse(seen.init.body).model, "deepseek-v4-flash");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.channel, "og");
});

test("valeProbe: og translate model probes zen chat/completions with Bearer", async () => {
  let seen;
  const res = await withFetch(async (url, init) => { seen = { url, init }; return new Response("{}", { status: 200 }); }, () =>
    valeProbe(keyedEnv, "og/minimax-m3"),
  );
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/chat/completions");
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-og");
  assert.equal(JSON.parse(seen.init.body).model, "minimax-m3");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.channel, "og");
});

test("valeProbe: ds channel ok when upstream 200", async () => {
  const res = await withFetch(async () => new Response("{}", { status: 200 }), () =>
    valeProbe(keyedEnv, "ds/deepseek-v4-flash"),
  );
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.channel, "ds");
  assert.equal(body.status, 200);
});

test("valeProbe: upstream 500 → ok false with status", async () => {
  const res = await withFetch(async () => new Response("{}", { status: 500 }), () =>
    valeProbe(keyedEnv, "ds/deepseek-v4-flash"),
  );
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, 500);
  assert.match(body.detail, /upstream 500/);
});

// round-517 (coverage-driven): the probe network-error catch arms had ZERO
// pins (only 200/500 responses were covered).
test("valeProbe: fetch throw → ok false with the error message", async () => {
  for (const model of ["ds/deepseek-v4-flash", "og/deepseek-v4-flash"]) {
    const res = await withFetch(async () => { throw new TypeError("fetch failed"); }, () =>
      valeProbe(keyedEnv, model),
    );
    const body = await res.json();
    assert.equal(body.ok, false, model);
    assert.match(body.detail, /fetch failed/, model);
  }
});

// round-522 (coverage-driven): the serveAssetText no-ASSETS arm had ZERO pins.
test("serveAssetText: env without ASSETS → null", async () => {
  const { serveAssetText } = await import("../src/tooling.ts");
  assert.equal(await serveAssetText({}, "/vale"), null);
  assert.equal(await serveAssetText({ ASSETS: {} }, "/vale"), null);
});

test("valeProbe: unknown model → 400", async () => {
  const res = await valeProbe(keyedEnv, "xx/nope");
  assert.equal(res.status, 400);
});

test("valeProbe: key missing → ok false, no upstream call", async () => {
  let calls = 0;
  const res = await withFetch(async () => { calls++; return new Response("{}", { status: 200 }); }, () =>
    valeProbe({ ...keyedEnv, DEEPSEEK_API_KEY: undefined }, "ds/deepseek-v4-flash"),
  );
  assert.equal(calls, 0);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /key not configured/);
});

test("valeProbe: qw channel ok when upstream 200 (QWEN_API_KEY branch)", async () => {
  // Keep only the QWEN key: if the branch reads the wrong key (e.g. DEEPSEEK_API_KEY), it returns key not configured
  const env = { ...keyedEnv, DEEPSEEK_API_KEY: undefined, OPENROUTER_API_KEY: undefined, OPENCODE_GO_API_KEY: undefined };
  const res = await withFetch(async () => new Response("{}", { status: 200 }), () =>
    valeProbe(env, "qw/qwen3.8-max-preview"),
  );
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.channel, "qw");
});

test("valeProbe: or channel ok when upstream 200 (OPENROUTER_API_KEY branch)", async () => {
  // Keep only the OPENROUTER key: if the branch reads the wrong key, it returns key not configured
  const env = { ...keyedEnv, DEEPSEEK_API_KEY: undefined, QWEN_API_KEY: undefined, OPENCODE_GO_API_KEY: undefined };
  const res = await withFetch(async () => new Response("{}", { status: 200 }), () =>
    valeProbe(env, "or/openai/gpt-5.6-luna:floor[1m]"),
  );
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.channel, "or");
});

test("valeProbe: gmi channel ok when upstream 200 (GMI_API_KEY branch)", async () => {
  // Keep only the GMI key: if the branch reads the wrong key (e.g. falls through to DEEPSEEK_API_KEY), it returns key not configured
  let seen;
  const env = {
    ...keyedEnv,
    DEEPSEEK_API_KEY: undefined, QWEN_API_KEY: undefined,
    OPENCODE_GO_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
    GMI_API_KEY: "gmi-key",
  };
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response("{}", { status: 200 });
  }, () => valeProbe(env, "gmi/MiniMaxAI/MiniMax-M3"));
  assert.equal(seen.url, "https://api.gmi-serving.com/v1/chat/completions");
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer gmi-key");
  assert.equal(JSON.parse(seen.init.body).model, "MiniMaxAI/MiniMax-M3");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.channel, "gmi");
});

test("valeProbe: nv channel uses NVAPI_KEY (not the DeepSeek key)", async () => {
  // Regression: nv/ probing used to fall into the DEEPSEEK_API_KEY branch — it must still probe with only NVAPI left
  const env = {
    ...keyedEnv,
    DEEPSEEK_API_KEY: undefined, QWEN_API_KEY: undefined,
    OPENCODE_GO_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
    NVAPI_KEY: "nv-key",
  };
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response("{}", { status: 200 });
  }, () => valeProbe(env, "nv/nvidia/nemotron-3-ultra-550b-a55b"));
  assert.equal(seen.url, "https://integrate.api.nvidia.com/v1/chat/completions");
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer nv-key");
  const body = await res.json();
  assert.equal(body.ok, true);
});

test("valeProbe: amd channel probes the native Radeon /v1/messages with the AMD key", async () => {
  // BYOK isolation: with only AMD_API_KEY left, amd/ must probe with it (an
  // unlisted prefix would silently fall through to the DEEPSEEK_API_KEY arm).
  const env = {
    ...keyedEnv,
    DEEPSEEK_API_KEY: undefined, QWEN_API_KEY: undefined,
    OPENCODE_GO_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
    GMI_API_KEY: undefined, NVAPI_KEY: undefined, CMD_API_KEY: undefined,
    AMD_API_KEY: "rc-key",
  };
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response("{}", { status: 200 });
  }, () => valeProbe(env, "amd/DeepSeek-V4-Flash"));
  assert.equal(seen.url, "https://developer.amd.com.cn/radeon/api/v1/messages");
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer rc-key");
  assert.equal(JSON.parse(seen.init.body).model, "DeepSeek-V4-Flash");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.channel, "amd");
});

// ── probeRateLimited (KV-backed, whole-gateway) ──────────────────
// Mirrors src/index.js: PROBE_RATE_LIMIT=60, window=60000ms.
const PROBE_RATE_LIMIT = 60;
const PROBE_WINDOW_MS = 60000;

function kvEnv() {
  const kv = new Map();
  return {
    kv,
    env: {
      KEYS: {
        get: async (k) => kv.get(k) ?? null,
        put: async (k, v) => { kv.set(k, v); }, // expirationTtl ignored by the mock
      },
    },
  };
}

test("probeRateLimited: 前 60 次放行, 第 61 次限流, 换时间桶后放行", async () => {
  const now = 1785000000000;
  const realDateNow = Date.now;
  Date.now = () => now;
  const { env } = kvEnv();
  try {
    for (let i = 0; i < PROBE_RATE_LIMIT; i++) {
      assert.equal(await probeRateLimited(env), false, `call ${i + 1} should pass`);
    }
    assert.equal(await probeRateLimited(env), true); // the 61st request is rate-limited
    Date.now = () => now + PROBE_WINDOW_MS; // next window
    assert.equal(await probeRateLimited(env), false);
  } finally {
    Date.now = realDateNow;
  }
});

// ── F2 coverage: probe-limiter KV write-back ─────────────────────────────
// The existing test exercises the limiter but never asserts the KV put —
// a regression that stopped writing the bucket back (so the ceiling multiplies
// per isolate) would be invisible. Assert the key is written with the count.
test("probeRateLimited: writes bucket back to KV (F2 coverage)", async () => {
  const now = 1785000000000;
  const realDateNow = Date.now;
  Date.now = () => now;
  const { env, kv } = kvEnv();
  try {
    // Use a unique IP to get a fresh bucket (the module-level __probeRate
    // Map persists across tests, so the default "unknown" IP may already be
    // at the limit from the preceding test).
    const req = new Request("https://g/health", { headers: { "cf-connecting-ip": "203.0.113.5" } });
    // First call seeds the bucket (KV miss → cur=0 → writes "1").
    assert.equal(await probeRateLimited(env, req), false);
    const raw = await env.KEYS.get("probe-rate:203.0.113.5:" + Math.floor(now / 60000));
    assert.equal(raw, "1", "first call must persist the bucket to KV (the F2 write-back fix)");
    // Second call is tracked in-memory — KV is NOT written again (the
    // "no per-request KV writes" invariant). Verify the value is unchanged.
    assert.equal(await probeRateLimited(env, req), false);
    assert.equal(await env.KEYS.get("probe-rate:203.0.113.5:" + Math.floor(now / 60000)), "1", "subsequent calls must not write KV");
  } finally {
    Date.now = realDateNow;
  }
});

test("probeRateLimited: KV 错误时 fail-open（不拦请求）", async () => {
  const env = {
    KEYS: {
      get: async () => { throw new Error("kv down"); },
      put: async () => { throw new Error("kv down"); },
    },
  };
  assert.equal(await probeRateLimited(env), false);
});

// ── auto route resolution ────────────────────────────
// env with mock RouteDO: route:<uid> → chosen model
function routeEnv(routeValue, breakerOpen = false, uid = "admin") {
  const routeStore = new Map();
  if (routeValue !== null) routeStore.set(uid, routeValue);
  return {
    KEYS: {
      async get(k) { return null; },
      async put(k, v) {},
      async delete(k) {},
    },
    BREAKER: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response(breakerOpen ? "1" : "0") }),
    },
    ROUTE: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async (req, init) => {
          const method = init?.method || "GET";
          const url = new URL(typeof req === "string" ? req : req.url);
          const uid = url.searchParams.get("uid");
          if (method === "GET") {
            const model = routeStore.get(uid) || null;
            return new Response(JSON.stringify({ model }));
          }
          if (method === "PUT") {
            const body = JSON.parse(init.body || "{}");
            routeStore.set(body.uid, body.model);
            return new Response(JSON.stringify({ ok: true }));
          }
          if (method === "DELETE") {
            routeStore.delete(uid);
            return new Response(JSON.stringify({ ok: true }));
          }
          return new Response("not found", { status: 404 });
        },
      }),
    },
    DEEPSEEK_API_KEY: "sk-ds", QWEN_API_KEY: "sk-qw",
    OPENROUTER_API_KEY: "sk-or", OPENCODE_GO_API_KEY: "sk-og",
  };
}

// NOTE: distinct uids per case — store.js caches route:<uid> for 60s
// module-wide, so a shared uid would leak the previous case's choice.
test("resolveAutoModel: uses chosen route", async () => {
  const env = routeEnv("qw/qwen3.8-max-preview", false, "u-choice");
  assert.equal(await resolveAutoModel(env, "u-choice"), "qw/qwen3.8-max-preview");
});

test("resolveAutoModel: no choice → default ds/deepseek-v4-flash", async () => {
  const env = routeEnv(null, false, "u-none");
  assert.equal(await resolveAutoModel(env, "u-none"), "ds/deepseek-v4-flash");
});

test("resolveAutoModel: chosen og channel with open breaker → falls back to default ds", async () => {
  const env = routeEnv("og/deepseek-v4-flash", true, "u-ogopen");
  assert.equal(await resolveAutoModel(env, "u-ogopen"), "ds/deepseek-v4-flash");
});

test("resolveAutoModel: chosen model not in whitelist → falls back to default ds", async () => {
  const env = routeEnv("xx/nope", false, "u-nope");
  assert.equal(await resolveAutoModel(env, "u-nope"), "ds/deepseek-v4-flash");
});

// ── resolveAutoModel fallback chain (round-407: only the default-ds path
// was pinned; the round-100 first-usable loop was not) ──

// NOTE: distinct uids per case — getUserKeys caches ukeys:<uid> module-wide,
// and getUserRoute caches route:<uid> for 60s.
function chainEnv({ ukeys = {}, uid = "u", choice = null, breakerOpen = false, extra = {} } = {}) {
  const kv = new Map([[`ukeys:${uid}`, JSON.stringify(ukeys)]]);
  const routes = new Map();
  if (choice !== null) routes.set(uid, choice);
  return {
    KEYS: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, String(v)); },
      async delete(k) { kv.delete(k); },
    },
    BREAKER: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response(breakerOpen ? "1" : "0") }),
    },
    ROUTE: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async (req, init) => {
          const method = init?.method || "GET";
          const url = new URL(typeof req === "string" ? req : req.url);
          const u = url.searchParams.get("uid");
          if (method === "GET") return new Response(JSON.stringify({ model: routes.get(u) || null }));
          return new Response("not found", { status: 404 });
        },
      }),
    },
    ...extra,
  };
}

test("resolveAutoModel: no ds key → first usable is qw", async () => {
  const env = chainEnv({ uid: "u-ch1", ukeys: { QWEN_API_KEY: "u-qw" } });
  assert.equal(await resolveAutoModel(env, "u-ch1"), "qw/qwen3.8-max-preview");
});

test("resolveAutoModel: only og key + closed breaker → og flash", async () => {
  const env = chainEnv({ uid: "u-ch2", ukeys: { OPENCODE_GO_API_KEY: "u-og" } });
  assert.equal(await resolveAutoModel(env, "u-ch2"), "og/deepseek-v4-flash");
});

test("resolveAutoModel: only or key → or luna", async () => {
  const env = chainEnv({ uid: "u-ch3", ukeys: { OPENROUTER_API_KEY: "u-or" } });
  assert.equal(await resolveAutoModel(env, "u-ch3"), "or/openai/gpt-5.6-luna:floor[1m]");
});

test("resolveAutoModel: keyless user still gets the default (last-line guarantee)", async () => {
  const env = chainEnv({ uid: "u-ch4" });
  assert.equal(await resolveAutoModel(env, "u-ch4"), "ds/deepseek-v4-flash");
});

test("resolveAutoModel: chosen-but-unusable falls into the chain (round-100)", async () => {
  const env = chainEnv({ uid: "u-ch5", choice: "og/deepseek-v4-flash", ukeys: { QWEN_API_KEY: "u-qw" } });
  assert.equal(await resolveAutoModel(env, "u-ch5"), "qw/qwen3.8-max-preview");
});

// ── isModelUsable key matrix (round-406: zero direct pins — only
// indirect resolveAutoModel exercise; the round-68 user-not-admin-keys
// rule and the nv/gmi pure-BYOK no-env-fallback are the teeth) ──

// NOTE: distinct uids per case — getUserKeys caches ukeys:<uid> module-wide.
function usableEnv({ ukeys = {}, breakerOpen = false, uid = "u", extra = {} } = {}) {
  const kv = new Map([[`ukeys:${uid}`, JSON.stringify(ukeys)]]);
  return {
    KEYS: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, String(v)); },
      async delete(k) { kv.delete(k); },
    },
    BREAKER: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response(breakerOpen ? "1" : "0") }),
    },
    DEEPSEEK_API_KEY: "sk-ds",
    ...extra,
  };
}

test("isModelUsable: whitelist gate + env-key channels", async () => {
  const { isModelUsable } = await import("../src/plugins/model-route.ts");
  const { __clearCaches } = await import("../src/store.ts");
  __clearCaches();
  const env = usableEnv({ uid: "u-use1" });
  assert.equal(await isModelUsable(env, "xx/nope", "u-use1"), false);
  assert.equal(await isModelUsable(env, "ds/deepseek-v4-flash", "u-use1"), true);
  // no qw key anywhere → unusable (would 502 every request)
  assert.equal(await isModelUsable(env, "qw/qwen3.8-max-preview", "u-use1"), false);
});

test("isModelUsable: round-68 — the REQUESTING user's key counts, not the admin's", async () => {
  const { isModelUsable } = await import("../src/plugins/model-route.ts");
  const { __clearCaches } = await import("../src/store.ts");
  __clearCaches();
  // No env QWEN key; the user brings their own → usable.
  const env = usableEnv({ uid: "u-use2", ukeys: { QWEN_API_KEY: "user-qw" } });
  assert.equal(await isModelUsable(env, "qw/qwen3.8-max-preview", "u-use2"), true);
});

// round-472 (coverage-driven): the getUserKeys-throw defensive arm had ZERO
// pins — a KV outage must read as "unusable" (safe fallback), never throw.
test("isModelUsable: KV outage degrades to unusable, never throws", async () => {
  const { isModelUsable } = await import("../src/plugins/model-route.ts");
  const { __clearCaches } = await import("../src/store.ts");
  __clearCaches();
  const env = usableEnv({ uid: "u-use9" });
  env.KEYS.get = async () => { throw new Error("kv down"); };
  // qw has no env-key fallback: with keys unreadable it must read unusable.
  assert.equal(await isModelUsable(env, "qw/qwen3.8-max-preview", "u-use9"), false);
  assert.equal(await isModelUsable(env, "xx/nope", "u-use9"), false);
});

// round-473 (coverage-driven): the /api/vale-probe 429 arm had ZERO route
// pins (only direct valeProbe calls).
test("vale-probe route: 60 probes pass, 61st 429s on a fixed IP", async () => {
  const { __clearCaches } = await import("../src/store.ts");
  __clearCaches();
  const kv = new Map();
  const env = {
    ...keyedEnv,
    KEYS: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, String(v)); },
      async delete(k) { kv.delete(k); },
    },
  };
  const probe = () => worker.fetch(new Request("https://x/api/vale-probe", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "10.88.88.88" },
    body: JSON.stringify({ model: "ds/deepseek-v4-flash" }),
  }), env);
  await withFetch(async () => new Response("{}", { status: 200 }), async () => {
    for (let i = 0; i < 60; i++) {
      assert.equal((await probe()).status, 200, `probe ${i + 1} passes the gate`);
    }
    assert.equal((await probe()).status, 429, "61st probe within the minute is rate-limited");
  });
});

test("isModelUsable: nv/gmi pure BYOK — user key only, never env", async () => {
  const { isModelUsable } = await import("../src/plugins/model-route.ts");
  const { __clearCaches } = await import("../src/store.ts");
  __clearCaches();
  // Even with env NVAPI_KEY set, a keyless user must NOT route there.
  const env = usableEnv({ uid: "u-use3", extra: { NVAPI_KEY: "env-nv", GMI_API_KEY: "env-gmi" } });
  assert.equal(await isModelUsable(env, "nv/nvidia/nemotron-3-ultra-550b-a55b", "u-use3"), false);
  assert.equal(await isModelUsable(env, "gmi/MiniMaxAI/MiniMax-M3", "u-use3"), false);
  __clearCaches();
  const keyed = usableEnv({ uid: "u-use4", ukeys: { NVAPI_KEY: "u-nv", GMI_API_KEY: "u-gmi" } });
  assert.equal(await isModelUsable(keyed, "nv/nvidia/nemotron-3-ultra-550b-a55b", "u-use4"), true);
  assert.equal(await isModelUsable(keyed, "gmi/MiniMaxAI/MiniMax-M3", "u-use4"), true);
});

test("isModelUsable: og/ honors the breaker; cm/amd honor keys", async () => {
  const { isModelUsable } = await import("../src/plugins/model-route.ts");
  const { __clearCaches } = await import("../src/store.ts");
  __clearCaches();
  const shut = usableEnv({ uid: "u-use5", extra: { OPENCODE_GO_API_KEY: "sk-og" }, breakerOpen: true });
  assert.equal(await isModelUsable(shut, "og/deepseek-v4-flash", "u-use5"), false);
  __clearDegradedCache();
  const open = usableEnv({ uid: "u-use6", extra: { OPENCODE_GO_API_KEY: "sk-og" } });
  assert.equal(await isModelUsable(open, "og/deepseek-v4-flash", "u-use6"), true);
  __clearCaches();
  // cm/amd take env keys (unlike nv/gmi) but still require one
  const ck = usableEnv({ uid: "u-use7", extra: { CMD_API_KEY: "sk-cm", AMD_API_KEY: "sk-amd" } });
  const cmId = "cm/deepseek/deepseek-v4-flash";
  const amdId = "amd/DeepSeek-V4-Flash";
  assert.equal(await isModelUsable(ck, cmId, "u-use7"), true);
  assert.equal(await isModelUsable(ck, amdId, "u-use7"), true);
  __clearCaches();
  const bare = usableEnv({ uid: "u-use8" });
  assert.equal(await isModelUsable(bare, cmId, "u-use8"), false);
  assert.equal(await isModelUsable(bare, amdId, "u-use8"), false);
});

// ── lib/ratelimit.ts factory security semantics ──────────────────────
// Pin the round-104 KV-quota invariant at the factory level: a memory-only
// limiter NEVER writes KV (the historical per-site implementations could
// drift toward "helpful" persistence — that would reopen the write-quota
// exhaustion vector on public endpoints).
test("createIpRateLimiter: kvSeed=false never touches KV; kvSeed=true persists once per bucket", async () => {
  const { createIpRateLimiter } = await import("../src/lib/ratelimit.ts");
  const kv = new Map();
  const writes = [];
  const env = {
    KEYS: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { writes.push([k, v]); kv.set(k, v); },
      async delete(k) { kv.delete(k); },
    },
  };
  const req = () => new Request("https://x/api", { headers: { "cf-connecting-ip": "1.2.3.4" } });

  const memoryOnly = createIpRateLimiter({ name: "mem-rate", limit: 2, windowMs: 60_000 });
  for (let i = 0; i < 5; i++) await memoryOnly(req(), env);
  assert.equal(writes.length, 0, "kvSeed=false must not write KV");
  assert.equal(kv.size, 0);

  const seeded = createIpRateLimiter({ name: "seed-rate", limit: 100, windowMs: 60_000, kvSeed: true });
  for (let i = 0; i < 3; i++) await seeded(req(), env);
  assert.equal(writes.length, 1, "kvSeed=true persists exactly once per bucket per IP (not per request)");
  assert.equal(kv.get("seed-rate:1.2.3.4:" + Math.floor(Date.now() / 60000)), "1");
});

// ── Limiter boundary behavior (round-397: trip point, window rollover,
// per-IP isolation, fail-open, capacity cap had no direct pins) ──

test("createIpRateLimiter: trips exactly at limit+1, per IP", async () => {
  const { createIpRateLimiter } = await import("../src/lib/ratelimit.ts");
  const lim = createIpRateLimiter({ name: "trip-rate", limit: 2, windowMs: 60_000 });
  const req = (ip) => new Request("https://x/api", { headers: { "cf-connecting-ip": ip } });
  assert.equal(await lim(req("9.9.9.9")), false);
  assert.equal(await lim(req("9.9.9.9")), false);
  assert.equal(await lim(req("9.9.9.9")), true, "3rd call over limit 2 trips");
  assert.equal(await lim(req("9.9.9.9")), true, "stays tripped in-window");
  assert.equal(await lim(req("8.8.8.8")), false, "other IPs unaffected");
  assert.equal(lim.keyPrefix, "trip-rate");
});

test("createIpRateLimiter: new window resets the budget", async () => {
  const { createIpRateLimiter } = await import("../src/lib/ratelimit.ts");
  const lim = createIpRateLimiter({ name: "win-rate", limit: 1, windowMs: 60_000 });
  const req = new Request("https://x/api", { headers: { "cf-connecting-ip": "7.7.7.7" } });
  assert.equal(await lim(req), false);
  assert.equal(await lim(req), true);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61_000;
    assert.equal(await lim(req), false, "next window starts fresh");
  } finally {
    Date.now = realNow;
  }
});

test("createIpRateLimiter: missing IP header shares the unknown bucket; errors fail open", async () => {
  const { createIpRateLimiter } = await import("../src/lib/ratelimit.ts");
  const lim = createIpRateLimiter({ name: "open-rate", limit: 1, windowMs: 60_000 });
  const noIp = new Request("https://x/api");
  assert.equal(await lim(noIp), false);
  assert.equal(await lim(noIp), true, "headerless requests share one unknown bucket");
  const open = createIpRateLimiter({ name: "fail-rate", limit: 1, windowMs: 60_000 });
  assert.equal(await open(null), false, "null request fails open, never throws");
  assert.equal(await open({ headers: { get() { throw new Error("boom"); } } }), false);
});

test("createIpRateLimiter: capacity capped at 4096 buckets", async () => {
  const { createIpRateLimiter } = await import("../src/lib/ratelimit.ts");
  const lim = createIpRateLimiter({ name: "cap-rate", limit: 1_000_000, windowMs: 60_000 });
  for (let i = 0; i < 4100; i++) {
    await lim(new Request("https://x/api", { headers: { "cf-connecting-ip": `10.0.${i >> 8}.${i & 255}` } }));
  }
  // First IP's bucket must have been evicted (insertion order): a repeat
  // call counts from zero instead of tripping on a stale accumulated count.
  assert.equal(await lim(new Request("https://x/api", { headers: { "cf-connecting-ip": "10.0.0.0" } })), false);
});
