// Vale Desktop preload — exposes the native menu command bridge,
// browser-session control, embedded real-render browser, and desktop-app
// settings to the SPA via contextBridge (Electron-native, no HTTP/CORS).
//
// The SPA (agent /desktop/ page) uses:
//   window.valeBrowser.*   — browser-session windows (driven via CDP :9333)
//   window.valeEmbedded.*  — embedded REAL browser view (round-246: replaces
//                            the JPEG screencast inside the SPA Browser page)
//   window.valeDesktop.*   — auto-launch settings + menu command bridge
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("valeBrowser", {
  open: (url: string) => ipcRenderer.invoke("browser-session:open", url),
  close: (id: string) => ipcRenderer.invoke("browser-session:close", id),
  list: () => ipcRenderer.invoke("browser-session:list"),
});

// round-246: the embedded real-render browser view. The SPA Browser page
// reports its placeholder bounds (via place) and the main process positions
// the WebContentsView over them; navigate() drives the same view the AI sees
// over CDP :9333. Absent from plain-browser (non-Electron) contexts — the
// SPA falls back to the screenshot stream there.
contextBridge.exposeInMainWorld("valeEmbedded", {
  navigate: (url: string) => ipcRenderer.invoke("embedded-browser:navigate", url),
  back: () => ipcRenderer.invoke("embedded-browser:back"),
  fwd: () => ipcRenderer.invoke("embedded-browser:fwd"),
  reload: () => ipcRenderer.invoke("embedded-browser:reload"),
  zoom: (factor: number) => ipcRenderer.invoke("embedded-browser:zoom", factor),
  place: (bounds: { x: number; y: number; width: number; height: number } | null) =>
    ipcRenderer.invoke("embedded-browser:place", bounds),
  state: () => ipcRenderer.invoke("embedded-browser:state"),
  // round-247: real-navigation pushes from the main process (URL/title/
  // history state after every actual navigation). Returns an unsubscribe fn.
  onNav: (handler: (s: { url: string; canBack: boolean; canFwd: boolean; title: string }) => void) => {
    const listener = (_e: unknown, s: { url: string; canBack: boolean; canFwd: boolean; title: string }) => {
      try { handler(s); } catch { /* SPA-side */ }
    };
    ipcRenderer.on("embedded-browser:nav", listener as never);
    return () => ipcRenderer.removeListener("embedded-browser:nav", listener as never);
  },
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
