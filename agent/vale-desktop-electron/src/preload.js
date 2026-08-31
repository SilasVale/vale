// Vale Desktop preload — exposes browser-session control + desktop-app
// settings (auto-launch) to the SPA via contextBridge (Electron-native, no
// HTTP/CORS). The SPA (agent /desktop/ page) calls window.valeBrowser.* and
// window.valeDesktop.*; the main process opens browser-session windows that
// playwright drives via CDP :9333, and manages login auto-launch.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("valeBrowser", {
  open: (url) => ipcRenderer.invoke("browser-session:open", url),
  close: (id) => ipcRenderer.invoke("browser-session:close", id),
  list: () => ipcRenderer.invoke("browser-session:list"),
});

// Desktop-app settings (Electron-specific — hidden when running in a plain
// browser; the SPA detects the bridge and shows the card only when present).
contextBridge.exposeInMainWorld("valeDesktop", {
  getAutoLaunch: () => ipcRenderer.invoke("desktop:get-auto-launch"),
  setAutoLaunch: (enabled) => ipcRenderer.invoke("desktop:set-auto-launch", enabled),
});
