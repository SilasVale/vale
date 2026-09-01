"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
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
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const net = __importStar(require("net"));
const BASE = "http://127.0.0.1:18080";
// P1: CDP port for AI (playwright) to drive Vale's own pages — the SAME
// Electron window the user watches. Vale's playwright-mcp connects via
// connectOverCDP("http://127.0.0.1:9333") and drives this window's pages.
const CDP_PORT = 9333;
// P1b: fallback local control endpoint for browser sessions (used when the
// SPA runs in a plain browser, not under the Electron preload IPC).
const CTRL_PORT = 9444;
let win = null;
let tray = null;
const browserSessions = new Map();
/** Initial target per browser window — reuse matching uses this instead of
 *  webContents.getURL() (which lags during navigation; stage-n). */
const browserTargets = new Map();
/** Cap on concurrent browser-session windows — an AI loop opening sessions
 *  repeatedly must not pile up windows on the desktop (stage-n). */
const MAX_BROWSER_WINDOWS = 8;
// stage-m: SINGLE-INSTANCE LOCK — a second Vale window exits immediately.
// (The agent itself also enforces single-instance via bind-failure exit.)
const gotTheLock = electron_1.app.requestSingleInstanceLock();
if (!gotTheLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on("second-instance", () => { focusMain(); });
}
// CDP must be enabled before app ready — pass it through Chromium switches.
electron_1.app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
// --- Menu command bridge: SPA ⇄ native menu ---
// stage-n: commands issued before the SPA registered its vale-menu listener
// (preload bridge + React useEffect) are silently dropped by webContents.send.
// Queue them and flush shortly after did-finish-load; the SPA's listener is
// registered within a second of load completing (token connect + effect).
let menuQueue = []; // null = SPA confirmed ready, send directly
let menuFlushTimer = null;
function sendMenu(cmd) {
    if (win && !win.isDestroyed()) {
        if (menuQueue) {
            menuQueue.push(cmd); // SPA not yet confirmed ready — queue
        }
        else {
            win.webContents.send("vale-menu", cmd);
        }
    }
}
function flushMenuQueue() {
    if (menuFlushTimer) {
        clearTimeout(menuFlushTimer);
        menuFlushTimer = null;
    }
    if (!win || win.isDestroyed())
        return;
    const q = menuQueue;
    menuQueue = null; // drain: subsequent sends go straight out
    if (q) {
        for (const cmd of q) {
            win.webContents.send("vale-menu", cmd);
        }
    }
}
function focusMain() {
    if (!win || win.isDestroyed())
        return;
    if (win.isMinimized())
        win.restore();
    win.show();
    win.focus();
}
/** Build the native application menu. Items that act on the SPA's state send
 *  `vale-menu` commands; pure-window items use Electron roles. */
function buildMenu() {
    const isMac = process.platform === "darwin";
    const template = [
        ...(isMac ? [{
                label: electron_1.app.name,
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
        {
            label: "View",
            submenu: [
                { label: "Toggle Trajectory", accelerator: "CmdOrCtrl+Shift+Y", click: () => sendMenu("toggle-trajectory") },
                { type: "separator" },
                { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => { if (win)
                        win.webContents.reload(); } },
                { role: "togglefullscreen" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { label: "Toggle Theme", accelerator: "CmdOrCtrl+Shift+D", click: () => sendMenu("toggle-theme") },
                { role: "toggleDevTools" },
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
                { role: "minimize" },
                { role: "zoom" },
                ...(isMac ? [
                    { type: "separator" },
                    { role: "front" },
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
    return electron_1.Menu.buildFromTemplate(template);
}
// --- Browser-session control: shared core (used by both IPC and HTTP) ---
/** Only http/https/about:blank targets are allowed — file:// and other
 *  schemes would hand the AI a local-file read primitive via the shared
 *  CDP endpoint (stage-n hardening). */
function sanitizeBrowserUrl(url) {
    const t = (url || "about:blank").trim();
    if (t === "about:blank")
        return t;
    try {
        const u = new URL(t);
        if (u.protocol === "http:" || u.protocol === "https:")
            return u.toString();
    }
    catch { /* fall through */ }
    return "about:blank";
}
function browserOpen(url) {
    const target = sanitizeBrowserUrl(url);
    // stage-n: reuse an existing window on the same URL instead of stacking
    // duplicates (AI-driven browsing opens/closes sessions repeatedly); focus
    // the existing window. Match against the window's INITIAL target (stored
    // at open) — webContents.getURL() lags during navigation (returns
    // about:blank while loading), so a same-URL reopen right after the first
    // open would otherwise miss the reuse and stack a duplicate.
    for (const [id, bw] of browserSessions) {
        if (!bw.isDestroyed() && browserTargets.get(id) === target) {
            if (bw.isMinimized())
                bw.restore();
            bw.show();
            bw.focus();
            return { ok: true, id, url: target, cdp: `http://127.0.0.1:${CDP_PORT}` };
        }
    }
    // Window cap: at most MAX_BROWSER_WINDOWS; evict the oldest when exceeded
    // so an AI loop cannot pile up windows.
    if (browserSessions.size >= MAX_BROWSER_WINDOWS) {
        const oldest = browserSessions.keys().next().value;
        if (oldest)
            browserClose(oldest);
    }
    const id = `browser-${Date.now()}`;
    const bw = new electron_1.BrowserWindow({ width: 1100, height: 750, title: `Vale Browser — ${target}` });
    bw.loadURL(target);
    bw.on("closed", () => { browserSessions.delete(id); browserTargets.delete(id); });
    browserSessions.set(id, bw);
    browserTargets.set(id, target);
    return { ok: true, id, url: target, cdp: `http://127.0.0.1:${CDP_PORT}` };
}
function browserClose(id) {
    const bw = browserSessions.get(id || "");
    if (bw) {
        bw.close();
        browserSessions.delete(id || "");
        browserTargets.delete(id || "");
    }
    return { ok: true };
}
function browserList() {
    const list = [...browserSessions.entries()].map(([id, bw]) => ({ id, url: bw.webContents.getURL() }));
    return { ok: true, sessions: list, cdp: `http://127.0.0.1:${CDP_PORT}` };
}
electron_1.ipcMain.handle("browser-session:open", (_e, url) => browserOpen(url));
electron_1.ipcMain.handle("browser-session:close", (_e, id) => browserClose(id));
electron_1.ipcMain.handle("browser-session:list", () => browserList());
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
function autoLaunchTaskExists() {
    try {
        (0, child_process_1.execSync)(`schtasks /query /tn "${AUTOSTART_TASK}"`, { stdio: "pipe", windowsHide: true });
        return true;
    }
    catch {
        return false;
    }
}
function autoLaunchTaskSet(enabled) {
    try {
        if (enabled && !autoLaunchTaskExists()) {
            (0, child_process_1.execSync)(`schtasks /create /tn "${AUTOSTART_TASK}" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File \\"${AUTOSTART_SCRIPT}\\"" /sc onlogon /f`, { stdio: "pipe", windowsHide: true });
        }
        else if (!enabled && autoLaunchTaskExists()) {
            (0, child_process_1.execSync)(`schtasks /delete /tn "${AUTOSTART_TASK}" /f`, { stdio: "pipe", windowsHide: true });
        }
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: String(e) };
    }
}
electron_1.ipcMain.handle("desktop:get-auto-launch", () => ({ enabled: autoLaunchTaskExists() }));
electron_1.ipcMain.handle("desktop:set-auto-launch", (_e, enabled) => autoLaunchTaskSet(!!enabled));
// --- Agent lifecycle (stage-m: Rust owns it; the shell only probes/triggers) ---
/** True if ANY process is listening on 127.0.0.1:18080 (TCP probe). */
function portBusy(port, timeoutMs = 1000) {
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
function startAgentTask() {
    try {
        (0, child_process_1.execSync)('schtasks /run /tn "ValeAgent"', { stdio: "pipe", windowsHide: true });
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: String(e) };
    }
}
// The SPA asks the shell for agent status / to (re)start the agent task.
electron_1.ipcMain.handle("shell:agent-status", async () => ({ running: await portBusy(18080) }));
electron_1.ipcMain.handle("shell:start-agent", () => startAgentTask());
// Fallback HTTP path (plain browser / no preload): same core, CORS-open.
const httpServer = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const send = (obj, code = 200) => {
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type, authorization");
        res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(obj));
    };
    if (req.method === "OPTIONS")
        return send({ ok: true });
    try {
        if (u.pathname === "/api/browser-session/open" && req.method === "POST")
            return send(browserOpen(u.searchParams.get("url") || "about:blank"));
        if (u.pathname === "/api/browser-session/close" && req.method === "POST")
            return send(browserClose(u.searchParams.get("id") || ""));
        if (u.pathname === "/api/browser-session/list")
            return send(browserList());
        if (u.pathname === "/api/shell/start-agent" && req.method === "POST")
            return send(startAgentTask());
        if (u.pathname === "/api/shell/agent-status")
            return (async () => send({ ok: true, running: await portBusy(18080) }))();
        send({ ok: false, error: "not found" }, 404);
    }
    catch (e) {
        send({ ok: false, error: String(e) }, 500);
    }
});
if (gotTheLock) {
    electron_1.app.whenReady().then(async () => {
        httpServer.listen(CTRL_PORT, "127.0.0.1");
        console.log(`[vale] browser-session control: http://127.0.0.1:${CTRL_PORT}`);
        // Native application menu (stage-l): menu commands → SPA via vale-menu.
        electron_1.Menu.setApplicationMenu(buildMenu());
        win = new electron_1.BrowserWindow({
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
        const agentReady = async () => portBusy(18080, 800);
        const WAIT_HTML = `<!doctype html><meta charset="utf-8"><title>Vale</title>
      <style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}p{color:#999}</style>
      <div><h2>Starting Vale Agent…</h2><p>waiting for 127.0.0.1:18080</p></div>`;
        let retryMs = 2000;
        const nextRetry = () => { retryMs = Math.min(retryMs * 2, 30000); return retryMs; };
        const resetRetry = () => { retryMs = 2000; };
        /** Window title carries the agent version for at-a-glance diagnosis:
         *  "Vale — v1.0.145". Falls back to "Vale" when the agent is unreachable. */
        const setVersionTitle = async () => {
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 3000);
                const r = await fetch(`${BASE}/api/status`, { signal: ctrl.signal });
                clearTimeout(t);
                if (r.ok) {
                    const j = await r.json();
                    if (j.version)
                        win?.setTitle(`Vale — v${j.version}`);
                }
            }
            catch { /* agent down — keep default title */ }
        };
        const loadDesktop = async () => {
            if (await agentReady()) {
                resetRetry();
                setVersionTitle();
                win?.loadURL(`${BASE}/desktop/`).catch(() => { });
            }
            else {
                win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(WAIT_HTML)}`).catch(() => { });
                setTimeout(() => { loadDesktop(); }, nextRetry());
            }
        };
        // Retry loop: did-fail-load (agent went down mid-load) or a still-down
        // agent re-runs loadDesktop; each failure schedules exactly one retry.
        win.webContents.on("did-fail-load", () => { setTimeout(() => { loadDesktop(); }, nextRetry()); });
        // stage-n: once the SPA finished loading, give its React effect time to
        // register the vale-menu listener, then flush any queued menu commands.
        win.webContents.on("did-finish-load", () => {
            if (menuFlushTimer)
                clearTimeout(menuFlushTimer);
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
                    const j = await r.json();
                    const ua = j["User-Agent"] || "";
                    if (ua.includes("vale-desktop-electron")) {
                        console.log(`[vale] CDP self-check OK: 127.0.0.1:${CDP_PORT} is this app`);
                    }
                    else {
                        console.warn(`[vale] CDP WARNING: port ${CDP_PORT} answered by another browser (UA=${ua.slice(0, 60)}…) — AI driving may target the wrong process`);
                    }
                }
                else {
                    console.warn(`[vale] CDP WARNING: ${CDP_PORT} not responding — remote debugging may be off`);
                }
            }
            catch {
                console.warn(`[vale] CDP WARNING: could not reach ${CDP_PORT} — remote debugging may be off`);
            }
        })();
        win.on("close", (e) => { if (!electron_1.app.isQuitting) {
            e.preventDefault();
            win?.hide();
        } });
        const iconPath = path.join(__dirname, "..", "icon.png");
        tray = new electron_1.Tray(fs.existsSync(iconPath) ? iconPath : electron_1.nativeImage.createEmpty());
        tray.setToolTip("Vale");
        tray.setContextMenu(electron_1.Menu.buildFromTemplate([
            { label: "Open", click: () => { focusMain(); } },
            { type: "separator" },
            { label: "New Terminal", click: () => { focusMain(); sendMenu("new-pty"); } },
            { label: "New SSH…", click: () => { focusMain(); sendMenu("new-ssh"); } },
            { label: "New Serial…", click: () => { focusMain(); sendMenu("new-serial"); } },
            { label: "New Browser…", click: () => { focusMain(); sendMenu("new-browser"); } },
            { type: "separator" },
            { label: "Quit", click: () => { electron_1.app.isQuitting = true; electron_1.app.quit(); } },
        ]));
    });
}
electron_1.app.on("before-quit", () => { electron_1.app.isQuitting = true; });
