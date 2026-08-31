// Vale Desktop preload — exposes browser-session control to the SPA via
// contextBridge (Electron-native, no HTTP/CORS). The SPA (agent /desktop/
// page) calls window.valeBrowser.open/close/list; the main process opens
// browser-session windows that playwright drives via CDP :9333.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("valeBrowser", {
  open: (url) => ipcRenderer.invoke("browser-session:open", url),
  close: (id) => ipcRenderer.invoke("browser-session:close", id),
  list: () => ipcRenderer.invoke("browser-session:list"),
});
