import { useEffect, useRef } from "react";
import { toggleTheme } from "../lib/theme";
import type { SessionView } from "../components/TabBar";

// useDesktopCommands — maps native-menu commands (Electron) AND browser-mode
// keyboard shortcuts onto the same SPA actions. The Electron main process
// sends `vale-menu` events with command ids; in a plain browser (or when the
// preload bridge is missing) the same accelerators are handled via keydown so
// the desktop experience degrades gracefully.
//
// Commands:
//   new-pty / new-ssh / new-serial / new-browser — open a session/modal
//   close-session      — close the active session
//   next/prev-session  — activate the next/previous live session
//   export-session     — export the active session log
//   toggle-trajectory  — flip the active session's terminal/trajectory view
//   toggle-theme       — light ↔ dark
//   show-status        — flash the desktop status strip
//
// App owns sessions; this hook only wires events → actions.

interface Actions {
  onNewSession: (kind: "pty" | "ssh" | "serial" | "browser") => void;
  onClose: (sid: string) => void;
  onActivate: (sid: string) => void;
  onExport: (sid: string) => void;
  onSetView: (sid: string, v: SessionView) => void;
}

export function useDesktopCommands(
  connected: boolean,
  sessions: { sid: string; closed: boolean }[],
  activeSid: string | null,
  sessionViews: Record<string, SessionView>,
  actions: Actions,
) {
  const a = useRef(actions);
  a.current = actions;
  const liveRef = useRef<string[]>([]);
  liveRef.current = sessions.filter((s) => !s.closed).map((s) => s.sid);
  const activeRef = useRef(activeSid);
  activeRef.current = activeSid;
  const viewsRef = useRef(sessionViews);
  viewsRef.current = sessionViews;

  const run = (cmd: string) => {
    switch (cmd) {
      case "new-pty": case "new-ssh": case "new-serial": case "new-browser":
        a.current.onNewSession(cmd.slice(4) as any);
        break;
      case "close-session": {
        const sid = activeRef.current;
        if (sid) a.current.onClose(sid);
        break;
      }
      case "next-session": case "prev-session": {
        const live = liveRef.current;
        if (live.length === 0) break;
        const cur = live.indexOf(activeRef.current ?? "");
        const dir = cmd === "next-session" ? 1 : -1;
        const target = live[(cur + dir + live.length) % live.length];
        a.current.onActivate(target);
        break;
      }
      case "export-session": {
        const sid = activeRef.current;
        if (sid) a.current.onExport(sid);
        break;
      }
      case "toggle-trajectory": {
        const sid = activeRef.current;
        if (sid) {
          const cur: SessionView = viewsRef.current[sid] || "terminal";
          a.current.onSetView(sid, cur === "terminal" ? "trajectory" : "terminal");
        }
        break;
      }
      case "toggle-theme": toggleTheme(); break;
      case "show-status": {
        const strip = document.querySelector(".desktop-status");
        if (strip) {
          strip.classList.remove("flash");
          void (strip as HTMLElement).offsetWidth; // restart animation
          strip.classList.add("flash");
        }
        break;
      }
      default: break;
    }
  };

  useEffect(() => {
    if (!connected) return;
    const bridge = (window as any).valeDesktop;
    let unsubscribe: (() => void) | null = null;
    if (bridge?.onCommand) {
      unsubscribe = bridge.onCommand(run);
    }
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      if (e.key === "Tab") {
        e.preventDefault();
        run(e.shiftKey ? "prev-session" : "next-session");
        return;
      }
      if (!e.shiftKey) return;
      const map: Record<string, string> = {
        t: "new-pty", s: "new-ssh", p: "new-serial", b: "new-browser",
        y: "toggle-trajectory", d: "toggle-theme", e: "export-session",
      };
      const cmd = map[e.key.toLowerCase()];
      if (cmd) {
        e.preventDefault();
        run(cmd);
      }
    };
    // Native menu accelerators already handle these in Electron; the keydown
    // fallback only applies without the bridge (plain browser).
    if (!unsubscribe) {
      document.addEventListener("keydown", onKey);
    }
    return () => {
      unsubscribe?.();
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);
}
