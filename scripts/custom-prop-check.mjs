// A `var()` THAT RESOLVES TO NOTHING SILENTLY DELETES THE DECLARATION.
//
// This is not a warning — it is how CSS works. `color: var(--x)` where `--x` is
// undefined makes the whole declaration INVALID AT COMPUTED-VALUE TIME, so the
// property is dropped and the element inherits. Nothing errors, nothing logs, and
// the page renders — just not the way the rule says.
//
// FOUND THE HARD WAY. Round 43's console Models page used three names that exist in
// the PANEL's token set and not in the console's:
//     --accent-soft      --accent-on-soft      --danger
// so the AMD lane had NO lane stripe at all and the "current model" chip was not
// highlighted — while every contrast sweep reported 0 under AA, because a dropped
// `color` leaves an inherited colour that measures fine. A contrast probe cannot see
// a declaration that never applied.
//
// It was invisible to the token contract too: that check compares names BOTH
// frontends declare, and these were declared by neither.
//
// So: every custom property USED in a frontend must be DEFINED in that frontend.
// A `var(--x, fallback)` is reported separately rather than failed — the fallback is
// real and the property does apply — but it is still a name the stylesheet does not
// own, which is how round 43 found 38 dead fallbacks in the panel.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Each frontend's CSS, as one blob: tokens and consumers often live apart. */
function consoleCss() {
  const dir = path.join(ROOT, "gateway", "ui", "src", "styles");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

function panelCss() {
  const dir = path.join(ROOT, "agent", "resources", "panel-react", "src", "styles");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

/** The landing page carries its CSS inside a JS template literal. */
function landingCss() {
  const src = readFileSync(path.join(ROOT, "index", "src", "page.js"), "utf8");
  const start = src.indexOf("<style>");
  const end = src.indexOf("</style>");
  return start >= 0 && end > start ? src.slice(start, end) : "";
}

/** Defined custom properties in a stylesheet: `--x:` at a declaration position. */
const defined = (css) =>
  new Set([...css.matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

/** `var(--x)` without a fallback — the fatal form. */
const usedBare = (css) =>
  new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((m) => m[1]));

/** `var(--x, …)` — applies, but the name is not owned here. */
const usedWithFallback = (css) =>
  new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,[^)]*\)/g)].map((m) => m[1]));

const FRONTENDS = [
  { name: "console (gateway/ui)", css: consoleCss, min: 20 },
  { name: "panel (panel-react)", css: panelCss, min: 40 },
  { name: "landing (index/page.js)", css: landingCss, min: 20 },
];

let failures = 0;
const summary = [];

for (const f of FRONTENDS) {
  const css = f.css();
  const dec = defined(css);
  const bare = usedBare(css);
  const fb = usedWithFallback(css);

  // A parser that reads nothing must not report a pass (round 33's rule).
  if (dec.size < f.min || bare.size < 5) {
    console.error(`FAIL ${f.name}: parsed only ${dec.size} definitions / ${bare.size} uses — the parser read the wrong thing`);
    failures++;
    continue;
  }

  const broken = [...bare].filter((v) => !dec.has(v)).sort();
  const fallbackOnly = [...fb].filter((v) => !dec.has(v)).sort();

  if (broken.length) {
    console.error(`\nFAIL ${f.name}: ${broken.length} custom propert${broken.length === 1 ? "y is" : "ies are"} USED BUT NOT DEFINED.`);
    console.error("  Each one makes its declaration INVALID, so the property is DROPPED and the element inherits:");
    for (const v of broken) console.error(`    ${v}`);
    failures++;
  } else {
    summary.push(`${f.name}: ${dec.size} defined, ${bare.size} used, 0 dangling`);
  }

  if (fallbackOnly.length) {
    // Not a failure — the fallback applies — but a name this stylesheet does not own.
    summary.push(`  note ${f.name}: ${fallbackOnly.length} used only WITH a fallback (${fallbackOnly.slice(0, 4).join(", ")})`);
  }
}

if (failures) {
  console.error(`\ncustom-property check: ${failures} frontend(s) with dangling references`);
  process.exit(1);
}
console.log("custom-property check: every var() used is defined in its own frontend");
for (const line of summary) console.log("  " + line);
