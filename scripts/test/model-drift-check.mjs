#!/usr/bin/env node
// model-drift-check.mjs — the pure half of scripts/model-drift.mjs.
//
// WHY THIS FILE EXISTS AND WHAT IT CANNOT DO. The drift REPORT needs live
// third-party endpoints, so it can never be a CI gate: an unreachable upstream
// would fail the build for a reason unrelated to the change. What CAN be pinned
// here is the part that decides what the report SAYS — the normalisation and the
// comparison — because that is where a checker goes wrong quietly.
//
// The distinction this file protects: `advertisedNotOffered` is reported as
// CHECK, never as a verdict. The first version of the report compared raw
// prefix-stripped names and produced FALSE POSITIVES for every channel — the
// `og/` list looked 2/8 broken and `nv/` 1/3, when in fact `og/` entries are
// valid and only one `nv/` entry is genuinely absent. A checker that reports
// problems which are not there is worse than no checker, and this repo has
// recorded that lesson more than once.
import { normalise, advertisedFor, diffChannel } from "../model-drift.mjs";
import assert from "node:assert/strict";

let n = 0;
const t = (desc, fn) => { fn(); n += 1; };

t("normalise strips Claude Code's [context-window] marker", () => {
  assert.equal(normalise("openai/gpt-5.6-luna:floor[1m]"), "openai/gpt-5.6-luna:floor");
  assert.equal(normalise("plain"), "plain");
  // Only a TRAILING bracket group, matching the router's own stripBracket.
  assert.equal(normalise("a[1m]b"), "a[1m]b");
});

t("advertisedFor keeps only one channel and strips its prefix", () => {
  const ids = ["og/a", "og/b[1m]", "nv/c", "or/d"];
  assert.deepEqual(advertisedFor(ids, "og"), ["a", "b"]);
  assert.deepEqual(advertisedFor(ids, "nv"), ["c"]);
  // A prefix that is a PREFIX OF ANOTHER must not leak: "o" is not "og".
  assert.deepEqual(advertisedFor(ids, "o"), []);
});

t("diffChannel separates the two directions", () => {
  const d = diffChannel(["a", "b[1m]", "gone"], ["a", "b", "fresh"]);
  assert.deepEqual(d.advertisedNotOffered, ["gone"]);
  assert.deepEqual(d.offeredNotAdvertised, ["fresh"]);
});

t("an exact catalogue produces no drift", () => {
  const d = diffChannel(["a", "b"], ["b", "a", "extra-not-compared-correctly"]);
  assert.deepEqual(d.advertisedNotOffered, []);
});

t("the bracket marker does NOT create false drift", () => {
  // `[1m]` is a client marker the router strips; comparing it raw would report
  // every real model as missing.
  const d = diffChannel(["gpt-5.6-luna[1m]"], ["gpt-5.6-luna"]);
  assert.deepEqual(d.advertisedNotOffered, []);
});

t("duplicates collapse rather than double-reporting", () => {
  const d = diffChannel(["a", "a"], ["b"]);
  assert.deepEqual(d.advertisedNotOffered, ["a"]);
});

console.log(`model-drift: all ${n} checks passed`);
