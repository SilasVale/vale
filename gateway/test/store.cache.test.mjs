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

test("getAdminPassword: cached, refreshed by set", async () => {
  const kv = makeKV({});
  assert.equal(await store.getAdminPassword(kv), "");
  await store.setAdminPassword(kv, "pw-1");
  assert.equal(await store.getAdminPassword(kv), "pw-1"); // write-through hit
  await store.setAdminPassword(kv, "pw-2");
  assert.equal(await store.getAdminPassword(kv), "pw-2");
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

test("listUsers reads raw (not cached)", async () => {
  const kv = makeKV({ "user:alice": user("alice"), "user:bob": user("bob") });
  const users = await store.listUsers(kv);
  assert.equal(users.length, 2);
  assert.equal(kv.counters.list, 1);
  assert.equal(kv.counters.get, 2); // one get per user, uncached
});

// ── Per-user route selection (model=auto) ──────────────────────

test("getUserRoute / setUserRoute: cached read, write-through refresh", async () => {
  const kv = makeKV({});
  assert.equal(await store.getUserRoute(kv, "admin"), null); // miss → 1 get
  await store.setUserRoute(kv, "admin", "qw/qwen3.8-max-preview"); // put + cache
  assert.equal(await store.getUserRoute(kv, "admin"), "qw/qwen3.8-max-preview"); // cache hit
  assert.equal(kv.counters.get, 1); // 只有首次读 KV
  await store.setUserRoute(kv, "admin", "ds/deepseek-v4-flash"); // write-through
  assert.equal(await store.getUserRoute(kv, "admin"), "ds/deepseek-v4-flash");
  assert.equal(kv.counters.get, 1); // 仍无新 KV 读
});

test("getUserRoute: cache expires after the 60s route TTL", async () => {
  const kv = makeKV({});
  const realNow = Date.now;
  try {
    await store.setUserRoute(kv, "erin", "qw/qwen3.8-max-preview"); // put + cache
    assert.equal(await store.getUserRoute(kv, "erin"), "qw/qwen3.8-max-preview"); // cache hit
    assert.equal(kv.counters.get, 0);
    Date.now = () => realNow() + 61 * 1000; // advance 61s — past the route TTL
    assert.equal(await store.getUserRoute(kv, "erin"), "qw/qwen3.8-max-preview"); // expired → re-read KV
    assert.equal(kv.counters.get, 1);
  } finally {
    Date.now = realNow;
  }
});
