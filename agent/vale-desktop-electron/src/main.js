// Vale Desktop P0 — Electron shell over the local vale-agent service.
// UI = agent /desktop/ route (panel-react SPA); agent = child process.
const { app, BrowserWindow, Tray, Menu, nativeImage } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const BASE = "http://127.0.0.1:18080";
let win = null, tray = null, agent = null;

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

async function startAgent() {
  if (agent && !agent.killed) return;
  // If the agent service is ALREADY serving on 18080 (e.g. the ValeAgent
  // scheduled task), don't spawn a second one (port bind fails, os 10048).
  const already = await waitReady(2000);
  if (already) {
    console.log("[vale] agent already running on 18080 — skipping spawn");
    return;
  }
  const exe = agentExe();
  console.log(`[vale] agent: ${exe}`);
  agent = spawn(exe, ["--config", path.join(process.cwd(), "config.yaml")], { windowsHide: true });
  agent.stderr?.on("data", (d) => process.stderr.write(`[agent] ${d}`));
  agent.on("exit", () => { agent = null; setTimeout(startAgent, 3000); });
  await waitReady(30000);
}

app.whenReady().then(async () => {
  await startAgent();
  win = new BrowserWindow({ width: 1200, height: 800, title: "Vale" });
  win.loadURL(`${BASE}/desktop/`);
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
