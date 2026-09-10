// Channel-registry integrity — MODELS is the whitelist every route
// decision depends on, so its shape gets structural pins: unique ids,
// known prefixes, cross-table consistency (health cards, US-proxy set,
// route info, priority). A typo'd id or a health card pointing at a
// non-whitelisted model would otherwise misroute silently.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPluginContext,
  registerPlugins,
  dispatch,
  route,
  emit,
  on,
  provideApi,
  requireApi,
  optionalApi,
} from "../src/plugins/registry.ts";
import {
  MODELS,
  ROUTE_INFO,
  HEALTH_CHANNELS,
  HEALTH_PRIORITY,
  OG_FORCE_US_PROXY,
  OG_ZEN_CHAT,
  QWEN_COMPAT_CHAT,
  CMD_CHAT,
  AMD_CHAT,
  usProxyBase,
  museResponsesExit,
} from "../src/channels.ts";

const KNOWN_PREFIXES = new Set(["ds", "og", "qw", "or", "nv", "gmi", "cm", "amd"]);

test("MODELS: ids unique, owned, known prefixes", () => {
  const ids = MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate model ids");
  for (const m of MODELS) {
    assert.ok(m.id && m.id.includes("/"), `bad id: ${m.id}`);
    assert.ok(m.owned_by && m.owned_by.length > 0, `${m.id} needs owned_by`);
    assert.ok(KNOWN_PREFIXES.has(m.id.split("/")[0]), `${m.id} has an unknown prefix`);
  }
});

test("HEALTH_CHANNELS: every card probes a whitelisted model", () => {
  const ids = new Set(MODELS.map((m) => m.id));
  assert.ok(HEALTH_CHANNELS.length > 0);
  for (const c of HEALTH_CHANNELS) {
    assert.ok(ids.has(c.model), `health card probes non-whitelisted ${c.model}`);
    assert.ok(KNOWN_PREFIXES.has(c.id), `health card has unknown channel ${c.id}`);
  }
});

test("OG_FORCE_US_PROXY members are whitelisted og models", () => {
  const ids = new Set(MODELS.map((m) => m.id));
  assert.ok(OG_FORCE_US_PROXY.size > 0);
  for (const m of OG_FORCE_US_PROXY) {
    assert.ok(m.startsWith("og/"), `${m} must be an og spelling`);
    assert.ok(ids.has(m), `${m} must be whitelisted`);
  }
});

test("HEALTH_PRIORITY channels exist; channel endpoints are https", () => {
  const channelIds = new Set(HEALTH_CHANNELS.map((c) => c.id));
  for (const p of HEALTH_PRIORITY) assert.ok(channelIds.has(p), `priority ${p} has no health card`);
  for (const u of [OG_ZEN_CHAT, QWEN_COMPAT_CHAT, CMD_CHAT, AMD_CHAT]) {
    assert.ok(u.startsWith("https://"), `endpoint must be https: ${u}`);
  }
});

test("ROUTE_INFO prefixes cover every model prefix", () => {
  const prefixes = new Set(ROUTE_INFO.map((r) => r.prefix.replace(/\/$/, "")));
  const used = new Set(MODELS.map((m) => m.id.split("/")[0]));
  for (const p of used) assert.ok(prefixes.has(p), `no ROUTE_INFO entry for ${p}/ models`);
});

// SOLID Round-40: the muse US-exit selector had zero direct pins (only
// indirect exercise through translate flows with env matrices). The four
// branches decide which continent serves the flagship model — pin exactly.
test("usProxyBase defaults, honors env", () => {
  assert.equal(usProxyBase({}), "https://v.saisi.online");
  assert.equal(usProxyBase(null), "https://v.saisi.online");
  assert.equal(usProxyBase({ US_PROXY_BASE: "https://egress.example" }), "https://egress.example");
});

test("museResponsesExit: vercel/zen-us/URL/default branches", () => {
  assert.equal(museResponsesExit({}), "https://oracle.saisi.online/v1/responses", "unset → Oracle default");
  assert.equal(museResponsesExit({ MUSE_RESPONSES_EXIT: "bogus" }), "https://oracle.saisi.online/v1/responses", "unknown → default");
  assert.equal(museResponsesExit({ MUSE_RESPONSES_EXIT: "zen-us" }), "https://zen-us.saisi.online/v1/responses");
  assert.equal(
    museResponsesExit({ MUSE_RESPONSES_EXIT: "https://alt.example.com/v1/responses" }),
    "https://alt.example.com/v1/responses",
    "custom URL verbatim",
  );
  assert.equal(
    museResponsesExit({ MUSE_RESPONSES_EXIT: "vercel" }),
    "https://v.saisi.online/api/zen?target=og&path=%2Fv1%2Fresponses",
    "vercel name rides the generic relay with an encoded path",
  );
  assert.equal(
    museResponsesExit({ MUSE_RESPONSES_EXIT: "vercel", US_PROXY_BASE: "https://eg.example" }),
    "https://eg.example/api/zen?target=og&path=%2Fv1%2Fresponses",
    "vercel branch honors the proxy base",
  );
});

// round-465 (coverage-driven): the framework helpers (dispatch/route/
// registerPlugins/emit/on) had ZERO direct pins — only indirect exercise
// through worker.fetch.
test("registry framework: dispatch first-match, no-match null, bad plugins skipped", () => {
  const ctx = createPluginContext(null, {});
  route(ctx, "GET", "/api/a", () => "a");
  route(ctx, ["GET", "POST"], "/api/b", () => "b");
  registerPlugins(ctx, [
    { name: "good", setup: (c) => route(c, "GET", "/api/c", () => "c") },
    null,
    { name: "broken" },
  ]);
  assert.equal(dispatch(ctx, "GET", "/api/a"), "a");
  assert.equal(dispatch(ctx, "POST", "/api/b"), "b");
  assert.equal(dispatch(ctx, "GET", "/api/c"), "c");
  assert.equal(dispatch(ctx, "DELETE", "/api/a"), null, "method mismatch → null");
  assert.equal(dispatch(ctx, "GET", "/nope"), null, "no match → null");
});

test("registry events: emit delivers, unsubscribe stops, throwers/rejecters swallowed", async () => {
  const ctx = createPluginContext(null, {});
  const seen = [];
  const off = on(ctx, "ev", (p) => seen.push(p));
  on(ctx, "ev", () => { throw new Error("sync boom"); });
  on(ctx, "ev", async () => { throw new Error("async boom"); });
  emit(ctx, "missing", 1); // no listeners → no-op, never throws
  emit(ctx, "ev", 42);
  await new Promise((r) => setTimeout(r, 10)); // let the async listener settle
  assert.deepEqual(seen, [42], "good listener got the payload despite the throwers");
  off();
  emit(ctx, "ev", 43);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [42], "unsubscribed listener stays silent");
});

test("registerPlugins: declared deps register before their consumers (topo order)", () => {
  const ctx = createPluginContext(null, {});
  const order = [];
  const dep = {
    name: "translate",
    deps: [],
    setup: (c) => {
      order.push("translate");
      c.api.translate = { resolveAutoModel: () => "auto-resolved" };
    },
  };
  const consumer = {
    name: "auth",
    deps: ["translate"],
    setup: (c) => {
      order.push("auth");
      // The bug this pins: auth was listed FIRST in index.ts's array, so
      // its setup read ctx.api.translate as undefined and the effective
      // model lookup permanently degraded. Deps must now win over array
      // order.
      c.api.authSawTranslate = !!(c.api && c.api.translate);
    },
  };
  registerPlugins(ctx, [consumer, dep]); // consumer listed BEFORE dep
  assert.deepEqual(order, ["translate", "auth"], "dep setup ran first");
  assert.equal(ctx.api.authSawTranslate, true, "consumer saw its declared dep");
});

test("registerPlugins: same-level plugins keep caller-array relative order", () => {
  const ctx = createPluginContext(null, {});
  const order = [];
  registerPlugins(ctx, [
    { name: "a", deps: [], setup: () => order.push("a") },
    { name: "b", deps: [], setup: () => order.push("b") },
    { name: "c", deps: [], setup: () => order.push("c") },
  ]);
  assert.deepEqual(order, ["a", "b", "c"], "stable relative order preserved");
});

test("registerPlugins: absent-from-list deps are tolerated (external provider)", () => {
  const ctx = createPluginContext(null, {});
  ctx.api.external = { provided: true };
  registerPlugins(ctx, [
    { name: "consumer", deps: ["external"], setup: (c) => { c.api.checked = !!(c.api.external); } },
  ]);
  assert.equal(ctx.api.checked, true, "dep already on ctx.api satisfies the consumer");
});

test("registerPlugins: dependency cycle throws (fail loud, never silent)", () => {
  const ctx = createPluginContext(null, {});
  assert.throws(
    () =>
      registerPlugins(ctx, [
        { name: "x", deps: ["y"], setup: () => {} },
        { name: "y", deps: ["x"], setup: () => {} },
      ]),
    /dependency cycle/,
    "cycle must surface instead of silently skipping setup",
  );
});

// SOLID Round-2 (ISP/DIP): typed capability seam — one write site, two read
// modes. Pins the contract the auth→translate soft-dep now relies on.
test("capability seam: provideApi stores+returns, optionalApi reads, requireApi enforces", () => {
  const ctx = createPluginContext(null, {});
  // soft-dep before provisioning → null (same fallback as the old `|| null`)
  assert.equal(optionalApi(ctx, "translate"), null, "missing soft-dep reads as null");
  assert.throws(() => requireApi(ctx, "translate"), /capability missing: "translate"/);
  const cap = { resolveAutoModel: () => "auto" };
  assert.equal(provideApi(ctx, "translate", cap), cap, "provide returns the capability");
  assert.equal(optionalApi(ctx, "translate"), cap, "soft read sees the provided cap");
  assert.equal(requireApi(ctx, "translate"), cap, "hard read sees the provided cap");
});
