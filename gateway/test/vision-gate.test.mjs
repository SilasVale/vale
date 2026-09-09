// Vision-gate no-touch paths (SOLID Round-9, test completion).
//
// Audit finding: after scanning every src export against test/ imports,
// isVisionCapable was the only behavioral predicate with zero direct pins
// (covered at best incidentally through image-bearing translate flows).
// For a request REWRITER the most dangerous behavior is touching what it
// shouldn't — so these pins fix the don't-touch contract: exact allowlist
// semantics of the predicate, and preprocessImages' two early returns
// (non-array input, capable model) which must never reach the network.
// The describe-and-replace path itself stays covered by live-flow tests;
// this file never stubs fetch and never needs KV.
import test from "node:test";
import assert from "node:assert/strict";
import { isVisionCapable, preprocessImages } from "../src/plugins/translate-vision.ts";

test("isVisionCapable: dialogue-model or upstream spelling allows", () => {
  const env = { VISION_CAPABLE_MODELS: "og/mimo-v2.5, ds/vision-x" };
  assert.equal(isVisionCapable("og/mimo-v2.5", "og/other", env), true, "dialogue spelling");
  assert.equal(isVisionCapable("og/other", "ds/vision-x", env), true, "upstream spelling");
  assert.equal(isVisionCapable("og/other", "ds/plain", env), false, "neither listed");
});

test("isVisionCapable: list parsing trims, drops empties, empty env denies", () => {
  const env = { VISION_CAPABLE_MODELS: "  og/a  ,,ds/b, " };
  assert.equal(isVisionCapable("og/a", "x", env), true, "whitespace trimmed");
  assert.equal(isVisionCapable("ds/b", "x", env), true);
  assert.equal(isVisionCapable("", "x", env), false, "blank dialogue model never matches");
  assert.equal(isVisionCapable("og/a", "x", {}), false, "unconfigured env denies");
  assert.equal(isVisionCapable("og/a", "x", { VISION_CAPABLE_MODELS: "" }), false);
});

test("isVisionCapable: matching is exact (case-sensitive, no substrings)", () => {
  const env = { VISION_CAPABLE_MODELS: "og/mimo-v2.5" };
  assert.equal(isVisionCapable("OG/MIMO-V2.5", "x", env), false, "case differs → no match");
  assert.equal(isVisionCapable("og/mimo", "x", env), false, "substring is not membership");
  assert.equal(isVisionCapable("og/mimo-v2.5-extra", "x", env), false, "superstring is not membership");
});

test("preprocessImages: non-array input passes through untouched", async () => {
  for (const input of ["nope", null, undefined, 42, { role: "user" }]) {
    const r = await preprocessImages(input, {}, {}, "og/plain", "og/plain", "u1");
    assert.equal(r.changed, false);
    assert.equal(r.messages, input, "same value back, no rewrite");
  }
});

test("preprocessImages: capable model returns the identical array (no network)", async () => {
  const env = { VISION_CAPABLE_MODELS: "og/mimo-v2.5" };
  const msgs = [{ role: "user", content: [{ type: "image", source: { data: "QUJD" } }] }];
  const r = await preprocessImages(msgs, env, {}, "og/mimo-v2.5", "og/mimo-v2.5", "u1");
  assert.equal(r.changed, false);
  assert.equal(r.messages, msgs, "identical reference — no copy, no describe call");
  // Upstream-spelling capability takes the same early return.
  const r2 = await preprocessImages(msgs, env, {}, "og/other", "og/mimo-v2.5", "u1");
  assert.equal(r2.changed, false);
  assert.equal(r2.messages, msgs);
});
