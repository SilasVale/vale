import { useEffect, useRef, useState } from "react";
import type { CommandEvent } from "../hooks/useCommandEvents";
import { terminalStatus } from "../hooks/useCommandEvents";
import { useTrajectory } from "../hooks/useTrajectory";
import type { TrajRound } from "../hooks/useTrajectory";
import { cardState, fmtDuration } from "./CommandCard";
import type { CommandCard } from "../hooks/useCommandEvents";

// dsh Trajectory-style raw event timeline (round-admin-ui Task 5): every
// audit event for a session (command/start → output → command/end | status)
// rendered as a timeline, grouped into ROUNDS (one per command/start). Unlike
// the command card stream (grouped summaries), this is the RAW log — status
// events like "opened"/"backgrounded" appear as their own rows. All rendering
// is TEXT-ONLY (React text nodes reach the DOM — never innerHTML).
//
// Pagination is client-side: /api/sessions/{sid} returns the FULL audit log;
// the view shows the newest ROUNDS_PAGE rounds (the tail is what streams,
// anchored like a terminal) and "load earlier" widens the window upward.

const ROUNDS_PAGE = 20;
// Within this many px of the list bottom, new output auto-scrolls (terminal
// follow); scrolled further up, the view stays put.
const STICK_DIST = 80;

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
}

/** Round → dsh StateDot/badge state. Reuses the command-card semantics
 *  (cardState) — a round ends at command/end or a terminal status. The
 *  preamble round (pre-first-command session events, e.g. "opened") never
 *  has a marker: show it muted, not falsely "running". */
function roundState(r: TrajRound): { state: "running" | "ok" | "fail" | "warn" | "muted"; label: string; compact: string } {
  if (r.startSeq === null && !r.ended) return { state: "muted", label: "Session", compact: "session" };
  return cardState({ id: r.id, seq: r.startSeq ?? 0, command: r.command, output: "", startedAt: r.startTs, ended: r.ended, exitCode: r.exitCode, reason: r.reason, durationMs: r.durationMs } as CommandCard);
}

function evMatches(ev: CommandEvent, needle: string): boolean {
  return (ev.text ?? "").toLowerCase().includes(needle)
    || (ev.command ?? "").toLowerCase().includes(needle)
    || (ev.status ?? "").toLowerCase().includes(needle)
    || (ev.reason ?? "").toLowerCase().includes(needle);
}

function roundMatches(r: TrajRound, needle: string): boolean {
  return r.command.toLowerCase().includes(needle) || r.events.some((ev) => evMatches(ev, needle));
}

/** Per-event dot state (timeline rail marker). */
function eventDotState(ev: CommandEvent): "running" | "ok" | "fail" | "warn" | "muted" {
  if (ev.kind === "command/end") return ev.exit_code === 0 ? "ok" : ev.exit_code != null ? "fail" : "muted";
  if (ev.kind === "status" && ev.status) {
    if (ev.status === "backgrounded") return "warn";
    const term = terminalStatus(ev.status);
    if (term) return term.exitCode === 0 ? "ok" : term.exitCode != null ? "fail" : "muted";
  }
  return "muted"; // output / session-level status (opened, …)
}

function EventRow({ ev }: { ev: CommandEvent }) {
  const dot = eventDotState(ev);
  return (
    <div className="traj-ev">
      <span className="traj-ev-time">{fmtTime(ev.ts)}</span>
      <span className="traj-ev-dotcol">
        <span className="traj-ev-rail" />
        <span className="traj-ev-dot" data-state={dot} />
      </span>
      <div className="traj-ev-content">
        {ev.kind === "output" ? (
          <pre className="traj-ev-out">{ev.text}</pre>
        ) : ev.kind === "command/end" ? (
          <span className="traj-ev-end">
            <span className="traj-ev-code" data-state={dot}>exit {ev.exit_code ?? "?"}</span>
            {ev.duration_ms != null && <span> · {fmtDuration(ev.duration_ms)}</span>}
            {ev.reason && <span> · {ev.reason}</span>}
          </span>
        ) : ev.kind === "status" && ev.status ? (
          <span className="cmd-badge traj-ev-status" data-state={dot}>{ev.status}</span>
        ) : (
          <span className="traj-ev-kind">{ev.kind}</span>
        )}
      </div>
    </div>
  );
}

export function TrajectoryView({ sid }: { sid: string }) {
  const rounds = useTrajectory(sid);
  const [query, setQuery] = useState("");
  const [windowCount, setWindowCount] = useState(ROUNDS_PAGE);
  // Explicit user state: collapsed = rounds the user folded, expanded = rounds
  // the user opened. A round with neither is open ONLY if it is the newest
  // (the default: the newest round streams). Two sets are needed because the
  // default is derived — removing a NON-newest round from `collapsed` cannot
  // open it.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastIdsRef = useRef("");

  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;
  const filtered = searching ? rounds.filter((r) => roundMatches(r, needle)) : null;
  const visible = filtered ?? rounds.slice(-windowCount);
  const hasMore = !searching && rounds.length > windowCount;
  const lastVisible = visible[visible.length - 1];

  // Terminal-style follow: while the newest round is still running, keep the
  // list at the bottom — but only if the user hasn't scrolled up (same
  // stick-to-bottom stance as a terminal; the ids guard fires only on new
  // rounds, so a streaming round's own growth stays put).
  useEffect(() => {
    if (!listRef.current || searching) return;
    const ids = visible.map((r) => r.id).join(",");
    if (ids === lastIdsRef.current) return;
    lastIdsRef.current = ids;
    const newest = visible[visible.length - 1];
    if (newest && !newest.ended && stickRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [visible, searching]);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DIST;
  };

  const toggleRound = (id: string, currentlyOpen: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (currentlyOpen) next.add(id); else next.delete(id);
      return next;
    });
    setExpanded((prev) => {
      const next = new Set(prev);
      if (currentlyOpen) next.delete(id); else next.add(id);
      return next;
    });
  };

  const collapseAll = () => {
    setCollapsed(new Set(visible.map((r) => r.id)));
    setExpanded(new Set());
  };

  return (
    <div id="traj-view">
      <div className="traj-header">
        <span className="traj-title">Trajectory</span>
        <span className="traj-count">{rounds.length}</span>
        <input
          className="traj-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter output…"
          aria-label="Filter trajectory"
          autoComplete="off"
        />
        <button
          className="cmd-btn traj-collapse"
          title={searching ? "Search active — matching rounds stay expanded" : "Collapse all rounds"}
          disabled={searching}
          onClick={collapseAll}
        >Collapse all</button>
      </div>
      <div className="traj-list" ref={listRef} onScroll={onListScroll}>
        {visible.length === 0 ? (
          <p className="traj-empty">{searching ? "No matching events." : "No commands in this session yet."}</p>
        ) : (
          <>
            {hasMore && (
              <button
                className="traj-earlier"
                title="Show the next older page of rounds"
                onClick={() => setWindowCount((n) => n + ROUNDS_PAGE)}
              >Load earlier — {rounds.length - windowCount} more round{rounds.length - windowCount === 1 ? "" : "s"}</button>
            )}
            {visible.map((r) => {
              const st = roundState(r);
              const isLast = r === lastVisible;
              // Default: only the newest round expands (it is what streams);
              // searching expands every match. "Collapse all" is a snapshot —
              // a later new round still streams expanded.
              const open = searching || expanded.has(r.id) || (!collapsed.has(r.id) && isLast);
              // The command/start is the round HEAD — skip its duplicate row
              // inside the body (its rail dot would falsely pulse "running").
              const shown = (searching ? r.events.filter((ev) => evMatches(ev, needle)) : r.events)
                .filter((ev) => ev.kind !== "command/start");
              return (
                <div key={r.id} className={`traj-round${open ? " open" : ""}`}>
                  <div
                    className="traj-round-head"
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => toggleRound(r.id, open)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleRound(r.id, open); }
                    }}
                  >
                    <span className="traj-chev">▸</span>
                    <span className="cmd-dot" data-state={st.state} />
                    <span className="traj-round-cmd" title={r.command}>{r.command}</span>
                    <span className="cmd-duration">{fmtDuration(r.ended ? r.durationMs : Date.now() - r.startTs * 1000)}</span>
                    <span className="cmd-badge" data-state={st.state}>{st.compact}</span>
                  </div>
                  {open && (
                    <div className="traj-body">
                      <div className="traj-evs">
                        {shown.length === 0 ? (
                          <p className="traj-empty-inline">{searching ? "No matching rows in this round." : "(no output yet)"}</p>
                        ) : shown.map((ev) => <EventRow key={ev.seq} ev={ev} />)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
