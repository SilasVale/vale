// Plugin pairing/ticket store helpers + the public pair/claim and ws-ticket
// routes. The plugin registry lives in a single KV JSON map (plugins:v1);
// pair codes and WS tickets are one-time KV values with TTLs. A Map-backed KV
// stub stands in for the Workers binding.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createPairCode, consumePairCode, addPluginLink, getPluginByToken, removePluginLink, createWsTicket, consumeWsTicket, __clearCaches } from "../src/store.js";

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
  // round-55: the plugin map is write-through cached now — a direct KV put
  // must clear the cache or the earlier add/remove tests' cached (empty) map
  // wins and the valid token 401s.
  __clearCaches();
  await kv.put("plugins:v1", JSON.stringify({ "tok-d1": { device: "d1", createdAt: 1, expiresAt: Date.now() + 86400000 * 30 } }));
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

test("plugin link: expires after 30 days, getPluginByToken drops it", async () => {
  const e = env();
  await addPluginLink(e, "tok-exp", "d1");
  const realNow = Date.now;
  try {
    assert.equal((await getPluginByToken(e, "tok-exp")).device, "d1");
    Date.now = () => realNow() + 31 * 24 * 60 * 60 * 1000; // 31 days
    assert.equal(await getPluginByToken(e, "tok-exp"), null);
  } finally {
    Date.now = realNow;
  }
});

// round-88: /api/plugins/status is admin-session-gated — no cookie → 401,
// a copied pre-logout cookie (sess-revoked blacklist) → 401, a valid admin
// session → 200. The R83 hand-rolled gate must match requireSession.
import { issueSessionToken } from "../src/auth.ts";

test("plugins/status: no cookie → 401 (R83 gate)", async () => {
  const env = makeEnv();
  const req = new Request("https://x/api/plugins/status", { method: "GET", headers: { "content-type": "application/json" } });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 401);
});

test("plugins/status: revoked cookie → 401 (R88 blacklist)", async () => {
  const env = makeEnv();
  // Blacklist a fake session cookie the way logout does (sess-revoked:<cookie>).
  await env.KEYS.put("sess-revoked:fake-cookie", "1", { expirationTtl: 3600 });
  const req = new Request("https://x/api/plugins/status", { method: "GET", headers: { "content-type": "application/json", cookie: "ag_session=fake-cookie" } });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 401);
});

test("plugins/status: valid admin session → 200 (R83 gate)", async () => {
  const env = makeEnv();
  const cookie = await issueSessionToken("pw", "admin", "admin");
  const req = new Request("https://x/api/plugins/status", { method: "GET", headers: { "content-type": "application/json", cookie: `ag_session=${cookie}` } });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
});

/* ---- Reset admin password (round-113, by admin gateway token) ---- */

function makeResetEnv() {
  const m = new Map([
    ["_admin_seeded", "1"],
    ["auth:admin_password", "oldsalt:oldhash"],
    ["user:admin", JSON.stringify({ id: "admin", username: "admin", role: "admin", enabled: true, token: "ADMIN_KEY_123" })],
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

test("reset-password: wrong adminKey → 403", async () => {
  __clearCaches();
  const env = makeResetEnv();
  const res = await apiFetch(env, "/api/auth/reset-password", { body: JSON.stringify({ adminKey: "WRONG", newPassword: "newpass123" }) });
  assert.equal(res.status, 403);
});

test("reset-password: correct adminKey → 200, login with new pw works, old rejected", async () => {
  __clearCaches();
  const env = makeResetEnv();
  const res = await apiFetch(env, "/api/auth/reset-password", { body: JSON.stringify({ adminKey: "ADMIN_KEY_123", newPassword: "newpass123" }) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);

  const login = await apiFetch(env, "/api/auth/login", { body: JSON.stringify({ username: "admin", password: "newpass123" }) });
  assert.equal(login.status, 200);
  const old = await apiFetch(env, "/api/auth/login", { body: JSON.stringify({ username: "admin", password: "oldpass" }) });
  assert.equal(old.status, 401);
});

test("reset-password: too-short new password → 400", async () => {
  __clearCaches();
  const env = makeResetEnv();
  const res = await apiFetch(env, "/api/auth/reset-password", { body: JSON.stringify({ adminKey: "ADMIN_KEY_123", newPassword: "short" }) });
  assert.equal(res.status, 400);
});

test("OpenRouter usage: authenticated request normalizes account data", async () => {
  __clearCaches();
  const env = makeEnv();
  await env.KEYS.put("ukeys:admin", JSON.stringify({ OPENROUTER_API_KEY: "or-secret" }));
  const cookie = await issueSessionToken("pw", "admin", "admin");
  const originalFetch = globalThis.fetch;
  let called;
  globalThis.fetch = async (url, init) => {
    called = { url, init };
    return new Response(JSON.stringify({ data: {
      label: "admin@example.com",
      usage: 1.25,
      limit: 10,
      is_free_tier: false,
      rate_limit: { limit: 200, interval: "1s" },
      unrelated: "must not leak",
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const req = new Request("https://x/api/me/keys/usage", {
      method: "POST",
      headers: { cookie: `ag_session=${cookie}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "OPENROUTER_API_KEY" }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      name: "OPENROUTER_API_KEY",
      status: 200,
      label: "admin@example.com",
      usage: 1.25,
      limit: 10,
      isFreeTier: false,
      rateLimit: { limit: 200, interval: "1s" },
    });
    assert.equal(called.url, "https://openrouter.ai/api/v1/auth/key");
    assert.equal(called.init.headers.Authorization, "Bearer or-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter usage: no session → 401 and invalid provider → 400", async () => {
  __clearCaches();
  const env = makeEnv();
  const unauth = await apiFetch(env, "/api/me/keys/usage", { body: JSON.stringify({ name: "OPENROUTER_API_KEY" }) });
  assert.equal(unauth.status, 401);
  const cookie = await issueSessionToken("pw", "admin", "admin");
  const req = new Request("https://x/api/me/keys/usage", {
    method: "POST",
    headers: { cookie: `ag_session=${cookie}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "DEEPSEEK_API_KEY" }),
  });
  const bad = await worker.fetch(req, env);
  assert.equal(bad.status, 400);
});

test("OpenRouter usage: missing key and upstream failure are safe", async () => {
  __clearCaches();
  const env = makeEnv();
  const cookie = await issueSessionToken("pw", "admin", "admin");
  const request = () => new Request("https://x/api/me/keys/usage", {
    method: "POST",
    headers: { cookie: `ag_session=${cookie}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "OPENROUTER_API_KEY" }),
  });
  const missing = await worker.fetch(request(), env);
  assert.deepEqual(await missing.json(), { ok: false, name: "OPENROUTER_API_KEY", detail: "Key not configured" });
  await env.KEYS.put("ukeys:admin", JSON.stringify({ OPENROUTER_API_KEY: "or-secret" }));
  __clearCaches();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("provider secret", { status: 429 });
  try {
    const failed = await worker.fetch(request(), env);
    assert.deepEqual(await failed.json(), { ok: false, name: "OPENROUTER_API_KEY", status: 429, detail: "Upstream 429" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
