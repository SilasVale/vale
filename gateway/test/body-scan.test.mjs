// scanTopLevelModel unit pins (round-466, coverage-driven: the escape
// arms in keys/values had ZERO direct pins — only incidental exercise
// through translate requests).
import test from "node:test";
import assert from "node:assert/strict";
import { scanTopLevelModel } from "../src/body-scan.ts";

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
