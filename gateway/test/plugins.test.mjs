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

// ── Admin ops remainder (round-424: cf-token shape/masking, invite issue,
// enable/disable guards had zero pins) ──

function adminEnv() {
  return makeBaseEnv({
    users: {
      admin: { id: "admin", username: "admin", role: "admin", enabled: true, token: "" },
      bob: { id: "bob", username: "bob", role: "user", enabled: true, token: "" },
    },
    kv: { _admin_seeded: "1", "auth:admin_password": "pw" },
  });
}

async function adminCookie() {
  return `ag_session=${await issueSessionToken("pw", "admin", "admin")}`;
}

test("admin/cf-token: invalid shape 400, valid roundtrips masked, empty clears", async () => {
  __clearCaches();
  const env = adminEnv();
  const h = { cookie: await adminCookie(), "content-type": "application/json" };
  const put = (token) => worker.fetch(
    new Request("https://x/api/admin/cloudflare-token", { method: "PUT", headers: h, body: JSON.stringify({ token }) }),
    env,
  );
  assert.equal((await put("short")).status, 400);
  assert.equal((await put("bad chars!!")).status, 400);
  const good = "CFTOKEN_abcdef1234567890";
  assert.deepEqual(await (await put(good)).json(), { ok: true });
  const got = await worker.fetch(new Request("https://x/api/admin/cloudflare-token", { headers: { cookie: await adminCookie() } }), env);
  const body = await got.json();
  assert.equal(body.configured, true);
  assert.equal(body.masked, maskKey(good));
  assert.ok(!JSON.stringify(body).includes(good), "raw CF token must not leak");
  assert.deepEqual(await (await put("")).json(), { ok: true });
  __clearCaches();
  const cleared = await worker.fetch(new Request("https://x/api/admin/cloudflare-token", { headers: { cookie: await adminCookie() } }), env);
  assert.equal((await cleared.json()).configured, false);
});

test("admin/invite: issues a code; gates apply", async () => {
  __clearCaches();
  const env = adminEnv();
  const h = { cookie: await adminCookie(), "content-type": "application/json" };
  const res = await worker.fetch(new Request("https://x/api/admin/invite", { method: "POST", headers: h }), env);
  assert.equal(res.status, 200);
  const { ok, code } = await res.json();
  assert.equal(ok, true);
  assert.ok(typeof code === "string" && code.length > 0, "invite code must be non-empty");
  // no session → 401
  assert.equal((await worker.fetch(new Request("https://x/api/admin/invite", { method: "POST" }), env)).status, 401);
});

test("admin/users/{id}/enabled: malformed id 400, admin untouchable, bob flips", async () => {
  __clearCaches();
  const env = adminEnv();
  const cookie = await adminCookie();
  const put = (id, enabled) => worker.fetch(
    new Request(`https://x/api/admin/users/${id}/enabled`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ enabled }) }),
    env,
  );
  assert.equal((await put("admin", false)).status, 400);
  assert.equal((await put("%zz", false)).status, 400);
  const off = await put("bob", false);
  assert.deepEqual(await off.json(), { ok: true, id: "bob", enabled: false });
  const on = await put("bob", true);
  assert.deepEqual(await on.json(), { ok: true, id: "bob", enabled: true });
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

// round-437 (coverage-driven): PUT /api/me/keys (BYOK save) had ZERO
// direct pins — the validation arms and the masked-echo contract.
test("me/keys PUT: 401 without session, 400 unknown name / empty value", async () => {
  __clearCaches();
  const env = makeEnv();
  const unauth = await worker.fetch(new Request("https://x/api/me/keys", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "OPENROUTER_API_KEY", value: "x" }),
  }), env);
  assert.equal(unauth.status, 401);
  const cookie = await issueSessionToken("pw", "admin", "admin");
  const put = (body) => worker.fetch(new Request("https://x/api/me/keys", {
    method: "PUT",
    headers: { cookie: `ag_session=${cookie}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  assert.equal((await put({ name: "NOPE_KEY", value: "x" })).status, 400);
  assert.equal((await put({ name: "OPENROUTER_API_KEY", value: "   " })).status, 400);
  assert.equal((await put({ name: "OPENROUTER_API_KEY" })).status, 400);
});

test("me/keys PUT: saves trimmed, echoes masked, reveal reads back full", async () => {
  __clearCaches();
  const env = makeEnv();
  const cookie = await issueSessionToken("pw", "admin", "admin");
  const authed = (path, method, body) => worker.fetch(new Request(`https://x${path}`, {
    method,
    headers: { cookie: `ag_session=${cookie}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  const res = await authed("/api/me/keys", "PUT", { name: "OPENROUTER_API_KEY", value: "  or-secret-value  " });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.masked, maskKey("or-secret-value"));
  assert.ok(!JSON.stringify(j).includes("or-secret-value"), "echo must not leak the secret");
  const stored = JSON.parse(await env.KEYS.get("ukeys:admin"));
  assert.equal(stored.OPENROUTER_API_KEY, "or-secret-value");
  const reveal = await authed("/api/me/keys/reveal", "POST", { name: "OPENROUTER_API_KEY" });
  assert.equal((await reveal.json()).value, "or-secret-value");
});

// round-438 (coverage-driven): POST /api/auth/register had ZERO route
// pins — the invite-gated account creation front door.
function regEnv() {
  return makeBaseEnv({
    users: {
      admin: { id: "admin", username: "admin", role: "admin", enabled: true, token: "" },
    },
    kv: { _admin_seeded: "1", "auth:admin_password": "pw" },
    extra: { SESSION_SECRET: "test-session-secret-0123456789abcdef" },
  });
}

async function mintInvite(env, adminH) {
  const r = await worker.fetch(new Request("https://x/api/admin/invite", {
    method: "POST", headers: adminH,
  }), env);
  assert.equal(r.status, 200);
  return (await r.json()).code;
}

test("register: invite → 200 with session cookie; new creds log in", async () => {
  __clearCaches();
  const env = regEnv();
  const adminH = { cookie: `ag_session=${await issueSessionToken("pw", "admin", "admin")}`, "content-type": "application/json" };
  const code = await mintInvite(env, adminH);
  const res = await worker.fetch(new Request("https://x/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "cara", password: "s3cret-long", inviteCode: code }),
  }), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.username, "cara");
  assert.equal(j.role, "user");
  assert.ok(j.token, "new user gets a device token");
  assert.ok(String(res.headers.get("set-cookie") || "").includes("ag_session="));
  const login = await worker.fetch(new Request("https://x/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "cara", password: "s3cret-long" }),
  }), env);
  assert.equal(login.status, 200);
});

test("register: bad invite / short password / duplicate name → 400; no secret → 500", async () => {
  __clearCaches();
  const env = regEnv();
  const reg = (body) => worker.fetch(new Request("https://x/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  assert.equal((await reg({ username: "dave", password: "s3cret-long", inviteCode: "WRONG" })).status, 400);
  const adminH = { cookie: `ag_session=${await issueSessionToken("pw", "admin", "admin")}`, "content-type": "application/json" };
  const code = await mintInvite(env, adminH);
  assert.equal((await reg({ username: "erin", password: "short", inviteCode: code })).status, 400);
  assert.equal((await reg({ username: "frank", password: "s3cret-long", inviteCode: code })).status, 200);
  assert.equal((await reg({ username: "frank", password: "s3cret-long", inviteCode: code })).status, 400);
  delete env.SESSION_SECRET;
  const code2 = await mintInvite(env, adminH);
  assert.equal((await reg({ username: "gail", password: "s3cret-long", inviteCode: code2 })).status, 500);
});

// round-442 (coverage-driven): the logout blacklist write had ZERO direct
// pins — only its verify side was tested. Round-122 (*1000 ms-unit bug)
// and round-124 (<60s floor) both lived exactly here.
test("logout: session cookie lands on the sess-revoked blacklist with a capped TTL", async () => {
  __clearCaches();
  const env = regEnv();
  const cookie = await issueSessionToken("test-session-secret-0123456789abcdef", "admin", "admin");
  const before = Math.floor(Date.now() / 1000);
  const res = await worker.fetch(new Request("https://x/api/auth/logout", {
    method: "POST",
    headers: { cookie: `ag_session=${cookie}` },
  }), env);
  assert.equal(res.status, 200);
  assert.ok(String(res.headers.get("set-cookie") || "").includes("ag_session=;"), "client cookie cleared");
  const rec = `sess-revoked:${cookie}`;
  assert.equal(await env.KEYS.get(rec), "1");
  const exp = env._expiry.get(rec);
  assert.ok(exp && exp - before <= 86400 && exp - before > 86000, `TTL capped at 24h, got ${exp - before}s`);
  // And the blacklisted cookie now dies on a gated route.
  const gated = await worker.fetch(new Request("https://x/api/plugins/status", {
    headers: { cookie: `ag_session=${cookie}` },
  }), env);
  assert.equal(gated.status, 401);
});

// round-443 (coverage-driven): /api/me/usproxy + /api/me/token/regenerate
// had ZERO route pins.
function meEnv() {
  return makeBaseEnv({
    users: {
      admin: { id: "admin", username: "admin", role: "admin", enabled: true, token: "" },
      bob: { id: "bob", username: "bob", role: "user", enabled: true, token: "bob-tok-1" },
    },
    kv: { _admin_seeded: "1", "auth:admin_password": "pw", "token:bob-tok-1": "bob" },
  });
}

const meReq = (env, cookie, path, method, body) => worker.fetch(new Request(`https://x${path}`, {
  method,
  headers: { ...(cookie ? { cookie: `ag_session=${cookie}` } : {}), "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}), env);

test("usproxy: 401 unauth, 403 non-admin, admin toggle roundtrips", async () => {
  __clearCaches();
  const env = meEnv();
  assert.equal((await meReq(env, null, "/api/me/usproxy", "GET")).status, 401);
  const admin = await issueSessionToken("pw", "admin", "admin");
  const bob = await issueSessionToken("pw", "bob", "user");
  assert.equal((await meReq(env, bob, "/api/me/usproxy", "PUT", { enabled: true })).status, 403);
  assert.deepEqual(await (await meReq(env, admin, "/api/me/usproxy", "GET")).json(), { enabled: false });
  assert.deepEqual(await (await meReq(env, admin, "/api/me/usproxy", "PUT", { enabled: true })).json(), { ok: true, enabled: true });
  assert.deepEqual(await (await meReq(env, admin, "/api/me/usproxy", "GET")).json(), { enabled: true });
  // round-94 end-to-end: explicit OFF persists (not env-bounce).
  assert.deepEqual(await (await meReq(env, admin, "/api/me/usproxy", "PUT", { enabled: false })).json(), { ok: true, enabled: false });
  assert.equal(await env.KEYS.get("settings:US_PROXY"), "0");
});

test("token/regenerate: 401 unauth; authed rotates and kills the old token", async () => {
  __clearCaches();
  const env = meEnv();
  assert.equal((await meReq(env, null, "/api/me/token/regenerate", "POST", {})).status, 401);
  const bob = await issueSessionToken("pw", "bob", "user");
  const res = await meReq(env, bob, "/api/me/token/regenerate", "POST", {});
  assert.equal(res.status, 200);
  const { token } = await res.json();
  assert.ok(token && token !== "bob-tok-1", "fresh token issued");
  assert.equal(await env.KEYS.get("token:bob-tok-1"), null, "old token revoked");
});

// round-444 (coverage-driven): DELETE /api/me/keys had ZERO route pins
// (store-level deleteUserKey covered, handler not).
test("me/keys DELETE: 401 unauth, 400 unknown name, deletes by query param", async () => {
  __clearCaches();
  const env = meEnv();
  const del = (cookie, qs) => worker.fetch(new Request(`https://x/api/me/keys${qs}`, {
    method: "DELETE",
    headers: { ...(cookie ? { cookie: `ag_session=${cookie}` } : {}) },
  }), env);
  assert.equal((await del(null, "?name=OPENROUTER_API_KEY")).status, 401);
  const bob = await issueSessionToken("pw", "bob", "user");
  assert.equal((await del(bob, "?name=NOPE_KEY")).status, 400);
  await env.KEYS.put("ukeys:bob", JSON.stringify({ OPENROUTER_API_KEY: "or-secret" }));
  const res = await del(bob, "?name=OPENROUTER_API_KEY");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await env.KEYS.get("ukeys:bob")), {});
});

// round-445 (coverage-driven): GET/PUT /api/me/route had ZERO route pins.
test("me/route: 401 unauth; PUT validates whitelist; GET shows stored + effective", async () => {
  __clearCaches();
  const env = meEnv();
  assert.equal((await meReq(env, null, "/api/me/route", "GET")).status, 401);
  assert.equal((await meReq(env, null, "/api/me/route", "PUT", { model: "og/deepseek-v4-flash" })).status, 401);
  const bob = await issueSessionToken("pw", "bob", "user");
  const fresh = await (await meReq(env, bob, "/api/me/route", "GET")).json();
  assert.equal(fresh.model, null);
  assert.equal(fresh.effective, null, "no stored route and no resolver wiring → null");
  assert.equal((await meReq(env, bob, "/api/me/route", "PUT", { model: "nope/model" })).status, 400);
  const put = await meReq(env, bob, "/api/me/route", "PUT", { model: "og/deepseek-v4-flash" });
  assert.deepEqual(await put.json(), { ok: true, model: "og/deepseek-v4-flash" });
  const after = await (await meReq(env, bob, "/api/me/route", "GET")).json();
  assert.equal(after.model, "og/deepseek-v4-flash");
  assert.equal(after.effective, "og/deepseek-v4-flash", "effective mirrors the stored route");
  const clear = await meReq(env, bob, "/api/me/route", "PUT", { model: null });
  assert.deepEqual(await clear.json(), { ok: true, model: null });
});
