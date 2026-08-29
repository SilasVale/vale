// Devices-page render smoke: same harness as render-smoke.mjs, but mocks the
// admin APIs, forces zh, mounts #/devices, and asserts the DASHBOARD-CARD
// markers (stats strip, card grid, per-device signal rows) — not just mount.
// Usage: npm run smoke:devices   (after npm run build)
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) { console.error("usage: node devices-render-smoke.mjs <built-js>"); process.exit(1); }
const html = readFileSync("../public/index.html", "utf8");
const js = readFileSync(jsPath, "utf8");
const now = Date.now();

const routes = {
  "/api/me": { username: "admin", role: "admin", token: "tok-abc", keys: {} },
  "/api/devices": {
    devices: [
      { name: "d1", hostname: "d1.agent.saisi.online", token: "a1b2c3d4e5f6g7h8", registeredAt: now - 86400000, lastSeenAt: now - 60000, lastVersion: "1.0.106" },
      { name: "d2", hostname: "d2.agent.saisi.online", token: "z9y8x7w6v5u4t3s2", lastVersion: "1.0.100" },
    ],
  },
  "/api/plugins/status": {
    devices: {
      d1: { online: false, agent_up: true, tunnel_up: true, version: "1.0.106", checked_at: now },
      d2: { online: false, agent_up: false, tunnel_up: false, checked_at: now },
    },
  },
  // version = agent (Cargo) scheme; the download filename carries the npm version.
  "/api/devices/install-cmd": { ok: true, version: "1.0.106", download: "https://v.saisi.online/dl/vale-agent-1.2.102.tgz" },
  "/api/devices/register-keys": { keys: [{ code: "abcd1234", expiresAt: now + 3600000 }] },
};

const dom = new JSDOM(html, {
  url: "https://ai.saisi.online/#/devices",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
window.fetch = async (input) => {
  const path = new URL(String(input), "https://ai.saisi.online").pathname;
  if (path in routes) {
    return new Response(JSON.stringify(routes[path]), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: { message: "not mocked: " + path } }), { status: 404, headers: { "content-type": "application/json" } });
};
window.localStorage.setItem("valegate-lang", "zh");
window.__ims = (s) => s;
window.eval(js.replaceAll("import.meta.resolve", "window.__ims").replaceAll("import.meta.url", JSON.stringify("https://ai.saisi.online/")));
await new Promise((r) => setTimeout(r, 800));

const doc = window.document;
const text = doc.body.textContent || "";
const checks = [
  ["stats strip renders", doc.querySelector(".dev-stats") !== null && text.includes("台设备") && text.includes("在线")],
  ["stat numbers (2 devices, 1 online, 1 tunnel, 1 key)", doc.querySelectorAll(".dev-stat").length === 4],
  ["card grid with 2 cards", doc.querySelectorAll(".dev-card").length === 2],
  ["signal rows per card (3 × 2)", doc.querySelectorAll(".dev-sig").length === 6],
  ["d1 online LED + d2 offline LED", doc.querySelector(".dev-led.on") !== null && doc.querySelector(".dev-led.off") !== null],
  ["tunnel down state text", text.includes("隧道断开")],
  ["outdated badge on d2 (1.0.100 → 1.0.106)", text.includes("可更新到 1.0.106")],
  ["relative last-seen on d1", text.includes("最近在线") && /最近在线 (刚刚|\d+ 分钟前)/.test(text)],
  ["ssh quick-copy on cards", doc.querySelectorAll('.dev-host .btn').length >= 2],
  ["reg key listed", text.includes("abcd1234")],
  ["row actions", text.includes("打开面板") && text.includes("配对扩展") && text.includes("编辑")],
  ["advanced collapsed block", text.includes("网关 MCP 配置")],
];
let fail = 0;
for (const [name, ok] of checks) {
  console.log(ok ? "  ✔" : "  ✘", name);
  if (!ok) fail++;
}
console.log(fail === 0 ? "DEVICES DASHBOARD RENDER OK" : `DEVICES DASHBOARD RENDER FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
