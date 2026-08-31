// Vale Desktop — Electron shell over the local vale-agent service.
// UI = agent /desktop/ route (panel-react SPA); agent = child process.
//
// Desktop-app experience (stage-l refactor):
// - Native application menu (File/Edit/View/Session/Help) with accelerators.
//   Menu items send `vale-menu` events to the SPA via webContents.send —
//   the SPA maps them to its actions (new PTY/SSH/serial/browser, close /
//   next / prev session, export, theme flip, toggle trajectory).
// - Browser-session windows (playwright drives them via CDP :9333).
// - Auto-launch via the ValeDesktop scheduled task.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut } = require("electron");
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
// P1b: fallback local control endpoint for browser sessions (used when the
// SPA runs in a plain browser, not under the Electron preload IPC).
const CTRL_PORT = 9444;
let win = null, tray = null, agent = null;
const browserSessions = new Map(); // id -> BrowserWindow

// CDP must be enabled before app ready — pass it through Chromium switches.
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));

// --- Menu command bridge: SPA ⇄ native menu ---
// Menu items fire `sendMenu(cmd)`; the SPA listens on
// `window.valeDesktop.onCommand(cmd => …)` (preload → contextBridge).
function sendMenu(cmd) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("vale-menu", cmd);
  }
}
// Window-focus helpers used by menu roles.
function focusMain() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Build the native application menu. Items that act on the SPA's state send
 *  `vale-menu` commands; pure-window items use Electron roles. */
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    // ── App (macOS) ────────────────────────────────────────────
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    // ── File ───────────────────────────────────────────────────
    {
      label: "File",
      submenu: [
        { label: "New Terminal", accelerator: "CmdOrCtrl+Shift+T", click: () => sendMenu("new-pty") },
        { label: "New SSH Connection…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendMenu("new-ssh") },
        { label: "New Serial Connection…", accelerator: "CmdOrCtrl+Shift+P", click: () => sendMenu("new-serial") },
        { label: "New Browser Session…", accelerator: "CmdOrCtrl+Shift+B", click: () => sendMenu("new-browser") },
        { type: "separator" },
        { label: "Close Session", accelerator: "CmdOrCtrl+W", click: () => sendMenu("close-session") },
        { label: "Close Window", accelerator: isMac ? "Cmd+Shift+W" : "Alt+F4", role: "close" },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit", label: "Exit" },
      ],
    },
    // ── Edit ───────────────────────────────────────────────────
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    // ── View ───────────────────────────────────────────────────
    {
      label: "View",
      submenu: [
        { label: "Toggle Trajectory", accelerator: "CmdOrCtrl+Shift+Y", click: () => sendMenu("toggle-trajectory") },
        { type: "separator" },
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => { if (win) win.webContents.reload(); } },
        { role: "togglefullscreen" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { label: "Toggle Theme", accelerator: "CmdOrCtrl+Shift+D", click: () => sendMenu("toggle-theme") },
        { role: "toggleDevTools" },
      ],
    },
    // ── Session ────────────────────────────────────────────────
    {
      label: "Session",
      submenu: [
        { label: "Next Session", accelerator: "Ctrl+Tab", click: () => sendMenu("next-session") },
        { label: "Previous Session", accelerator: "Ctrl+Shift+Tab", click: () => sendMenu("prev-session") },
        { type: "separator" },
        { label: "Export Session Log…", accelerator: "CmdOrCtrl+Shift+E", click: () => sendMenu("export-session") },
        { type: "separator" },
        { label: "List Sessions", accelerator: "CmdOrCtrl+Shift+L", click: () => sendMenu("list-sessions") },
      ],
    },
    // ── Window ─────────────────────────────────────────────────
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [
          { type: "separator" },
          { role: "front" },
        ] : []),
      ],
    },
    // ── Help ───────────────────────────────────────────────────
    {
      role: "help",
      submenu: [
        { label: "Vale Agent Status", click: () => { focusMain(); sendMenu("show-status"); } },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// --- Browser-session control: shared core (used by both IPC and HTTP) ---
function browserOpen(url) {
  const target = url || "about:blank";
  const id = `browser-${Date.now()}`;
  const bw = new BrowserWindow({ width: 1100, height: 750, title: `Vale Browser — ${target}` });
  bw.loadURL(target);
  bw.on("closed", () => browserSessions.delete(id));
  browserSessions.set(id, bw);
  return { ok: true, id, url: target, cdp: `http://127.0.0.1:${CDP_PORT}` };
}
function browserClose(id) {
  const bw = browserSessions.get(id || "");
  if (bw) { bw.close(); browserSessions.delete(id); }
  return { ok: true };
}
function browserList() {
  const list = [...browserSessions.entries()].map(([id, bw]) => ({ id, url: bw.webContents.getURL() }));
  return { ok: true, sessions: list, cdp: `http://127.0.0.1:${CDP_PORT}` };
}

// Electron-native path: the SPA calls window.valeBrowser.* (preload bridge).
ipcMain.handle("browser-session:open", (_e, url) => browserOpen(url));
ipcMain.handle("browser-session:close", (_e, id) => browserClose(id));
ipcMain.handle("browser-session:list", () => browserList());

// Desktop-app settings (auto-launch) — the Settings page toggles this. We
// manage a per-user scheduled task ("ValeDesktop", onlogon) instead of
// Electron's setLoginItemSettings: in dev mode (electron .) the login-item
// API is unreliable, while schtasks works for the current user without
// elevation. The task runs start-desktop.ps1 (non-elevated → clickable).
const AUTOSTART_TASK = "ValeDesktop";
// The app dir is the cwd when launched as `electron .`; the start script
// lives one level up (next to the vale-desktop-electron folder, e.g.
// D:\Vale\start-desktop.ps1 — created by the shell's setup path).
const AUTOSTART_SCRIPT = path.join(process.cwd(), "..", "start-desktop.ps1");
function autoLaunchTaskExists() {
  try {
    const { execSync } = require("child_process");
    execSync(`schtasks /query /tn "${AUTOSTART_TASK}"`, { stdio: "pipe", windowsHide: true });
    return true;
  } catch { return false; }
}
function autoLaunchTaskSet(enabled) {
  const { execSync } = require("child_process");
  if (enabled) {
    execSync(`schtasks /create /tn "${AUTOSTART_TASK}" /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\"${AUTOSTART_SCRIPT}\\"" /sc onlogon /ru ${process.env.USERNAME} /f`, { stdio: "pipe", windowsHide: true });
  } else {
    execSync(`schtasks /delete /tn "${AUTOSTART_TASK}" /f`, { stdio: "pipe", windowsHide: true });
  }
}
ipcMain.handle("desktop:get-auto-launch", () => {
  try { return { ok: true, enabled: autoLaunchTaskExists() }; }
  catch (e) { return { ok: false, error: String(e) }; }
});
ipcMain.handle("desktop:set-auto-launch", (_e, enabled) => {
  try {
    autoLaunchTaskSet(!!enabled);
    return { ok: true, enabled: !!enabled };
  } catch (e) { return { ok: false, error: String(e) }; }
});

// Fallback HTTP path (plain browser / no preload): same core, CORS-open.
const httpServer = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const send = (obj, code = 200) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "OPTIONS") return send({ ok: true });
  try {
    if (u.pathname === "/api/browser-session/open" && req.method === "POST") return send(browserOpen(u.searchParams.get("url") || "about:blank"));
    if (u.pathname === "/api/browser-session/close" && req.method === "POST") return send(browserClose(u.searchParams.get("id") || ""));
    if (u.pathname === "/api/browser-session/list") return send(browserList());
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

  // Native application menu (stage-l): menu commands → SPA via vale-menu.
  Menu.setApplicationMenu(buildMenu());

  win = new BrowserWindow({
    width: 1200, height: 800, title: "Vale",
    webPreferences: {
      // preload exposes window.valeBrowser.* to the SPA (Electron-native
      // browser-session control — no HTTP/CORS involved).
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`${BASE}/desktop/`);
  // P1: report the CDP endpoint so AI clients (playwright-mcp) can attach:
  // connectOverCDP("http://127.0.0.1:9333") → drives THIS window's pages.
  console.log(`[vale] CDP endpoint: http://127.0.0.1:${CDP_PORT} (playwright connectOverCDP)`);
  win.on("close", (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  const iconPath = path.join(__dirname, "..", "icon.png");
  tray = new Tray(fs.existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
  tray.setToolTip("Vale");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open", click: () => { focusMain(); } },
    { type: "separator" },
    { label: "New Terminal", click: () => { focusMain(); sendMenu("new-pty"); } },
    { label: "New SSH…", click: () => { focusMain(); sendMenu("new-ssh"); } },
    { label: "New Serial…", click: () => { focusMain(); sendMenu("new-serial"); } },
    { label: "New Browser…", click: () => { focusMain(); sendMenu("new-browser"); } },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
});

app.on("before-quit", () => { app.isQuitting = true; try { agent?.kill(); } catch {} });
