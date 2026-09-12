// Extract the SHIPPED playwright-mcp's tool contract into a committed snapshot.
//
// WHY A SNAPSHOT RATHER THAN READING THE BUNDLE DIRECTLY. The bundle
// (`agent/deploy/vale-playwright.zip`, 31 MB) is a boxed build artifact and is
// NOT tracked by git — so a test that reads it passes on a box that has it and
// FAILS IN CI, which is exactly what happened the first time this contract test
// was written. That is the "works on my box" failure in its purest form.
//
// This is the same pattern the device inventory already uses
// (`agent/spec-tools.json`): generate a small snapshot from the authoritative
// artifact, commit it, and give the test a refresh command. The snapshot names
// the version it came from, so an upgrade shows up as a diff.
//
//   node gateway/scripts/extract-playwright-tools.mjs
//
// Re-run it whenever the boxed playwright bundle is updated.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ZIP = `${ROOT}agent/deploy/vale-playwright.zip`;
const OUT = fileURLToPath(new URL("../playwright-tools.json", import.meta.url));

const read = (entry) => execFileSync("unzip", ["-p", ZIP, entry], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");

const pkg = JSON.parse(read("playwright/node_modules/@playwright/mcp/package.json"));
const bundle = read("playwright/node_modules/playwright-core/lib/coreBundle.js");

/**
 * name -> the tool's RAW `inputSchema:` text, from `inputSchema:` to the
 * `handle:` that follows it.
 *
 * NO PARAMETER EXTRACTION. Three attempts at producing a key LIST here (a lazy
 * regex, a brace walk, an indentation-bounded slice) each produced a DIFFERENT
 * wrong answer — zero for every tool, then extra keys from the handler body, then
 * empty for tools that plainly have parameters. Each was a parser that could be
 * subtly wrong while looking right, and a wrong snapshot makes the contract test
 * assert nonsense.
 *
 * Keeping the raw text removes the parser entirely: the test asks "does this
 * tool's schema text declare `fullPage`?" against the shipped bytes, so the only
 * thing that can be wrong is the WINDOW, which is asserted to be substantial.
 */
const tools = {};
const marks = [...bundle.matchAll(/name:\s*"(browser_[a-z_]+)"/g)];
for (let i = 0; i < marks.length; i++) {
  const name = marks[i][1];
  if (tools[name]) continue;
  const from = marks[i].index;
  const to = i + 1 < marks.length ? marks[i + 1].index : bundle.length;
  const block = bundle.slice(from, to);
  const at = block.indexOf("inputSchema:");
  if (at === -1) continue;
  // The schema LINE, which may be an inline `z.object({...})` OR a named
  // reference (`screenshotSchema`), and those references CHAIN
  // (`screenshotSchema = optionalElementSchema.extend({...})`). A hand-rolled
  // parser cannot follow a composition graph, so we do not try: capture the
  // tool's own schema line plus the definition text of every identifier it
  // mentions, transitively, and let the test read the shipped BYTES rather than
  // a parsed interpretation of them.
  const handle = block.indexOf("handle:", at);
  let text = block.slice(at, handle === -1 ? block.length : handle).trim();
  const seen = new Set();
  const queue = [...text.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=\.extend|,|\n|\s*$)/g)]
    .map((m) => m[1])
    .filter((id) => !/^(z\d*|inputSchema|object|optional|string|number|boolean|array|enum|describe)$/.test(id));
  while (queue.length > 0 && seen.size < 12) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const def = new RegExp(`\\b${id}\\s*=\\s*`).exec(bundle);
    if (!def) continue;
    // A definition ends at the next closing brace group at the bundle's inner
    // indent (no backticks here: one inside a comment opens a template literal
    // and eats the following code).
    const tail = bundle.slice(def.index);
    const stop = tail.search(/\n\s{0,6}\};?\n/) ;
    const piece = tail.slice(0, stop === -1 ? Math.min(tail.length, 1600) : stop + 40);
    text += "\n" + piece;
    for (const m of piece.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=\.extend)/g)) queue.push(m[1]);
  }
  if (text.length < 20) continue;
  tools[name] = text;
}

const names = Object.keys(tools).sort();
if (names.length < 5) throw new Error(`only ${names.length} browser_* tools found — wrong bundle?`);
// A window that captured nothing is the failure this guards against: it would
// make the contract test check nothing while reporting success.
const totalChars = names.reduce((n, k) => n + tools[k].length, 0);
if (totalChars < 200) throw new Error(`captured only ${totalChars} chars of schema — the extractor is reading nothing`);

const header =
  "// The SHIPPED playwright-mcp's browser_* tool contract, extracted from\n" +
  "// agent/deploy/vale-playwright.zip (playwright-core/lib/coreBundle.js).\n" +
  "// The bundle is a boxed, untracked artifact, so this snapshot is what CI can see.\n" +
  "// Regenerate with: node gateway/scripts/extract-playwright-tools.mjs\n" +
  "// Do not hand-edit.\n";
writeFileSync(OUT, header + JSON.stringify({ source: `@playwright/mcp ${pkg.version}`, tools }, null, 2) + "\n");
console.log(`wrote ${OUT} — @playwright/mcp ${pkg.version}, ${names.length} tools`);
