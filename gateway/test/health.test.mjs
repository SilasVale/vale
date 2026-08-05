// /api/health + /api/vale-probe logic — pure function tests with mocked
// breaker and fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHealth, encodeBase64Utf8, posixInstaller, probeRateLimited, psInstaller, resolveAutoModel, valeProbe } from "../src/index.js";

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

test("health: channels cover all four prefixes in priority order", async () => {
  const h = await buildHealth(closedEnv);
  assert.deepEqual(h.channels.map((c) => c.id), ["ds", "qw", "og", "or"]);
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

function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return fn();
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
  // 只留 QWEN 密钥：若分支读错 key（如 DEEPSEEK_API_KEY），会返回 key not configured
  const env = { ...keyedEnv, DEEPSEEK_API_KEY: undefined, OPENROUTER_API_KEY: undefined, OPENCODE_GO_API_KEY: undefined };
  const res = await withFetch(async () => new Response("{}", { status: 200 }), () =>
    valeProbe(env, "qw/qwen3.8-max-preview"),
  );
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.channel, "qw");
});

test("valeProbe: or channel ok when upstream 200 (OPENROUTER_API_KEY branch)", async () => {
  // 只留 OPENROUTER 密钥：若分支读错 key，会返回 key not configured
  const env = { ...keyedEnv, DEEPSEEK_API_KEY: undefined, QWEN_API_KEY: undefined, OPENCODE_GO_API_KEY: undefined };
  const res = await withFetch(async () => new Response("{}", { status: 200 }), () =>
    valeProbe(env, "or/openai/gpt-5.6-luna:floor[1m]"),
  );
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.channel, "or");
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
    assert.equal(await probeRateLimited(env), true); // 第 61 次被限流
    Date.now = () => now + PROBE_WINDOW_MS; // 下一个窗口
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
// env with KV mock: route:<uid> → chosen model
function routeEnv(routeValue, breakerOpen = false, uid = "admin") {
  const m = new Map();
  if (routeValue !== null) m.set(`route:${uid}`, routeValue);
  return {
    KEYS: {
      async get(k) { return m.has(k) ? m.get(k) : null; },
      async put(k, v) { m.set(k, String(v)); },
      async delete(k) { m.delete(k); },
    },
    BREAKER: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response(breakerOpen ? "1" : "0") }),
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
