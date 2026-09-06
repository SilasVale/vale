// safePageUrl unit pins (round-449, coverage-driven: the catch arm was
// the last uncovered line in the index worker).
import test from "node:test";
import assert from "node:assert/strict";
import { safePageUrl } from "../src/page.js";

test("safePageUrl: https passes, loopback http passes, external http falls back", () => {
  assert.equal(safePageUrl("https://agent.saisi.online/x", "FB"), "https://agent.saisi.online/x");
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(safePageUrl(`http://${h}/y`, "FB"), `http://${h}/y`, h);
  }
  // Bare ::1 is not a valid URL host — falls back like any other non-loopback.
  assert.equal(safePageUrl("http://::1/y", "FB"), "FB");
  assert.equal(safePageUrl("http://evil.example/x", "FB"), "FB");
  assert.equal(safePageUrl("data:text/html,hi", "FB"), "FB");
});

test("safePageUrl: unparseable input falls back instead of throwing", () => {
  assert.equal(safePageUrl("http://[::1", "FB"), "FB");
  assert.equal(safePageUrl("http://exa mple.com", "FB"), "FB");
});
