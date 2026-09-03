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
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("valeBrowser", {
  open: (url: string) => ipcRenderer.invoke("browser-session:open", url),
  close: (id: string) => ipcRenderer.invoke("browser-session:close", id),
  list: () => ipcRenderer.invoke("browser-session:list"),
});

// round-249: the embedded <webview> browser. Navigation, back/fwd/reload,
// URL/history tracking all happen on the <webview> ELEMENT itself (its DOM
// API + events) — no per-nav IPC. The bridge only:
//   * announceGuest(webContentsId) — pins the guest so the main process can
//     route its window.open in-view and expose it for AI (CDP :9333)
//   * state() — reads the guest's url/title/history for the toolbar
// Absent from plain-browser (non-Electron) contexts — the SPA falls back to
// the screenshot stream there.
contextBridge.exposeInMainWorld("valeEmbedded", {
  announceGuest: (webContentsId: number) =>
    ipcRenderer.invoke("embedded-browser:guest-attached", webContentsId),
  state: () => ipcRenderer.invoke("embedded-browser:state"),
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
