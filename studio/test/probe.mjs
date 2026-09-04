import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", e => console.log("PAGEERR:", e.message.slice(0,180)));
await page.goto("http://127.0.0.1:7780/", { waitUntil: "domcontentloaded" });
await page.fill("#gate-token", "dev-studio-token-2026-08-25-local");
await page.click("#gate-go");
await page.waitForFunction(() => document.querySelectorAll("#tree .tree-item").length > 0);

// replicate e2e predecessor: full navigation to a deep link
await page.goto("http://127.0.0.1:7780/#/open?p=" + encodeURIComponent("/home/zhengsaisi/vale/studio/public/index.html") + "&l=12");
await page.waitForSelector(".monaco-editor", { timeout: 10000 });

// then the search flow exactly as e2e does it
await page.click('.act-btn[data-view="search"]');
await page.fill("#search-input", "VSTUDIO_ROOT");
await page.keyboard.press("Enter");
await page.waitForSelector(".sr-file", { timeout: 10000 });
const tabsBefore = await page.$$eval("#tabs .tab", els => els.length);
console.log("tabsBefore:", tabsBefore);
console.log("firstHit:", await page.$eval(".sr-hit", el => el.textContent.slice(0,50)));
await page.locator(".sr-hit").first().click();
await page.waitForTimeout(3000);
const after = await page.evaluate(() => ({
  tabs: [...document.querySelectorAll("#tabs .tab .name")].map(n => n.textContent),
  toasts: [...document.querySelectorAll(".toast")].map(t => t.textContent),
}));
console.log("AFTER:", JSON.stringify(after));
await browser.close();
