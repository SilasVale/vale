// Empty-token admin backfill (bricked-deploy migration):
// deployments seeded BEFORE the mint fix have user:admin with token:"" +
// _admin_seeded="1" and seedAdmin's early-return locked them out forever.
// seedAdmin must now heal that record (mint + remap, exactly like fresh)
// while leaving a record with a NON-empty token completely untouched.
//
// Fresh process per test file, so store.ts's process-once `seeded` flag
// starts false; __resetSeedForTests re-arms it between the two cases.
import test from "node:test";
import assert from "node:assert/strict";
import { seedAdmin, getAdminPassword, verifyAdminPassword, __clearCaches, __resetSeedForTests } from "../src/store.ts";

function mockEnv(entries) {
  __clearCaches();
  const kv = new Map(entries);
  return {
    KEYS: {
      async get(k) {
        return kv.has(k) ? kv.get(k) : null;
      },
      async put(k, v) {
        kv.set(k, v);
      },
      async delete(k) {
        kv.delete(k);
      },
    },
    _kv: kv,
  };
}

const ADMIN_EMPTY = JSON.stringify({
  id: "admin",
  username: "admin",
  role: "admin",
  enabled: true,
  createdAt: 1,
  token: "",
});

test("seedAdmin heals an empty-token admin record (mint + remap, marker kept)", async () => {
  const env = mockEnv([
    ["user:admin", ADMIN_EMPTY],
    ["_admin_seeded", "1"],
  ]);
  await seedAdmin(env);
  const admin = JSON.parse(env._kv.get("user:admin"));
  assert.ok(/^[0-9a-f]{48}$/.test(admin.token), "empty token replaced by a minted 48-hex key");
  assert.equal(env._kv.get(`token:${admin.token}`), "admin", "fresh token: mapping written");
  assert.equal(env._kv.get("_admin_seeded"), "1", "seed marker preserved");
  assert.equal(admin.username, "admin", "rest of the record preserved");
  assert.equal(admin.enabled, true, "rest of the record preserved");
});

test("seedAdmin leaves a non-empty-token admin record untouched", async () => {
  __resetSeedForTests();
  const env = mockEnv([
    [
      "user:admin",
      JSON.stringify({
        id: "admin",
        username: "admin",
        role: "admin",
        enabled: true,
        createdAt: 1,
        token: "KEEP123",
      }),
    ],
    ["token:KEEP123", "admin"],
    ["_admin_seeded", "1"],
  ]);
  const before = new Map(env._kv);
  await seedAdmin(env);
  assert.deepEqual([...env._kv.entries()].sort(), [...before.entries()].sort(), "KV untouched");
});

// ── Fresh deploy + migration + process-once (round-394) ──

test("seedAdmin on a fresh deploy mints admin + remap + marker (legacy CLIENT_KEY honored)", async () => {
  __resetSeedForTests();
  const env = mockEnv([["CLIENT_KEY", "LEGACYKEY"]]);
  await seedAdmin(env);
  const admin = JSON.parse(env._kv.get("user:admin"));
  assert.equal(admin.token, "LEGACYKEY", "legacy key becomes the admin token");
  assert.equal(env._kv.get("token:LEGACYKEY"), "admin");
  assert.equal(env._kv.get("_admin_seeded"), "1");
});

test("seedAdmin on a fresh deploy without CLIENT_KEY mints a random token", async () => {
  __resetSeedForTests();
  const env = mockEnv([]);
  await seedAdmin(env);
  const admin = JSON.parse(env._kv.get("user:admin"));
  assert.ok(/^[0-9a-f]{48}$/.test(admin.token));
  assert.equal(env._kv.get(`token:${admin.token}`), "admin");
});

test("seedAdmin migrates v1 random-ID records to the username schema", async () => {
  __resetSeedForTests();
  const env = mockEnv([
    [
      "user:u-admin",
      JSON.stringify({ id: "u-admin", username: "admin", role: "admin", enabled: true, token: "V1TOK" }),
    ],
    ["token:V1TOK", "u-admin"],
    ["ukeys:u-admin", JSON.stringify({ DEEPSEEK_API_KEY: "k" })],
  ]);
  await seedAdmin(env);
  assert.equal(env._kv.has("user:u-admin"), false, "old record removed");
  assert.equal(JSON.parse(env._kv.get("user:admin")).id, "admin");
  assert.equal(env._kv.get("token:V1TOK"), "admin", "token remapped");
  assert.equal(JSON.parse(env._kv.get("ukeys:admin")).DEEPSEEK_API_KEY, "k", "keys moved");
});

test("seedAdmin runs once per process; keyless env is a no-op", async () => {
  __resetSeedForTests();
  const env = mockEnv([]);
  await seedAdmin(env);
  const marker = env._kv.get("_admin_seeded");
  env._kv.delete("user:admin"); // simulate external change
  await seedAdmin(env); // second call: process-once flag, must not re-seed
  assert.equal(env._kv.has("user:admin"), false);
  assert.equal(env._kv.get("_admin_seeded"), marker);
  __resetSeedForTests();
  await seedAdmin({}); // no KEYS binding: must not throw
});

// round-447 (coverage-driven): getAdminPassword's keyless-env branch had
// ZERO pins — the legacy Worker-secret fallback path.
test("getAdminPassword without KEYS: empty without secret, legacy hash with it", async () => {
  __clearCaches();
  assert.equal(await getAdminPassword({}), "");
  const v = await getAdminPassword({ ADMIN_PASSWORD: "s3cret" });
  assert.ok(v.startsWith("legacy:"), `migrated format, got: ${v.slice(0, 8)}…`);
  assert.equal(await verifyAdminPassword({ ADMIN_PASSWORD: "s3cret" }, "s3cret"), true);
  assert.equal(await verifyAdminPassword({ ADMIN_PASSWORD: "s3cret" }, "wrong"), false);
});
