// Vale Desktop preload — exposes the native menu command bridge,
// browser-session control, and desktop-app settings to the SPA via
// contextBridge (Electron-native, no HTTP/CORS).
//
// The SPA (agent /desktop/ page) uses:
//   window.valeBrowser.*   — browser-session windows (driven via CDP :9333)
//   window.valeDesktop.*   — auto-launch settings + menu command bridge
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("valeBrowser", {
  open: (url: string) => ipcRenderer.invoke("browser-session:open", url),
  close: (id: string) => ipcRenderer.invoke("browser-session:close", id),
  list: () => ipcRenderer.invoke("browser-session:list"),
});

// Desktop-app settings + menu bridge (Electron-specific — hidden when running
// in a plain browser; the SPA detects the bridge and shows the card only when
// present).
contextBridge.exposeInMainWorld("valeDesktop", {
  getAutoLaunch: () => ipcRenderer.invoke("desktop:get-auto-launch"),
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke("desktop:set-auto-launch", enabled),
  // Native menu → SPA command bridge (stage-l): the main process sends
  // "vale-menu" with a command id (new-pty, new-ssh, new-serial, new-browser,
  // close-session, next-session, prev-session, export-session,
  // toggle-trajectory, toggle-theme, show-status). Returns an unsubscribe fn.
  onCommand: (handler: (cmd: string) => void) => {
    const listener = (_e: unknown, cmd: string) => { try { handler(cmd); } catch { /* SPA-side */ } };
    ipcRenderer.on("vale-menu", listener as never);
    return () => ipcRenderer.removeListener("vale-menu", listener as never);
  },
});
