// Screenshot every console view × both themes against a stubbed API.
// Usage: node scripts/screenshot.mjs [tag]     (default: before)
//
// THE CONSOLE HAD NO WAY TO BE LOOKED AT. `wrangler dev` cannot start on this box
// (workerd needs a newer glibc), there is no mock API, and `vite preview` serves
// the SPA without one — so every layout decision for this surface was being made
// blind while the same decisions on the panel were checked against screenshots.
//
// This borrows the panel audit's trick instead of a server: Playwright intercepts
// every request, serves the BUILT bundle out of ../public/ for the SPA's own paths,
// and answers /api/* from the table below. NO LISTENER IS OPENED — the standing rule
// on this box is that nothing outside 127.0.0.1 may listen, and this opens nothing
// at all.
//
// The stub data is deliberately ordinary rather than minimal: a view that only ever
// renders its empty state is not the view anyone is judging.
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "..", "public"); // gateway/public (the built assets)
const TAG = process.argv[2] || "before";
const OUT = `/tmp/console-shot/${TAG}`;
const ORIGIN = "https://ai.saisi.online";
const VIEWS = ["", "keys", "routes", "models", "users", "devices"];
const THEMES = ["light", "dark"];
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon" };

const now = Date.now();
const API = {
  "/api/me": { username: "admin", role: "admin", token: "tok-a1b2c3d4", keys: {} },
  "/api/health": {
    channels: [
      { id: "og", ok: true, model: "og/deepseek-v4.1-flash" },
      { id: "or", ok: true, model: "or/z-ai/glm-5.2:free" },
      { id: "nv", ok: true, model: "nv/nvidia/nemotron-3-ultra-550b-a55b" },
      { id: "gmi", ok: false, model: "gmi/MiniMaxAI/MiniMax-M3" },
      { id: "cm", ok: true, model: "cm/deepseek/deepseek-v4.1-flash" },
    ],
    recommended: { channel: "cm", model: "cm/deepseek/deepseek-v4.1-flash" },
  },
  "/api/me/route": { model: "cm/deepseek/deepseek-v4.1-flash", effective: "cm/deepseek/deepseek-v4.1-flash" },
  "/api/me/usproxy": { enabled: false },
  "/api/me/keys/usage": { configured: 4, total: 8, keys: [] },
  "/api/admin/models": { custom: ["cm/meituan/LongCat-2.0:free"], disabled: ["og/muse-spark-1.3-contributor"] },
  "/api/admin/public": {
    // `models` is the authoritative prefixed catalogue — the view needs it to render
    // anything at all, and the first stub omitted it, which made the Models page show
    // its "could not read the catalogue" arm instead of the screen being judged.
    models: [
      "og/deepseek-v4.1-flash",
      "og/gpt-5.6-luna",
      "or/z-ai/glm-5.2:free",
      "or/nvidia/nemotron-3-ultra-550b-a55b:free",
      "nv/nvidia/nemotron-3-ultra-550b-a55b",
      "gmi/MiniMaxAI/MiniMax-M3",
      "cm/deepseek/deepseek-v4.1-flash",
      "cm/meituan/LongCat-2.0:free",
    ],
    apiHost: "api.saisi.online",
    routes: [
      { prefix: "og/", backend: "OpenCode Go", desc: "Primary lane", models: ["og/deepseek-v4.1-flash", "og/gpt-5.6-luna"] },
      { prefix: "or/", backend: "OpenRouter", desc: "BYOK relay", models: ["or/z-ai/glm-5.2:free"] },
      { prefix: "cm/", backend: "Command Code", desc: "Fallback", models: ["cm/deepseek/deepseek-v4.1-flash"] },
    ],
  },
  "/api/admin/password": { set: true },
  "/api/admin/cloudflare-token": { configured: true, masked: "cf-••••••••3f9a" },
  "/api/admin/users": {
    users: [
      { id: "u1", username: "admin", role: "admin", enabled: true, keys: 4, createdAt: now - 86400000 * 30 },
      { id: "u2", username: "silas", role: "user", enabled: true, keys: 2, createdAt: now - 86400000 * 12 },
      { id: "u3", username: "guest", role: "user", enabled: false, keys: 0, createdAt: now - 86400000 * 3 },
    ],
  },
  "/api/devices": {
    devices: [
      { name: "d1", hostname: "d1.agent.saisi.online", token: "a1b2c3d4e5f6g7h8", registeredAt: now - 86400000 * 14, lastSeenAt: now - 45000, lastVersion: "1.2.361" },
      { name: "d2", hostname: "d2.agent.saisi.online", token: "z9y8x7w6v5u4t3s2", registeredAt: now - 86400000 * 6, lastSeenAt: now - 3600000 * 5, lastVersion: "1.2.340" },
      { name: "lab", hostname: "lab.agent.saisi.online", token: "q1w2e3r4t5y6u7i8", registeredAt: now - 86400000 * 2, lastVersion: "1.2.361" },
    ],
  },
  "/api/plugins/status": {
    devices: {
      d1: { online: true, agent_up: true, tunnel_up: true, version: "1.2.361", checked_at: now },
      d2: { online: false, agent_up: true, tunnel_up: false, version: "1.2.340", checked_at: now },
      lab: { online: false, agent_up: false, tunnel_up: false, version: "1.2.361", checked_at: now },
    },
  },
  "/api/devices/install-cmd": { ok: true, version: "1.2.361", download: "https://v.saisi.online/dl/vale-agent-1.2.361.tgz" },
  "/api/devices/register-keys": { keys: [{ code: "abcd1234", expiresAt: now + 3600000 }] },
  "/api/me/keys": { masked: "sk-••••••••••4f2a" },
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

let shots = 0;
for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname.startsWith("/api/")) {
      const body = API[url.pathname];
      // A stub the table does not know is answered with an empty object rather than
      // a 404: a 404 makes the view render its error arm, which is not the screen
      // being judged, and it would hide the real one behind a red banner.
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body ?? {}) });
    }
    const file = url.pathname === "/" ? "/index.html" : url.pathname;
    const fsPath = join(PUBLIC, file);
    if (existsSync(fsPath) && !file.includes(".."))
      return route.fulfill({ status: 200, contentType: MIME[extname(fsPath)] || "application/octet-stream", body: readFileSync(fsPath) });
    return route.fulfill({ status: 404, body: "not found" });
  });
  await page.addInitScript(
    ([t]) => {
      localStorage.setItem("valegate-theme", t);
      localStorage.setItem("valegate-lang", "en");
    },
    [theme],
  );
  for (const view of VIEWS) {
    await page.goto(`${ORIGIN}/#/${view}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${OUT}/${theme}-${view || "overview"}.png` });
    shots++;
  }
  await ctx.close();
}
await browser.close();
console.log(`console screenshots → ${OUT}/ (${shots} files)`);
