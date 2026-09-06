// Console display formatter pins — maskToken is the only secret-adjacent
// rendering in the UI (round-436 beachhead: the console had zero unit
// tests; this pure helper needs no DOM, unlike theme.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { maskToken } from "../src/lib/format.ts";

test("maskToken: empty/null → blank, short kept mostly, long head…tail", () => {
  assert.equal(maskToken(""), "");
  assert.equal(maskToken(null), "");
  assert.equal(maskToken(undefined), "");
  // ≤8 chars: first + … + last 3 (slice(-3) keeps the whole string
  // when it is already that short — still recognizable, never expanded).
  assert.equal(maskToken("abc"), "a…abc");
  assert.equal(maskToken("12345678"), "1…678");
  // long: first 6 + … + last 4.
  assert.equal(maskToken("vk-1234567890abcdef"), "vk-123…cdef");
  const masked = maskToken("supersecretadmintokenvalue");
  assert.ok(!masked.includes("secretadmintoken"), "middle must not leak");
});
