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
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const net = __importStar(require("net"));
// url-policy.ts (shipped alongside, staged by vale update): pure
// origin/URL predicates, unit-tested in test/url-policy.test.mjs.
const url_policy_1 = require("./url-policy");
// IPC audit #3: /api/status is TOKEN-GATED (same fact the watchdog fix cites);
// credential-less fetches got 401 -> version title + tray vitals were DEAD on
// every configured device. The shell runs as the interactive admin, and the
// config is now ACL-restricted to SYSTEM+Administrators (1.2.226) — reading
// the local device_token from it is exactly the trust that grants.
let _tokenCache = { at: 0, tok: null };
function agentToken() {
    if (Date.now() - _tokenCache.at < 60_000)
        return _tokenCache.tok;
    let tok = null;
    try {
        const raw = fs.readFileSync(path.join(__dirname, "..", "..", "config.yaml"), "utf8");
        const m = /device_token:\s*"?([0-9a-f]{16,})"?/.exec(raw);
        if (m)
            tok = m[1];
    }
    catch { /* no local config — vitals stay hidden, same as before */ }
    _tokenCache = { at: Date.now(), tok };
    return tok;
}
function authHeaders() {
    const t = agentToken();
    return t ? { authorization: `Bearer ${t}` } : {};
}
// Remote-verifiable icon facts (GET /api/shell/icon-status on the 9444
// loopback control server): file blind-flying on icon issues ended here —
// every surface records what it resolved so the console can read it back.
const iconReport = { platform: process.platform };
function statSize(p) {
    try {
        return fs.existsSync(p) ? fs.statSync(p).size : -1;
    }
    catch {
        return -1;
    }
}
// Brand icon for every native surface. Tray on Windows needs .ico;
// BrowserWindow takes .png on ALL platforms (Skia-decodes reliably —
// Chromium's ICO parser has choked on PNG-compressed 256px entries,
// silently falling back to the stock electron.exe icon, device-caught).
// Empty string when absent — callers fall back to Electron defaults.
function appIcon() {
    const name = process.platform === "win32" ? "icon.ico" : "icon.png";
    const p = path.join(__dirname, "..", name);
    let out = "";
    try {
        out = fs.existsSync(p) ? p : "";
    }
    catch {
        out = "";
    }
    iconReport["tray"] = { path: p, size: statSize(p), used: out !== "" };
    return out;
}
function windowIcon() {
    const p = path.join(__dirname, "..", "icon.png");
    let out = "";
    try {
        out = fs.existsSync(p) ? p : "";
    }
    catch {
        out = "";
    }
    iconReport["window"] = { path: p, size: statSize(p), used: out !== "" };
    return out;
}
// IPC audit #2: preload runs in EVERY frame; will-navigate never gated
// iframes. Handlers must reject anything not sourced from the pinned panel.
function frameOk(e) {
    return (0, url_policy_1.frameUrlOk)(e.senderFrame?.url || "");
}
// P1: CDP port for AI (playwright) to drive Vale's own pages — the SAME
// Electron window the user watches. Vale's playwright-mcp connects via
// connectOverCDP("http://127.0.0.1:9333") and drives this window's pages.
const CDP_PORT = 9333;
// P1b: fallback local control endpoint for browser sessions (used when the
// SPA runs in a plain browser, not under the Electron preload IPC).
const CTRL_PORT = 9444;
let win = null;
let tray = null;
/** Whether the hide-to-tray notification has been shown (once per launch). */
let hideNotified = false;
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
// round-274 (device-caught): when the window is hidden (hide-to-tray /
// SYSTEM-session background) Chromium flips the page to visibilityState
// "hidden" and STOPS requestAnimationFrame — xterm's rAF-driven DOM
// renderer then never paints, so every terminal goes blank while the AI
// keeps operating. backgroundThrottling:false alone does NOT restore rAF
// for hidden pages; these renderer-level switches do:
//   disable-renderer-backgrounding        — don't pause rAF/timers when the
//                                           renderer is backgrounded
//   disable-backgrounding-occluded-windows — same for occluded windows
electron_1.app.commandLine.appendSwitch("disable-renderer-backgrounding");
electron_1.app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
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
                { label: "Browser", accelerator: "CmdOrCtrl+Shift+G", click: () => sendMenu("open-browser") },
                { label: "Memory", accelerator: "CmdOrCtrl+Shift+M", click: () => sendMenu("open-memory") },
                { label: "Settings", accelerator: "CmdOrCtrl+Shift+,", click: () => sendMenu("open-settings") },
                { label: "Plugins", click: () => sendMenu("open-plugins") },
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
                // IPC audit #6: the "List Sessions" entry dispatched 'list-sessions',
                // a command with NO SPA-side handler — deleted (dead menu surface).
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
function browserOpen(url) {
    const target = (0, url_policy_1.sanitizeBrowserUrl)(url);
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
    const bw = new electron_1.BrowserWindow({
        width: 1100, height: 750, title: `Vale Browser — ${target}`,
        ...(windowIcon() ? { icon: windowIcon() } : {}),
        // review #6/#7: these windows load ARBITRARY internet pages. contextIsolation
        // on + nodeIntegration off + NO preload = zero Node/bridge surface (the
        // default; made explicit). Popups are denied (they would otherwise spawn
        // unmanaged windows outside the MAX_BROWSER_WINDOWS cap).
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    bw.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    bw.loadURL(target);
    bw.on("closed", () => { browserSessions.delete(id); browserTargets.delete(id); });
    // stage-n: the window title starts as "Vale Browser — <target>" but a
    // site's own <title> is more useful after load (and after in-page
    // navigation); follow it so window managers/taskbar show the real page.
    bw.webContents.on("page-title-updated", (_e, title) => {
        if (!bw.isDestroyed() && title)
            bw.setTitle(`Vale Browser — ${title}`);
    });
    browserSessions.set(id, bw);
    browserTargets.set(id, target);
    return { ok: true, id, url: target, cdp: `http://127.0.0.1:${CDP_PORT}` };
}
function browserClose(id) {
    const bw = browserSessions.get(id || "");
    // review #g: close() is vetoable by a page's beforeunload — an arbitrary
    // remote page could refuse eviction, so the MAX_BROWSER_WINDOWS cap never
    // freed and browserOpen stalled. destroy() is unconditional (these are
    // disposable, headless-driven windows).
    if (bw) {
        bw.destroy();
        browserSessions.delete(id || "");
        browserTargets.delete(id || "");
    }
    return { ok: true };
}
function browserList() {
    const list = [...browserSessions.entries()].map(([id, bw]) => ({ id, url: bw.webContents.getURL() }));
    return { ok: true, sessions: list, cdp: `http://127.0.0.1:${CDP_PORT}` };
}
electron_1.ipcMain.handle("browser-session:open", (e, url) => frameOk(e) ? browserOpen(url) : { ok: false, error: "forbidden frame" });
electron_1.ipcMain.handle("browser-session:close", (e, id) => frameOk(e) ? browserClose(id) : { ok: false, error: "forbidden frame" });
electron_1.ipcMain.handle("browser-session:list", (e) => frameOk(e) ? browserList() : { ok: false, error: "forbidden frame" });
// ── Embedded real-render browser view (round-246) ──────────────────────────
// The SPA's Browser page used to show the BRIDGE's headless-chromium as a
// JPEG screencast (lossy q60-92 frames over a websocket) — never as sharp as
// a real browser, and a SECOND browser instance alongside the desktop shell.
// In the Electron shell we replace it with a REAL WebContentsView embedded
// over the SPA's browser placeholder: GPU-composited, vector text, directly
// interactive. Its webContents is a first-class CDP target on the SAME
// :9333 endpoint, so AI (playwright connectOverCDP) drives EXACTLY the page
// the user sees — one browser, zero JPEG.
//
// Security posture mirrors the browser-session windows: the view loads
// arbitrary internet pages, so contextIsolation on, nodeIntegration off, NO
// preload, sandbox on, popups denied, permissions denied by default.
let embeddedView = null;
let embeddedVisible = false;
let embeddedUrl = "about:blank";
// round-256: last placed bounds — kept so a renderer-crash recovery can
// re-show the fresh view at the same spot without waiting for the SPA.
let embeddedBounds = null;
function embeddedViewEnsure() {
    if (embeddedView && !embeddedView.webContents.isDestroyed())
        return embeddedView;
    const view = new electron_1.WebContentsView({
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // round-246 (review #6/#7 parity): no preload = zero Node surface.
        },
    });
    view.setVisible(false);
    embeddedVisible = false;
    // round-248 (user report "浏览器超链接跳转不了"): `target=_blank` links
    // (the norm on real sites — Baidu's every external link opens a new
    // window) were DENIED, so clicking them did nothing. The embedded view is
    // a single-tab browser: intercept window.open and navigate the SAME view
    // to the requested URL instead (the address bar follows via the nav
    // events). Only http/https/data/about are honored — anything else
    // (javascript:, file:, chrome:) is dropped like the url-policy requires.
    view.webContents.setWindowOpenHandler(({ url }) => {
        const safe = (0, url_policy_1.sanitizeBrowserUrl)(url);
        if (safe && safe !== "about:blank") {
            embeddedNavigate(safe);
        }
        return { action: "deny" };
    });
    // round-248: same-view navigation for window.name/target=_top style links
    // that Chromium routes as renderer-initiated top navigations is already
    // handled natively; this handler only covers the window.open path above.
    // round-247: real-navigation events → SPA (URL/title/history tracking).
    embeddedWireNavEvents(view);
    try {
        electron_1.session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
        electron_1.session.defaultSession.setPermissionCheckHandler(() => false);
    }
    catch { /* non-fatal (already set at app ready) */ }
    embeddedView = view;
    // Attach to the main window's content view once the window exists. The
    // view is added hidden and only shown when the SPA's Browser page is
    // active and reports its placeholder bounds.
    if (win)
        win.contentView.addChildView(view);
    return view;
}
/** Place the embedded view over the SPA's browser placeholder (CSS px in the
 *  window's content coordinate space). Empty bounds hide it. */
function embeddedViewPlace(bounds) {
    const view = embeddedViewEnsure();
    if (!win)
        return;
    if (!bounds || bounds.width < 50 || bounds.height < 50) {
        view.setVisible(false);
        embeddedVisible = false;
        return;
    }
    embeddedBounds = bounds;
    view.setBounds(bounds);
    view.setVisible(true);
    embeddedVisible = true;
    // Keep it above the SPA content (the SPA placeholder is an empty div).
    win.contentView.addChildView(view);
}
function embeddedNavigate(raw) {
    const url = (0, url_policy_1.sanitizeBrowserUrl)(raw);
    const view = embeddedViewEnsure();
    embeddedUrl = url;
    view.webContents.loadURL(url).catch(() => { });
    return { ok: true, url };
}
/** round-247: nav controls on the embedded view (the SPA's toolbar mirrors a
 *  real browser: back/fwd/reload operate the actual webContents history). */
function embeddedGo(delta) {
    const view = embeddedView;
    if (!view || view.webContents.isDestroyed())
        return { ok: false };
    try {
        if (delta < 0)
            view.webContents.goBack();
        else
            view.webContents.goForward();
        return { ok: true };
    }
    catch {
        return { ok: false };
    }
}
function embeddedReload() {
    const view = embeddedView;
    if (!view || view.webContents.isDestroyed())
        return { ok: false };
    try {
        view.webContents.reload();
        return { ok: true };
    }
    catch {
        return { ok: false };
    }
}
function embeddedState() {
    const view = embeddedView;
    const wc = view && !view.webContents.isDestroyed() ? view.webContents : null;
    return {
        ok: true,
        url: wc ? wc.getURL() || embeddedUrl : embeddedUrl,
        canBack: !!wc && wc.navigationHistory.canGoBack(),
        canFwd: !!wc && wc.navigationHistory.canGoForward(),
        title: wc ? wc.getTitle() : "",
        visible: embeddedVisible && !!view && !view.webContents.isDestroyed(),
    };
}
/** round-247: push real navigation state (URL + title + history) to the SPA
 *  so its address bar and back/fwd buttons track the ACTUAL embedded page —
 *  event-driven (fires on navigation, no polling). */
function embeddedWireNavEvents(view) {
    const wc = view.webContents;
    const push = () => {
        if (!win || win.isDestroyed())
            return;
        const s = embeddedState();
        win.webContents.send("embedded-browser:nav", { url: s.url, canBack: s.canBack, canFwd: s.canFwd, title: s.title });
    };
    wc.on("did-navigate", push);
    wc.on("did-navigate-in-page", push);
    wc.on("page-title-updated", push);
    // round-256: the embedded view's RENDERER can crash (process-gone) or hang
    // mid-load (did-fail-load). Push a `gone` event so the SPA shows a recovery
    // state instead of "Starting…" forever; the SPA then offers a reload.
    wc.on("render-process-gone", (_e, details) => {
        if (!win || win.isDestroyed())
            return;
        // Hide the dead view so the SPA's recovery banner (which paints under
        // the native view) becomes visible in the slot.
        try {
            view.setVisible(false);
        }
        catch { /* already gone */ }
        embeddedVisible = false;
        win.webContents.send("embedded-browser:gone", {
            reason: details.reason,
            exitCode: details.exitCode,
        });
    });
}
/** round-256: recover the embedded view after a RENDERER CRASH. A
 *  process-gone renderer usually leaves the webContents object alive but
 *  dead — loadURL on it never recovers, so force a full re-create: drop the
 *  old view (destroy + remove) and build a fresh one via embeddedViewEnsure,
 *  then navigate to the last URL (or a default). */
function embeddedRecover() {
    try {
        if (embeddedView && !embeddedView.webContents.isDestroyed()) {
            embeddedView.webContents.close({ waitForBeforeUnload: false });
        }
        if (embeddedView) {
            try {
                win?.contentView.removeChildView(embeddedView);
            }
            catch { /* already gone */ }
            embeddedView = null;
        }
    }
    catch { /* fall through to ensure() */ }
    const view = embeddedViewEnsure();
    if (!view || view.webContents.isDestroyed())
        return { ok: false };
    const url = embeddedUrl && embeddedUrl !== "about:blank" ? embeddedUrl : "https://www.bing.com";
    view.webContents.loadURL(url).catch(() => { });
    // Re-show if the SPA slot is live (bounds were placed before the crash).
    if (embeddedVisible && win && embeddedBounds) {
        view.setBounds(embeddedBounds);
        view.setVisible(true);
        win.contentView.addChildView(view);
    }
    return { ok: true };
}
electron_1.ipcMain.handle("embedded-browser:recover", (e) => frameOk(e) ? embeddedRecover() : { ok: false });
electron_1.ipcMain.handle("embedded-browser:navigate", (e, url) => frameOk(e) ? embeddedNavigate(String(url || "")) : { ok: false, error: "forbidden frame" });
electron_1.ipcMain.handle("embedded-browser:back", (e) => frameOk(e) ? embeddedGo(-1) : { ok: false });
electron_1.ipcMain.handle("embedded-browser:fwd", (e) => frameOk(e) ? embeddedGo(1) : { ok: false });
electron_1.ipcMain.handle("embedded-browser:reload", (e) => frameOk(e) ? embeddedReload() : { ok: false });
/** round-251: zoom the REAL embedded view (webContents.setZoomFactor — the
 *  native browser zooms, not a CSS scale). factor: 0.5-3.0. */
electron_1.ipcMain.handle("embedded-browser:zoom", (e, factor) => {
    if (!frameOk(e))
        return { ok: false };
    const view = embeddedView;
    if (!view || view.webContents.isDestroyed())
        return { ok: false };
    const f = Math.min(3, Math.max(0.5, Number(factor) || 1));
    try {
        view.webContents.setZoomFactor(f);
        return { ok: true, factor: f };
    }
    catch {
        return { ok: false };
    }
});
electron_1.ipcMain.handle("embedded-browser:place", (e, bounds) => {
    if (!frameOk(e))
        return { ok: false };
    embeddedViewPlace(bounds);
    return { ok: true };
});
electron_1.ipcMain.handle("embedded-browser:state", (e) => frameOk(e) ? embeddedState() : { ok: false, error: "forbidden frame" });
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
async function autoLaunchTaskExists() {
    // review #4: was sync execSync schtasks — the same hang class that killed
    // electron; route through the bounded async runner.
    const r = await runSchtasks(["/query", "/tn", AUTOSTART_TASK]);
    return r.ok;
}
/** Run schtasks asynchronously with a hard timeout — the SYNC execSync
 *  variant could hang the main process on a wedged schtasks (observed: the
 *  electron process died when setAutoLaunch ran it inline). Spawn + await
 *  keeps the UI thread free and bounds the call (stage-n). */
function runSchtasks(args) {
    return new Promise((resolve) => {
        try {
            const { spawn } = require("child_process");
            const child = spawn("schtasks", args, { windowsHide: true, stdio: "pipe" });
            // review #5: consume the pipes — a task "already running" message on
            // stdout with no reader EPIPE-kills the child and surfaces a spurious
            // error even though schtasks succeeded.
            child.stdout?.resume();
            child.stderr?.resume();
            const t = setTimeout(() => { try {
                child.kill();
            }
            catch { } resolve({ ok: false, error: "schtasks timed out" }); }, 15000);
            child.on("error", (e) => { clearTimeout(t); resolve({ ok: false, error: String(e) }); });
            child.on("close", (code) => { clearTimeout(t); resolve({ ok: code === 0, error: code === 0 ? undefined : `schtasks exit ${code}` }); });
        }
        catch (e) {
            resolve({ ok: false, error: String(e) });
        }
    });
}
async function autoLaunchTaskSet(enabled) {
    try {
        if (enabled && !(await autoLaunchTaskExists())) {
            // Under SYSTEM, a spawn-array schtasks /create without /ru fails with
            // "no mapping between account names and security IDs" (exit 1) — the
            // interactive user is not resolvable from the service session. A bare
            // STRING invocation happens to work (shell default), but spawn arrays
            // need an explicit account: use Administrator (the d1 console user).
            const r = await runSchtasks([
                "/create", "/tn", AUTOSTART_TASK,
                // schtasks re-parses the /tr VALUE as a command line — it needs its
                // OWN inner quotes around the script path. The spawn array keeps the
                // outer arg intact; the embedded \\" quotes survive to schtasks.
                "/tr", `powershell -NoProfile -ExecutionPolicy Bypass -File \\"${AUTOSTART_SCRIPT}\\"`,
                "/sc", "onlogon", "/ru", "Administrator", "/f",
            ]);
            if (!r.ok)
                return r;
        }
        else if (!enabled && (await autoLaunchTaskExists())) {
            // End the task first (a RUNNING task's process tree is terminated on
            // delete) then remove it — the current electron instance must survive.
            await runSchtasks(["/end", "/tn", AUTOSTART_TASK]);
            const r = await runSchtasks(["/delete", "/tn", AUTOSTART_TASK, "/f"]);
            if (!r.ok)
                return r;
        }
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: String(e) };
    }
}
electron_1.ipcMain.handle("desktop:get-auto-launch", async (e) => frameOk(e) ? { enabled: await autoLaunchTaskExists() } : { ok: false, error: "forbidden frame" });
// The auto-launch pair is the PERSISTENCE primitive (onlogon schtasks in an
// admin context) — it absolutely cannot be reachable from a foreign frame.
electron_1.ipcMain.handle("desktop:set-auto-launch", async (e, enabled) => frameOk(e) ? autoLaunchTaskSet(!!enabled) : { ok: false, error: "forbidden frame" });
// --- Agent lifecycle (stage-m: Rust owns it; the shell only probes/triggers) ---
/** True if ANY process is listening on 127.0.0.1:18080 (TCP probe). */
function portBusy(port, timeoutMs = 1000) {
    return new Promise((res) => {
        const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); res(true); });
        sock.on("error", () => res(false));
        sock.setTimeout(timeoutMs, () => { sock.destroy(); res(false); });
    });
}
// review #2 (HIGH): a raw TCP connect only proves the PORT is held — an
// agent that is wedged (deadlock / OOM-parked) but still listening keeps the
// connect succeeding, so the watchdog's miss counter NEVER reached the gate,
// the wait page never showed, and a stuck device stayed stuck in silence.
// Liveness = GET /api/status answers 200 within the budget.
function agentResponds(timeoutMs = 2000) {
    return new Promise((res) => {
        let done = false;
        const finish = (v) => { if (!done) {
            done = true;
            res(v);
        } };
        const req = http.get(`${url_policy_1.BASE}/api/status`, { timeout: timeoutMs }, (r) => {
            r.resume();
            // ANY HTTP response = the accept loop is alive (this is the exact thing
            // the TCP probe could not see). Do NOT require 200: /api/status is
            // token-gated, so a HEALTHY agent answers 401 to the shell's
            // credential-less probe — requiring 200 made a live agent look dead and
            // sent the watchdog into a restart loop (self-caught regression).
            finish(typeof r.statusCode === "number" && r.statusCode > 0);
        });
        req.on("timeout", () => { req.destroy(); finish(false); });
        req.on("error", () => finish(false));
    });
}
/** Start the agent via the ValeAgent scheduled task — the ONLY sanctioned
 *  spawn path (the task runs the agent as SYSTEM; the agent itself enforces
 *  single-instance via VALE_NO_PAUSE bind-failure exit). Never spawn the exe
 *  directly from JS. */
async function startAgentTask() {
    // review #1 (HIGH): sync execSync on the wait-page button / IPC / HTTP
    // paths — one wedged schtasks froze the WHOLE main process (the exact
    // hang class already fixed for the watchdog). Same bounded async runner.
    return runSchtasks(["/run", "/tn", "ValeAgent"]);
}
// The SPA asks the shell for agent status / to (re)start the agent task.
// IPC audit #6: shell:agent-status / shell:start-agent had ZERO consumers
// (preload never exposed them; the wait page and SPA use the 9444 HTTP API).
// Dead handlers removed — every exposed channel is attack surface.
// Fallback HTTP path (plain browser / no preload): same core, CORS-open.
const httpServer = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const send = (obj, code = 200) => {
        // review #8: was ACAO:* with no origin check — ANY web page open in ANY
        // local browser could POST /api/shell/start-agent or spam
        // /api/browser-session/open (loopback is exempt from mixed-content
        // blocking). Reflect the origin, and reject state-changing requests
        // from foreign origins. "null" (our data: wait page) and absent
        // (native tooling/curl) stay allowed.
        res.setHeader("access-control-allow-origin", req.headers.origin || "*");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type, authorization");
        res.setHeader("vary", "Origin");
        res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(obj));
    };
    if (req.method === "OPTIONS")
        return send({ ok: true });
    if (req.method === "POST") {
        const origin = req.headers.origin;
        if (origin && origin !== "null"
            && !/^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|file:\/\/)/i.test(origin)) {
            return send({ ok: false, error: "forbidden origin" }, 403);
        }
    }
    try {
        if (u.pathname === "/api/browser-session/open" && req.method === "POST")
            return send(browserOpen(u.searchParams.get("url") || "about:blank"));
        if (u.pathname === "/api/browser-session/close" && req.method === "POST")
            return send(browserClose(u.searchParams.get("id") || ""));
        if (u.pathname === "/api/browser-session/list")
            return send(browserList());
        if (u.pathname === "/api/shell/start-agent" && req.method === "POST")
            return (async () => send(await startAgentTask()))();
        if (u.pathname === "/api/shell/agent-status")
            return (async () => send({ ok: true, running: await agentResponds(1000) }))();
        if (u.pathname === "/api/shell/icon-status")
            return send({ ok: true, icons: iconReport });
        send({ ok: false, error: "not found" }, 404);
    }
    catch (e) {
        send({ ok: false, error: String(e) }, 500);
    }
});
if (gotTheLock) {
    // Taskbar grouping/identity on Windows (taskbar button + jump list group
    // under Vale instead of Electron). Must be set before ready.
    try {
        if (process.platform === "win32")
            electron_1.app.setAppUserModelId("online.saisi.vale.agent");
        iconReport["appUserModelId"] = process.platform === "win32" ? "online.saisi.vale.agent" : "(non-windows)";
    }
    catch {
        iconReport["appUserModelId"] = "(set-failed)";
    }
    electron_1.app.whenReady().then(async () => {
        // review #7: with no handler Electron AUTO-GRANTS every permission
        // request (media/geolocation/clipboard) — deny by default for all
        // windows, esp. the remote-browser ones loading arbitrary pages.
        try {
            electron_1.session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
            electron_1.session.defaultSession.setPermissionCheckHandler(() => false);
        }
        catch { /* non-fatal */ }
        httpServer.listen(CTRL_PORT, "127.0.0.1");
        console.log(`[vale] browser-session control: http://127.0.0.1:${CTRL_PORT}`);
        // Native application menu (stage-l): menu commands → SPA via vale-menu.
        electron_1.Menu.setApplicationMenu(buildMenu());
        win = new electron_1.BrowserWindow({
            width: 1200, height: 800, title: "Vale",
            // Taskbar + title-bar icon: without this Windows shows the stock
            // electron.exe icon (the running binary is stock Electron). PNG —
            // see windowIcon() on why not .ico here.
            ...(windowIcon() ? { icon: windowIcon() } : {}),
            webPreferences: {
                preload: path.join(__dirname, "preload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                // stage-n preload audit LOW: defense-in-depth — the preload is
                // static/safe, but sandbox:true removes any Node escape path.
                sandbox: true,
                // round-274 (device-caught): the window was hidden (hide-to-tray /
                // background session) and the SPA's visibilityState flipped to
                // "hidden" — Chromium then stops requestAnimationFrame, and xterm's
                // DOM renderer (rAF-driven) silently stopped painting: every
                // terminal went blank while the AI kept operating. backgroundThrottling:
                // false keeps rAF/timers running for hidden windows, so the panel
                // always renders regardless of window visibility.
                backgroundThrottling: false,
            },
        });
        // review #6 (MED) TOP RISK: the main window carries the valeDesktop/
        // valeBrowser preload bridge (setAutoLaunch → schtasks /create …
        // -File <ps1>, browser-session:open). Without a navigation veto a
        // compromised/redirected agent page — or any window.open target — could
        // load an ARBITRARY origin into this privileged window and drive those
        // IPC channels for persistence. Pin the main window to its own origin
        // (the SPA is served from BASE; the wait page is a data: URL).
        win.webContents.on("will-navigate", (e, url) => {
            // audit #1: PARSED-origin veto. The data: carve-out was unnecessary
            // (programmatic loadURL — including the wait page — never fires
            // will-navigate) and only widened the hole.
            if (!(0, url_policy_1.isBaseOrigin)(url))
                e.preventDefault();
        });
        // round-258 (device-caught): CDP-driven navigation (an attached
        // playwright/AI) BYPASSES will-navigate — a browser_navigate call
        // hijacked the main window to qq.com and the panel vanished. Tripwire:
        // the moment the MAIN window lands anywhere that is not the base origin
        // or the wait page, snap it straight back to the desktop SPA. The SPA's
        // own in-page router never fires did-navigate to a different origin, so
        // this cannot fight legitimate panel use.
        let snappingBack = false;
        win.webContents.on("did-navigate", (_e, url) => {
            if (snappingBack)
                return;
            if (url.startsWith(`${url_policy_1.BASE}/desktop`) || url.startsWith("data:"))
                return;
            if (url === "about:blank")
                return;
            console.log(`[vale] main-window tripwire: blocked stray navigation to ${url.slice(0, 80)}`);
            snappingBack = true;
            win?.loadURL(`${url_policy_1.BASE}/desktop/`).catch(() => { }).finally(() => {
                setTimeout(() => { snappingBack = false; }, 2000);
            });
        });
        // review #7: a target=_blank from the SPA must NOT get a preload-bearing
        // window; route it to a sandboxed browser session instead.
        win.webContents.setWindowOpenHandler(({ url }) => {
            browserOpen(url);
            return { action: "deny" };
        });
        // stage-n: load /desktop/ only when the agent is actually listening.
        // A blind loadURL fails white-screen when the ValeAgent task is down
        // (startup race, crash, update mid-swap); poll 18080 and retry with
        // exponential backoff (2s → 4s → 8s → 30s cap) so a dead agent doesn't
        // spam retries.
        const agentReady = async () => portBusy(18080, 800);
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
        const loadWaitPage = () => {
            win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(WAIT_HTML)}`).catch(() => { });
        };
        let retryMs = 2000;
        const nextRetry = () => { retryMs = Math.min(retryMs * 2, 30000); return retryMs; };
        const resetRetry = () => { retryMs = 2000; };
        /** Window title carries the agent version for at-a-glance diagnosis:
         *  "Vale — v1.0.145". Falls back to "Vale" when the agent is unreachable. */
        const setVersionTitle = async () => {
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 3000);
                const r = await fetch(`${url_policy_1.BASE}/api/status`, { signal: ctrl.signal, headers: authHeaders() });
                clearTimeout(t);
                if (r.ok) {
                    const j = await r.json();
                    if (j.version)
                        win?.setTitle(`Vale — v${j.version}`);
                }
            }
            catch { /* agent down — keep default title */ }
        };
        // stage-n: SELF-HEAL watchdog. The wait-page button needed a human, but
        // when the AGENT is down the cloudflared tunnel (agent-supervised) dies
        // too — a remote operator then has NO channel left to click anything
        // (happened on d1: a killed script had run `schtasks /End` before its
        // `/Run`, and the device stayed dark). After ≥5 consecutive failed
        // probes (~60 s of silence — comfortably past an update swap's ~10 s
        // stop/restart window, so no race with the sanctioned updater) the
        // shell runs the only sanctioned spawn path itself, at most once per
        // 5 minutes. The async schtasks (runSchtasks) keeps the main process
        // free — the same hang class that killed the old auto-launch toggle.
        let agentMissCount = 0;
        let lastAutoStartAt = 0;
        const AUTO_START_AFTER_MISSES = 5;
        const AUTO_START_MIN_GAP_MS = 5 * 60 * 1000;
        const loadDesktop = async () => {
            if (await agentReady()) {
                agentMissCount = 0;
                resetRetry();
                setVersionTitle();
                win?.loadURL(`${url_policy_1.BASE}/desktop/`).catch(() => { });
            }
            else {
                loadWaitPage();
                agentMissCount += 1;
                if (agentMissCount >= AUTO_START_AFTER_MISSES && Date.now() - lastAutoStartAt > AUTO_START_MIN_GAP_MS) {
                    lastAutoStartAt = Date.now();
                    agentMissCount = 0;
                    void runSchtasks(["/run", "/tn", "ValeAgent"]).then((r) => {
                        console.log(`[vale] agent watchdog: schtasks /run ValeAgent → ${r.ok ? "ok" : "failed: " + r.error}`);
                    });
                }
                setTimeout(() => { loadDesktop(); }, nextRetry());
            }
        };
        // Retry loop: did-fail-load (agent went down mid-load) or a still-down
        // agent re-runs loadDesktop; each failure schedules exactly one retry.
        // review #3: a same-URL reload dispatches did-fail-load(-3, ERR_ABORTED)
        // on the MAIN frame, and subframe failures fired too — each stacked
        // ANOTHER loadDesktop chain (accelerated miss counting + duplicate
        // loadURLs). Only a real main-frame failure (not ABORTED) should retry.
        win.webContents.on("did-fail-load", (_e, errorCode, _desc, _url, isMainFrame) => {
            if (!isMainFrame || errorCode === -3)
                return;
            setTimeout(() => { loadDesktop(); }, nextRetry());
        });
        // stage-n: once the SPA finished loading, give its React effect time to
        // register the vale-menu listener, then flush any queued menu commands.
        win.webContents.on("did-finish-load", () => {
            if (menuFlushTimer)
                clearTimeout(menuFlushTimer);
            menuFlushTimer = setTimeout(flushMenuQueue, 1000);
        });
        await loadDesktop();
        // round-259: eagerly create the EMBEDDED view at startup (hidden) so an
        // attached playwright/AI ALWAYS has its own dedicated page to drive —
        // without it, playwright grabbed the MAIN window (now tripwired) or the
        // user had to open the Browser page first. The view is hidden until the
        // SPA's Browser page reports bounds (embeddedViewPlace shows it).
        try {
            const v = embeddedViewEnsure();
            if (v && !v.webContents.isDestroyed()) {
                v.webContents.loadURL("https://www.bing.com").catch(() => { });
            }
        }
        catch { /* non-fatal */ }
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
        win.on("close", (e) => {
            if (!electron_1.app.isQuitting) {
                e.preventDefault();
                win?.hide();
                // stage-n: first close hides to tray — tell the user once so they
                // don't think the app exited (a silent hide reads as 'closed').
                if (!hideNotified) {
                    hideNotified = true;
                    try {
                        new electron_1.Notification({ title: "Vale", body: "Vale is still running in the system tray." }).show();
                    }
                    catch { /* notifications unavailable — harmless */ }
                }
            }
        });
        // Windows requires .ico for tray; macOS/Linux accept .png.
        const iconPath = appIcon();
        tray = new electron_1.Tray(iconPath ? iconPath : electron_1.nativeImage.createEmpty());
        console.log(`[vale] icons ${JSON.stringify(iconReport)}`);
        // review #f: single/double-click on the tray icon did nothing (only the
        // context-menu "Open" worked).
        tray.on("click", () => focusMain());
        // stage-n: tray reflects live agent state — tooltip + a status line in
        // the menu, refreshed on a 30s poll and on demand (menu open re-checks).
        let trayAgentRunning = false;
        // stage-n: guards the single loadDesktop re-entry loop (see tray hook).
        let agentWatchActive = false;
        let trayAgentVersion = "";
        let trayAgentUptime = "";
        let trayAgentSessions = 0;
        // stage-n: vitals mirrored from /api/status into the tray (the SPA
        // status strip shows the same pair).
        let trayAgentCpu = null;
        let trayAgentMem = null;
        /** "3m 24s" / "1h 5m" / "2d 3h" — compact uptime for the tray. */
        const fmtUptime = (secs) => {
            if (secs < 60)
                return `${secs}s`;
            if (secs < 3600)
                return `${Math.floor(secs / 60)}m ${secs % 60}s`;
            if (secs < 86400)
                return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
            return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
        };
        const refreshTray = async () => {
            const running = await portBusy(18080, 600);
            let version = trayAgentVersion;
            let uptime = trayAgentUptime;
            let sessions = trayAgentSessions;
            let cpu = trayAgentCpu;
            let mem = trayAgentMem;
            if (running) {
                try {
                    const ctrl = new AbortController();
                    const t = setTimeout(() => ctrl.abort(), 2500);
                    const r = await fetch(`${url_policy_1.BASE}/api/status`, { signal: ctrl.signal, headers: authHeaders() });
                    clearTimeout(t);
                    if (r.ok) {
                        const j = await r.json();
                        if (j.version)
                            version = j.version;
                        if (typeof j.uptime_secs === "number")
                            uptime = fmtUptime(j.uptime_secs);
                        if (typeof j.live_sessions === "number")
                            sessions = j.live_sessions;
                        if (typeof j.cpu_pct === "number")
                            cpu = j.cpu_pct;
                        if (typeof j.mem_pct === "number")
                            mem = j.mem_pct;
                    }
                }
                catch { /* keep last */ }
            }
            trayAgentRunning = running;
            trayAgentVersion = version;
            trayAgentUptime = uptime;
            trayAgentSessions = sessions;
            trayAgentCpu = cpu;
            trayAgentMem = mem;
            const vitals = running && mem !== null
                ? `, CPU ${cpu === null ? "?" : Math.round(cpu)}% · MEM ${Math.round(mem)}%`
                : "";
            const health = running
                ? `Agent running (v${version || "?"}${uptime ? `, up ${uptime}` : ""}${sessions ? `, ${sessions} session${sessions === 1 ? "" : "s"}` : ""}${vitals})`
                : "Agent stopped";
            // stage-n: the agent died WHILE the window was showing the SPA (the
            // wait page only renders when the boot probe fails). Swap the window
            // to the wait page — its "Start Agent" button is now actually visible
            // (user report: the button could never be reached) — and re-enter the
            // loadDesktop retry loop, whose watchdog auto-runs `schtasks /run
            // ValeAgent` after ~60 s of misses. One loop guard so repeated tray
            // polls cannot stack retries.
            if (!running && !agentWatchActive && win && !win.isDestroyed()
                && (0, url_policy_1.isBaseOrigin)(win.webContents.getURL())) {
                agentWatchActive = true;
                void loadDesktop();
            }
            if (running && agentWatchActive)
                agentWatchActive = false;
            tray.setToolTip(`Vale — ${health}`);
            tray.setContextMenu(electron_1.Menu.buildFromTemplate([
                { label: "Open", click: () => { focusMain(); } },
                { type: "separator" },
                { label: health, enabled: false },
                { type: "separator" },
                { label: "New Terminal", click: () => { focusMain(); sendMenu("new-pty"); } },
                { label: "New SSH…", click: () => { focusMain(); sendMenu("new-ssh"); } },
                { label: "New Serial…", click: () => { focusMain(); sendMenu("new-serial"); } },
                { label: "New Browser…", click: () => { focusMain(); sendMenu("new-browser"); } },
                { type: "separator" },
                { label: "Quit", click: () => { electron_1.app.isQuitting = true; electron_1.app.quit(); } },
            ]));
        };
        refreshTray();
        setInterval(() => { refreshTray(); }, 30000);
    });
}
electron_1.app.on("before-quit", () => {
    electron_1.app.isQuitting = true;
    // stage-n: close every browser-session window explicitly — app.quit()
    // tears down the main window but independent BrowserWindows with pending
    // beforeunload handlers can stall or leak on exit.
    for (const [id, bw] of browserSessions) {
        if (!bw.isDestroyed())
            bw.destroy();
        browserSessions.delete(id);
        browserTargets.delete(id);
    }
});
