// Screenshot every panel page × both densities × both themes against the mock
// agent. Usage: node scripts/screenshot.mjs <tag>   (e.g. before | after)
//
// THE PAGE LIST MIRRORS Shell.tsx's PAGES — all SEVEN of them. This script used
// to hold its own five-item list, so `archive` and `activity` were never
// captured and a redesign could break them with every screenshot still green.
// `pageCoverage.test.ts` pins the union in the shells; nothing pinned the
// harness, which is how the two drifted apart.
//
// Launch args are for this Linux dev box (no user namespaces → the Chromium
// sandbox cannot start). They are inert on the Windows box the panel ships to.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const TAG = process.argv[2] || "before";
const BASE = process.env.VALE_SHOT_BASE || "http://127.0.0.1:18811";
const OUT = `/tmp/panel-shot/${TAG}`;
const PAGES = ["terminal", "archive", "activity", "browser", "memory", "plugins", "settings"];
const THEMES = ["light", "dark"];
const DENSITIES = ["panel", "desktop"];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2 });

let shots = 0;
let misses = 0;
for (const theme of THEMES) {
  for (const density of DENSITIES) {
    const prefix = density === "panel" ? "/panel/" : "/desktop/";
    const page = await ctx.newPage();
    await page.addInitScript(
      ([t]) => {
        localStorage.setItem("valeHost", "127.0.0.1:18811");
        localStorage.setItem("valeToken", "mock-token");
        localStorage.setItem("valeFontSize", "13");
        localStorage.setItem("vale-theme", t);
      },
      [theme],
    );
    await page.goto(BASE + prefix, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    for (const p of PAGES) {
      // The rail's aria-label is the capitalized page name (IconRail.tsx).
      const btn = page.locator(`button[aria-label="${p[0].toUpperCase() + p.slice(1)}"]`).first();
      try {
        await btn.click({ timeout: 3000 });
      } catch {
        // A silent miss is how the five-page list survived: the file was named
        // after the page it was NOT on. Fail loudly instead.
        console.log(`  ! rail click failed: ${p} (${theme}/${density})`);
        misses++;
      }
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}/${theme}-${density}-${p}.png` });
      shots++;
    }
    await page.close();
  }
}
await browser.close();
console.log(`screenshots → ${OUT}/ (${shots} files, ${misses} click misses)`);
if (misses > 0) process.exit(1);
