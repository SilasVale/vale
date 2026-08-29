#!/usr/bin/env node
/**
 * build-css.mjs — assemble the panel stylesheet from the src/styles split
 * files into ../panel/panel.css (the file web.rs embeds via include_str!).
 *
 * Also runs a static tokens check: every `var(--x)` referenced anywhere in
 * the output must be DEFINED in the :root block; a missing token fails the
 * build (exit non-zero) so undefined-variable regressions can never reach
 * the shipped stylesheet again.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // panel-react/
const stylesDir = path.join(root, "src", "styles");
// The agent embeds ../resources/panel/panel.css relative to agent/ — i.e.
// panel-react's PARENT (agent/resources/) panel dir.
const outFile = path.join(root, "..", "panel", "panel.css");

const ORDER = ["tokens.css", "base.css", "components.css", "layout.css", "desktop.css"];

const parts = ORDER.map((f) => {
  const p = path.join(stylesDir, f);
  const src = readFileSync(p, "utf8");
  return `/* ============ ${f} ============ */\n${src}`;
});

const css = parts.join("\n\n");

// ---- tokens check: every var() usage must be defined in :root ----
const defined = new Set();
const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/);
if (!rootBlock) {
  console.error("build-css: no :root block found — tokens.css missing?");
  process.exit(1);
}
for (const m of rootBlock[1].matchAll(/--[a-z0-9-]+/g)) defined.add(m[0]);

const missing = new Set();
for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
  if (!defined.has(m[1])) missing.add(m[1]);
}
// var() fallbacks (e.g. var(--x, #fff)) are allowed only for legacy aliases
// that ARE defined; the set above already covers that.
if (missing.size > 0) {
  console.error(`build-css: undefined CSS variables referenced:\n  ${[...missing].sort().join("\n  ")}`);
  process.exit(1);
}

writeFileSync(outFile, css + "\n");
console.log(`build-css: wrote ${outFile} (${css.length} bytes, ${defined.size} tokens, 0 undefined refs)`);
