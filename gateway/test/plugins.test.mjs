// Plugin-link STORE helpers (round-345: pair codes + WS tickets removed
// with the extension; links still guard the device reverse proxy and are
// revoked on device delete/rename). The plugin registry lives in a single KV
// JSON map (plugins:v1). A Map-backed KV stub stands in for the binding.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { getPluginByToken, removePluginLink, __clearCaches, setAdminPassword, maskKey } from "../src/store.ts";
import { makeEnv as makeBaseEnv } from "./helpers.mjs";

// Full worker fetch: pair/claim + ws-ticket are public (no admin session) —
// the extension has no session cookie. Asserted by behavior, not source order.
// Shared Map-KV stub (helpers.mjs) seeded with this file's minimal base.
function makeEnv() {
  return makeBaseEnv({
    users: { admin: { id: "admin", username: "admin", role: "admin", enabled: true, token: "" } },
    kv: { _admin_seeded: "1", "auth:admin_password": "pw" },
  });
}

async function apiFetch(env, path, init = {}) {
  const req = new Request(`https://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, ...init });
  return worker.fetch(req, env);
}

// Bare stub for the store-helper tests (direct store.ts calls, no worker).
function env() {
  return makeBaseEnv({});
}

test("plugin link: get/remove (KV-seeded)", async () => {
  const e = env();
  __clearCaches();
  await e.KEYS.put("plugins:v1", JSON.stringify({
    "tok": { device: "d1", createdAt: 1, expiresAt: Date.now() + 86400000 * 30 },
  }));
  const link = await getPluginByToken(e, "tok");
  assert.equal(link.device, "d1");
  assert.ok(link.createdAt);
  await removePluginLink(e, "tok");
  assert.equal(await getPluginByToken(e, "tok"), null);
});

// round-340: the public pair/claim + ws-ticket endpoint tests were
// removed with the extension pairing endpoints (browser extension deleted
// round-262). Store-helper tests below stay — handlePair (admin) still uses
// createPairCode / plugin links.
test("plugin link: expires after 30 days, getPluginByToken drops it", async () => {
  const e = env();
  __clearCaches();
  await e.KEYS.put("plugins:v1", JSON.stringify({
    "tok-exp": { device: "d1", createdAt: 1, expiresAt: Date.now() + 86400000 * 30 },
  }));
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
import { issueSessionToken, SESSION_COOKIE } from "../src/auth.ts";

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
  return makeBaseEnv({
    users: { admin: { id: "admin", username: "admin", role: "admin", enabled: true, token: "ADMIN_KEY_123" } },
    kv: { _admin_seeded: "1", "auth:admin_password": "oldsalt:oldhash" },
    // Fail-closed issuance: login refuses without SESSION_SECRET.
    extra: { SESSION_SECRET: "test-session-secret-0123456789abcdef" },
  });
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

// SESSION_SECRET fail-closed issuance: correct credentials but no signing
// secret → 500 config_error and NO session cookie (never fall back to the
// admin password as HMAC key — it would be offline-brute-forceable).
test("login without SESSION_SECRET → 500, no session issued (fail-closed)", async () => {
  __clearCaches();
  const env = makeResetEnv();
  delete env.SESSION_SECRET;
  await setAdminPassword(env, "newpass123");
  const login = await apiFetch(env, "/api/auth/login", { body: JSON.stringify({ username: "admin", password: "newpass123" }) });
  assert.equal(login.status, 500);
  assert.ok(!String(login.headers.get("set-cookie") || "").includes("ag_session="));
});

// Rotation compat: a cookie signed with the OLD admin-password key still
// verifies after SESSION_SECRET is configured (next login re-issues).
test("pre-rotation password-signed cookie still verifies with SESSION_SECRET set", async () => {
  __clearCaches();
  const env = makeEnv();
  env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
  const cookie = await issueSessionToken("pw", "admin", "admin"); // old key = stored admin password
  const req = new Request("https://x/api/plugins/status", { method: "GET", headers: { "content-type": "application/json", cookie: `ag_session=${cookie}` } });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
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

test("plugin link: revoke never resurrects or wipes fresh-KV links (stale-cache guard)", async () => {
  const { migratePluginLinks, removePluginLinksForDevice, listPluginLinks } =
    await import("../src/store.ts");
  const e = env();
  __clearCaches();
  // Prime the isolate cache with only tokA ...
  await e.KEYS.put("plugins:v1", JSON.stringify({
    "tokA": { device: "d1", createdAt: 1, expiresAt: Date.now() + 86400000 * 30 },
  }));
  assert.equal((await getPluginByToken(e, "tokA")).device, "d1");
  // ... then another isolate pairs tokB straight to KV (cache now stale).
  await e.KEYS.put("plugins:v1", JSON.stringify({
    "tokA": { device: "d1", createdAt: 1, expiresAt: Date.now() + 86400000 * 30 },
    "tokB": { device: "d2", createdAt: 2, expiresAt: Date.now() + 86400000 * 30 },
  }));
  // Revoking tokA must NOT wipe tokB (old code rewrote the cached blob).
  await removePluginLink(e, "tokA");
  assert.equal(await getPluginByToken(e, "tokA"), null);
  assert.equal((await getPluginByToken(e, "tokB")).device, "d2");
  // Rename migrates from fresh KV too.
  assert.equal(await migratePluginLinks(e, "d2", "d3"), true);
  assert.equal((await getPluginByToken(e, "tokB")).device, "d3");
  assert.equal(await migratePluginLinks(e, "ghost", "d4"), false);
  // Device delete revokes exactly that device's links.
  assert.equal(await removePluginLinksForDevice(e, "d3"), 1);
  assert.equal(await getPluginByToken(e, "tokB"), null);
  assert.deepEqual(await listPluginLinks(e), {});
});

// ── POST /api/me/keys/reveal (session-gated full-key read for the Keys page
// copy button — the /api/me list only carries maskKey() output, so the old
// copy button copied the MASK, not the credential).
test("keys reveal: session-gated, name-validated, full value only when configured", async () => {
  __clearCaches();
  const env = makeEnv();
  // No session → 401 (fail-closed: this endpoint returns a real credential).
  const unauth = await apiFetch(env, "/api/me/keys/reveal", { body: JSON.stringify({ name: "DEEPSEEK_API_KEY" }) });
  assert.equal(unauth.status, 401);

  const cookie = await issueSessionToken("pw", "admin", "admin");
  const req = (name) =>
    new Request("https://x/api/me/keys/reveal", {
      method: "POST",
      headers: { cookie: `ag_session=${cookie}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });

  // Unknown key name → 400.
  const bad = await worker.fetch(req("NOT_A_KEY"), env);
  assert.equal(bad.status, 400);

  // Unconfigured → 404 (no mask, no empty-string value).
  const missing = await worker.fetch(req("DEEPSEEK_API_KEY"), env);
  assert.equal(missing.status, 404);

  // Configured → the FULL value, not the mask.
  await env.KEYS.put("ukeys:admin", JSON.stringify({ DEEPSEEK_API_KEY: "sk-full-secret-abcdef123456" }));
  __clearCaches();
  const ok = await worker.fetch(req("DEEPSEEK_API_KEY"), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, name: "DEEPSEEK_API_KEY", value: "sk-full-secret-abcdef123456" });
});

// ── GET /api/admin/users: gateway tokens masked, never raw ──
// Same rule as the devices list (maskKey on device tokens): a console
// session holder must not harvest every user's credential. No reveal
// endpoint by design — rotation lives in /api/me.
test("admin/users: user tokens are masked, raw values never leave the server", async () => {
  __clearCaches();
  const env = makeBaseEnv({
    users: {
      admin: { id: "admin", username: "admin", role: "admin", enabled: true, token: "ADMIN_RAW_TOKEN_1234567890" },
      bob: { id: "bob", username: "bob", role: "user", enabled: true, token: "BOB_RAW_TOKEN_1234567890" },
    },
    kv: {
      _admin_seeded: "1",
      "auth:admin_password": "pw",
      "token:ADMIN_RAW_TOKEN_1234567890": "admin",
      "token:BOB_RAW_TOKEN_1234567890": "bob",
    },
  });
  const cookie = await issueSessionToken("pw", "admin", "admin");
  const res = await worker.fetch(
    new Request("https://x/api/admin/users", { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("ADMIN_RAW_TOKEN_1234567890"), "admin raw token must not leak");
  assert.ok(!raw.includes("BOB_RAW_TOKEN_1234567890"), "user raw token must not leak");
  const byId = Object.fromEntries(body.users.map((u) => [u.id, u]));
  assert.equal(byId.admin.token, maskKey("ADMIN_RAW_TOKEN_1234567890"));
  assert.equal(byId.bob.token, maskKey("BOB_RAW_TOKEN_1234567890"));
});

// ── Link-map hardening (round-392: sweep persistence, legacy links,
// corrupt blobs, write-through — only return values were pinned) ──

test("plugin link: expired get sweeps the KV record (not just null)", async () => {
  const { PLUGIN_LINK_TTL_MS } = await import("../src/store.ts");
  assert.equal(PLUGIN_LINK_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  const e = env();
  __clearCaches();
  await e.KEYS.put("plugins:v1", JSON.stringify({
    "tok-old": { device: "d1", createdAt: 1, expiresAt: Date.now() - 1000 },
    "tok-live": { device: "d1", createdAt: 1, expiresAt: Date.now() + 86400000 },
  }));
  assert.equal(await getPluginByToken(e, "tok-old"), null);
  const raw = JSON.parse(await e.KEYS.get("plugins:v1"));
  assert.equal(raw["tok-old"], undefined, "expired link must be deleted from KV");
  assert.ok(raw["tok-live"], "live link must survive the sweep");
});

test("plugin link: legacy record without expiresAt sweeps as expired (round-122)", async () => {
  const e = env();
  __clearCaches();
  await e.KEYS.put("plugins:v1", JSON.stringify({
    "tok-legacy": { device: "d1", createdAt: 1 },
  }));
  assert.equal(await getPluginByToken(e, "tok-legacy"), null);
  const raw = JSON.parse(await e.KEYS.get("plugins:v1"));
  assert.equal(raw["tok-legacy"], undefined, "legacy link must not grant permanent control");
});

test("plugin link: corrupt blob reads as empty, never throws", async () => {
  const { listPluginLinks, savePluginLinks, migratePluginLinks, removePluginLinksForDevice } =
    await import("../src/store.ts");
  const e = env();
  __clearCaches();
  await e.KEYS.put("plugins:v1", "not json{{{");
  assert.deepEqual(await listPluginLinks(e), {});
  assert.equal(await getPluginByToken(e, "anything"), null);
  await removePluginLink(e, "anything");
  assert.equal(await migratePluginLinks(e, "a", "b"), false);
  assert.equal(await removePluginLinksForDevice(e, "a"), 0);
  // savePluginLinks tested below; keep the import used.
  void savePluginLinks;
});

test("plugin link: savePluginLinks is write-through (same-isolate reads stay fresh)", async () => {
  const { listPluginLinks, savePluginLinks } = await import("../src/store.ts");
  const e = env();
  __clearCaches();
  const map = { tokW: { device: "d9", createdAt: 7, expiresAt: Date.now() + 99999 } };
  await savePluginLinks(e, map);
  assert.deepEqual(JSON.parse(await e.KEYS.get("plugins:v1")), map);
  // Yank the KV record out from under the isolate: the write-through
  // cache still serves the saved map (documented same-isolate behavior).
  env_scrub(e);
  assert.deepEqual(await listPluginLinks(e), map);
});

function env_scrub(e) {
  e._kv.delete("plugins:v1");
}
