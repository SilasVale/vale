// translate-vision tests — the img-desc KV cache contract. The cache key is
// user-scoped + SHA-256 (security-regression round: the pre-fix key was
// content-derived FNV while the comment claimed user scoping — round-45
// Medium #1's invariant was not actually enforced). Pins:
//   1. the same image from a DIFFERENT user never hits another user's cache
//      entry (a second upstream call happens; B's description is B's own),
//   2. the same user repeating the image hits the cache (one upstream call),
//   3. a failed vision describe THROWS (round-119: no fabricated
//      descriptions), and the failed value is never cached.
import test from "node:test";
import assert from "node:assert/strict";
import { preprocessImages } from "../src/plugins/translate-vision.ts";
import { makeEnv as makeBaseEnv } from "./helpers.mjs";
import { __clearCaches } from "../src/store.ts";

const IMG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const imageMessage = {
  role: "user",
  content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: IMG } }],
};

function env() {
  __clearCaches();
  const e = makeBaseEnv({});
  e.VISION_MODEL = "og/mimo-v2.5";
  e.OPENCODE_GO_API_KEY = "up-key";
  return e;
}

function stubVision(text) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("img-desc cache: cross-user isolation — same bytes, different users, separate entries", async () => {
  const e = env();
  const s = stubVision("user-A description");
  try {
    const a = await preprocessImages([imageMessage], e, { OPENCODE_GO_API_KEY: "up-key" }, "m", "up-model", "uA");
    assert.equal(a.changed, true);
    assert.match(a.messages[0].content[0].text, /user-A description/);
    assert.equal(s.calls.length, 1, "first call for A dials upstream");
    const aKeys = [...e._kv.keys()].filter((k) => k.startsWith("img-desc:uA:"));
    assert.equal(aKeys.length, 1, "A's cache entry exists");

    // User B sends the IDENTICAL bytes: must NOT be served A's description.
    s.restore();
    const s2 = stubVision("user-B description");
    try {
      const b = await preprocessImages([imageMessage], e, { OPENCODE_GO_API_KEY: "up-key" }, "m", "up-model", "uB");
      assert.equal(s2.calls.length, 1, "B's identical image must re-dial (no cross-user hit)");
      assert.match(b.messages[0].content[0].text, /user-B description/);
      const bKeys = [...e._kv.keys()].filter((k) => k.startsWith("img-desc:uB:"));
      assert.equal(bKeys.length, 1);
      assert.notEqual(aKeys[0], bKeys[0], "user prefix separates the namespaces");
    } finally {
      s2.restore();
    }
  } finally {
    s.restore();
  }
});

test("img-desc cache: same user repeating the image hits the cache (one upstream call)", async () => {
  const e = env();
  const s = stubVision("desc for uA");
  try {
    await preprocessImages([imageMessage], e, { OPENCODE_GO_API_KEY: "up-key" }, "m", "up-model", "uA");
    const second = await preprocessImages([imageMessage], e, { OPENCODE_GO_API_KEY: "up-key" }, "m", "up-model", "uA");
    assert.equal(s.calls.length, 1, "second identical request serves from KV");
    assert.match(second.messages[0].content[0].text, /desc for uA/);
  } finally {
    s.restore();
  }
});

test("vision describe failure THROWS (round-119) and caches nothing", async () => {
  const e = env();
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
  try {
    await assert.rejects(
      preprocessImages([imageMessage], e, { OPENCODE_GO_API_KEY: "up-key" }, "m", "up-model", "uA"),
      /vision preprocessing failed/,
    );
    assert.equal([...e._kv.keys()].filter((k) => k.startsWith("img-desc:")).length, 0);
  } finally {
    globalThis.fetch = real;
  }
});

// round-479 (coverage-driven): the or/ passthrough failure arms had ZERO
// pins (only the og/zen path was exercised).
function orEnv() {
  __clearCaches();
  const e = makeBaseEnv({});
  e.VISION_MODEL = "or/some-vision-model";
  return e;
}

function stubAnthropic(status, json) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify(json), {
      status, headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("vision passthrough: missing backend key fails instead of fabricating", async () => {
  const e = orEnv();
  await assert.rejects(
    preprocessImages([imageMessage], e, {}, "m", "up-model", "uP"),
    /视觉模型后端未配置/,
  );
});

test("vision passthrough: upstream !ok fails with the status; success inserts the description", async () => {
  const ukeys = { OPENROUTER_API_KEY: "user-or-key" };
  const e1 = orEnv();
  const s1 = stubAnthropic(500, { error: "boom" });
  try {
    await assert.rejects(
      preprocessImages([imageMessage], e1, ukeys, "m", "up-model", "uP1"),
      /500/,
    );
  } finally {
    s1.restore();
  }
  const e2 = orEnv();
  const s2 = stubAnthropic(200, { content: [{ type: "text", text: "a red door" }] });
  try {
    const out = await preprocessImages([imageMessage], e2, ukeys, "m", "up-model", "uP2");
    assert.equal(out.changed, true);
    assert.match(out.messages[0].content[0].text, /a red door/);
    assert.equal(s2.calls.length, 1);
    assert.match(s2.calls[0].url, /openrouter\.ai/);
  } finally {
    s2.restore();
  }
});

// round-487 (coverage-driven): the mixed-block passthrough + empty-data
// arms had ZERO pins.
test("vision: non-image blocks ride along; empty image data fails, never fabricates", async () => {
  const e = env();
  const s = stubVision("mixed desc");
  try {
    const mixed = {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: IMG } },
      ],
    };
    const out = await preprocessImages([mixed], e, { OPENCODE_GO_API_KEY: "up-key" }, "m", "up-model", "uM");
    assert.equal(out.changed, true);
    assert.equal(out.messages[0].content[0].text, "look at this", "text block passes through verbatim");
    assert.match(out.messages[0].content[1].text, /mixed desc/);
  } finally {
    s.restore();
  }
  const empty = {
    role: "user",
    content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }],
  };
  await assert.rejects(
    preprocessImages([empty], e, { OPENCODE_GO_API_KEY: "up-key" }, "m", "up-model", "uM"),
    /vision preprocessing failed/,
  );
});
