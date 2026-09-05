// Shared test helpers — the withFetch stub was duplicated in three test files
// with subtly different semantics (one counted calls, one didn't; one had the
// await-inside-try comment from a past restore-timing bug). One implementation
// with a live call counter for everyone.
//
// makeEnv below is the shared Map-backed KV env builder: 11 test files used to
// re-declare near-identical copies (makeEnv/freshEnv/corsEnv/gwEnv) that all
// stubbed env.KEYS with a Map. One implementation with the RICHEST variant's
// semantics (KV list() + expiration tracking); per-file seeding data moves
// into each file's thin adapter so the exact seeding is preserved.
import assert from "node:assert/strict";
import { __clearCaches } from "../src/store.ts";

/**
 * Install `handler` as globalThis.fetch for the duration of fn(), restoring it
 * afterwards. Must await fn() INSIDE the try: returning fn() directly restores
 * fetch in the same tick, so a fetch deferred past an await (e.g. og's breaker
 * check) hits the real network instead of the stub.
 *
 * Call count is read via `withFetch.calls` INSIDE the callback (the counter is
 * live while fn() runs; it's reset on every withFetch entry).
 */
export async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  withFetch.calls = 0;
  globalThis.fetch = async (...args) => { withFetch.calls++; return handler(...args); };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/** Assert the current withFetch run made exactly n upstream calls. */
export function assertFetchCalls(n, msg = `expected ${n} fetch calls`) {
  const actual = withFetch.calls || 0;
  assert.equal(actual, n, msg);
}

/**
 * Build a worker-fetch env with a Map-backed KV stub (richest variant: get/
 * put/delete + list() with expiration tracking, so KV TTL semantics — e.g.
 * regkey expiry — behave like real KV). ALWAYS calls __clearCaches() first:
 * store.ts keeps module-level caches, and tests that mutate KV would
 * otherwise read stale cached entries seeded by an earlier test.
 *
 * Seeding options — pass exactly what the old local builder seeded; the stub
 * never invents entries:
 *   devices — devices:v1 value (array, or an object-shaped seed for
 *             reject-path tests); JSON-stringified verbatim. `null` omits
 *             the key entirely (builders that never seeded it).
 *   links   — plugins:v1 map (plugin-link token → { device, … }); seeded
 *             when provided (an empty object seeds "{}"). `plugins` is an
 *             alias merged underneath `links` for the same key.
 *   users   — { id → record }: each record JSON-stringified to user:<id>
 *             (string records pass through raw). NO token:<t> reverse
 *             mappings are derived — seed those explicitly via kv, exactly
 *             like the builders did.
 *   kv      — raw KV entries (full key → value; objects JSON-stringified)
 *             for everything else: auth:admin_password, _admin_seeded,
 *             token:<t>, ukeys:<id>, regkey:<code>, sess-revoked:*, …
 *   extra   — spread onto the env object LAST (ASSETS stub, ACCESS_* vars,
 *             SESSION_SECRET, a CONSOLE_HOST override, …).
 *
 * The returned env exposes the raw Map as `_kv` (seed/inspection hook) and
 * the expiry Map as `_expiry` (backdate entries to reproduce real KV's
 * expired-but-unreaped list() names).
 */
export function makeEnv({
  devices = null,
  users = {},
  plugins = null,
  links = null,
  kv = {},
  extra = {},
} = {}) {
  __clearCaches();
  const map = new Map();
  const expiry = new Map(); // key → expiration (epoch SECONDS, like real KV)
  const seed = (k, v) => map.set(k, typeof v === "string" ? v : JSON.stringify(v));
  if (devices !== null) map.set("devices:v1", JSON.stringify(devices));
  if (plugins !== null || links !== null) {
    map.set("plugins:v1", JSON.stringify({ ...(plugins || {}), ...(links || {}) }));
  }
  for (const [id, rec] of Object.entries(users)) seed(`user:${id}`, rec);
  for (const [k, v] of Object.entries(kv)) seed(k, v);
  return {
    CONSOLE_HOST: "x",
    KEYS: {
      async get(k) { return map.has(k) ? map.get(k) : null; },
      async put(k, v, opts) {
        map.set(k, v);
        if (opts && opts.expirationTtl) expiry.set(k, Math.floor(Date.now() / 1000) + opts.expirationTtl);
      },
      async delete(k) { map.delete(k); expiry.delete(k); },
      async list({ prefix } = {}) {
        const keys = [];
        for (const k of map.keys()) {
          if (prefix && !k.startsWith(prefix)) continue;
          keys.push({ name: k, expiration: expiry.get(k) || 0 });
        }
        return { keys };
      },
    },
    // Test hooks: raw map for seed/inspection assertions, expiry map for
    // reproducing expired-but-unreaped KV list() entries.
    _kv: map,
    _expiry: expiry,
    ...extra,
  };
}
