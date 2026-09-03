"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Vale Desktop preload — exposes the native menu command bridge,
// browser-session control, embedded real-render browser, and desktop-app
// settings to the SPA via contextBridge (Electron-native, no HTTP/CORS).
//
// The SPA (agent /desktop/ page) uses:
//   window.valeBrowser.*   — browser-session windows (driven via CDP :9333)
//   window.valeEmbedded.*  — embedded REAL browser view (round-246: replaces
//                            the JPEG screencast inside the SPA Browser page)
//   window.valeDesktop.*   — auto-launch settings + menu command bridge
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("valeBrowser", {
    open: (url) => electron_1.ipcRenderer.invoke("browser-session:open", url),
    close: (id) => electron_1.ipcRenderer.invoke("browser-session:close", id),
    list: () => electron_1.ipcRenderer.invoke("browser-session:list"),
});
// round-246: the embedded real-render browser view. The SPA Browser page
// reports its placeholder bounds (via place) and the main process positions
// the WebContentsView over them; navigate() drives the same view the AI sees
// over CDP :9333. Absent from plain-browser (non-Electron) contexts — the
// SPA falls back to the screenshot stream there.
electron_1.contextBridge.exposeInMainWorld("valeEmbedded", {
    navigate: (url) => electron_1.ipcRenderer.invoke("embedded-browser:navigate", url),
    back: () => electron_1.ipcRenderer.invoke("embedded-browser:back"),
    fwd: () => electron_1.ipcRenderer.invoke("embedded-browser:fwd"),
    reload: () => electron_1.ipcRenderer.invoke("embedded-browser:reload"),
    zoom: (factor) => electron_1.ipcRenderer.invoke("embedded-browser:zoom", factor),
    place: (bounds) => electron_1.ipcRenderer.invoke("embedded-browser:place", bounds),
    state: () => electron_1.ipcRenderer.invoke("embedded-browser:state"),
    // round-256: recovery after a renderer crash — the main process force-
    // re-creates the view and navigates to the last URL.
    recover: () => electron_1.ipcRenderer.invoke("embedded-browser:recover"),
    // round-247: real-navigation pushes from the main process (URL/title/
    // history state after every actual navigation). Returns an unsubscribe fn.
    onNav: (handler) => {
        const listener = (_e, s) => {
            try {
                handler(s);
            }
            catch { /* SPA-side */ }
        };
        electron_1.ipcRenderer.on("embedded-browser:nav", listener);
        return () => electron_1.ipcRenderer.removeListener("embedded-browser:nav", listener);
    },
    // round-256: the embedded view's renderer crashed (reason + exitCode).
    // Returns an unsubscribe fn.
    onGone: (handler) => {
        const listener = (_e, d) => {
            try {
                handler(d);
            }
            catch { /* SPA-side */ }
        };
        electron_1.ipcRenderer.on("embedded-browser:gone", listener);
        return () => electron_1.ipcRenderer.removeListener("embedded-browser:gone", listener);
    },
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
