// Coverage audit row 3: `scrubKeys` (gateway/src/plugins/translate.ts:152)
// scrubs leaked provider API keys from any surfaced error body — exported
// for the first time so the money-critical regex is unit-tested.
import test from "node:test";
import assert from "node:assert/strict";
import { scrubKeys, keyMissingError } from "../src/plugins/translate.ts";

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

test("keyMissingError: one 502 per BYOK kind with the historical wire message", async () => {
  // The translate plugin's keyless guards all delegate here (round-2026-09-08:
  // 21 inline copies collapsed into this table). Pin the exact messages —
  // the existing keyless-channel tests already assert these strings end-to-end
  // through the HTTP surface; this unit test makes the table itself the
  // single source of truth.
  const cases = {
    deepseek: "DEEPSEEK_API_KEY not configured — add your own key in the console",
    opencode: "OPENCODE_GO_API_KEY not configured — add your own key in the console",
    openrouter: "OPENROUTER_API_KEY not configured — add your own key in the console",
    qwen: "QWEN_API_KEY not configured — add your own key in the console",
    nvidia: "NVAPI_KEY not configured — add your NVIDIA build.nvidia.com key",
    gmi: "GMI_API_KEY not configured — add your GMI Cloud key in the console",
    amd: "AMD_API_KEY not configured — add your AMD Radeon Cloud (rc-…) key in the console",
    commandgoat: "CMD_API_KEY not configured — add your Command Code key in the console",
  };
  for (const [kind, msg] of Object.entries(cases)) {
    const r = keyMissingError(kind);
    assert.ok(r, `${kind} must yield a 502`);
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.equal(body.error?.message, msg, `${kind} message drift`);
    assert.equal(body.error?.type, "config_error");
  }
});

test("keyMissingError: unknown / empty kinds return null", () => {
  assert.equal(keyMissingError("none"), null); // not a route kind — routing 404s earlier
  assert.equal(keyMissingError("???"), null);
  assert.equal(keyMissingError(""), null);
});
