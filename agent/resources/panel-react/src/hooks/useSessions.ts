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
  // round-94: a live mirror of activeSid for async callbacks (closeSession
  // awaits terminal_close, during which the user can activate another tab —
  // the closed-over activeSid was stale and stomped that activation).
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeSid;

  // round-163: the 3s terminal_list POLL is gone. The list refreshes on:
  // connect (initial), an agent-pushed `sessions-changed` SSE event (emitted
  // by terminal_open/close), and tab refocus. During an SSE outage the UI
  // shows "reconnecting" anyway; the refocus sweep covers stale gaps.
  useEffect(() => {
    if (!connected) return;
    const tick = async () => {
      // round-245 (terminal-display audit HIGH-1): the refresh contract was
      // ONE fire-and-forget terminal_list after each sessions-changed event.
      // A transient failure (tunnel blip, agent mid-restart) swallowed the
      // event and the AI-opened session NEVER appeared — no later event
      // exists to retry it (the agent emits sessions-changed only on
      // open/close/death). Retry the list once after a short delay.
      for (let attempt = 0; attempt < 2; attempt++) {
        let list: any = null;
        try {
          // round-113: a FAILED poll (tunnel blip, agent restarting) used to
          // return [] and tombstone EVERY open session — the heartbeat then
          // skipped them and the agent's 15-min sweeper reaped them while the
          // user watched. Only a SUCCESSFUL list may mark sessions gone.
          list = await callTool("terminal_list");
          if (!Array.isArray(list)) return; // tool error surfaced as non-array → give up
        } catch {
          // Transient failure — retry once, then give up (the background
          // sweep below still covers the gap).
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 1200));
            continue;
          }
          return;
        }
        const seen = new Set(list.map((s: any) => s.id));
        setSessions((prev) => {
          const next = [...prev];
          for (const s of list as any[]) {
            const existing = next.find((x) => x.sid === s.id);
            if (!existing) {
              next.push({ sid: s.id, label: s.label || s.id, kind: s.kind || "pty", closed: false, savedOnly: false, active: false, openedAt: Date.now(), closedAt: null });
            } else if (existing.closed) {
              // round-245 (terminal-display audit HIGH-1): REVIVE a tombstone
              // whose sid reappears live. A fast AI session (open → one
              // command → exit) used to be tombstoned by a list that raced
              // the agent's close emit, and NOTHING ever revived it — the tab
              // sat dead forever (activate() refuses closed entries). A live
              // reappearance means the session is real: un-tombstone it.
              const revived = { ...existing, closed: false, closedAt: null };
              next[next.indexOf(existing)] = revived;
            }
          }
          // Mark gone sessions closed (retained history shows as tombstone).
          // round-88: a session that died server-side (PTY exit, SSH drop,
          // serial error) must ALSO release focus — the R86 close-switching
          // only covered the ✕ path, so a dead active tab kept the blinking
          // cursor and swallowed keystrokes.
          // review #6: immutable pass — the old loop MUTATED objects still
          // referenced by the previous state array (breaks memo/batching
          // contracts; React 18 double-invoke shows stale tabs).
          let deadActive = false;
          const next2 = next.map((x) => {
            if (!seen.has(x.sid) && !x.savedOnly) {
              if (x.active) deadActive = true;
              return { ...x, closed: true, closedAt: x.closedAt || Date.now(), active: false };
            }
            return x;
          });
          let out = next2;
          if (deadActive) {
            const nextLive = out.find((s) => !s.closed);
            if (nextLive) {
              setActiveSid(nextLive.sid);
              out = out.map((x) => (x.sid === nextLive.sid ? { ...x, active: true } : x));
            } else setActiveSid(null);
          }
          // round-117: cap the tombstone count — every session the device
          // ever hosted (PTY/SSH churn, other clients) accumulated forever,
          // growing the tab bar and the per-tick O(m) scan. Keep the newest
          // 32 closed entries; older ones are dropped (their history is
          // still readable server-side via the sessions dir).
          const closed = out.filter((s) => s.closed);
          if (closed.length > 32) {
            const drop = new Set(closed.slice(0, closed.length - 32).map((s) => s.sid));
            return out.filter((s) => !drop.has(s.sid));
          }
          return out;
        });
        return; // success — done
      }
    };
    tick();
    const onChange = () => { tick(); };
    window.addEventListener("vale-sessions-changed", onChange);
    document.addEventListener("visibilitychange", onChange);
    // round-245 (HIGH-1): a slow background sweep (30 s) that ONLY ADDS live
    // sessions the panel has never seen — the safety net when both the
    // event-driven refetch AND its retry failed. It must never tombstone
    // (tombstoning is the event path's job, where the agent's close emit
    // proves the session died).
    const sweep = window.setInterval(async () => {
      try {
        const list = await callTool("terminal_list");
        if (!Array.isArray(list)) return;
        setSessions((prev) => {
          // Only add never-seen live sessions + auto-activate the newest when
          // nothing is active — never tombstone here (that is the event
          // path's job, where the agent's close emit proves death).
          const missing = (list as any[]).filter((s) => !prev.some((x) => x.sid === s.id));
          const next = [...prev];
          for (const s of missing) {
            next.push({ sid: s.id, label: s.label || s.id, kind: s.kind || "pty", closed: false, savedOnly: false, active: false, openedAt: Date.now(), closedAt: null });
          }
          if (!prev.some((x) => x.active) && next.some((x) => !x.closed && x.active === false)) {
            const liveTail = next.filter((x) => !x.closed);
            const target = liveTail[liveTail.length - 1];
            if (target) {
              setActiveSid(target.sid);
              return next.map((x) => (x.sid === target.sid ? { ...x, active: true } : x));
            }
          }
          return next;
        });
      } catch { /* transient — next sweep */ }
    }, 30_000);
    return () => {
      window.removeEventListener("vale-sessions-changed", onChange);
      document.removeEventListener("visibilitychange", onChange);
      window.clearInterval(sweep);
    };
  }, [connected]);

  const setStatus = useCallback((msg: string) => setStatusState(msg), []);

  const openSession = useCallback(async (kind: string, target: string, extra: Record<string, unknown> = {}) => {
    try {
      const sid = await callTool("terminal_open", { kind, target, rows: 30, cols: 120, ...extra });
      if (typeof sid !== "string" || !sid) throw new Error("terminal_open returned no sid");
      setSessions((prev) => {
        // round-131: rebuild the entry UNCONDITIONALLY — the old
        // `prev.some(...) return prev` guard let a 3s poll tick (which
        // registered the session with active:false between the server's
        // open and this setSessions) skip the activation, leaving the pane
        // display:none (round-86 bug class). Filtering any existing entry
        // also clears a stale tombstone from a reordered poll response.
        const label = kind === "ssh" ? target.split("@").pop() || target : kind === "serial" ? target.split("?")[0] : target || "shell";
        // round-86: the new session is the ACTIVE one — the old active:false
        // + setActiveSid(sid) never set the session's own flag, so the pane
        // stayed display:none (blank terminal area).
        return [...prev.filter((s) => s.sid !== sid).map((s) => ({ ...s, active: false })), { sid, label, kind, closed: false, savedOnly: false, active: true, openedAt: Date.now(), closedAt: null }];
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
    // round-117: a CLOSED (tombstone) session must not become active —
    // round-113 unmounted closed panes, so activating one blanks the whole
    // terminal area (every mounted pane hidden; with no live sessions the
    // blank is permanent). The round-86 "review closed history" intent died
    // with round-113; a closed tab click is now a no-op.
    setSessions((prev) => {
      const target = prev.find((s) => s.sid === sid);
      if (!target || target.closed) return prev;
      setActiveSid(sid);
      return prev.map((s) => ({ ...s, active: s.sid === sid }));
    });
  }, []);

  const exportSession = useCallback((sid: string) => {
    // review #7: ONE read returns at most 1 MiB (the spill cap tail-clamps)
    // — long sessions exported as a truncated slice with no marker. Page
    // the retained history with the returned END cursor (bounded: 64 MiB).
    (async () => {
      try {
        const parts: string[] = [];
        let offset = 0;
        for (let i = 0; i < 64; i++) {
          const r: any = await callTool("terminal_read", { session_id: sid, offset, clean: true });
          const text = (r && r.text) || "";
          if (!text) break;
          parts.push(text);
          const end = Number(r.end ?? 0);
          if (!Number.isFinite(end) || end <= offset) break;
          offset = end;
        }
        const blob = new Blob([parts.join("")], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${sid}.log`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch {
        setStatusState("export failed");
      }
    })();
  }, [setStatusState]);

  return { sessions, activeSid, status, setStatus, openSession, closeSession, activate, exportSession, runtimes };
}
