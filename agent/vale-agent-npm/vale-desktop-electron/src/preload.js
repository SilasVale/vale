"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Vale Desktop preload — exposes the native menu command bridge,
// browser-session control, and desktop-app settings to the SPA via
// contextBridge (Electron-native, no HTTP/CORS).
//
// The SPA (agent /desktop/ page) uses:
//   window.valeBrowser.*   — browser-session windows (driven via CDP :9333)
//   window.valeDesktop.*   — auto-launch settings + menu command bridge
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("valeBrowser", {
    open: (url) => electron_1.ipcRenderer.invoke("browser-session:open", url),
    close: (id) => electron_1.ipcRenderer.invoke("browser-session:close", id),
    list: () => electron_1.ipcRenderer.invoke("browser-session:list"),
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
