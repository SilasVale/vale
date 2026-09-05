// decideClaim unit tests: the one-time-claim rule as a pure function
// (no I/O, no DO runtime needed). Pins the exact pre-existing semantics
// the DO must honor: 404 gone / 410 expired / serve, including the legacy
// uploads that carry no expiresAt deadline.
import test from "node:test";
import assert from "node:assert/strict";
import { decideClaim } from "../src/claim.js";

const NOW = 1_786_000_000_000;

test("missing object -> gone (404 already-downloaded)", () => {
  assert.equal(decideClaim({ exists: false, expiresAtRaw: undefined, nowMs: NOW }), "gone");
  // A stale expiresAt on a missing object is still just gone.
  assert.equal(decideClaim({ exists: false, expiresAtRaw: String(NOW - 1), nowMs: NOW }), "gone");
});

test("no expiresAt deadline -> serve (legacy uploads predate the field)", () => {
  for (const raw of [undefined, null, ""]) {
    assert.equal(decideClaim({ exists: true, expiresAtRaw: raw, nowMs: NOW }), "serve", String(raw));
  }
});

test("future expiresAt -> serve; past expiresAt -> expired", () => {
  assert.equal(decideClaim({ exists: true, expiresAtRaw: String(NOW + 1000), nowMs: NOW }), "serve");
  assert.equal(decideClaim({ exists: true, expiresAtRaw: String(NOW - 1), nowMs: NOW }), "expired");
});

test("boundary: expiresAt == now serves (existing code uses strict <)", () => {
  assert.equal(decideClaim({ exists: true, expiresAtRaw: String(NOW), nowMs: NOW }), "serve");
});

test("non-numeric expiresAt expires (fail closed: corrupt deadline must not grant unbounded download)", () => {
  assert.equal(decideClaim({ exists: true, expiresAtRaw: "not-a-number", nowMs: NOW }), "expired");
  assert.equal(decideClaim({ exists: true, expiresAtRaw: "NaN", nowMs: NOW }), "expired");
  assert.equal(decideClaim({ exists: true, expiresAtRaw: "Infinity", nowMs: NOW }), "expired");
});
