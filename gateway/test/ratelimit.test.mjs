// createIpRateLimiter contract pins (SOLID Round-13, test completion).
//
// Audit finding: the single per-IP limiter factory — the brute-force gate
// for auth register, the probe budget, the devices public gate — had ZERO
// direct tests (only incidental exercise through handler suites). These pins
// fix its contract: fixed-window counting, per-IP isolation, KV seeding
// on/off, fail-open posture, and the 4096-key eviction bound.
// Time-safe by construction: every counting test shares one wide window,
// so no sleeps and no bucket-rollover flakiness by design.
import test from "node:test";
import assert from "node:assert/strict";
import { createIpRateLimiter } from "../src/lib/ratelimit.ts";

const W = 3_600_000; // one-hour window: rapid calls always share a bucket
const req = (ip) =>
  new Request("https://console.test/api/x", {
    headers: ip ? { "cf-connecting-ip": ip } : {},
  });

// Map-backed KEYS stub with call counters (the only KV surface the factory
// touches: get on first sight per bucket, put to persist the count).
function fakeKeys(pre = {}) {
  const m = new Map(Object.entries(pre));
  return {
    _m: m,
    getCalls: 0,
    putCalls: 0,
    putOpts: null,
    async get(k) {
      this.getCalls += 1;
      return m.has(k) ? m.get(k) : null;
    },
    async put(k, v, opts) {
      this.putCalls += 1;
      this.putOpts = opts;
      m.set(k, v);
    },
  };
}

test("allows up to the limit, then blocks; exposes keyPrefix", async () => {
  const gate = createIpRateLimiter({ name: "t13-basic", limit: 3, windowMs: W });
  assert.equal(gate.keyPrefix, "t13-basic");
  assert.equal(await gate(req("1.1.1.1")), false);
  assert.equal(await gate(req("1.1.1.1")), false);
  assert.equal(await gate(req("1.1.1.1")), false);
  assert.equal(await gate(req("1.1.1.1")), true, "4th sight over limit 3");
  assert.equal(await gate(req("1.1.1.1")), true, "stays blocked for the window");
});

test("per-IP isolation; headerless clients share the 'unknown' bucket", async () => {
  const gate = createIpRateLimiter({ name: "t13-iso", limit: 1, windowMs: W });
  assert.equal(await gate(req("9.9.9.9")), false);
  assert.equal(await gate(req("9.9.9.9")), true, "same IP blocked");
  assert.equal(await gate(req("8.8.8.8")), false, "other IP unaffected");
  assert.equal(await gate(req()), false, "first headerless sight allowed");
  assert.equal(await gate(req()), true, "headerless shares one bucket");
});

test("kvSeed: inherits the persisted budget, persists first sight, then serves from memory", async () => {
  const keys = fakeKeys();
  const gate = createIpRateLimiter({ name: "t13-seed", limit: 2, windowMs: W, kvSeed: true });
  const env = { KEYS: keys };
  assert.equal(await gate(req("2.2.2.2"), env), false, "miss seeds from 0");
  assert.equal(keys.getCalls, 1, "KV read once on first sight");
  assert.equal(keys.putCalls, 1, "count persisted once");
  assert.equal(keys.putOpts.expirationTtl, 7210, "TTL = 2×window(s) + 10s");
  assert.equal(await gate(req("2.2.2.2"), env), false);
  assert.equal(await gate(req("2.2.2.2"), env), true, "3rd sight over limit 2");
  assert.equal(keys.getCalls, 1, "later sights served from memory");
  assert.equal(keys.putCalls, 1, "no KV write per request (quota guard)");
});

test("kvSeed: pre-seeded budget applies on first sight (new-isolate inheritance)", async () => {
  const keys = fakeKeys();
  const gate = createIpRateLimiter({ name: "t13-inherit", limit: 5, windowMs: W, kvSeed: true });
  const env = { KEYS: keys };
  // Seed the exact first-sight key: name:ip:current-bucket.
  const bucket = Math.floor(Date.now() / W);
  keys._m.set(`t13-inherit:3.3.3.3:${bucket}`, "5");
  assert.equal(await gate(req("3.3.3.3"), env), true, "persisted 5/5 blocks immediately");
});

test("kvSeed off: KEYS never touched even when present (round-104 quota guard)", async () => {
  const keys = fakeKeys();
  const gate = createIpRateLimiter({ name: "t13-mem", limit: 1, windowMs: W });
  const env = { KEYS: keys };
  assert.equal(await gate(req("4.4.4.4"), env), false);
  assert.equal(await gate(req("4.4.4.4"), env), true);
  assert.equal(keys.getCalls, 0, "memory-only: no KV reads");
  assert.equal(keys.putCalls, 0, "memory-only: no KV writes");
});

test("KV failures fail open (same posture as the breaker)", async () => {
  const badKeys = {
    async get() {
      throw new Error("kv down");
    },
    async put() {
      throw new Error("kv down");
    },
  };
  const gate = createIpRateLimiter({ name: "t13-fo", limit: 5, windowMs: W, kvSeed: true });
  assert.equal(await gate(req("5.5.5.5"), { KEYS: badKeys }), false, "read failure counts from 0");
});

test("4096-key capacity: oldest bucket evicted, newest retained", async () => {
  const gate = createIpRateLimiter({ name: "t13-cap", limit: 1, windowMs: W });
  const ip = (i) => `10.9.${Math.floor(i / 256)}.${i % 256}`;
  for (let i = 0; i < 4097; i++) {
    assert.equal(await gate(req(ip(i))), false, `first sight of ${ip(i)} allowed`);
  }
  assert.equal(await gate(req(ip(0))), false, "evicted oldest recounts from 0");
  assert.equal(await gate(req(ip(4096))), true, "retained newest still counts its sight");
}, { timeout: 30000 });
