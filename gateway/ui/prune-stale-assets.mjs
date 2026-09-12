#!/usr/bin/env node
// prune-stale-assets.mjs — drop the PREVIOUS console bundle after a build.
//
// WHY THIS IS NEEDED. `vite.config` sets `emptyOutDir: false` deliberately:
// `gateway/public/` is also where the code-viewer mirror lives, so emptying it
// would delete files that are not build output. Vite warns that an outDir outside
// the project root will not be emptied — which is correct and also means EVERY
// hashed bundle this console has ever built stays in the repo and ships with the
// worker, forever. Measured: two rebuilds in one round left two superseded
// `index-*.css` files behind, both still tracked by git.
//
// WHAT IT TOUCHES. ONLY files matching `assets/index-*.{js,css}` that
// `public/index.html` does NOT reference. It never removes anything else from
// `public/` — the mirror, the icons, the og image and `_headers` are out of
// scope by construction, which is the entire reason the config refuses to empty
// the directory.
//
// Usage: node prune-stale-assets.mjs   (run by `npm run build`, after vite)
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PUB = fileURLToPath(new URL("../public/", import.meta.url));
const ASSETS = `${PUB}assets/`;

const html = readFileSync(`${PUB}index.html`, "utf8");
const referenced = new Set(html.match(/index-[A-Za-z0-9_-]+\.(?:js|css)/g) || []);
if (referenced.size === 0) {
  // A check that read nothing must not report success — it would delete every
  // bundle on the strength of an empty list.
  console.error("prune-stale-assets: index.html references no index-*.{js,css} — refusing to prune anything");
  process.exit(1);
}

let removed = 0;
for (const f of readdirSync(ASSETS)) {
  if (!/^index-[A-Za-z0-9_-]+\.(js|css)$/.test(f)) continue;
  if (referenced.has(f)) continue;
  unlinkSync(ASSETS + f);
  console.log(`prune-stale-assets: removed superseded bundle ${f}`);
  removed += 1;
}
console.log(`prune-stale-assets: kept ${[...referenced].join(", ")}; removed ${removed}`);
