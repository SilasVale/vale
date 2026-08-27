// /api/health + /api/vale-probe logic — pure function tests with mocked
// breaker and fetch.
import test from "node:test";
import assert from "node:assert/strict";
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
  assert.deepEqual(h.channels.map((c) => c.id), ["ds", "qw", "og", "og", "og", "og", "or", "or", "or", "or", "or", "nv", "gmi", "gmi", "cm"]);
  assert.deepEqual(h.channels.map((c) => c.model), [
    "ds/deepseek-v4-flash",
    "qw/qwen3.8-max-preview",
    "og/deepseek-v4-flash",
    "og/gpt-5.6-luna",
    "og/mimo-v2.5",
    "og/ox-alpha-free",
    "or/openai/gpt-5.6-luna:floor[1m]",
    "or/z-ai/glm-5.2:free",
    "or/nvidia/nemotron-3-ultra-550b-a55b:free",
    "or/stealth/ox-alpha",
    "or/deepseek/deepseek-v4-flash-0731",
    "nv/nvidia/nemotron-3-ultra-550b-a55b",
    "gmi/MiniMaxAI/MiniMax-M3",
    "gmi/MiniMaxAI/MiniMax-M2.7",
    "cm/deepseek/deepseek-v4-flash",
  ]);
  // og and or repeat per model card; the dedup'd set must still cover every
  // priority prefix in order.
  assert.deepEqual([...new Set(h.channels.map((c) => c.id))], ["ds", "qw", "og", "or", "nv", "gmi", "cm"]);
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
