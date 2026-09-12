#!/usr/bin/env node
// contrast-probe-check.mjs — the contrast math, pinned.
//
// Four rounds of contrast sweeps used an ad-hoc snippet retyped each time, and it
// was wrong twice. Both defects are assertions here, with the numbers they cost:
//
//   1. TRANSLUCENT BACKGROUNDS. Reading `rgba(255,255,255,0.07)` as if it were
//      white reported 2.51 for text that actually sits on a composited
//      rgb(44,45,49) and measures 5.49 — twenty of fifty findings were this.
//   2. A SKIP RULE THAT DISABLED THE SWEEP. Skipping anything with a
//      background-image ancestor skipped EVERY node in the panel and reported
//      `checked=0, underAA=0`, which reads exactly like a pass.
//
// The functions tested here are the ones the BROWSER runs: `PROBE_SOURCE` embeds
// them with `Function.prototype.toString()`, so this is not a copy that can drift.
import {
  compositeStack, contrastRatio, aaThreshold, parseColour, failures, unmeasurable, inactive, PROBE_SOURCE,
} from "../../agent/scripts/lib/contrast-probe.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let n = 0;
const t = (desc, fn) => { fn(); n += 1; };

t("a translucent white over a dark base composites — it is NOT white", () => {
  const bg = compositeStack([{ r: 255, g: 255, b: 255, a: 0.07 }], { r: 28, g: 29, b: 34 });
  assert.ok(bg.r > 40 && bg.r < 50, `expected a dark grey, got ${JSON.stringify(bg)}`);
  // ...and the difference is the whole point.
  assert.equal(contrastRatio({ r: 162, g: 163, b: 172 }, bg), 5.49);
  assert.equal(contrastRatio({ r: 162, g: 163, b: 172 }, { r: 255, g: 255, b: 255 }), 2.51);
});

t("the stack applies innermost LAST (order is the defect both times)", () => {
  // Element's own bg first in the array, then its parent, then the canvas.
  const over = compositeStack([
    { r: 255, g: 255, b: 255, a: 0.5 },   // the element
    { r: 0, g: 0, b: 0, a: 1 },           // an opaque parent stops the walk
  ]);
  assert.deepEqual(over, { r: 127.5, g: 127.5, b: 127.5 });
});

t("an opaque layer ends the walk regardless of what is beneath", () => {
  const over = compositeStack([{ r: 19, g: 20, b: 24, a: 1 }, { r: 255, g: 0, b: 0, a: 1 }]);
  assert.deepEqual(over, { r: 19, g: 20, b: 24 });
});

t("WCAG ratios match the reference values", () => {
  assert.equal(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }), 21);
  assert.equal(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }), 1);
  // The two numbers this repo argues about, so they cannot be re-derived wrongly.
  assert.equal(contrastRatio({ r: 162, g: 161, b: 170 }, { r: 255, g: 255, b: 255 }), 2.56);
  assert.equal(contrastRatio({ r: 82, g: 82, b: 91 }, { r: 255, g: 255, b: 255 }), 7.73);
});

t("the AA bar depends on size and weight", () => {
  assert.equal(aaThreshold(12, 400), 4.5);
  assert.equal(aaThreshold(24, 400), 3);
  assert.equal(aaThreshold(18.66, 700), 3);
  // 18px bold is NOT large — the boundary is 18.66, and rounding it to 18 would
  // let a real failure through.
  assert.equal(aaThreshold(18, 700), 4.5);
});

t("colours parse in every form the app emits", () => {
  assert.deepEqual(parseColour("rgb(29, 29, 31)"), { r: 29, g: 29, b: 31, a: 1 });
  assert.deepEqual(parseColour("rgba(255, 255, 255, 0.07)"), { r: 255, g: 255, b: 255, a: 0.07 });
  assert.equal(parseColour("transparent"), null);
  assert.equal(parseColour(""), null);
});

t("failures() uses each row's OWN bar, not a flat 4.5", () => {
  const rows = [
    { cr: 3.5, size: 30, weight: 400, need: 3 },     // large text, passes
    { cr: 3.5, size: 12, weight: 400, need: 4.5 },   // body text, fails
  ];
  assert.equal(failures(rows).length, 1);
  assert.equal(failures(rows)[0].size, 12);
});

t("an INACTIVE control is exempt, not a failure", () => {
  // WCAG 1.4.3 exempts inactive UI components. The panel's disabled Start button
  // measures a truthful 2.1:1 through its opacity chain, which is a real reading
  // of a control nobody can use — chasing it as a defect wastes a round.
  const rows = [
    { cr: 2.1, inactive: true, size: 12, weight: "400", need: 4.5 },
    { cr: 2.1, inactive: false, size: 12, weight: "400", need: 4.5 },
  ];
  assert.equal(failures(rows).length, 1);
  assert.equal(inactive(rows).length, 1);
});

// NO SEPARATE BACKTICK CHECK, and the reason is worth keeping. I wrote one three
// times and every version had a wrong premise (exactly-2-in-the-file: 42; last
// backtick: reaches into the JSDoc below; first backtick-semicolon: matched the
// stray's own close). Then I noticed the guard ALREADY EXISTS: this file IMPORTS
// the module, so a stray backtick inside the template makes the import throw a
// SyntaxError and the whole test file fails loudly. I watched it do exactly that
// twice. A hand-rolled parser for a case the import already catches is a check
// that can only be wrong.

t("PROBE_SOURCE is SYNTACTICALLY VALID", () => {
  // It is a template literal, so a stray BACKTICK inside an embedded comment
  // terminates it — which is exactly what happened while adding the gradient
  // guard above, and the module failed to PARSE at import time rather than at
  // sweep time. Compiling it here turns that into a test failure instead.
  assert.doesNotThrow(() => new Function(`return ${PROBE_SOURCE}`), "the probe must compile");
  assert.ok(!PROBE_SOURCE.includes("`"), "the probe is a template literal: no backticks inside it");
});

t("a gradient row is UNMEASURABLE, not a failure and not a pass", () => {
  const rows = [
    { cr: null, gradient: true, size: 40, weight: "400", need: 3 },  // the panel's "V"
    { cr: 2.0, gradient: false, size: 12, weight: "400", need: 4.5 }, // a real failure
  ];
  // It must not be counted as a failure — that was a false positive on the live
  // panel (white on white = 1.0, because the walk went PAST the gradient).
  assert.equal(failures(rows).length, 1);
  assert.equal(failures(rows)[0].cr, 2.0);
  // ...and it must not vanish either: the caller has to be able to SAY how many
  // were skipped, or a sweep that measured nothing reads as a clean pass.
  assert.equal(unmeasurable(rows).length, 1);
});

t("PROBE_SOURCE carries the REAL functions, not a paraphrase", () => {
  // If the module's functions are edited without the probe following, the browser
  // and the test stop being the same code — which is the failure this whole module
  // exists to prevent.
  assert.ok(PROBE_SOURCE.includes(compositeStack.toString()), "compositeStack not embedded");
  assert.ok(PROBE_SOURCE.includes(contrastRatio.toString()), "contrastRatio not embedded");
  assert.ok(PROBE_SOURCE.includes(aaThreshold.toString()), "aaThreshold not embedded");
  assert.ok(PROBE_SOURCE.includes(parseColour.toString()), "parseColour not embedded");
});

console.log(`contrast-probe: all ${n} checks passed`);
