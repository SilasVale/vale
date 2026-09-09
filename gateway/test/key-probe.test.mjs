// Key-probe pins (SOLID Round-32 — keyProbeResult/testKey exported
// additively; handlers untouched). The console's key-test buttons dial a
// different upstream per provider; a wrong URL/auth mapping fails only
// live. The keystone pin is COMPLETENESS: every USER_KEY_NAMES entry must
// resolve to a Response (a 9th key added to the allowlist without a probe
// arm would make testKey return undefined and crash the dispatch).
// Upstream traffic runs against the shared withFetch stub — zero network.
import test from "node:test";
import assert from "node:assert/strict";
import { keyProbeResult, testKey } from "../src/plugins/auth.ts";
import { USER_KEY_NAMES } from "../src/store.ts";
import { withFetch, assertFetchCalls } from "./helpers.mjs";

const okJson = (obj) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });

test("keyProbeResult: ok text on success, Upstream NNN otherwise", async () => {
  const ok = keyProbeResult("X", new Response("{}", { status: 200 }), "All good");
  assert.deepEqual(await ok.json(), { ok: true, name: "X", status: 200, detail: "All good" });
  const bad = keyProbeResult("X", new Response("{}", { status: 403 }), "All good");
  assert.deepEqual(await bad.json(), { ok: false, name: "X", status: 403, detail: "Upstream 403" });
});

test("testKey: empty key answers locally, never dials", async () => {
  await withFetch(async () => {
    throw new Error("must not be called");
  }, async () => {
    const r = await testKey({}, "DEEPSEEK_API_KEY", "");
    assert.deepEqual(await r.json(), { ok: false, name: "DEEPSEEK_API_KEY", detail: "Key not configured" });
    assertFetchCalls(0);
  });
});

test("testKey: GET-models probes hit their hosts with the caller key", async () => {
  const seen = {};
  const ok = async (url, init) => {
    seen.url = String(url);
    seen.auth = new Headers(init.headers).get("authorization");
    return okJson({ data: [{ id: "m1" }, { id: "m2" }] });
  };
  await withFetch(ok, async () => {
    const gmi = await testKey({}, "GMI_API_KEY", "sk-gmi");
    assert.equal(seen.url, "https://api.gmi-serving.com/v1/models");
    assert.equal(seen.auth, "Bearer sk-gmi");
    assert.deepEqual(await gmi.json(), { ok: true, name: "GMI_API_KEY", status: 200, detail: "GMI Cloud auth OK" });

    const amd = await testKey({}, "AMD_API_KEY", "sk-amd");
    assert.equal(seen.url, "https://developer.amd.com.cn/radeon/api/v1/models");
    assert.match((await amd.json()).detail, /2 models: m1, m2/, "catalog surfaced in the detail");

    const nv = await testKey({}, "NVAPI_KEY", "sk-nv");
    assert.equal(seen.url, "https://integrate.api.nvidia.com/v1/models");
    assert.deepEqual(await nv.json(), { ok: true, name: "NVAPI_KEY", status: 200, detail: "NVIDIA NIM auth OK" });
  });
});

test("testKey: POST probes carry JSON bodies with the caller key", async () => {
  const seen = {};
  const ok = async (url, init) => {
    seen.url = String(url);
    seen.init = init;
    return okJson({});
  };
  await withFetch(ok, async () => {
    await testKey({}, "DEEPSEEK_API_KEY", "sk-ds");
    assert.equal(seen.url, "https://api.deepseek.com/models");
    assert.equal(new Headers(seen.init.headers).get("authorization"), "Bearer sk-ds");

    await testKey({}, "QWEN_API_KEY", "sk-qw");
    assert.match(seen.url, /maas\.aliyuncs\.com\/apps\/anthropic\/v1\/messages/);
    const qwenBody = JSON.parse(seen.init.body);
    assert.equal(qwenBody.model, "qwen3.8-max-preview");

    await testKey({}, "CMD_API_KEY", "sk-cm");
    assert.equal(seen.url, "https://api.commandcode.ai/provider/v1/chat/completions");

    await testKey({}, "OPENROUTER_API_KEY", "sk-or");
    assert.equal(seen.url, "https://openrouter.ai/api/v1/auth/key");
  });
});

test("testKey: og probes zen chat/completions with a session header", async () => {
  const seen = {};
  const sse = async (url, init) => {
    seen.url = String(url);
    seen.init = init;
    return new Response("data: {\"x\":1}\n\n", { status: 200 });
  };
  // No US_PROXY setting anywhere (null KEYS read) → direct zen URL.
  const env = { KEYS: { async get() { return null; } } };
  await withFetch(sse, async () => {
    const r = await testKey(env, "OPENCODE_GO_API_KEY", "sk-og");
    assert.match(seen.url || "", /opencode\.ai/);
    const h = new Headers(seen.init?.headers);
    assert.equal(h.get("authorization"), "Bearer sk-og");
    assert.ok(h.get("x-opencode-session"), "zen session header present");
    assert.deepEqual(await r.json(), { ok: true, name: "OPENCODE_GO_API_KEY", status: 200, detail: "OpenCode Go auth OK" });
  });
});

test("testKey: upstream failure maps to ok:false, throws map to Test failed", async () => {
  await withFetch(async () => new Response("no", { status: 401 }), async () => {
    const r = await testKey({}, "DEEPSEEK_API_KEY", "sk-ds");
    assert.deepEqual(await r.json(), { ok: false, name: "DEEPSEEK_API_KEY", status: 401, detail: "Upstream 401" });
  });
  const orig = console.error;
  console.error = () => {};
  try {
    await withFetch(async () => {
      throw new Error("conn reset");
    }, async () => {
      const r = await testKey({}, "DEEPSEEK_API_KEY", "sk-ds");
      assert.match((await r.json()).detail, /Test failed: conn reset/);
    });
  } finally {
    console.error = orig;
  }
});

test("COMPLETENESS: every USER_KEY_NAMES entry probes to a Response (never undefined)", async () => {
  assert.ok(USER_KEY_NAMES.length >= 8, "allowlist non-trivial");
  await withFetch(async () => okJson({ data: [] }), async () => {
    for (const name of USER_KEY_NAMES) {
      const r = await testKey({}, name, "sk-probe-key");
      assert.ok(r instanceof Response, `${name} must resolve to a Response (probe arm exists)`);
    }
  });
});
