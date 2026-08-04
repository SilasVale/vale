// /api/health channel-status logic — pure function test with a mocked breaker.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHealth, encodeBase64Utf8, posixInstaller, psInstaller } from "../src/index.js";

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
