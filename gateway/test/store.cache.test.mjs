// store.js KV-cache unit tests — pure local, no Cloudflare calls.
//
// The store layer is the only KV consumer in the repo; these tests verify the
// 24h TTL cache + write-through behavior: repeated reads cost one KV get,
// writes refresh the cache immediately, token revocation is instant, and the
// TTL backstop re-reads after expiry. A counting mock KV stands in for the
// Workers binding.
import test from "node:test";
import assert from "node:assert/strict";
import * as store from "../src/store.js";

// ── Counting mock KV ───────────────────────────────────────────

function makeKV(seed = {}) {
  const kv = new Map(Object.entries(seed));
  const counters = { get: 0, put: 0, del: 0, list: 0 };
  return {
    counters,
    KEYS: {
      async get(k) { counters.get++; return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { counters.put++; kv.set(k, String(v)); },
      async delete(k) { counters.del++; kv.delete(k); },
      async list(opts = {}) {
        counters.list++;
        const prefix = opts.prefix || "";
        return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
      },
    },
    // raw access for seed assertions
    _kv: kv,
  };
}

const user = (id, extra = {}) => JSON.stringify({ id, username: id, role: "user", enabled: true, ...extra });

// ── Read caching ───────────────────────────────────────────────

test("getUser: two reads → one KV get", async () => {
  const kv = makeKV({ "user:alice": user("alice") });
  const u1 = await store.getUser(kv, "alice");
  const u2 = await store.getUser(kv, "alice");
  assert.equal(u1.id, "alice");
  assert.equal(u2.id, "alice");
  assert.equal(kv.counters.get, 1);
});

test("getUser caches 'not found' too (no zombie lookups)", async () => {
  const kv = makeKV({});
  assert.equal(await store.getUser(kv, "ghost-1"), null);
  assert.equal(await store.getUser(kv, "ghost-1"), null);
  assert.equal(kv.counters.get, 1);
});

test("findUserByToken: token + user each cached", async () => {
  const kv = makeKV({ "user:gloria": user("gloria"), "token:tok-gloria": "gloria" });
  await store.findUserByToken(kv, "tok-gloria");
  await store.findUserByToken(kv, "tok-gloria");
  assert.equal(kv.counters.get, 2); // one token read + one user read, not 4
});

test("getAdminPassword: hashed (salt:hash), cached, verified, refreshed by set", async () => {
  const kv = makeKV({});
  assert.equal(await store.getAdminPassword(kv), "");
  await store.setAdminPassword(kv, "pw-1");
  const stored1 = await store.getAdminPassword(kv);
  // Never plaintext: stored as salt:pbkdf2hash.
  assert.notEqual(stored1, "pw-1");
  assert.match(stored1, /^[0-9a-f]+:[0-9a-f]+$/);
  assert.equal(await store.verifyAdminPassword(kv, "pw-1"), true);
  assert.equal(await store.verifyAdminPassword(kv, "wrong"), false);
  await store.setAdminPassword(kv, "pw-2");
  assert.equal(await store.verifyAdminPassword(kv, "pw-2"), true);
  assert.equal(await store.verifyAdminPassword(kv, "pw-1"), false);
  assert.equal(kv.counters.get, 1); // first read only — subsequent reads cached
});

// ── Write-through freshness ────────────────────────────────────

test("setUserEnabled refreshes the cache immediately", async () => {
  const kv = makeKV({ "user:bob": user("bob") });
  await store.getUser(kv, "bob"); // cache miss → 1 get
  const u = await store.setUserEnabled(kv, "bob", false); // raw read → 2 get + put
  assert.equal(u.enabled, false);
  const again = await store.getUser(kv, "bob"); // cache hit, fresh value
  assert.equal(again.enabled, false);
  assert.equal(kv.counters.get, 2);
});

test("regenerateToken revokes the old token immediately", async () => {
  const kv = makeKV({
    "user:carol": user("carol", { token: "tok-old-carol" }),
    "token:tok-old-carol": "carol",
  });
  assert.equal((await store.findUserByToken(kv, "tok-old-carol")).id, "carol");
  const newTok = await store.regenerateToken(kv, "carol");
  assert.notEqual(newTok, "tok-old-carol");
  assert.equal(await store.findUserByToken(kv, "tok-old-carol"), null); // old dead
  assert.equal((await store.findUserByToken(kv, newTok)).id, "carol"); // new works
});

test("setUserKey / deleteUserKey refresh getUserKeys", async () => {
  const kv = makeKV({});
  assert.deepEqual(await store.getUserKeys(kv, "dave"), {});
  await store.setUserKey(kv, "dave", "DEEPSEEK_API_KEY", "sk-123");
  assert.equal((await store.getUserKeys(kv, "dave")).DEEPSEEK_API_KEY, "sk-123");
  await store.deleteUserKey(kv, "dave", "DEEPSEEK_API_KEY");
  assert.equal((await store.getUserKeys(kv, "dave")).DEEPSEEK_API_KEY, undefined);
});

test("saveDevices refreshes listDevices (via upsert/delete)", async () => {
  const kv = makeKV({});
  assert.deepEqual(await store.listDevices(kv), []);
  await store.upsertDevice(kv, { name: "d1", hostname: "d1.example.com", token: "abcdefgh" });
  assert.deepEqual(await store.listDevices(kv), [{ name: "d1", hostname: "d1.example.com", token: "abcdefgh" }]);
  assert.equal(await store.deleteDevice(kv, "d1"), true);
  assert.deepEqual(await store.listDevices(kv), []);
});

test("setCfToken: put and delete both refresh the cache", async () => {
  const kv = makeKV({});
  await store.setCfToken(kv, "cfat-xyz");
  assert.equal(await store.getCfToken(kv), "cfat-xyz");
  await store.setCfToken(kv, "");
  assert.equal(await store.getCfToken(kv), "");
});

test("createUser writes and caches user + token", async () => {
  const kv = makeKV({ "invite:AAAAA": "1" });
  const created = await store.createUser(kv, { username: "frank", password: "secret123", inviteCode: "AAAAA" });
  assert.equal((await store.findUserByToken(kv, created.token)).username, "frank");
  assert.equal((await store.findUserByUsername(kv, "frank")).username, "frank");
  assert.equal((await store.getUser(kv, "frank")).username, "frank");
  assert.ok(kv._kv.has("user:frank"));
});

// ── TTL backstop & uncached keys ───────────────────────────────

test("cached entries are re-read after the 24h TTL", async () => {
  const kv = makeKV({ "user:erin": user("erin") });
  const realNow = Date.now;
  try {
    await store.getUser(kv, "erin"); // miss → 1 get
    await store.getUser(kv, "erin"); // hit
    assert.equal(kv.counters.get, 1);
    Date.now = () => realNow() + 25 * 60 * 60 * 1000; // advance 25h
    await store.getUser(kv, "erin"); // expired → re-read
    assert.equal(kv.counters.get, 2);
  } finally {
    Date.now = realNow;
  }
});

test("hasRegKey always reads KV (one-time keys not cached)", async () => {
  const kv = makeKV({ "regkey:abc123": "1" });
  assert.equal(await store.hasRegKey(kv, "abc123"), true);
  assert.equal(await store.hasRegKey(kv, "abc123"), true);
  assert.equal(kv.counters.get, 2);
});

test("consumeRegKey spends the key once and grants register handoff", async () => {
  const kv = makeKV({ "regkey:xyz789": "1" });
  assert.equal(await store.hasRegKey(kv, "xyz789"), true);
  await store.consumeRegKey(kv, "xyz789");
  // spent: neither the key itself nor repeated grants can re-harvest
  assert.equal(await store.hasRegKey(kv, "xyz789"), false);
  assert.equal(await store.hasRegKey(kv, "xyz789"), false); // no regeneration
  assert.equal(kv.counters.get, 3);
  // the one-time grant lets the same install finish registration
  assert.equal(await store.hasRegGrant(kv, "xyz789"), true); // 4th get
  await store.deleteRegGrant(kv, "xyz789");
  assert.equal(await store.hasRegGrant(kv, "xyz789"), false);
});

test("listUsers reads raw (not cached)", async () => {
  const kv = makeKV({ "user:alice": user("alice"), "user:bob": user("bob") });
  const users = await store.listUsers(kv);
  assert.equal(users.length, 2);
  assert.equal(kv.counters.list, 1);
  assert.equal(kv.counters.get, 2); // one get per user, uncached
});

// ── Per-user route selection (model=auto) ──────────────────────
// Route storage now uses RouteDO (Durable Object) instead of KV.
// Mock RouteDO for unit tests.

function makeRouteDO() {
  const store = new Map();
  return {
    idFromName: () => ({}),
    get: () => ({
      fetch: async (req, init) => {
        const method = init?.method || "GET";
        const url = new URL(typeof req === "string" ? req : req.url);
        const uid = url.searchParams.get("uid");
        if (method === "GET") {
          return new Response(JSON.stringify({ model: store.get(uid) || null }));
        }
        if (method === "PUT") {
          const body = JSON.parse(init.body || "{}");
          store.set(body.uid, body.model);
          return new Response(JSON.stringify({ ok: true }));
        }
        if (method === "DELETE") {
          store.delete(uid);
          return new Response(JSON.stringify({ ok: true }));
        }
        return new Response("not found", { status: 404 });
      },
    }),
  };
}

test("getUserRoute / setUserRoute: DO-based read/write", async () => {
  const env = { ROUTE: makeRouteDO() };
  assert.equal(await store.getUserRoute(env, "admin"), null);
  await store.setUserRoute(env, "admin", "qw/qwen3.8-max-preview");
  assert.equal(await store.getUserRoute(env, "admin"), "qw/qwen3.8-max-preview");
  await store.setUserRoute(env, "admin", "ds/deepseek-v4-flash");
  assert.equal(await store.getUserRoute(env, "admin"), "ds/deepseek-v4-flash");
});

test("getUserRoute / setUserRoute: clear route with null", async () => {
  const env = { ROUTE: makeRouteDO() };
  await store.setUserRoute(env, "erin", "qw/qwen3.8-max-preview");
  assert.equal(await store.getUserRoute(env, "erin"), "qw/qwen3.8-max-preview");
  await store.setUserRoute(env, "erin", null);
  assert.equal(await store.getUserRoute(env, "erin"), null);
});

test("getUserRoute / setUserRoute: isolated per user", async () => {
  const env = { ROUTE: makeRouteDO() };
  await store.setUserRoute(env, "alice", "og/deepseek-v4-flash");
  await store.setUserRoute(env, "bob", "qw/qwen3.8-max-preview");
  assert.equal(await store.getUserRoute(env, "alice"), "og/deepseek-v4-flash");
  assert.equal(await store.getUserRoute(env, "bob"), "qw/qwen3.8-max-preview");
});

test("getGlobalSetting: auth keys expire after 60s (not 24h)", async () => {
  const kv = makeKV({ "settings:US_PROXY": "1" });
  const realNow = Date.now;
  try {
    assert.equal(await store.getGlobalSetting(kv, "US_PROXY"), "1"); // cache
    assert.equal(kv.counters.get, 1);
    Date.now = () => realNow() + 61 * 1000; // past the 60s auth TTL
    assert.equal(await store.getGlobalSetting(kv, "US_PROXY"), "1"); // re-read KV
    assert.equal(kv.counters.get, 2);
  } finally {
    Date.now = realNow;
  }
});
