// Screenshot the five pages × both densities against the mock agent.
// Usage: node shot.mjs before|after
import { chromium } from "playwright-core";

const TAG = process.argv[2] || "before";
const BASE = "http://127.0.0.1:18811";
const OUT = `/tmp/panel-shot/${TAG}`;
const PAGES = ["terminal", "browser", "memory", "plugins", "settings"];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 } });

for (const density of ["panel", "desktop"]) {
  const prefix = density === "panel" ? "/panel/" : "/desktop/";
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("valeHost", "127.0.0.1:18811");
    localStorage.setItem("valeToken", "mock-token");
    localStorage.setItem("valeFontSize", "13");
  });
  await page.goto(BASE + prefix, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  for (const p of PAGES) {
    // Click the rail button for the page (aria-label = capitalized page).
    const btn = page.locator(`button[aria-label="${p[0].toUpperCase() + p.slice(1)}"]`).first();
    try { await btn.click({ timeout: 3000 }); } catch { console.log(`  ! rail click failed: ${p} (${density})`); }
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/${density}-${p}.png` });
  }
  await page.close();
}
await browser.close();
console.log(`screenshots → ${OUT}/ (${PAGES.length * 2} files)`);
