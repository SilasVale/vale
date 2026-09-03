"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Vale Desktop preload — exposes the native menu command bridge,
// browser-session control, embedded <webview> browser, and desktop-app
// settings to the SPA via contextBridge (Electron-native, no HTTP/CORS).
//
// The SPA (agent /desktop/ page) uses:
//   window.valeBrowser.*   — browser-session windows (driven via CDP :9333)
//   window.valeEmbedded.*  — embedded REAL browser (round-249: a <webview>
//                            tag inside the SPA; the guest webContents is a
//                            CDP target on :9333 that AI drives)
//   window.valeDesktop.*   — auto-launch settings + menu command bridge
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("valeBrowser", {
    open: (url) => electron_1.ipcRenderer.invoke("browser-session:open", url),
    close: (id) => electron_1.ipcRenderer.invoke("browser-session:close", id),
    list: () => electron_1.ipcRenderer.invoke("browser-session:list"),
});
// round-249: the embedded <webview> browser. Navigation, back/fwd/reload,
// URL/history tracking all happen on the <webview> ELEMENT itself (its DOM
// API + events) — no per-nav IPC. The bridge only:
//   * announceGuest(webContentsId) — pins the guest so the main process can
//     route its window.open in-view and expose it for AI (CDP :9333)
//   * state() — reads the guest's url/title/history for the toolbar
// Absent from plain-browser (non-Electron) contexts — the SPA falls back to
// the screenshot stream there.
electron_1.contextBridge.exposeInMainWorld("valeEmbedded", {
    announceGuest: (webContentsId) => electron_1.ipcRenderer.invoke("embedded-browser:guest-attached", webContentsId),
    state: () => electron_1.ipcRenderer.invoke("embedded-browser:state"),
});
// Desktop-app settings + menu bridge (Electron-specific — hidden when running
// in a plain browser; the SPA detects the bridge and shows the card only when
// present).
electron_1.contextBridge.exposeInMainWorld("valeDesktop", {
    getAutoLaunch: () => electron_1.ipcRenderer.invoke("desktop:get-auto-launch"),
    setAutoLaunch: (enabled) => electron_1.ipcRenderer.invoke("desktop:set-auto-launch", enabled),
    // Native menu → SPA command bridge (stage-l): the main process sends
    // "vale-menu" with a command id (new-pty, new-ssh, new-serial, new-browser,
    // close-session, next-session, prev-session, export-session,
    // toggle-trajectory, toggle-theme, show-status). Returns an unsubscribe fn.
    onCommand: (handler) => {
        const listener = (_e, cmd) => { try {
            handler(cmd);
        }
        catch { /* SPA-side */ } };
        electron_1.ipcRenderer.on("vale-menu", listener);
        return () => electron_1.ipcRenderer.removeListener("vale-menu", listener);
    },
});
