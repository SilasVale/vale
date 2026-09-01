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
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, MenuItemConstructorOptions, Notification } from "electron";
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
/** Whether the hide-to-tray notification has been shown (once per launch). */
let hideNotified = false;
const browserSessions = new Map<string, BrowserWindow>();
/** Initial target per browser window — reuse matching uses this instead of
 *  webContents.getURL() (which lags during navigation; stage-n). */
const browserTargets = new Map<string, string>();
/** Cap on concurrent browser-session windows — an AI loop opening sessions
 *  repeatedly must not pile up windows on the desktop (stage-n). */
const MAX_BROWSER_WINDOWS = 8;

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
// stage-n: commands issued before the SPA registered its vale-menu listener
// (preload bridge + React useEffect) are silently dropped by webContents.send.
// Queue them and flush shortly after did-finish-load; the SPA's listener is
// registered within a second of load completing (token connect + effect).
let menuQueue: string[] | null = [];  // null = SPA confirmed ready, send directly
let menuFlushTimer: NodeJS.Timeout | null = null;
function sendMenu(cmd: string): void {
  if (win && !win.isDestroyed()) {
    if (menuQueue) {
      menuQueue.push(cmd);          // SPA not yet confirmed ready — queue
    } else {
      win.webContents.send("vale-menu", cmd);
    }
  }
}
function flushMenuQueue(): void {
  if (menuFlushTimer) { clearTimeout(menuFlushTimer); menuFlushTimer = null; }
  if (!win || win.isDestroyed()) return;
  const q = menuQueue;
  menuQueue = null;                  // drain: subsequent sends go straight out
  if (q) {
    for (const cmd of q) {
      win.webContents.send("vale-menu", cmd);
    }
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
        { label: "Browser", accelerator: "CmdOrCtrl+Shift+G", click: () => sendMenu("open-browser") },
        { label: "Memory", accelerator: "CmdOrCtrl+Shift+M", click: () => sendMenu("open-memory") },
        { label: "Settings", accelerator: "CmdOrCtrl+Shift+," , click: () => sendMenu("open-settings") },
        { label: "Plugins", click: () => sendMenu("open-plugins") },
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
  // stage-n: reuse an existing window on the same URL instead of stacking
  // duplicates (AI-driven browsing opens/closes sessions repeatedly); focus
  // the existing window. Match against the window's INITIAL target (stored
  // at open) — webContents.getURL() lags during navigation (returns
  // about:blank while loading), so a same-URL reopen right after the first
  // open would otherwise miss the reuse and stack a duplicate.
  for (const [id, bw] of browserSessions) {
    if (!bw.isDestroyed() && browserTargets.get(id) === target) {
      if (bw.isMinimized()) bw.restore();
      bw.show();
      bw.focus();
      return { ok: true, id, url: target, cdp: `http://127.0.0.1:${CDP_PORT}` };
    }
  }
  // Window cap: at most MAX_BROWSER_WINDOWS; evict the oldest when exceeded
  // so an AI loop cannot pile up windows.
  if (browserSessions.size >= MAX_BROWSER_WINDOWS) {
    const oldest = browserSessions.keys().next().value as string | undefined;
    if (oldest) browserClose(oldest);
  }
  const id = `browser-${Date.now()}`;
  const bw = new BrowserWindow({ width: 1100, height: 750, title: `Vale Browser — ${target}` });
  bw.loadURL(target);
  bw.on("closed", () => { browserSessions.delete(id); browserTargets.delete(id); });
  // stage-n: the window title starts as "Vale Browser — <target>" but a
  // site's own <title> is more useful after load (and after in-page
  // navigation); follow it so window managers/taskbar show the real page.
  bw.webContents.on("page-title-updated", (_e, title) => {
    if (!bw.isDestroyed() && title) bw.setTitle(`Vale Browser — ${title}`);
  });
  browserSessions.set(id, bw);
  browserTargets.set(id, target);
  return { ok: true, id, url: target, cdp: `http://127.0.0.1:${CDP_PORT}` };
}
function browserClose(id?: string): { ok: true } {
  const bw = browserSessions.get(id || "");
  if (bw) { bw.close(); browserSessions.delete(id || ""); browserTargets.delete(id || ""); }
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
    // stage-n: the wait page now carries a "Start Agent" action — the
    // header comment promised it but it never existed. The button calls the
    // shell's own /api/shell/start-agent (schtasks /run ValeAgent — the
    // only sanctioned spawn path), then keeps polling until the agent is
    // up. This turns a dead-end white screen into a recoverable state when
    // the ValeAgent task is down (crash, stopped task, update mid-swap).
    const WAIT_HTML = `<!doctype html><meta charset="utf-8"><title>Vale</title>
      <style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}p{color:#999}button{margin-top:18px;padding:10px 22px;font-size:15px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;cursor:pointer}button:hover{background:#333}button:disabled{opacity:.5;cursor:default}</style>
      <div>
        <h2>Vale Agent is not running</h2>
        <p id="status">waiting for 127.0.0.1:18080…</p>
        <button id="start">Start Agent</button>
      </div>
      <script>
        const btn = document.getElementById("start");
        const st = document.getElementById("status");
        let busy = false;
        btn.addEventListener("click", async () => {
          if (busy) return;
          busy = true; btn.disabled = true;
          st.textContent = "starting ValeAgent task…";
          try {
            await fetch("http://127.0.0.1:9444/api/shell/start-agent", { method: "POST" });
            st.textContent = "started — waiting for the agent to come up…";
          } catch (e) {
            st.textContent = "start request failed (" + e + ") — the task may already be starting";
          }
          setTimeout(() => { busy = false; btn.disabled = false; }, 3000);
        });
      </script>`;
    const loadWaitPage = (): void => {
      win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(WAIT_HTML)}`).catch(() => {});
    };
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
        loadWaitPage();
        setTimeout(() => { loadDesktop(); }, nextRetry());
      }
    };
    // Retry loop: did-fail-load (agent went down mid-load) or a still-down
    // agent re-runs loadDesktop; each failure schedules exactly one retry.
    win.webContents.on("did-fail-load", () => { setTimeout(() => { loadDesktop(); }, nextRetry()); });
    // stage-n: once the SPA finished loading, give its React effect time to
    // register the vale-menu listener, then flush any queued menu commands.
    win.webContents.on("did-finish-load", () => {
      if (menuFlushTimer) clearTimeout(menuFlushTimer);
      menuFlushTimer = setTimeout(flushMenuQueue, 1000);
    });
    await loadDesktop();
    console.log(`[vale] CDP endpoint: http://127.0.0.1:${CDP_PORT} (playwright connectOverCDP)`);
    // stage-n: CDP self-check — if 9333 is occupied by another process
    // (a second browser/electron), remote-debugging-port silently fails and
    // AI driving would hit the WRONG target. Probe /json/version and verify
    // the User-Agent belongs to this app.
    (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) {
          const j = await r.json() as { "User-Agent"?: string };
          const ua = j["User-Agent"] || "";
          if (ua.includes("vale-desktop-electron")) {
            console.log(`[vale] CDP self-check OK: 127.0.0.1:${CDP_PORT} is this app`);
          } else {
            console.warn(`[vale] CDP WARNING: port ${CDP_PORT} answered by another browser (UA=${ua.slice(0, 60)}…) — AI driving may target the wrong process`);
          }
        } else {
          console.warn(`[vale] CDP WARNING: ${CDP_PORT} not responding — remote debugging may be off`);
        }
      } catch {
        console.warn(`[vale] CDP WARNING: could not reach ${CDP_PORT} — remote debugging may be off`);
      }
    })();
    win.on("close", (e) => {
      if (!(app as any).isQuitting) {
        e.preventDefault();
        win?.hide();
        // stage-n: first close hides to tray — tell the user once so they
        // don't think the app exited (a silent hide reads as 'closed').
        if (!hideNotified) {
          hideNotified = true;
          try {
            new Notification({ title: "Vale", body: "Vale is still running in the system tray." }).show();
          } catch { /* notifications unavailable — harmless */ }
        }
      }
    });
    const iconPath = path.join(__dirname, "..", "icon.png");
    tray = new Tray(fs.existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
    // stage-n: tray reflects live agent state — tooltip + a status line in
    // the menu, refreshed on a 30s poll and on demand (menu open re-checks).
    let trayAgentRunning = false;
    let trayAgentVersion = "";
    let trayAgentUptime = "";
    let trayAgentSessions = 0;
    /** "3m 24s" / "1h 5m" / "2d 3h" — compact uptime for the tray. */
    const fmtUptime = (secs: number): string => {
      if (secs < 60) return `${secs}s`;
      if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
      if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
      return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
    };
    const refreshTray = async (): Promise<void> => {
      const running = await portBusy(18080, 600);
      let version = trayAgentVersion;
      let uptime = trayAgentUptime;
      let sessions = trayAgentSessions;
      if (running) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 2500);
          const r = await fetch(`${BASE}/api/status`, { signal: ctrl.signal });
          clearTimeout(t);
          if (r.ok) {
            const j = await r.json() as { version?: string; uptime_secs?: number; live_sessions?: number };
            if (j.version) version = j.version;
            if (typeof j.uptime_secs === "number") uptime = fmtUptime(j.uptime_secs);
            if (typeof j.live_sessions === "number") sessions = j.live_sessions;
          }
        } catch { /* keep last */ }
      }
      trayAgentRunning = running;
      trayAgentVersion = version;
      trayAgentUptime = uptime;
      trayAgentSessions = sessions;
      const health = running
        ? `Agent running (v${version || "?"}${uptime ? `, up ${uptime}` : ""}${sessions ? `, ${sessions} session${sessions === 1 ? "" : "s"}` : ""})`
        : "Agent stopped";
      tray!.setToolTip(`Vale — ${health}`);
      tray!.setContextMenu(Menu.buildFromTemplate([
        { label: "Open", click: () => { focusMain(); } },
        { type: "separator" },
        { label: health, enabled: false },
        { type: "separator" },
        { label: "New Terminal", click: () => { focusMain(); sendMenu("new-pty"); } },
        { label: "New SSH…", click: () => { focusMain(); sendMenu("new-ssh"); } },
        { label: "New Serial…", click: () => { focusMain(); sendMenu("new-serial"); } },
        { label: "New Browser…", click: () => { focusMain(); sendMenu("new-browser"); } },
        { type: "separator" },
        { label: "Quit", click: () => { (app as any).isQuitting = true; app.quit(); } },
      ]));
    };
    refreshTray();
    setInterval(() => { refreshTray(); }, 30000);
  });
}

app.on("before-quit", () => {
  (app as any).isQuitting = true;
  // stage-n: close every browser-session window explicitly — app.quit()
  // tears down the main window but independent BrowserWindows with pending
  // beforeunload handlers can stall or leak on exit.
  for (const [id, bw] of browserSessions) {
    if (!bw.isDestroyed()) bw.destroy();
    browserSessions.delete(id);
    browserTargets.delete(id);
  }
});
