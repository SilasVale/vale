import { useCallback, useEffect, useRef, useState } from "react";
import { callApi, callTool } from "../lib/api";

// Session state (migrated from panel.js) — the xterm instance + render
// cursor live OUTSIDE React state (imperative, heavy); React tracks only the
// session list + metadata. The term object is attached to a ref map so the
// render cycle never re-creates it.

/** Map the agent's snake_case pending_approval onto the camelCase shape React
 *  uses. One helper because THREE call sites need it (first sight, revive,
 *  refresh) and three hand-written mappings would drift — the panel would then
 *  show a prompt for a command the agent had already released. */
/** Grants arrive as a plain array of first words. Anything that is not a
 *  non-empty string is dropped rather than rendered: the UI must never show a
 *  grant it could not revoke by the same string. */
/** A goal is a non-empty string or nothing. An empty or whitespace-only value
 *  from the server would render as a blank objective, which is worse than no
 *  objective: it looks like one was set. */
function mapGoal(s: any): string | null {
  const g = s?.goal;
  return typeof g === "string" && g.trim().length > 0 ? g : null;
}

/** The plan arrives as an array of step labels; same filtering discipline as
 *  grants, so the UI never renders a step it could not match back. */
function mapPlan(s: any): string[] {
  const p = s?.plan;
  if (!Array.isArray(p)) return [];
  return p.filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
}

function mapGrants(s: any): string[] {
  const g = s?.approval_grants;
  if (!Array.isArray(g)) return [];
  return g.filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
}

/** A question the device is holding open for a person to answer.
 *
 *  `expiresAtMs` is an ABSOLUTE wall-clock deadline, not the device's remaining
 *  budget. The device reports `expires_in_ms` — a countdown that SHRINKS on
 *  every read — and a component that keeps that number while also accumulating
 *  its own elapsed time counts the same seconds twice: with the old 60 s block
 *  a 2 s poll made the display fall at roughly double speed, which is fatal at
 *  the gate's real ~15-minute TTL (the operator would be told the question had
 *  minutes left when it had half an hour, or the reverse). Converting ONCE, at
 *  the edge where the wire shape is read, leaves the display with one honest
 *  number that only the clock moves. */
export interface PendingApproval {
  id: string;
  command: string;
  expiresAtMs: number;
}

export function mapPending(s: any): PendingApproval | null {
  const p = s?.pending_approval;
  if (!p || typeof p.id !== "string") return null;
  const budget = typeof p.expires_in_ms === "number" && Number.isFinite(p.expires_in_ms)
    ? Math.max(0, p.expires_in_ms)
    : 0;
  return {
    id: p.id,
    command: typeof p.command === "string" ? p.command : "",
    expiresAtMs: Date.now() + budget,
  };
}

/** How many sessions are holding a question for the operator right now.
 *
 *  Keyed on `pendingApproval`, NEVER on `approvalRequired`: the gate being armed
 *  is a standing posture (every command will ask), while a pending approval is
 *  an actual decision waiting. A badge driven by "armed" would make every armed
 *  session shout permanently — and an indicator that is always on is one nobody
 *  reads. Closed tombstones are excluded: their question is history. */
export function pendingApprovalCount(sessions: Session[]): number {
  return sessions.filter((s) => !s.closed && s.pendingApproval).length;
}

export interface Session {
  sid: string;
  label: string;
  kind: string;
  closed: boolean;
  savedOnly: boolean;
  active: boolean;
  openedAt: number;
  closedAt: number | null;
  /** A PERSON holds this session's keyboard (control handoff). Server-owned
   *  state mirrored here: the agent refuses `terminal_execute` while it is set,
   *  so the panel must SHOW it or the operator cannot tell why the AI stopped. */
  heldByHuman: boolean;
  /** The session is ARMED: every execute waits for a decision. Server-owned. */
  approvalRequired: boolean;
  /** The command currently blocked at the gate, if any. Present only while a
   *  decision is actually being waited for — the agent clears it on every exit
   *  path, so a rendered prompt is always a live question. */
  pendingApproval: PendingApproval | null;
  /** First words allowed without asking. Server-owned and derived from commands
   *  the operator approved, so the panel's job is to SHOW them: a grant nobody
   *  can see is one nobody can judge or revoke, and these decide what runs. */
  approvalGrants: string[];
  /** What the operator asked this session to achieve, if they said. Server-owned:
   *  the goal is the anchor a run is judged against, so the panel must show the
   *  stored value rather than whatever was last typed. */
  goal: string | null;
  /** The AGENT's declared plan: what it intends to do, in order. Distinct from
   *  `goal`, which is the operator's. Showing both is what makes a divergence
   *  visible — the plan says five steps, the path shows three plus two nobody
   *  announced. */
  plan: string[];
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

// P1-4: export downloads at most this many 1 MiB pages (see exportSession).
export const MAX_EXPORT_PAGES = 16;

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
              next.push({ sid: s.id, label: s.label || s.id, kind: s.kind || "pty", closed: false, savedOnly: false, active: false, openedAt: Date.now(), closedAt: null, heldByHuman: !!s.held_by_human,
                approvalRequired: !!s.approval_required, pendingApproval: mapPending(s),
                approvalGrants: mapGrants(s), goal: mapGoal(s), plan: mapPlan(s) });
            } else if (existing.closed) {
              // round-245 (terminal-display audit HIGH-1): REVIVE a tombstone
              // whose sid reappears live. A fast AI session (open → one
              // command → exit) used to be tombstoned by a list that raced
              // the agent's close emit, and NOTHING ever revived it — the tab
              // sat dead forever (activate() refuses closed entries). A live
              // reappearance means the session is real: un-tombstone it.
              const revived = { ...existing, closed: false, closedAt: null,
                heldByHuman: !!s.held_by_human, approvalRequired: !!s.approval_required,
                pendingApproval: mapPending(s), approvalGrants: mapGrants(s), goal: mapGoal(s),
                plan: mapPlan(s) };
              next[next.indexOf(existing)] = revived;
            } else if (
              existing.heldByHuman !== !!s.held_by_human ||
              existing.approvalRequired !== !!s.approval_required ||
              existing.pendingApproval?.id !== mapPending(s)?.id
              || existing.approvalGrants.join("\u0000") !== mapGrants(s).join("\u0000")
              || existing.goal !== mapGoal(s)
              || existing.plan.join("\u0000") !== mapPlan(s).join("\u0000")
            ) {
              // The hold is server-owned and can change WITHOUT a sessions-changed
              // event (this panel's own control button, or another client).
              // Syncing it here is what keeps the indicator honest. Placed AFTER
              // the revive branch on purpose: a closed tombstone whose hold
              // differs must still be REVIVED, not merely have its flag synced.
              next[next.indexOf(existing)] = {
                ...existing,
                heldByHuman: !!s.held_by_human,
                approvalRequired: !!s.approval_required,
                pendingApproval: mapPending(s),
                approvalGrants: mapGrants(s),
                goal: mapGoal(s),
                plan: mapPlan(s),
              };
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
            next.push({ sid: s.id, label: s.label || s.id, kind: s.kind || "pty", closed: false, savedOnly: false, active: false, openedAt: Date.now(), closedAt: null, heldByHuman: !!s.held_by_human,
                approvalRequired: !!s.approval_required, pendingApproval: mapPending(s),
                approvalGrants: mapGrants(s), goal: mapGoal(s), plan: mapPlan(s) });
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

  // FAST POLL while the gate is armed — SEPARATE from the effect above, because
  // it must be able to start and stop as the mode changes without tearing down
  // the event listeners.
  //
  // WHAT IT IS FOR, now that the question lives for the gate's full TTL
  // (~15 minutes) instead of a one-minute block: DISCOVERY, not rescue. The 30 s
  // background sweep would still find a question eventually, but "eventually" is
  // up to 30 s of the operator staring at a session that is already waiting —
  // and the decision is theirs to make in the first seconds. 2 s also notices
  // RETIREMENT promptly, so an expired question clears instead of sitting there.
  // (The old comment here justified 2 s as "well inside the agent's one-minute
  // window"; that window is gone, and the reason above is the one that survived.)
  //
  // Gated on being armed, so an idle panel still polls nothing — the same "poll
  // only when needed" discipline as round-163, which removed a 3 s poll in
  // favour of events.
  const armed = sessions.some((s) => s.approvalRequired);
  useEffect(() => {
    if (!armed) return;
    // Re-fires the SAME event the agent's SSE pushes, rather than calling the
    // refresh directly: the listener above already owns the retry, the tombstone
    // and the revive rules, and a second call path would be a second copy of them.
    const fast = window.setInterval(() => {
      window.dispatchEvent(new CustomEvent("vale-sessions-changed"));
    }, 2000);
    return () => window.clearInterval(fast);
  }, [armed]);

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
        return [...prev.filter((s) => s.sid !== sid).map((s) => ({ ...s, active: false })), { sid, label, kind, closed: false, savedOnly: false, active: true, openedAt: Date.now(), closedAt: null, heldByHuman: false, approvalRequired: false, pendingApproval: null, approvalGrants: [], goal: null, plan: [] }];
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
    // the retained history with the returned END cursor.
    // P1-4 (export backpressure): bound the download (a 64 MiB Blob build
    // froze the tab on huge AI sessions) and SAY SO — a truncation marker
    // goes into the file tail plus a status-line prompt.
    (async () => {
      try {
        const parts: string[] = [];
        let offset = 0;
        let truncated = false;
        for (let i = 0; i < MAX_EXPORT_PAGES; i++) {
          const r: any = await callTool("terminal_read", { session_id: sid, offset, clean: true });
          const text = (r && r.text) || "";
          if (!text) break;
          parts.push(text);
          const end = Number(r.end ?? 0);
          if (!Number.isFinite(end) || end <= offset) break;
          offset = end;
          if (i === MAX_EXPORT_PAGES - 1) {
            // Loop exhausted with the cursor still advancing — probe once to
            // tell "stopped exactly at the end" from "more history pending".
            try {
              const probe: any = await callTool("terminal_read", { session_id: sid, offset, clean: true });
              if (probe && probe.text) truncated = true;
            } catch { /* probe failed — treat the export as complete */ }
          }
        }
        if (truncated) parts.push(`\n…[export truncated at ${MAX_EXPORT_PAGES} MiB — read the full log via terminal_read offset ${offset}]…\n`);
        const blob = new Blob([parts.join("")], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${sid}.log`;
        a.click();
        URL.revokeObjectURL(a.href);
        if (truncated) setStatusState(`export truncated at ${MAX_EXPORT_PAGES} MiB — the file tail says where to continue reading`);
      } catch {
        setStatusState("export failed");
      }
    })();
  }, [setStatusState]);

  /** Hand the session's keyboard to a person, or back to the AI.
   *
   *  The agent owns this state; the response is the authority, so the local flag
   *  is set from what the SERVER reports rather than from what was requested.
   *  A failed call leaves the flag alone and surfaces the error — a button that
   *  flipped optimistically would tell the operator they hold a keyboard the
   *  agent is still driving, which is worse than showing nothing. */
  const setControl = useCallback(async (sid: string, human: boolean) => {
    try {
      const r = await callApi(`/api/sessions/${encodeURIComponent(sid)}/control`, {
        method: "POST",
        body: JSON.stringify({ holder: human ? "human" : "ai" }),
      });
      const held = !!r?.held_by_human;
      setSessions((prev) =>
        prev.map((s) => (s.sid === sid ? { ...s, heldByHuman: held } : s)),
      );
      setStatusState(held ? "you have the keyboard" : "AI may drive this session");
      return held;
    } catch (e: any) {
      setStatusState(`control failed: ${e?.message ?? e}`);
      throw e;
    }
  }, []);

  /** Arm or disarm the approval gate for a session.
   *
   *  Like `setControl`, the SERVER's answer is the authority: a button that
   *  flipped optimistically would tell the operator the gate is armed while the
   *  agent still runs commands unattended — the one direction of error that
   *  matters here. */
  const setApproval = useCallback(async (sid: string, required: boolean) => {
    try {
      const r = await callApi(`/api/sessions/${encodeURIComponent(sid)}/control`, {
        method: "POST",
        body: JSON.stringify({ approval_required: required }),
      });
      const on = !!r?.approval_required;
      setSessions((prev) =>
        prev.map((s) => (s.sid === sid ? { ...s, approvalRequired: on } : s)),
      );
      setStatusState(on ? "approval required for this session" : "approval gate off");
      return on;
    } catch (e: any) {
      setStatusState(`approval mode failed: ${e?.message ?? e}`);
      throw e;
    }
  }, []);

  /** Answer a pending approval.
   *
   *  `decided: false` means there was nothing left to decide — the agent gave up
   *  or another client answered first. That is NOT success, so the status says
   *  so rather than leaving the operator believing their click landed. */
  const decideApproval = useCallback(async (
    sid: string,
    id: string,
    approve: boolean,
    grant = false,
  ) => {
    try {
      const r = await callApi(`/api/sessions/${encodeURIComponent(sid)}/approval`, {
        method: "POST",
        body: JSON.stringify({ id, approve, grant }),
      });
      if (!r?.decided) {
        setStatusState("that request was already resolved");
        return false;
      }
      // Grants come back on the decision's own response, so the list updates
      // immediately rather than one poll later.
      if (Array.isArray(r?.approval_grants)) {
        const g: string[] = r.approval_grants;
        setSessions((prev) =>
          prev.map((s) => (s.sid === sid ? { ...s, approvalGrants: g } : s)),
        );
      }
      setStatusState(
        approve ? (grant ? "approved, and remembered" : "approved") : "refused",
      );
      return true;
    } catch (e: any) {
      setStatusState(`decision failed: ${e?.message ?? e}`);
      throw e;
    }
  }, []);

  /** State the session's goal, or clear it with an empty string.
   *
   *  The SERVER's stored value is what lands in state, so a goal that was trimmed
   *  or capped comes back as what is actually in force rather than as what was
   *  typed. */
  const setGoal = useCallback(async (sid: string, goal: string) => {
    try {
      const r = await callApi(`/api/sessions/${encodeURIComponent(sid)}/control`, {
        method: "POST",
        body: JSON.stringify({ goal }),
      });
      const stored = typeof r?.goal === "string" && r.goal.trim() ? r.goal : null;
      setSessions((prev) => prev.map((s) => (s.sid === sid ? { ...s, goal: stored } : s)));
      setStatusState(stored ? "goal set" : "goal cleared");
      return stored;
    } catch (e: any) {
      setStatusState(`goal failed: ${e?.message ?? e}`);
      throw e;
    }
  }, []);

  /** Revoke one grant, or all of them. The SERVER's list is the answer, so a
   *  revoke that did not land cannot leave the panel showing it as gone. */
  const revokeGrants = useCallback(async (sid: string, grant?: string) => {
    try {
      const r = await callApi(`/api/sessions/${encodeURIComponent(sid)}/grants`, {
        method: "POST",
        body: JSON.stringify(grant === undefined ? { all: true } : { grant }),
      });
      const g: string[] = Array.isArray(r?.approval_grants) ? r.approval_grants : [];
      setSessions((prev) =>
        prev.map((s) => (s.sid === sid ? { ...s, approvalGrants: g } : s)),
      );
      setStatusState(
        grant === undefined ? "all allowances revoked" : `no longer allowing ${grant}`,
      );
      return g;
    } catch (e: any) {
      setStatusState(`revoke failed: ${e?.message ?? e}`);
      throw e;
    }
  }, []);

  return { sessions, activeSid, status, setStatus, openSession, closeSession, activate, exportSession, runtimes, setControl, setApproval, decideApproval, revokeGrants, setGoal };
}
