// Channel-registry integrity — MODELS is the whitelist every route
// decision depends on, so its shape gets structural pins: unique ids,
// known prefixes, cross-table consistency (health cards, US-proxy set,
// route info, priority). A typo'd id or a health card pointing at a
// non-whitelisted model would otherwise misroute silently.
import test from "node:test";
import assert from "node:assert/strict";
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
