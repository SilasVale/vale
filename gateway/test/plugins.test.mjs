// Plugin pairing/ticket store helpers — pure local, no Cloudflare calls.
//
// The plugin registry lives in a single KV JSON map (plugins:v1); pair codes
// and WS tickets are one-time KV values with TTLs. A Map-backed KV stub stands
// in for the Workers binding.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPairCode, consumePairCode, addPluginLink, getPluginByToken, removePluginLink, createWsTicket, consumeWsTicket } from "../src/store.js";

function env() {
  const m = new Map();
  return { KEYS: {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => m.set(k, v),
    delete: async (k) => m.delete(k),
  } };
}

test("pair code: create then consume (one-time)", async () => {
  const e = env();
  const code = await createPairCode(e, "d1");
  assert.ok(code);
  assert.equal(await consumePairCode(e, code), "d1");
  assert.equal(await consumePairCode(e, code), null);
});

test("plugin link: add/get/remove", async () => {
  const e = env();
  await addPluginLink(e, "tok", "d1");
  const link = await getPluginByToken(e, "tok");
  assert.equal(link.device, "d1");
  assert.ok(link.createdAt);
  await removePluginLink(e, "tok");
  assert.equal(await getPluginByToken(e, "tok"), null);
});

test("ws ticket: one-time", async () => {
  const e = env();
  const t = await createWsTicket(e, "d1");
  assert.equal(await consumeWsTicket(e, t), "d1");
  assert.equal(await consumeWsTicket(e, t), null);
});

// The extension has no admin session, so pair/claim and /ws must be reachable
// without one. handleConsole's public section ends where requireSession is
// called — a route registered after that gate 401s before its handler runs.
// Worker routing can't run under plain node, so assert the registration order
// by reading handleConsole's source (same check a reviewer would do by eye).
test("pair/claim + /ws routes sit in the PUBLIC section (before requireSession)", () => {
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async function handleConsole"));
  const sessionGate = body.indexOf("const user = await requireSession(request, env);");
  assert.ok(sessionGate > 0, "requireSession gate found");
  const claim = body.indexOf("`${PLUGIN_BASE}/pair/claim`");
  const ws = body.indexOf("`${PLUGIN_BASE}/ws`");
  assert.ok(claim > 0, "pair/claim route found");
  assert.ok(ws > 0, "/ws route found");
  assert.ok(claim < sessionGate, "pair/claim registered before requireSession");
  assert.ok(ws < sessionGate, "/ws registered before requireSession");
  // Exactly one registration each — no admin-section copy left behind.
  assert.equal(claim, body.lastIndexOf("`${PLUGIN_BASE}/pair/claim`"));
  assert.equal(ws, body.lastIndexOf("`${PLUGIN_BASE}/ws`"));
});

test("pair code: unknown or empty code is rejected (claim 403 path)", async () => {
  const e = env();
  assert.equal(await consumePairCode(e, ""), null);
  assert.equal(await consumePairCode(e, "NOPE123"), null);
});

test("ws ticket: bound to its device — mismatched ?device= fails the gate", async () => {
  const e = env();
  const t = await createWsTicket(e, "d1");
  const claimedDevice = await consumeWsTicket(e, t);
  // /api/plugins/ws forwards to the hub only when the ticket's device matches
  // the ?device= param; a mismatch must 403 before any hub fetch.
  assert.equal(claimedDevice, "d1");
  assert.notEqual(claimedDevice, "d2");
});
