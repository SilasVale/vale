// /api/health + /api/vale-probe logic — pure function tests with mocked
// breaker and fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHealth, encodeBase64Utf8, posixInstaller, psInstaller, valeProbe } from "../src/index.js";

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
  const shMatch = sh.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/);
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
