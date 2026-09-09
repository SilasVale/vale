// Upload-primitive pins (SOLID Round-30 — three pure units exported
// additively from src/index.js; the handler is untouched). The header
// sanitizer is a split-injection defense, the token sampler carries a
// uniformity invariant (P2-11), and the sha shape is what stands between
// agent_update and an unverifiable install (round-119) — all three had
// zero direct pins.
import test from "node:test";
import assert from "node:assert/strict";
import { buildContentDisposition, genToken, SHA256_RE } from "../src/index.js";

test("buildContentDisposition: plain ASCII names pass through quoted", () => {
  assert.equal(buildContentDisposition("fw.bin"), 'attachment; filename="fw.bin"');
  assert.equal(
    buildContentDisposition("vale-agent-1.2.307.tgz"),
    'attachment; filename="vale-agent-1.2.307.tgz"',
  );
});

test("buildContentDisposition: quotes/backslashes/controls stripped (header split)", () => {
  assert.equal(buildContentDisposition('a"b\\c.bin'), 'attachment; filename="abc.bin"');
  assert.equal(buildContentDisposition("a\r\nb: evil"), 'attachment; filename="ab: evil"');
  assert.equal(buildContentDisposition('   spaced.bin  '), 'attachment; filename="spaced.bin"');
  assert.equal(buildContentDisposition('"""'), null, "nothing survives → null (caller 400s)");
  assert.equal(buildContentDisposition(""), null);
  assert.equal(buildContentDisposition(null), null);
});

test("buildContentDisposition: non-ASCII rides filename* with an ASCII fallback", () => {
  assert.equal(
    buildContentDisposition("中文.zip"),
    `attachment; filename=".zip"; filename*=UTF-8''${encodeURIComponent("中文.zip")}`,
  );
  assert.equal(
    buildContentDisposition("中文"),
    `attachment; filename="download.bin"; filename*=UTF-8''${encodeURIComponent("中文")}`,
  );
});

test("genToken: URL-safe alphabet, honored length, unique", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = genToken();
    assert.match(t, /^[A-Za-z0-9]{22}$/, "22 URL-safe chars by default");
    assert.ok(!seen.has(t), "no repeats in 200 draws");
    seen.add(t);
  }
  assert.match(genToken(8), /^[A-Za-z0-9]{8}$/, "custom length honored");
});

test("SHA256_RE: 64 hex only (placeholder/truncated shas refused)", () => {
  assert.ok(SHA256_RE.test("a".repeat(64)));
  assert.ok(SHA256_RE.test("A".repeat(63) + "0"), "case-insensitive");
  for (const bad of ["", "abc", "a".repeat(63), "a".repeat(65), "z".repeat(64), "a".repeat(64) + "\n"]) {
    assert.equal(SHA256_RE.test(bad), false, `rejected: ${JSON.stringify(bad)}`);
  }
});
