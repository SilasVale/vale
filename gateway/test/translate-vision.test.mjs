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
import { preprocessImages, describeImage } from "../src/plugins/translate-vision.ts";
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
    /OPENROUTER_API_KEY 未配置/,
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

// round-489 (coverage-driven): the og-path fetch-throw + bad-JSON arms had
// ZERO pins (both must fail the request, never fabricate).
test("vision og path: network throw + unparsable body fail the request", async () => {
  const real = globalThis.fetch;
  const e = env();
  try {
    globalThis.fetch = async () => { throw new Error("conn reset"); };
    await assert.rejects(
      preprocessImages([imageMessage], e, { OPENCODE_GO_API_KEY: "up-key" }, "m", "up-model", "uN"),
      /vision preprocessing failed/,
    );
    globalThis.fetch = async () => new Response("not-json{{{", { status: 200 });
    await assert.rejects(
      preprocessImages([imageMessage], e, { OPENCODE_GO_API_KEY: "up-key" }, "m", "up-model", "uN"),
      /vision preprocessing failed/,
    );
    assert.equal([...e._kv.keys()].filter((k) => k.startsWith("img-desc:")).length, 0, "failures never cache");
  } finally {
    globalThis.fetch = real;
  }
});

// round-491 (coverage-driven): the KV-read-throw swallow arm had ZERO pins
// (a KV outage must not fail the describe — it just skips the cache).
test("vision: KV read outage degrades to uncached describe, never throws", async () => {
  const e = env();
  const origGet = e.KEYS.get;
  e.KEYS.get = async () => { throw new Error("kv down"); };
  const s = stubVision("kv-down desc");
  try {
    const out = await preprocessImages([imageMessage], e, { OPENCODE_GO_API_KEY: "up-key" }, "m", "up-model", "uK");
    assert.equal(out.changed, true);
    assert.match(out.messages[0].content[0].text, /kv-down desc/);
  } finally {
    s.restore();
    e.KEYS.get = origGet;
  }
});

// SOLID Round-38 (failure taxonomy): every describeImage fault maps to an
// explicit marker string — and every marker MUST match preprocessImages'
// throw gate (/图片描述失败|图片描述为空|图片数据为空/), or a fault would
// degrade into a fabricated description again (the round-119 lesson).
// Direct unit pins; the throw wiring itself is pinned above end-to-end.
// Must mirror the gate in preprocessImages — if that regex ever changes,
// this table's last case fails loudly by design.
const THROW_GATE = /图片描述失败|图片描述为空|图片数据为空/;
const OG = "og/mimo-v2.5";
const OGKEYS = { OPENCODE_GO_API_KEY: "sk-og" };

async function withStubFetch(fn, handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("describeImage: fault → marker taxonomy (og branch)", async () => {
  const src = (data) => ({ media_type: "image/png", data });
  assert.equal(await describeImage({}, {}, src(""), OG, "u1"), "(图片数据为空)", "empty data, no fetch");
  assert.equal(
    await describeImage({}, {}, src(IMG), OG, "u1"),
    "(图片描述失败：OPENCODE_GO_API_KEY 未配置)",
    "missing og key",
  );
  await withStubFetch(async () => {
    // fetchDescribeOrError converts the throw into a marker (never rejects).
    assert.match(await describeImage({}, OGKEYS, src(IMG), OG, "u1"), /图片描述失败/, "network throw");
  }, async () => {
    throw new Error("boom");
  });
  await withStubFetch(async () => {
    assert.equal(
      await describeImage({}, OGKEYS, src(IMG), OG, "u1"),
      "(图片描述失败：500)",
      "non-ok status",
    );
  }, async () => new Response("err", { status: 500 }));
  await withStubFetch(async () => {
    assert.equal(
      await describeImage({}, OGKEYS, src(IMG), OG, "u1"),
      "(图片描述失败：响应解析失败)",
      "garbage body",
    );
  }, async () => new Response("not-json{{{", { status: 200 }));
  await withStubFetch(async () => {
    assert.equal(
      await describeImage({}, OGKEYS, src(IMG), OG, "u1"),
      "(图片描述为空)",
      "valid JSON, empty content",
    );
  }, async () => new Response(JSON.stringify({ choices: [{ message: { content: "  " } }] }), { status: 200 }));
});

test("describeImage: passthrough branch key + success shape", async () => {
  const src = { media_type: "image/png", data: IMG };
  assert.equal(
    await describeImage({}, {}, src, "or/some-vision-model", "u1"),
    "(图片描述失败：OPENROUTER_API_KEY 未配置)",
    "missing passthrough key",
  );
  await withStubFetch(async () => {
    assert.equal(
      await describeImage({}, { OPENROUTER_API_KEY: "sk-or" }, src, "or/some-vision-model", "u1"),
      "seen-it",
      "Anthropic content[] extraction",
    );
  }, async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: "seen-it" }] }), { status: 200 }),
  );
});

test("taxonomy consistency: every marker trips the throw gate", async () => {
  const markers = [
    "(图片数据为空)",
    "(图片描述失败：x)",
    "(图片描述为空)",
    await describeImage({}, {}, { data: "" }, OG, "u1"),
    await describeImage({}, {}, { data: IMG }, OG, "u1"),
  ];
  for (const m of markers) {
    assert.match(m, THROW_GATE, `marker trips the gate: ${m}`);
  }
  // And the gate actually fires through the public path on empty data.
  await assert.rejects(
    preprocessImages(
      [{ role: "user", content: [{ type: "image", source: { media_type: "image/png", data: "" } }] }],
      {},
      OGKEYS,
      "m",
      OG,
      "u1",
    ),
    /vision preprocessing failed/,
  );
});

// ── VISION_MODEL backend routing (2026-09-10) ─────────────────
// The var names a channel; describeImage must dial THAT channel with THAT
// channel's own user key. The pre-fix code hardcoded or/→OpenRouter and
// everything else translate-shaped →OpenCode Go, which sent the OpenCode key
// to Command Code whenever VISION_MODEL was a cm/ model (the deployed value
// since the V4 vision-exp retirement) — wrong credential to a third party,
// plus a guaranteed describe failure.
const CMD = "cm/deepseek/deepseek-v4.1-flash";

test("describeImage: cm/ vision model dials Command Code with the CMD key (never the OG key)", async () => {
  const src = { media_type: "image/png", data: IMG };
  assert.equal(
    await describeImage({}, {}, src, CMD, "u1"),
    "(图片描述失败：CMD_API_KEY 未配置)",
    "missing cm key",
  );
  let seen = null;
  await withStubFetch(async () => {
    const desc = await describeImage(
      {},
      { CMD_API_KEY: "sk-cm", OPENCODE_GO_API_KEY: "sk-og" },
      src,
      CMD,
      "u1",
    );
    assert.equal(desc, "cm saw it", "OpenAI choices[] extraction");
  }, async (url, init) => {
    seen = { url: String(url), auth: new Headers(init?.headers).get("authorization") };
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "cm saw it" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  assert.equal(seen.url, "https://api.commandcode.ai/provider/v1/chat/completions");
  assert.equal(seen.auth, "Bearer sk-cm", "the user's CMD key, not the OpenCode key");
});

test("describeImage: ds/ vision model keeps the Anthropic shape + its own key", async () => {
  const src = { media_type: "image/png", data: IMG };
  assert.equal(
    await describeImage({}, {}, src, "ds/deepseek-flash", "u1"),
    "(图片描述失败：DEEPSEEK_API_KEY 未配置)",
  );
  let seen = null;
  await withStubFetch(async () => {
    const desc = await describeImage({}, { DEEPSEEK_API_KEY: "sk-ds" }, src, "ds/deepseek-flash", "u1");
    assert.equal(desc, "ds saw it");
  }, async (url, init) => {
    seen = { url: String(url), auth: new Headers(init?.headers).get("authorization") };
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ds saw it" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(seen.url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(seen.auth, "Bearer sk-ds");
});

test("describeImage: an unmapped backend kind fails closed (no fetch, no key guess)", async () => {
  const { registerRoute, ROUTE_TABLE } = await import("../src/upstream.ts");
  registerRoute("zz-vis", ({ via }) => ({
    type: "translate",
    kind: "zzvision",
    stripPrefix: true,
    upstream: via("https://example.invalid/chat", "/chat"),
  }));
  try {
    let called = false;
    await withStubFetch(async () => {
      const desc = await describeImage(
        {},
        { OPENCODE_GO_API_KEY: "sk-og", CMD_API_KEY: "sk-cm", DEEPSEEK_API_KEY: "sk-ds" },
        { media_type: "image/png", data: IMG },
        "zz-vis/anything",
        "u1",
      );
      assert.equal(desc, "(图片描述失败：视觉模型后端不支持)");
    }, async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });
    assert.equal(called, false, "unknown backend must not dial anyone");
  } finally {
    delete ROUTE_TABLE["zz-vis"];
  }
});
