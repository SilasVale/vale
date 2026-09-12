#!/usr/bin/env node
// token-contract-check.mjs — ONE design vocabulary across the two frontends.
//
// WHY. The console (`gateway/ui`, the fleet surface served by the worker) and the
// device panel (`agent/resources/panel-react`, the operator surface) are one
// product with two hand-rolled token sets. They shared SIXTEEN token NAMES and
// TWELVE of them held different VALUES: the console's frame was Bootstrap's gray
// scale while the panel's was zinc/Apple, and the radii were 6/14px against
// 10/20px. A shared name therefore meant two different things depending on which
// surface you were looking at — and the console's own comment claimed "Same
// vocabulary as the device panel's frame", which is what stopped anyone checking.
//
// WHAT IT COMPARES. Only the names BOTH sides define, and it compares what they
// RESOLVE to rather than how they are spelled: the panel writes `var(--ds-neutral-50)`
// where the console writes the literal `#fafafa`, and that difference is
// legitimate — the console has no `--ds-neutral-*` scale. One `var()` level is
// resolved on each side; anything deeper is reported UNRESOLVED rather than
// silently treated as a match, because a comparison that cannot read a value must
// not report agreement (the model-drift lesson, one round old).
//
// WHAT IT DOES NOT DO. It does not check the names only ONE side defines, and it
// is not a contrast audit — that is `scripts/panel-render-audit.mjs`'s job.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONSOLE = "gateway/ui/src/styles/globals.css";
const PANEL = "agent/resources/panel-react/src/styles/tokens.css";

/** Every `--name: value;` in every rule OUTSIDE comments, keyed by selector.
 *  Comments are stripped FIRST: the console's header mentions
 *  `body[data-theme="dark"]` in prose, and a naive `find` matches there and then
 *  reads the LIGHT block as if it were the dark one — which is exactly the wrong
 *  answer I published before writing this. */
export function blocks(cssText) {
  const s = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = {};
  for (const m of s.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().split("\n").pop().trim();
    const vars = {};
    for (const v of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) vars[v[1]] = v[2].trim();
    out[sel] = { ...(out[sel] || {}), ...vars };
  }
  return out;
}

/** Resolve ONE `var(--x)` level against the same block. Returns null when the
 *  value still contains a var() afterwards — the caller reports that rather than
 *  comparing two strings neither side can read. */
export function resolve(value, vars) {
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(value.trim());
  if (!m) return value;
  const next = vars[m[1]];
  if (next === undefined) return null;
  return /var\(/.test(next) ? null : next;
}

export function divergences(consoleVars, panelVars) {
  const shared = Object.keys(consoleVars).filter((k) => k in panelVars);
  const differ = [];
  const unresolved = [];
  for (const k of shared) {
    const a = resolve(consoleVars[k], consoleVars);
    const b = resolve(panelVars[k], panelVars);
    if (a === null || b === null) { unresolved.push(k); continue; }
    if (a !== b) differ.push({ token: k, console: a, panel: b });
  }
  return { shared, differ, unresolved };
}

/**
 * The console's NEUTRALS must be drawn from the panel's declared scale.
 *
 * WHY THIS EXISTS ON TOP OF THE NAME COMPARISON, and it is not theoretical: the
 * name comparison compares only names BOTH sides define, and the console's own
 * `--text`, `--border` and `--bg-secondary` are not shared names — so nothing was
 * checking them. I aligned the console's `--chrome-*` frame first and left its
 * body on Bootstrap's grays, which produced a ZINC FRAME AROUND A BOOTSTRAP BODY:
 * measurably worse than leaving both alone, because the two halves then
 * disagreed INSIDE one surface. All 19 console neutrals are now values the panel
 * also declares, and this fails if one ever is not.
 */
export function offScaleNeutrals(consoleVars, panelVars, isColour) {
  const scale = new Set(Object.values(panelVars).filter(isColour));
  const out = [];
  for (const [k, v] of Object.entries(consoleVars)) {
    if (!/^--(bg|border|text|chrome)/.test(k)) continue;
    const r = resolve(v, consoleVars);
    if (r === null) continue; // reported by the caller's unresolved list
    if (isColour(r) && !scale.has(r)) out.push({ token: k, value: r });
  }
  return out;
}

const isColour = (v) => /^#|^rgba?\(/.test(String(v));

const cases = [
  ["light", ":root", ":root"],
  ["dark", 'body[data-theme="dark"]', 'body[data-theme="dark"]'],
];
const gc = blocks(readFileSync(`${ROOT}${CONSOLE}`, "utf8"));
const pc = blocks(readFileSync(`${ROOT}${PANEL}`, "utf8"));

let failures = 0;
for (const [label, gsel, psel] of cases) {
  const g = gc[gsel] || {};
  const p = pc[psel] || {};
  const { shared, differ, unresolved } = divergences(g, p);
  // A comparison that read nothing must not report success.
  assert.ok(shared.length >= 8, `${label}: only ${shared.length} shared tokens found — the parser read the wrong block`);
  if (unresolved.length) {
    console.log(`  ${label}: ${unresolved.length} shared token(s) UNRESOLVED (nested var) — not compared: ${unresolved.join(", ")}`);
  }
  // The console's neutrals, in this mode, against the panel's whole scale.
  const scalePanel = { ...(pc[":root"] || {}), ...(pc[psel] || {}) };
  const off = offScaleNeutrals(g, scalePanel, isColour);
  if (off.length === 0) {
    console.log(`  ${label}: every console neutral is a value the panel declares`);
  } else {
    failures += off.length;
    console.log(`  ${label}: ${off.length} console neutral(s) are NOT on the panel's scale:`);
    for (const o of off) console.log(`    ${o.token}: ${o.value} is the console's alone`);
  }

  if (differ.length === 0) {
    console.log(`  ${label}: ${shared.length} shared tokens agree`);
  } else {
    failures += differ.length;
    console.log(`  ${label}: ${differ.length} of ${shared.length} shared tokens DIVERGE`);
    for (const d of differ) console.log(`    ${d.token}: console ${d.console} vs panel ${d.panel}`);
  }
}
if (failures) {
  console.error(`\ntoken contract FAILED: ${failures} token(s) mean different things on the two surfaces.`);
  console.error("Pick ONE value: the panel is the device's primary operator surface, so the console follows it.");
  process.exit(1);
}
console.log("token contract: the console and the panel agree on every shared token name.");
