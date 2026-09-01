// Vale Desktop — Electron shell over the local vale-agent service (TS).
// UI = agent /desktop/ route (panel-react SPA); agent = child process.
//
// stage-m architecture: agent lifecycle lives in RUST (the agent is managed
// by the ValeAgent scheduled task; a second agent instance exits immediately
// via VALE_NO_PAUSE on bind failure — no orphan processes). This shell only:
//   1. probes 127.0.0.1:18080 (agent health)
//   2. loads the SPA when the agent is up; shows a "start agent" action
//      otherwise (schtasks /run — the ONLY sanctioned spawn path)
//   3. window / tray / native menu / CDP exposure / browser sessions
// No spawn() of vale-agent.exe from JS — that was the d1 Chrome-OOM root
// cause (a bind-failed child wedged on "Press Enter to exit" forever).
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, MenuItemConstructorOptions } from "electron";
import { execSync, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";

const BASE = "http://127.0.0.1:18080";
// P1: CDP port for AI (playwright) to drive Vale's own pages — the SAME
// Electron window the user watches. Vale's playwright-mcp connects via
// connectOverCDP("http://127.0.0.1:9333") and drives this window's pages.
const CDP_PORT = 9333;
// P1b: fallback local control endpoint for browser sessions (used when the
// SPA runs in a plain browser, not under the Electron preload IPC).
const CTRL_PORT = 9444;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
const browserSessions = new Map<string, BrowserWindow>();

// stage-m: SINGLE-INSTANCE LOCK — a second Vale window exits immediately.
// (The agent itself also enforces single-instance via bind-failure exit.)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => { focusMain(); });
}

// CDP must be enabled before app ready — pass it through Chromium switches.
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));

// --- Menu command bridge: SPA ⇄ native menu ---
function sendMenu(cmd: string): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send("vale-menu", cmd);
  }
}
function focusMain(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Build the native application menu. Items that act on the SPA's state send
 *  `vale-menu` commands; pure-window items use Electron roles. */
function buildMenu(): Menu {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" as const },
        { type: "separator" as const },
        { role: "hide" as const },
        { role: "hideOthers" as const },
        { role: "unhide" as const },
        { type: "separator" as const },
        { role: "quit" as const },
      ],
    }] : []),
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
        isMac ? { role: "close" as const } : { role: "quit", label: "Exit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle Trajectory", accelerator: "CmdOrCtrl+Shift+Y", click: () => sendMenu("toggle-trajectory") },
        { type: "separator" },
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => { if (win) win.webContents.reload(); } },
        { role: "togglefullscreen" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" },
        { label: "Toggle Theme", accelerator: "CmdOrCtrl+Shift+D", click: () => sendMenu("toggle-theme") },
        { role: "toggleDevTools" as const },
      ],
    },
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
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(isMac ? [
          { type: "separator" as const },
          { role: "front" as const },
        ] : []),
      ],
    },
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
/** Only http/https/about:blank targets are allowed — file:// and other
 *  schemes would hand the AI a local-file read primitive via the shared
 *  CDP endpoint (stage-n hardening). */
function sanitizeBrowserUrl(url?: string): string {
  const t = (url || "about:blank").trim();
  if (t === "about:blank") return t;
  try {
    const u = new URL(t);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch { /* fall through */ }
  return "about:blank";
}
function browserOpen(url?: string): { ok: true; id: string; url: string; cdp: string } {
  const target = sanitizeBrowserUrl(url);
  const id = `browser-${Date.now()}`;
  const bw = new BrowserWindow({ width: 1100, height: 750, title: `Vale Browser — ${target}` });
  bw.loadURL(target);
  bw.on("closed", () => browserSessions.delete(id));
  browserSessions.set(id, bw);
  return { ok: true, id, url: target, cdp: `http://127.0.0.1:${CDP_PORT}` };
}
function browserClose(id?: string): { ok: true } {
  const bw = browserSessions.get(id || "");
  if (bw) { bw.close(); browserSessions.delete(id || ""); }
  return { ok: true };
}
function browserList(): { ok: true; sessions: { id: string; url: string }[]; cdp: string } {
  const list = [...browserSessions.entries()].map(([id, bw]) => ({ id, url: bw.webContents.getURL() }));
  return { ok: true, sessions: list, cdp: `http://127.0.0.1:${CDP_PORT}` };
}

ipcMain.handle("browser-session:open", (_e, url: string) => browserOpen(url));
ipcMain.handle("browser-session:close", (_e, id: string) => browserClose(id));
ipcMain.handle("browser-session:list", () => browserList());

// Desktop-app settings (auto-launch) — the Settings page toggles this. We
// manage a per-user scheduled task ("ValeDesktop", onlogon) instead of
// Electron's setLoginItemSettings: in dev mode (electron .) the login-item
// API is unreliable, while schtasks works for the current user without
// elevation. The task runs start-desktop.ps1 (non-elevated → clickable).
const AUTOSTART_TASK = "ValeDesktop";
// Resolve the autostart script from __dirname (the compiled main.js location:
// <install>\vale-desktop-electron\src\) — process.cwd() depends on how the
// shell was launched and broke the toggle when electron started from another
// directory. The install root is two levels up from src/.
const AUTOSTART_SCRIPT = path.join(__dirname, "..", "..", "start-desktop.ps1");
function autoLaunchTaskExists(): boolean {
  try {
    execSync(`schtasks /query /tn "${AUTOSTART_TASK}"`, { stdio: "pipe", windowsHide: true });
    return true;
  } catch { return false; }
}
function autoLaunchTaskSet(enabled: boolean): { ok: boolean; error?: string } {
  try {
    if (enabled && !autoLaunchTaskExists()) {
      execSync(
        `schtasks /create /tn "${AUTOSTART_TASK}" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File \\"${AUTOSTART_SCRIPT}\\"" /sc onlogon /f`,
        { stdio: "pipe", windowsHide: true },
      );
    } else if (!enabled && autoLaunchTaskExists()) {
      execSync(`schtasks /delete /tn "${AUTOSTART_TASK}" /f`, { stdio: "pipe", windowsHide: true });
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

ipcMain.handle("desktop:get-auto-launch", () => ({ enabled: autoLaunchTaskExists() }));
ipcMain.handle("desktop:set-auto-launch", (_e, enabled: boolean) => autoLaunchTaskSet(!!enabled));

// --- Agent lifecycle (stage-m: Rust owns it; the shell only probes/triggers) ---
/** True if ANY process is listening on 127.0.0.1:18080 (TCP probe). */
function portBusy(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((res) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); res(true); });
    sock.on("error", () => res(false));
    sock.setTimeout(timeoutMs, () => { sock.destroy(); res(false); });
  });
}

/** Start the agent via the ValeAgent scheduled task — the ONLY sanctioned
 *  spawn path (the task runs the agent as SYSTEM; the agent itself enforces
 *  single-instance via VALE_NO_PAUSE bind-failure exit). Never spawn the exe
 *  directly from JS. */
function startAgentTask(): { ok: boolean; error?: string } {
  try {
    execSync('schtasks /run /tn "ValeAgent"', { stdio: "pipe", windowsHide: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// The SPA asks the shell for agent status / to (re)start the agent task.
ipcMain.handle("shell:agent-status", async () => ({ running: await portBusy(18080) }));
ipcMain.handle("shell:start-agent", () => startAgentTask());

// Fallback HTTP path (plain browser / no preload): same core, CORS-open.
const httpServer = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  const send = (obj: unknown, code = 200) => {
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
    if (u.pathname === "/api/shell/start-agent" && req.method === "POST") return send(startAgentTask());
    if (u.pathname === "/api/shell/agent-status") return (async () => send({ ok: true, running: await portBusy(18080) }))();
    send({ ok: false, error: "not found" }, 404);
  } catch (e) {
    send({ ok: false, error: String(e) }, 500);
  }
});

if (gotTheLock) {
  app.whenReady().then(async () => {
    httpServer.listen(CTRL_PORT, "127.0.0.1");
    console.log(`[vale] browser-session control: http://127.0.0.1:${CTRL_PORT}`);

    // Native application menu (stage-l): menu commands → SPA via vale-menu.
    Menu.setApplicationMenu(buildMenu());

    win = new BrowserWindow({
      width: 1200, height: 800, title: "Vale",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // stage-n: load /desktop/ only when the agent is actually listening.
    // A blind loadURL fails white-screen when the ValeAgent task is down
    // (startup race, crash, update mid-swap); poll 18080 and retry with
    // exponential backoff (2s → 4s → 8s → 30s cap) so a dead agent doesn't
    // spam retries.
    const agentReady = async (): Promise<boolean> => portBusy(18080, 800);
    const WAIT_HTML = `<!doctype html><meta charset="utf-8"><title>Vale</title>
      <style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}p{color:#999}</style>
      <div><h2>Starting Vale Agent…</h2><p>waiting for 127.0.0.1:18080</p></div>`;
    let retryMs = 2000;
    const nextRetry = (): number => { retryMs = Math.min(retryMs * 2, 30000); return retryMs; };
    const resetRetry = (): void => { retryMs = 2000; };
    /** Window title carries the agent version for at-a-glance diagnosis:
     *  "Vale — v1.0.145". Falls back to "Vale" when the agent is unreachable. */
    const setVersionTitle = async (): Promise<void> => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(`${BASE}/api/status`, { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) {
          const j = await r.json() as { version?: string };
          if (j.version) win?.setTitle(`Vale — v${j.version}`);
        }
      } catch { /* agent down — keep default title */ }
    };
    const loadDesktop = async (): Promise<void> => {
      if (await agentReady()) {
        resetRetry();
        setVersionTitle();
        win?.loadURL(`${BASE}/desktop/`).catch(() => { /* did-fail-load retries below */ });
      } else {
        win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(WAIT_HTML)}`).catch(() => {});
        setTimeout(() => { loadDesktop(); }, nextRetry());
      }
    };
    // Retry loop: did-fail-load (agent went down mid-load) or a still-down
    // agent re-runs loadDesktop; each failure schedules exactly one retry.
    win.webContents.on("did-fail-load", () => { setTimeout(() => { loadDesktop(); }, nextRetry()); });
    await loadDesktop();
    console.log(`[vale] CDP endpoint: http://127.0.0.1:${CDP_PORT} (playwright connectOverCDP)`);
    win.on("close", (e) => { if (!(app as any).isQuitting) { e.preventDefault(); win?.hide(); } });
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
      { label: "Quit", click: () => { (app as any).isQuitting = true; app.quit(); } },
    ]));
  });
}

app.on("before-quit", () => { (app as any).isQuitting = true; });
