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
import { seedAdmin, __clearCaches, __resetSeedForTests } from "../src/store.ts";

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
