// Usage-mapper pins (SOLID Round-39 — the three provider mappers extracted
// verbatim from meKeyUsage; the skeleton was already shared). The console
// renders whatever these return, so a wrong field mapping shows garbage or
// NaN live with every gate green — these tables fix each mapping exactly,
// including the type-guard edges (null vs absent vs wrong-type).
import test from "node:test";
import assert from "node:assert/strict";
import { usageQuery, mapOpenRouterUsage, mapAmdUsage, mapOgUsage, usageQueryFor } from "../src/plugins/auth.ts";
import { withFetch } from "./helpers.mjs";

const okJson = (obj) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });

test("mapOpenRouterUsage: full shape, sparse shape, invalid data throws with detail", () => {
  assert.deepEqual(
    mapOpenRouterUsage({
      data: {
        label: "me",
        usage: 1.25,
        limit: 10,
        is_free_tier: false,
        rate_limit: { limit: 200, interval: "1m", reset: "soon", extra: true },
      },
    }),
    {
      label: "me",
      usage: 1.25,
      limit: 10,
      isFreeTier: false,
      rateLimit: { limit: 200, interval: "1m", reset: "soon" },
    },
  );
  assert.deepEqual(mapOpenRouterUsage({ data: {} }), {}, "empty data → empty map, no throw");
  for (const bad of [null, undefined, {}, { data: null }, { data: "x" }]) {
    assert.throws(() => mapOpenRouterUsage(bad), (e) => e.detail === "Invalid upstream response");
  }
  // Arrays are objects to typeof: treated as (empty) data, not an error.
  assert.deepEqual(mapOpenRouterUsage({ data: [1] }), {});
  // Strings pass (labels are string-shaped); nested objects are skipped, not coerced.
  assert.deepEqual(mapOpenRouterUsage({ data: { usage: { nested: 1 }, limit: "high" } }), {
    limit: "high",
  });
});

test("mapAmdUsage: spend/rate/label mapping with null-tolerant edges", () => {
  assert.deepEqual(
    mapAmdUsage({
      daily_cost_used_usd: 0.5,
      daily_cost_limit_usd: 5,
      rpm_limit: 60,
      daily_reset_at: "tomorrow",
      organization_id: "org-1",
      all_time: { requests: 10, total_tokens: 200 },
    }),
    {
      usage: 0.5,
      limit: 5,
      rateLimit: { limit: 60, interval: "minute", reset: "tomorrow" },
      label: "org-1 · 10 req · 200 tok",
    },
  );
  assert.deepEqual(
    mapAmdUsage({}),
    { limit: null },
    "limit is always present (null when unknown) — the renderer keys on it",
  );
  assert.deepEqual(
    mapAmdUsage({ all_time: {} }).label,
    "radeon · 0 req · 0 tok",
    "missing org/counters fall back, never NaN",
  );
  assert.equal(mapAmdUsage({ rpm_limit: "fast" }).rateLimit, undefined, "non-numeric rpm ignored");
});

test("mapOgUsage: flat shape, multi-window shape, non-object safe", () => {
  assert.deepEqual(
    mapOgUsage({ used: 3, limit: 100, balance: 97, plan: "pro", windows: null }),
    { usage: 3, limit: 100, balance: 97, label: "pro" },
  );
  assert.deepEqual(mapOgUsage({ used: 1, limit: null }), { usage: 1, limit: null });
  assert.deepEqual(
    mapOgUsage({ windows: { "5h": { used: 1, limit: 10, remaining: 9, reset_at: "t" }, junk: 42 } }),
    { windows: { "5h": { used: 1, limit: 10, remaining: 9, resetAt: "t" } } },
  );
  assert.deepEqual(mapOgUsage(null), {}, "non-object → empty, never throws");
  assert.deepEqual(mapOgUsage("x"), {});
});

test("usageQuery: envelope merges mapping; !ok and throws map to safe shapes", async () => {
  await withFetch(async () => okJson({ hello: "world" }), async () => {
    const r = await usageQuery("https://u.example/", "sk", "N", (p) => ({ echo: p.hello }));
    assert.deepEqual(await r.json(), { ok: true, name: "N", status: 200, echo: "world" });
  });
  await withFetch(async () => new Response("no", { status: 429 }), async () => {
    const r = await usageQuery("https://u.example/", "sk", "N", () => ({}));
    assert.deepEqual(await r.json(), { ok: false, name: "N", status: 429, detail: "Upstream 429" });
  });
  await withFetch(async () => okJson({ data: null }), async () => {
    // Mapper-thrown {detail} surfaces specifically (openrouter invalid shape).
    const r = await usageQuery("https://u.example/", "sk", "OPENROUTER_API_KEY", mapOpenRouterUsage);
    assert.deepEqual(await r.json(), { ok: false, name: "OPENROUTER_API_KEY", detail: "Invalid upstream response" });
  });
  const orig = console.error;
  console.error = () => {};
  try {
    await withFetch(async () => {
      throw new Error("dns fail");
    }, async () => {
      const r = await usageQuery("https://u.example/", "sk", "N", () => ({}));
      assert.deepEqual(await r.json(), { ok: false, name: "N", detail: "Usage query failed" });
    });
  } finally {
    console.error = orig;
  }
});

// SOLID Round-93: the usage endpoint table — every queryable key resolves
// to its (url, mapper); anything else is null (the handler's fail-loud
// backstop). Adding a provider is one table row; the allowlist derives
// from the same source.
test("usageQueryFor: every row resolves, unknown is null", () => {
  assert.deepEqual(Object.keys(usageQueryFor("OPENROUTER_API_KEY") || {}).sort(), ["map", "url"]);
  assert.equal(usageQueryFor("OPENROUTER_API_KEY")?.url, "https://openrouter.ai/api/v1/auth/key");
  assert.equal(usageQueryFor("OPENROUTER_API_KEY")?.map, mapOpenRouterUsage);
  assert.equal(usageQueryFor("AMD_API_KEY")?.url, "https://developer.amd.com.cn/radeon/api/v1/usage");
  assert.equal(usageQueryFor("AMD_API_KEY")?.map, mapAmdUsage);
  assert.equal(usageQueryFor("OPENCODE_GO_API_KEY")?.url, "https://opencode.ai/zen/go/v1/usage");
  assert.equal(usageQueryFor("OPENCODE_GO_API_KEY")?.map, mapOgUsage);
  assert.equal(usageQueryFor("DEEPSEEK_API_KEY"), null, "no usage endpoint → null, not throw");
  assert.equal(usageQueryFor(""), null);
});
