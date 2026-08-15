import { useCallback, useEffect, useRef, useState } from "react";
import { callTool } from "../lib/api";

// Session state (migrated from panel.js) — the xterm instance + render
// cursor live OUTSIDE React state (imperative, heavy); React tracks only the
// session list + metadata. The term object is attached to a ref map so the
// render cycle never re-creates it.

export interface Session {
  sid: string;
  label: string;
  kind: string;
  closed: boolean;
  savedOnly: boolean;
  active: boolean;
  openedAt: number;
  closedAt: number | null;
}

interface SessionRuntime {
  term: any;            // xterm Terminal
  fit: any;             // FitAddon
  container: HTMLDivElement | null;
  renderedBytes: number;
  needSync: boolean;
  sseDirty: boolean;
}

const runtimes = new Map<string, SessionRuntime>();

export function useSessions(connected: boolean) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSid, setActiveSid] = useState<string | null>(null);
  const [status, setStatusState] = useState("");
  const pollRef = useRef<number | null>(null);
  // round-94: a live mirror of activeSid for async callbacks (closeSession
  // awaits terminal_close, during which the user can activate another tab —
  // the closed-over activeSid was stale and stomped that activation).
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeSid;

  // Poll the session list while connected (the panel polls terminal_list
  // every 3s to pick up sessions created by other clients).
  useEffect(() => {
    if (!connected) return;
    const tick = async () => {
      try {
        // round-113: a FAILED poll (tunnel blip, agent restarting) used to
        // return [] and tombstone EVERY open session — the heartbeat then
        // skipped them and the agent's 15-min sweeper reaped them while the
        // user watched. Only a SUCCESSFUL list may mark sessions gone.
        const list = await callTool("terminal_list");
        if (!Array.isArray(list)) return;
        const seen = new Set(list.map((s: any) => s.id));
        setSessions((prev) => {
          const next = [...prev];
          for (const s of list as any[]) {
            const existing = next.find((x) => x.sid === s.id);
            if (!existing) next.push({ sid: s.id, label: s.label || s.id, kind: s.kind || "pty", closed: false, savedOnly: false, active: false, openedAt: Date.now(), closedAt: null });
          }
          // Mark gone sessions closed (retained history shows as tombstone).
          // round-88: a session that died server-side (PTY exit, SSH drop,
          // serial error) must ALSO release focus — the R86 close-switching
          // only covered the ✕ path, so a dead active tab kept the blinking
          // cursor and swallowed keystrokes.
          let deadActive = false;
          for (const s of next) {
            if (!seen.has(s.sid) && !s.savedOnly) {
              if (s.active) deadActive = true;
              s.closed = true;
              s.closedAt = s.closedAt || Date.now();
              s.active = false;
            }
          }
          if (deadActive) {
            const nextLive = next.find((s) => !s.closed);
            if (nextLive) { setActiveSid(nextLive.sid); nextLive.active = true; }
            else setActiveSid(null);
          }
          return next;
        });
      } catch { /* transient — next poll retries */ }
    };
    tick();
    pollRef.current = window.setInterval(tick, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [connected]);

  const setStatus = useCallback((msg: string) => setStatusState(msg), []);

  const openSession = useCallback(async (kind: string, target: string, extra: Record<string, unknown> = {}) => {
    try {
      const sid = await callTool("terminal_open", { kind, target, rows: 30, cols: 120, ...extra });
      if (typeof sid !== "string" || !sid) throw new Error("terminal_open returned no sid");
      setSessions((prev) => {
        if (prev.some((s) => s.sid === sid)) return prev;
        const label = kind === "ssh" ? target.split("@").pop() || target : kind === "serial" ? target.split("?")[0] : target || "shell";
        // round-86: the new session is the ACTIVE one — the old active:false
        // + setActiveSid(sid) never set the session's own flag, so the pane
        // stayed display:none (blank terminal area).
        return [...prev.map((s) => ({ ...s, active: false })), { sid, label, kind, closed: false, savedOnly: false, active: true, openedAt: Date.now(), closedAt: null }];
      });
      setActiveSid(sid);
      return sid;
    } catch (e: any) {
      setStatusState(`open failed: ${e.message}`);
      throw e;
    }
  }, []);

  const closeSession = useCallback(async (sid: string) => {
    // round-83: a transient close failure must NOT mark the session closed —
    // the old catch(() => {}) swallowed the error and the tab wedged
    // (closed class, onClick disabled, SSE still streaming). On failure keep
    // it open and surface the error.
    try {
      await callTool("terminal_close", { session_id: sid });
      setSessions((prev) => {
        const next = prev.map((s) => (s.sid === sid ? { ...s, closed: true, closedAt: Date.now() } : s));
        // round-86: closing the ACTIVE session must switch to the next live
        // one — the old code left activeSid on the dead tab (stale output,
        // unclickable, typing went nowhere).
        // round-94: read the LIVE activeSid — the user may have activated
        // another tab while terminal_close was in flight; only switch if the
        // closed session is still the active one.
        if (activeRef.current === sid) {
          const nextLive = next.find((s) => !s.closed && s.sid !== sid);
          if (nextLive) {
            setActiveSid(nextLive.sid);
            return next.map((s) => ({ ...s, active: s.sid === nextLive.sid }));
          }
          // round-88: no live session left — the closed one must NOT stay
          // active (it kept its pane visible with a blinking cursor while
          // no tab was highlighted).
          setActiveSid(null);
          return next.map((s) => ({ ...s, active: false }));
        }
        return next;
      });
    } catch (e: any) {
      setStatusState(`close failed — session still open: ${e.message}`);
    }
  }, [activeSid]);

  const activate = useCallback((sid: string) => {
    setActiveSid(sid);
    setSessions((prev) => prev.map((s) => ({ ...s, active: s.sid === sid })));
  }, []);

  const exportSession = useCallback((sid: string) => {
    // Pull the retained history text (terminal_read from 0, raw) and save.
    callTool("terminal_read", { session_id: sid, offset: 0, clean: false })
      .then((r: any) => {
        const text = (r && r.text) || "";
        const blob = new Blob([text], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${sid}.log`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => setStatusState("export failed"));
  }, [setStatusState]);

  return { sessions, activeSid, status, setStatus, openSession, closeSession, activate, exportSession, runtimes };
}
