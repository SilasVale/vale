// Plugin pairing/ticket store helpers + the public pair/claim and ws-ticket
// routes. The plugin registry lives in a single KV JSON map (plugins:v1);
// pair codes and WS tickets are one-time KV values with TTLs. A Map-backed KV
// stub stands in for the Workers binding.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createPairCode, consumePairCode, addPluginLink, getPluginByToken, removePluginLink, createWsTicket, consumeWsTicket } from "../src/store.js";

// Full worker fetch: pair/claim + ws-ticket are public (no admin session) —
// the extension has no session cookie. Asserted by behavior, not source order.
function makeEnv() {
  const m = new Map([
    ["_admin_seeded", "1"],
    ["auth:admin_password", "pw"],
    ["user:admin", JSON.stringify({ id: "admin", username: "admin", role: "admin", enabled: true, token: "" })],
  ]);
  return {
    CONSOLE_HOST: "x",
    KEYS: {
      async get(k) { return m.has(k) ? m.get(k) : null; },
      async put(k, v) { m.set(k, v); },
      async delete(k) { m.delete(k); },
    },
  };
}

async function apiFetch(env, path, init = {}) {
  const req = new Request(`https://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, ...init });
  return worker.fetch(req, env);
}

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

// Behavior tests: pair/claim and ws-ticket are PUBLIC (the extension has no
// session cookie) — a valid code/ticket returns 200, invalid ones 403/401.

test("pair/claim: valid code → 200 with token, invalid code → 403", async () => {
  const env = makeEnv();
  // Store a real pair code for device d1 (value is the device name string).
  const kv = env.KEYS;
  const code = "PAIRCODE123";
  await kv.put(`pair:${code}`, "d1");
  const ok = await apiFetch(env, "/api/plugins/pair/claim", { body: JSON.stringify({ code }) });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.device, "d1");
  assert.ok(j.token.length >= 8);
  // One-time: consuming again fails (the code was deleted).
  const again = await apiFetch(env, "/api/plugins/pair/claim", { body: JSON.stringify({ code }) });
  assert.equal(again.status, 403);
  // Unknown code → 403.
  const bad = await apiFetch(env, "/api/plugins/pair/claim", { body: JSON.stringify({ code: "NOPE" }) });
  assert.equal(bad.status, 403);
});

test("pair/claim: no admin session required (public route)", async () => {
  const env = makeEnv();
  const kv = env.KEYS;
  await kv.put("pair:CODE2", "d1");
  // No cookie, no Authorization header — must still reach the handler.
  const res = await apiFetch(env, "/api/plugins/pair/claim", { body: JSON.stringify({ code: "CODE2" }) });
  assert.equal(res.status, 200);
});

test("ws-ticket: valid plugin token → 200, unknown token → 401 (public route)", async () => {
  const env = makeEnv();
  const kv = env.KEYS;
  await kv.put("plugins:v1", JSON.stringify({ "tok-d1": { device: "d1", createdAt: 1 } }));
  const ok = await apiFetch(env, "/api/plugins/ws-ticket", {
    headers: { authorization: "Bearer tok-d1", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(ok.status, 200);
  const bad = await apiFetch(env, "/api/plugins/ws-ticket", {
    headers: { authorization: "Bearer tok-nope", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(bad.status, 401);
});
