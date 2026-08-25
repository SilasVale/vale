import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", m => { if (m.type()==="error") console.log("CONSOLE:", m.text().slice(0,140)); });
await page.goto("http://127.0.0.1:7780/", { waitUntil: "domcontentloaded" });
await page.fill("#gate-token", "dev-studio-token-2026-08-25-local");
await page.click("#gate-go");
await page.waitForFunction(() => document.querySelectorAll("#tree .tree-item").length > 0);
await page.keyboard.press("Control+`");
await page.waitForSelector(".term-host.active .xterm", { timeout: 12000 });
await page.waitForTimeout(1200);
// instrument: capture onData flow
await page.evaluate(() => {
  window.__sent = [];
  const host = document.querySelector(".term-host.active");
  // monkey-patch WebSocket send on the live socket via xterm's data path:
  // easier—hook Terminal.prototype._core... too deep; instead watch network frames
});
// log all WS frames via CDP
const client = await page.context().newCDPSession(page);
await client.send("Network.enable");
client.on("Network.webSocketFrameSent", ev => {
  const d = ev.response.payloadData;
  if (d && !d.includes("resize")) console.log("SENT frame:", JSON.stringify(d.slice(0,40)));
});
client.on("Network.webSocketFrameReceived", ev => {
  const d = ev.response.payloadData;
  if (d && d.length < 60 && d.includes("$")) console.log("RECV:", JSON.stringify(d.slice(0,50)));
});
await page.locator(".term-host.active .xterm").click();
await page.keyboard.type("echo HI123\r");
await page.waitForTimeout(2500);
const txt = await page.$eval(".term-host.active .xterm", el => el.textContent);
console.log("TAIL:", JSON.stringify(txt.slice(-100)));
await browser.close();
