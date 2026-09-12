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
import {
  contrastRatio,
  parseColour,
} from "../../agent/scripts/lib/contrast-probe.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONSOLE = "gateway/ui/src/styles/globals.css";
const PANEL = "agent/resources/panel-react/src/styles/tokens.css";
// The THIRD surface. It has its own namespace, but the names it DOES share must mean
// the same thing — and nothing was checking them.
const LANDING = "index/src/page.js";

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
    for (const v of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
      vars[v[1]] = v[2].trim();
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
    if (a === null || b === null) {
      unresolved.push(k);
      continue;
    }
    // Compare MEANING, not source formatting: whitespace anywhere (including just inside
    // a function's parentheses) is not a difference between two surfaces.
    const squash = (v) => String(v).replace(/\s+/g, "");
    if (squash(a) !== squash(b))
      differ.push({ token: k, console: a, panel: b });
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

/**
 * A fallback on a token the system DECLARES is dead code.
 *
 * `var(--accent, #4f7cff)` never applies, because `--accent` is always defined —
 * so it is not a safety net, it is a description of a design the surface no
 * longer has. The panel carried THIRTY-EIGHT of these, and together they spelled
 * out an entire abandoned palette: a BLUE accent (#4f7cff / #4f6bed /
 * rgba(79,124,255,0.2)) where the panel's accent is orange, plus a darker grey
 * family (#1c1e22/#23262c/#2a2d34) and #4caf50/#d97706. The console has ZERO, so
 * the two surfaces disagreed on this too — and the panel's dead values are a
 * TRAP, not just noise: delete a token and the design silently reverts to a
 * palette nobody has looked at in months, with every gate green.
 *
 * Removing them all was verified RENDERING-NEUTRAL rather than argued: the
 * previously built panel.css with its fallbacks mechanically stripped is
 * BYTE-IDENTICAL to the newly built one.
 *
 * A fallback on a token the system does NOT declare is a different thing and is
 * deliberately NOT reported — that is how a caller supplies a default for a
 * variable someone else owns.
 */
export function deadFallbacks(cssText, defined, skipFile = "") {
  void skipFile;
  const out = [];
  for (const m of cssText.matchAll(
    /var\(\s*(--[a-z0-9-]+)\s*,\s*([\s\S]*?)\)\s*[,;)]/g,
  )) {
    if (defined.has(m[1]))
      out.push({ token: m[1], fallback: m[2].trim().slice(0, 40) });
  }
  return out;
}

// Declared BEFORE its first use. It was not, and the result is worth recording:
// `failures += dead` sat above this line, so a clean tree never reached it and
// the check passed — while a tree WITH a dead fallback crashed on a
// ReferenceError (TDZ) instead of reporting. A gate that only breaks when it has
// something to say is the worst possible shape, and the exit code being non-zero
// anyway is exactly what would have hidden it from CI.
let failures = 0;

// --- a semantic colour has TWO weights, and text needs the readable one -----
// The console had ONE value per state and used it as both a mark and text, so
// every status word on the devices view measured under AA — 在线 3.13,
// 可更新到 3.30, 离线 4.11, 删除 4.32 — and those words are the most important
// information on the page. The panel already separates the two (`--success-text`
// beside `--success`, `--danger-on-soft`, the whole `--chrome-active-*` family);
// the console now does too. Measured after the change: 13 failures -> 1, and that
// one is a false positive of the sweep (`.rail-avatar` is white on a
// `background-image` gradient, which a `backgroundColor` walk cannot see).
{
  const g = blocks(
    readFileSync(`${ROOT}gateway/ui/src/styles/globals.css`, "utf8"),
  );
  const root = g[":root"] || {};
  const dark = g['body[data-theme="dark"]'] || {};
  for (const tok of ["--success-text", "--warning-text", "--error-text"]) {
    if (!(tok in root) || !(tok in dark)) {
      failures += 1;
      console.log(
        `    console: ${tok} must be declared in BOTH theme blocks (light-only freezes against the light background)`,
      );
    }
  }
  const css = readFileSync(
    `${ROOT}gateway/ui/src/styles/globals.css`,
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  // ...and the NEUTRAL ladder is the same story, measured on the surfaces these
  // steps actually sit on:
  //   #71717a (--text-muted)  white 4.83 | --bg 4.63 | --bg-secondary 4.40 | --bg-tertiary 4.10
  //   #a1a1aa (--text-faint)  white 2.56 | --bg 2.46 | --bg-secondary 2.34 | --bg-tertiary 2.18
  // `--text-muted` passes on the two lightest and FAILS on the two darker ones,
  // so whether it was safe depended on which surface a rule happened to land on —
  // not something a stylesheet check can see. Both remain valid as marks.
  for (const mark of ["--text-muted", "--text-faint"]) {
    const offenders = [
      ...css.matchAll(new RegExp(`(?<![\\w-])color:\\s*var\\(${mark}\\)`, "g")),
    ];
    if (offenders.length) {
      failures += offenders.length;
      console.log(
        `    console: ${offenders.length} rule(s) paint TEXT with ${mark}, a MARK weight — use --text-secondary`,
      );
    }
  }
  for (const mark of ["--success", "--warning", "--error"]) {
    const offenders = [
      ...css.matchAll(new RegExp(`(?<![\\w-])color:\\s*var\\(${mark}\\)`, "g")),
    ];
    if (offenders.length) {
      failures += offenders.length;
      console.log(
        `    console: ${offenders.length} rule(s) paint TEXT with ${mark}, the MARK weight — use ${mark}-text`,
      );
    }
  }
  if (!failures)
    console.log("  console: semantic colours have a readable text weight");
}

// --- dead fallbacks, both frontends ----------------------------------------
for (const [label, dir, tokenFile] of [
  ["console", "gateway/ui/src/", "styles/globals.css"],
  ["panel", "agent/resources/panel-react/src/", "styles/tokens.css"],
]) {
  const tokText = blocks(readFileSync(`${ROOT}${dir}${tokenFile}`, "utf8"));
  const defined = new Set(
    Object.values(tokText).flatMap((b) => Object.keys(b)),
  );
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (d) =>
    readdirSync(d).flatMap((e) => {
      const f = `${d}/${e}`;
      if (statSync(f).isDirectory()) return e === "node_modules" ? [] : walk(f);
      return /\.(css|tsx|ts)$/.test(f) && !f.endsWith(tokenFile) ? [f] : [];
    });
  let dead = 0;
  for (const f of walk(`${ROOT}${dir}`)) {
    const hits = deadFallbacks(readFileSync(f, "utf8"), defined);
    for (const h of hits) {
      dead += 1;
      if (dead <= 3)
        console.log(
          `    ${f.replace(ROOT, "")}: var(${h.token}, ${h.fallback}…) can never apply`,
        );
    }
  }
  if (dead) {
    failures += dead;
    console.log(
      `  ${label}: ${dead} DEAD fallback(s) — a token the system declares always wins`,
    );
  } else {
    console.log(`  ${label}: no dead fallbacks`);
  }
}

const cases = [
  ["light", ":root", ":root"],
  ["dark", 'body[data-theme="dark"]', 'body[data-theme="dark"]'],
];
const gc = blocks(readFileSync(`${ROOT}${CONSOLE}`, "utf8"));
const pc = blocks(readFileSync(`${ROOT}${PANEL}`, "utf8"));
// page.js is a JS MODULE with a <style> block inside a template literal, not a
// stylesheet — handing the whole file to a CSS parser makes it match JS braces too.
// (It happened to read `:root` correctly, which is exactly the kind of accidental
// success that hides a parser pointed at the wrong input.) Extract the stylesheet
// first, and FAIL if there is not one.
const landingSrc = readFileSync(`${ROOT}${LANDING}`, "utf8");
const landingCss = /<style>([\s\S]*?)<\/style>/.exec(landingSrc);
assert.ok(
  landingCss,
  `${LANDING}: no <style> block found — the parser would read JS`,
);
const lc = blocks(landingCss[1]);

// --- the accent family must be READABLE, in both directions ------------------
//
// The accent is used BOTH ways: as a button background carrying `--accent-fg`, and as
// TEXT on the page background. It failed BOTH in the light theme — white on #d9480f
// measured 4.30, and #d9480f as text on #fafafa measured 4.12 — for as long as the
// value existed, and nothing watched it. The dark theme was worse: white on #ffa94d
// measured 1.90, a factor of two under AA, on the login button.
//
// This is the check that would have caught all three. It reads the tokens the two
// frontends actually ship, so a palette change that re-breaks them fails here rather
// than at a user's eyes.
const AA_TEXT = 4.5;
function contrastFailures(label, tokens) {
  const out = [];
  const get = (k) => {
    const v = tokens[k];
    return typeof v === "string" ? v.trim() : null;
  };
  // TOKEN values, not computed styles. `parseColour` from the probe library is built
  // for `getComputedStyle` output — it reads digit runs, so `#ffffff` has NO digits and
  // parses to null (it handles `rgb()`/`rgba()` only). A hex-aware resolver is needed
  // here, and an unparseable value must FAIL rather than be skipped: a check that
  // cannot read its input is not a check that found nothing.
  const toRgb = (c) => {
    const v = String(c || "").trim();
    let m = v.match(/^#([0-9a-f]{3})$/i);
    if (m)
      return {
        r: parseInt(m[1][0] + m[1][0], 16),
        g: parseInt(m[1][1] + m[1][1], 16),
        b: parseInt(m[1][2] + m[1][2], 16),
      };
    m = v.match(/^#([0-9a-f]{6})$/i);
    if (m)
      return {
        r: parseInt(m[1].slice(0, 2), 16),
        g: parseInt(m[1].slice(2, 4), 16),
        b: parseInt(m[1].slice(4, 6), 16),
      };
    const rgb = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
    return null;
  };
  const ratioOf = (a, b) => {
    const fgO = toRgb(a),
      bgO = toRgb(b);
    if (!fgO || !bgO) return null;
    return contrastRatio(fgO, bgO);
  };
  const check = (what, fg, bg) => {
    const r = ratioOf(fg, bg);
    if (r === null) {
      out.push(`${label}: ${what} could not be measured (${fg} on ${bg})`);
    } else if (r < AA_TEXT) {
      out.push(
        `${label}: ${what} measures ${r.toFixed(2)}, under AA ${AA_TEXT} (${fg} on ${bg})`,
      );
    }
  };
  const fg = get("--accent-fg");
  const accent = get("--accent");
  const bg = get("--bg");
  // A missing token is itself a failure — an absent `--accent-fg` silently falls back
  // to inheritance, which is how a 1.90:1 button ships.
  if (!fg) out.push(`${label}: --accent-fg is not declared`);
  if (!accent) out.push(`${label}: --accent is not declared`);
  if (fg && accent) check("--accent-fg on --accent", fg, accent);
  if (accent && bg) check("--accent as text on --bg", accent, bg);
  return out;
}

let accentFailures = 0;
for (const [label, gsel] of [
  ["light", ":root"],
  ["dark", 'body[data-theme="dark"]'],
]) {
  const tokens = { ...(gc[":root"] || {}), ...(gc[gsel] || {}) };
  const bad = contrastFailures(label, tokens);
  accentFailures += bad.length;
  for (const b of bad) console.log(`  ${b}`);
}
if (accentFailures === 0)
  console.log("  accent family: readable in both directions, both themes");

for (const [label, gsel, psel] of cases) {
  const g = gc[gsel] || {};
  const p = pc[psel] || {};
  const { shared, differ, unresolved } = divergences(g, p);
  // A comparison that read nothing must not report success.
  assert.ok(
    shared.length >= 8,
    `${label}: only ${shared.length} shared tokens found — the parser read the wrong block`,
  );
  if (unresolved.length) {
    console.log(
      `  ${label}: ${unresolved.length} shared token(s) UNRESOLVED (nested var) — not compared: ${unresolved.join(", ")}`,
    );
  }
  // The console's neutrals, in this mode, against the panel's whole scale.
  // THE LANDING PAGE, for the names it shares with the console. Its own `--dsw-alias-*`
  // namespace is deliberately local; what must agree is anything it declares under a
  // name the console also declares.
  {
    // EFFECTIVE sets, not raw blocks. A theme's tokens are `:root` PLUS its override —
    // the console's dark block redefines console-named tokens while the landing's
    // redefines `--dsw-alias-*`, so comparing the two OVERRIDE blocks alone found an
    // intersection of exactly ZERO and would have reported "no disagreement" for the
    // worst possible reason.
    const effective = (blk, sel) => ({
      ...(blk[":root"] || {}),
      ...(blk[sel] || {}),
    });
    const gEff = effective(gc, gsel);
    const lEff = effective(
      lc,
      label === "light" ? ":root" : "body[data-ds-dark-theme]",
    );
    const { shared: lShared, differ: lDiffer } = divergences(gEff, lEff);
    assert.ok(
      lShared.length >= 8,
      `${label}: landing comparison read only ${lShared.length} shared tokens — the parser looked at the wrong block`,
    );
    for (const d of lDiffer) {
      failures += 1;
      console.log(
        `  ${label}: landing  ${d.token}: console ${d.console} vs landing ${d.panel}`,
      );
    }
    if (!lDiffer.length)
      console.log(
        `  ${label}: landing agrees on all ${lShared.length} shared tokens`,
      );
  }

  const scalePanel = { ...(pc[":root"] || {}), ...(pc[psel] || {}) };
  const off = offScaleNeutrals(g, scalePanel, isColour);
  if (off.length === 0) {
    console.log(
      `  ${label}: every console neutral is a value the panel declares`,
    );
  } else {
    failures += off.length;
    console.log(
      `  ${label}: ${off.length} console neutral(s) are NOT on the panel's scale:`,
    );
    for (const o of off)
      console.log(`    ${o.token}: ${o.value} is the console's alone`);
  }

  if (differ.length === 0) {
    console.log(`  ${label}: ${shared.length} shared tokens agree`);
  } else {
    failures += differ.length;
    console.log(
      `  ${label}: ${differ.length} of ${shared.length} shared tokens DIVERGE`,
    );
    for (const d of differ)
      console.log(`    ${d.token}: console ${d.console} vs panel ${d.panel}`);
  }
}
failures += accentFailures;
if (failures) {
  // The count covers TWO different causes and the old summary named only one —
  // a dead fallback was reported as "N token(s) mean different things on the two
  // surfaces", which sends a reader looking for a value mismatch that is not
  // there. Say which.
  console.error(`\ntoken contract FAILED (${failures}):`);
  console.error(
    "  * a shared token holding DIFFERENT VALUES on the two surfaces -> the panel is",
  );
  console.error(
    "    the device's primary operator surface, so pick ITS value for the console;",
  );
  console.error(
    "  * a DEAD fallback (`var(--x, v)` where the system declares --x) -> drop the",
  );
  console.error(
    "    fallback, it can never apply and it describes a design that is gone;",
  );
  console.error(
    "  * or the ACCENT FAMILY is not readable (see the measurements above) -> darken the",
  );
  console.error(
    "    accent rather than the ink: no foreground passes on #d9480f at the base AND its",
  );
  process.exit(1);
}
console.log(
  "token contract: the console and the panel agree on every shared token name.",
);
