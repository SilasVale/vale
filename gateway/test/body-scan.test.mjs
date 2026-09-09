// scanTopLevelModel unit pins (round-466, coverage-driven: the escape
// arms in keys/values had ZERO direct pins — only incidental exercise
// through translate requests).
//
// SOLID Round-7: estimateTokens was split (verbatim) into the pure helpers
// countBase64Payloads + estimateTextTokens under a thin composer. The pins
// below cover the previously-untested helpers, the composer contract, and
// the small raw-* rewriters (also zero direct coverage before this round).
import test from "node:test";
import assert from "node:assert/strict";
import {
  scanTopLevelModel,
  rawWithModel,
  rawWithTopLevelField,
  rawWithDeepSeekProvider,
  rawWithOxAlphaReasoningDefault,
  countBase64Payloads,
  estimateTextTokens,
  estimateTokens,
} from "../src/body-scan.ts";

test("scan: plain top-level model + value span for passthrough swap", () => {
  const raw = '{"model":"og/deepseek-v4-flash","max_tokens":1}';
  const r = scanTopLevelModel(raw);
  assert.equal(r.model, "og/deepseek-v4-flash");
  assert.equal(raw.slice(r.valueStart, r.valueEnd), '"og/deepseek-v4-flash"');
});

test("scan: escaped quotes inside keys and values do not break the scan", () => {
  const raw = '{"we\\"ird":1,"model":"og/a\\"b","x":true}';
  const r = scanTopLevelModel(raw);
  assert.equal(r.model, 'og/a\\"b', "escaped quote preserved in the value");
  const raw2 = '{"model":"a\\\\b"}';
  assert.equal(scanTopLevelModel(raw2).model, "a\\\\b", "escaped backslash preserved");
});

test("scan: no model / nested-only model → null", () => {
  assert.equal(scanTopLevelModel('{"a":1}').model, null);
  assert.equal(scanTopLevelModel('{"data":{"model":"og/x"}}').model, null);
  assert.equal(scanTopLevelModel("not json{{").model, null);
});

// ── SOLID Round-7: countBase64Payloads ──────────────────────────

test("images: none / short-run / boundary / multi", () => {
  assert.deepEqual(countBase64Payloads('{"model":"x"}'), { images: 0, removedChars: 0 });
  // Short data field (< 512 b64 chars) is text, not a payload.
  assert.deepEqual(countBase64Payloads(`{"data":"${"A".repeat(100)}"}`), {
    images: 0,
    removedChars: 0,
  });
  // Exact boundary: 511 ignored, 512 counted.
  assert.deepEqual(countBase64Payloads(`{"data":"${"A".repeat(511)}"}`), {
    images: 0,
    removedChars: 0,
  });
  assert.deepEqual(countBase64Payloads(`{"data":"${"A".repeat(512)}"}`), {
    images: 1,
    removedChars: 512,
  });
  // Two payloads accumulate; removedChars counts payload bytes only.
  const two = `{"a":"${"A".repeat(600)}","data":"${"B".repeat(700)}","data":"${"C".repeat(800)}"}`;
  assert.deepEqual(countBase64Payloads(two), { images: 2, removedChars: 1500 });
});

test("images: payload inside the last user message is found", () => {
  const body = `{"messages":[{"role":"user","content":[{"type":"image","data":"${"A".repeat(600)}"}]}]}`;
  assert.deepEqual(countBase64Payloads(body), { images: 1, removedChars: 600 });
});

// ── SOLID Round-7: estimateTextTokens ───────────────────────────

test("text: ASCII ≈ len/4, CJK ≈ 1.8x, ratio extrapolates", () => {
  assert.equal(estimateTextTokens("a".repeat(400), 400), 100, "400 ASCII → 100");
  const cjk = estimateTextTokens("中".repeat(400), 400);
  assert.ok(cjk >= 700 && cjk <= 730, `400 CJK ≈ 720, got ${cjk}`);
  // Extrapolation: 2-char sample scaled to a 200-char body.
  assert.equal(estimateTextTokens("ab", 200), 50, "ceil(2*100/4)");
});

// ── SOLID Round-7: estimateTokens composer contract ─────────────

test("composer: text-only body, image allowance, non-string coercion", () => {
  assert.equal(estimateTokens('{"model":"x"}'), 4, "13 ASCII chars → ceil(13/4)");
  assert.equal(estimateTokens(12345), 2, "coerced to '12345' → ceil(5/4)");
  // Composer == text helper over the base64-excluded length + 1600/image.
  const body = `{"messages":[{"role":"user","content":[{"type":"image","data":"${"A".repeat(600)}"}]}]}`;
  const { removedChars } = countBase64Payloads(body);
  assert.equal(removedChars, 600);
  assert.equal(
    estimateTokens(body),
    estimateTextTokens(body, body.length - removedChars) + 1600,
  );
});

// ── SOLID Round-7: raw-* rewriters (first direct pins) ──────────

test("rawWithModel: swaps the scanned span, falls back unchanged", () => {
  const raw = '{"model":"old","x":1}';
  const scanned = scanTopLevelModel(raw);
  assert.equal(rawWithModel(raw, "new", scanned), '{"model":"new","x":1}');
  assert.equal(rawWithModel(raw, "new"), '{"model":"new","x":1}', "rescans when skipped");
  assert.equal(rawWithModel('{"a":1}', "new"), '{"a":1}', "no model → byte-identical");
});

test("rawWithTopLevelField: replaces present, appends missing", () => {
  assert.equal(rawWithTopLevelField('{"a":1,"b":1}', "b", 2), '{"a":1,"b":2}');
  assert.equal(rawWithTopLevelField('{"a":1}', "b", 2), '{"a":1,"b":2}');
  assert.equal(rawWithTopLevelField('{}', "b", 2), '{"b":2}', "empty object → no leading comma");
});

test("one-liners: provider injected, reasoning defaulted but respected", () => {
  const pv = rawWithDeepSeekProvider('{"model":"ds/x"}');
  assert.ok(pv.includes('"provider":{"order":["deepseek"],"allow_fallbacks":false}'), pv);
  const withReason = rawWithOxAlphaReasoningDefault('{"model":"ox/y"}');
  assert.ok(withReason.includes('"reasoning":{"effort":"max"}'), withReason);
  const kept = '{"model":"ox/y","reasoning":{"effort":"low"}}';
  assert.equal(rawWithOxAlphaReasoningDefault(kept), kept, "client-sent reasoning untouched");
});
