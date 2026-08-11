// Shared test helpers — the withFetch stub was duplicated in three test files
// with subtly different semantics (one counted calls, one didn't; one had the
// await-inside-try comment from a past restore-timing bug). One implementation
// with a live call counter for everyone.
import assert from "node:assert/strict";

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
