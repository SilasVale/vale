/**
 * store/cache.ts — per-isolate KV cache + per-key write locks.
 *
 * This is the SINGLE process-global instance: every store/<domain> module
 * imports cget/cset/cdel from here (never its own copy) so write-through
 * freshness and the test hook __clearCaches() stay coherent across domains.
 */

/** Workers env bindings — the shape we touch (loosely typed, same style as
 *  registry.ts). */
export interface Env {
  [key: string]: any;
}

/* ---- Per-isolate TTL cache ----
 *
 * Reads go through this cache (24h TTL); every write refreshes the cache
 * immediately (write-through), so admin changes take effect instantly on the
 * hot isolate. The TTL only backstops cross-isolate consistency: after 24h a
 * cached value is re-read from KV even if no write touched this isolate.
 * KV read volume is thus decoupled from request volume — each key costs at
 * most one read per day per isolate, instead of one read per request.
 */
const CACHE_TTL = 24 * 60 * 60 * 1000;
// Security-critical keys get a short TTL so admin changes (disable user,
// regenerate token, flip US_PROXY, change password) propagate across
// isolates within a minute instead of up to 24h. KV reads are cheap — a few
// hundred per key per isolate per day.
const AUTH_CACHE_TTL = 60 * 1000;
// "devices:" + "plugins:" join the short-TTL set (round-55/56): a device
// registered via /api/register (or a plugin token paired) on a COLD isolate
// stayed invisible on hot isolates for up to 24h — /proxy and /mcp 404'd on
// the new device. Plugin tokens gate chrome.debugger-level device control —
// a revoked link must propagate within a minute, not a day.
const AUTH_PREFIXES = [
  "settings:",
  "token:",
  "user:",
  "ukeys:",
  "auth:",
  "route:",
  "devices:",
  "plugins:",
  "cf:",
  // "providers:" (2026-09-13): a custom provider record carries a credential and
  // an egress DESTINATION. A deleted or re-pointed provider must stop being
  // dialled within a minute on every isolate, not within a day — the same
  // argument that put devices:/plugins: here. The read cost is bounded because
  // resolveRoute only consults this key for prefixes the built-in ROUTE_TABLE
  // does not know, so no built-in traffic pays for it.
  "providers:",
];
const __c = new Map<string, { v: any; exp: number }>(); // kvKey -> { v, exp }; v may be null (cached "not found")
export function cget(k: string): any {
  const e = __c.get(k);
  if (!e) return undefined;
  if (e.exp <= Date.now()) {
    __c.delete(k);
    return undefined;
  }
  return e.v;
}
export function cset(k: string, v: any): void {
  if (__c.size >= 512) __c.delete(__c.keys().next().value!); // bound cache size
  const ttl = AUTH_PREFIXES.some((p) => k.startsWith(p)) ? AUTH_CACHE_TTL : CACHE_TTL;
  __c.set(k, { v, exp: Date.now() + ttl });
}
export function cdel(...ks: string[]): void {
  for (const k of ks) __c.delete(k);
}
/** Test hook: wipe the module-level 24h caches (settings/route/keys). Never
 *  called in production — tests that flip global settings (e.g. US_PROXY)
 *  would otherwise read a stale cached value from an earlier test. */
export function __clearCaches(): void {
  __c.clear();
}

// Per-key single-flight queue: concurrent read-modify-write on the same KV
// blob (ukeys:<id>, devices:v1, plugins:v1) previously LOST updates — two
// requests both read the pre-write value and the second put clobbered the
// first's record. Serializing per key makes same-isolate writes atomic
// (Workers isolates are single-threaded; the queue bridges the awaits).
// round-122: settled chains are pruned opportunistically — the old size
// bound deleted the OLDEST key (always a hot key like devices:v1 whose
// chain could be pending), letting a new caller run CONCURRENTLY with the
// queued writers (the exact lost-update the queue prevents). Evict only
// chains that are no longer in flight: a chain is settled once it resolves,
// so wrap each stored promise to self-prune on completion.
const __locks = new Map<string, Promise<any>>();
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = __locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Self-prune on settle (round-124: the first attempt compared against
  // `next` but stored the .finally() wrapper — a DIFFERENT object, so the
  // prune never fired and every key accumulated until the 512 bound evicted
  // the oldest (hot, possibly-pending) chain). Capture the stored wrapper
  // and compare against it.
  const stored = next
    .catch(() => {})
    .finally(() => {
      if (__locks.get(key) === stored) __locks.delete(key);
    });
  __locks.set(key, stored);
  // Hard bound for pathological distinct-key bursts: evict the oldest key,
  // accepting that a pending chain there loses its queue (its own RMW still
  // completes; only a NEW caller for that key can now race it). Far rarer
  // than the old always-hit-hot-key eviction.
  if (__locks.size > 512) __locks.delete(__locks.keys().next().value!);
  return next;
}
