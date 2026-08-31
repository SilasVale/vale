// Vale Desktop P0 — Electron shell over the local vale-agent service.
// UI = agent /desktop/ route (panel-react SPA); agent = child process.
const { app, BrowserWindow, Tray, Menu, nativeImage } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");

const BASE = "http://127.0.0.1:18080";
// P1: CDP port for AI (playwright) to drive Vale's own pages — the SAME
// Electron window the user watches. Vale's playwright-mcp connects via
// connectOverCDP("http://127.0.0.1:9333") and drives this window's pages.
// 9333 avoids collisions with the agent's 9224 (bridge) / 9229 (runner).
const CDP_PORT = 9333;
// P1b: local control endpoint for browser sessions. The SPA (served by the
// agent on 18080) calls this to open/close browser-session windows; CDP 9333
// exposes them all to playwright.
const CTRL_PORT = 9444;
let win = null, tray = null, agent = null;
const browserSessions = new Map(); // id -> BrowserWindow

// CDP must be enabled before app ready — pass it through Chromium switches.
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));

// --- Browser-session control HTTP (127.0.0.1:9444) ---
const httpServer = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const send = (obj, code = 200) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  try {
    if (u.pathname === "/api/browser-session/open" && req.method === "POST") {
      const url = u.searchParams.get("url") || "about:blank";
      const id = `browser-${Date.now()}`;
      const bw = new BrowserWindow({ width: 1100, height: 750, title: `Vale Browser — ${url}` });
      bw.loadURL(url);
      bw.on("closed", () => browserSessions.delete(id));
      browserSessions.set(id, bw);
      return send({ ok: true, id, url, cdp: `http://127.0.0.1:${CDP_PORT}` });
    }
    if (u.pathname === "/api/browser-session/close" && req.method === "POST") {
      const id = u.searchParams.get("id") || "";
      const bw = browserSessions.get(id);
      if (bw) { bw.close(); browserSessions.delete(id); }
      return send({ ok: true });
    }
    if (u.pathname === "/api/browser-session/list") {
      const list = [...browserSessions.entries()].map(([id, bw]) => ({ id, url: bw.webContents.getURL() }));
      return send({ ok: true, sessions: list, cdp: `http://127.0.0.1:${CDP_PORT}` });
    }
    send({ ok: false, error: "not found" }, 404);
  } catch (e) {
    send({ ok: false, error: String(e) }, 500);
  }
});

function agentExe() {
  const cands = [];
  try {
    const { execSync } = require("child_process");
    const out = execSync('reg query "HKLM\\SOFTWARE\\Vale\\Agent" /v InstallDir', { encoding: "utf8" });
    const m = out.match(/InstallDir\s+REG_SZ\s+(.+)/);
    if (m) cands.push(path.join(m[1].trim(), "vale-agent.exe"));
  } catch {}
  cands.push(path.join(process.cwd(), "vale-agent.exe"));
  return cands.find(fs.existsSync) || cands[0] || "vale-agent.exe";
}

function waitReady(ms) {
  const dl = Date.now() + ms;
  return new Promise((res) => {
    const probe = () => {
      const r = http.get(`${BASE}/api/status`, (resp) => { resp.resume(); resp.statusCode === 200 ? res(true) : retry(); });
      r.on("error", retry); r.setTimeout(2000, () => { r.destroy(); retry(); });
      function retry() { Date.now() > dl ? res(false) : setTimeout(probe, 500); }
    };
    probe();
  });
}

/** True if ANY process is listening on 127.0.0.1:18080 (TCP probe). The
 *  agent service (scheduled task) binds it at boot; if anything listens we
 *  must NOT spawn a second agent (bind fails with os 10048 and the child
 *  retries forever, spamming the console). */
function portBusy(port, timeoutMs = 1000) {
  return new Promise((res) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); res(true); });
    sock.on("error", () => res(false));
    sock.setTimeout(timeoutMs, () => { sock.destroy(); res(false); });
  });
}

async function startAgent() {
  if (agent && !agent.killed) return;
  // TCP-level check beats an HTTP probe: the service may still be starting
  // (HTTP not answering yet) while the port is already bound — spawning in
  // that window fails with 10048. A bound port always means "someone owns
  // the agent here"; skip spawn.
  const busy = await portBusy(18080);
  console.log(`[vale] port 18080 ${busy ? "in use — agent service present, not spawning" : "free — spawning agent"}`);
  if (busy) return;
  const exe = agentExe();
  console.log(`[vale] agent: ${exe}`);
  agent = spawn(exe, ["--config", path.join(process.cwd(), "config.yaml")], { windowsHide: true });
  agent.stderr?.on("data", (d) => process.stderr.write(`[agent] ${d}`));
  agent.on("exit", () => { agent = null; setTimeout(startAgent, 3000); });
  await waitReady(30000);
}

app.whenReady().then(async () => {
  httpServer.listen(CTRL_PORT, "127.0.0.1");
  console.log(`[vale] browser-session control: http://127.0.0.1:${CTRL_PORT}`);
  await startAgent();
  win = new BrowserWindow({ width: 1200, height: 800, title: "Vale" });
  win.loadURL(`${BASE}/desktop/`);
  // P1: report the CDP endpoint so AI clients (playwright-mcp) can attach:
  // connectOverCDP("http://127.0.0.1:9333") → drives THIS window's pages.
  console.log(`[vale] CDP endpoint: http://127.0.0.1:${CDP_PORT} (playwright connectOverCDP)`);
  win.on("close", (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  const iconPath = path.join(__dirname, "..", "icon.png");
  tray = new Tray(fs.existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
  tray.setToolTip("Vale");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open", click: () => { win.show(); win.focus(); } },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
});

app.on("before-quit", () => { app.isQuitting = true; try { agent?.kill(); } catch {} });
