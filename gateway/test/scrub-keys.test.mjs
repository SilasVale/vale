// Coverage audit row 3: `scrubKeys` (gateway/src/plugins/translate.ts:152)
// scrubs leaked provider API keys from any surfaced error body — exported
// for the first time so the money-critical regex is unit-tested.
import test from "node:test";
import assert from "node:assert/strict";
import { scrubKeys } from "../src/plugins/translate.ts";

test("scrubKeys: redacts all provider prefixes", () => {
  assert.equal(scrubKeys("sk-1234567890abcdef"), "***");
  assert.equal(scrubKeys("sk-rc-xxxxxxxxxxxx"), "***"); // the rc-x form
  assert.equal(scrubKeys("rc-1234567890"), "***");
  assert.equal(scrubKeys("sc-1234567890"), "***");
  assert.equal(scrubKeys("or-1234567890"), "***");
  assert.equal(scrubKeys("xoxb-pass89012"), "***"); // Slack bot token
  assert.equal(scrubKeys("xoxr-aaaa89012"), "***");
});

test("scrubKeys: leaves short tokens and unrelated text alone", () => {
  assert.equal(scrubKeys("sk-12345"), "sk-12345"); // < 8 chars after the prefix
  assert.equal(scrubKeys("nothing to see"), "nothing to see");
  assert.equal(scrubKeys(""), "");
  assert.equal(scrubKeys("some text sk-1234567890 more"), "some text *** more");
});
