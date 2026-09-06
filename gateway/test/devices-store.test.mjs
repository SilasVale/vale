// store/devices.ts registry unit tests — upsert/insert/rename/delete/
// takeover + secret-preservation rules, touch write-budget, corrupt-KV
// tolerance, cf token roundtrip. Handler suites cover the HTTP layer;
// this pins the store contract directly with a counting mock KV.
import test from "node:test";
import assert from "node:assert/strict";
import {
  listDevices,
  saveDevices,
  getDevice,
  upsertDevice,
  insertDevice,
  deleteDevice,
  renameDevice,
  touchDeviceSeen,
  getCfToken,
  setCfToken,
  __clearCaches,
} from "../src/store.ts";

function makeKV(seed = {}) {
  const kv = new Map(Object.entries(seed));
  const counters = { get: 0, put: 0, del: 0 };
  const KEYS = {
    async get(k) {
      counters.get++;
      return kv.has(k) ? kv.get(k) : null;
    },
    async put(k, v) {
      counters.put++;
      kv.set(k, String(v));
    },
    async delete(k) {
      counters.del++;
      kv.delete(k);
    },
  };
  return { counters, env: { KEYS }, _kv: kv };
}

const dev = (name, extra = {}) => ({ name, hostname: `${name}.x`, token: `tok-${name}`, ...extra });

function freshEnv(seed) {
  __clearCaches();
  return makeKV(seed);
}

test("corrupt / non-array / missing registry reads as empty", async () => {
  for (const raw of ["not json{{{", '{"a":1}', "null", undefined]) {
    const seed = raw === undefined ? {} : { "devices:v1": raw };
    const { env } = freshEnv(seed);
    assert.deepEqual(await listDevices(env), [], `raw=${raw}`);
    assert.equal(await getDevice(env, "d1"), null);
  }
  assert.deepEqual(await listDevices({}), []);
});

test("upsert preserves proxySecret unless the caller sets one (round-106)", async () => {
  const { env } = freshEnv({
    "devices:v1": JSON.stringify([dev("d1", { proxySecret: "S1" })]),
  });
  const kept = await upsertDevice(env, dev("d1", { hostname: "new.x" }));
  assert.equal(kept.proxySecret, "S1");
  assert.equal(kept.hostname, "new.x");
  const replaced = await upsertDevice(env, dev("d1", { proxySecret: "S2" }));
  assert.equal(replaced.proxySecret, "S2");
  const added = await upsertDevice(env, dev("d2"));
  assert.equal(added.name, "d2");
  assert.equal((await listDevices(env)).length, 2);
});

test("insertDevice refuses duplicates (round-122 takeover guard)", async () => {
  const { env } = freshEnv({ "devices:v1": JSON.stringify([dev("d1")]) });
  assert.equal(await insertDevice(env, dev("d1", { hostname: "evil.x" })), null);
  assert.equal((await getDevice(env, "d1")).hostname, "d1.x");
  const ok = await insertDevice(env, dev("d2"));
  assert.equal(ok?.name, "d2");
});

test("deleteDevice reports removal; missing is false", async () => {
  const { env } = freshEnv({ "devices:v1": JSON.stringify([dev("d1")]) });
  assert.equal(await deleteDevice(env, "ghost"), false);
  assert.equal(await deleteDevice(env, "d1"), true);
  assert.deepEqual(await listDevices(env), []);
});

test("renameDevice preserves token/secret/metadata; guards taken/missing", async () => {
  const { env } = freshEnv({
    "devices:v1": JSON.stringify([
      dev("d1", { proxySecret: "S", registeredAt: 5, lastVersion: "1.2.1" }),
      dev("d2"),
    ]),
  });
  assert.equal(await renameDevice(env, "ghost", "d3"), "not_found");
  assert.equal(await renameDevice(env, "d1", "d2"), "name_taken");
  const r = await renameDevice(env, "d1", "d3", "newhost.x");
  assert.equal(r.name, "d3");
  assert.equal(r.hostname, "newhost.x");
  assert.equal(r.token, "tok-d1");
  assert.equal(r.proxySecret, "S");
  assert.equal(r.registeredAt, 5);
  assert.equal(await getDevice(env, "d1"), null);
});

test("touchDeviceSeen writes only on version change or hourly staleness", async () => {
  const now = Date.now();
  const { env, counters } = freshEnv({
    "devices:v1": JSON.stringify([
      dev("fresh", { lastSeenAt: now, lastVersion: "1.0" }),
      dev("stale", { lastSeenAt: now - 2 * 3600 * 1000, lastVersion: "1.0" }),
    ]),
  });
  const putsBefore = counters.put;
  await touchDeviceSeen(env, "fresh", "1.0");
  assert.equal(counters.put, putsBefore, "fresh device must not burn a KV write");
  await touchDeviceSeen(env, "ghost", "9.9");
  assert.equal(counters.put, putsBefore, "unknown device is a no-op");
  await touchDeviceSeen(env, "fresh", "2.0");
  assert.equal(counters.put, putsBefore + 1, "version change writes once");
  assert.equal((await getDevice(env, "fresh")).lastVersion, "2.0");
  await touchDeviceSeen(env, "stale", "1.0");
  assert.equal(counters.put, putsBefore + 2, "hour-old seen writes once");
  assert.ok((await getDevice(env, "stale")).lastSeenAt >= now);
});

test("cf token roundtrips; empty clears; keyless reads blank", async () => {
  const { env } = freshEnv({});
  assert.equal(await getCfToken(env), "");
  assert.equal(await setCfToken(env, " CFTOK "), "CFTOK");
  assert.equal(await getCfToken(env), "CFTOK");
  assert.equal(await setCfToken(env, ""), "");
  assert.equal(await getCfToken(env), "");
  assert.equal(await getCfToken({}), "");
  await assert.rejects(() => setCfToken({}, "x"), /KV not bound/);
});

test("saveDevices without KEYS is a silent no-op", async () => {
  await saveDevices({}, [dev("d1")]);
});
