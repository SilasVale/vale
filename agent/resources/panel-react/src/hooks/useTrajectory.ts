import { useMemo } from "react";
import { terminalStatus, useSessionEvents } from "./useCommandEvents";
import type { CommandEvent } from "./useCommandEvents";

// Trajectory (round-admin-ui Task 5): the RAW audit event timeline for a
// session, grouped into rounds (one per command/start). This is a raw view
// distinct from the grouped command cards: status events like "opened" /
// "backgrounded" stay visible as their own rows, and a round's end state
// derives from the same round-99/100 terminal markers the cards use
// (command/end, or a status of backgrounded / closed / exited:N). Events
// before the first command/start (session-level statuses) form the preamble
// round.

export interface TrajRound {
  /** `r-<start seq>`; `r-pre` for the preamble (no command/start). */
  id: string;
  /** seq of the round's command/start; null for the preamble round. */
  startSeq: number | null;
  /** The round's command; "(session)" for the preamble. */
  command: string;
  /** Unix seconds of the round's first event. */
  startTs: number;
  /** All events in the round, in seq order (includes the command/start). */
  events: CommandEvent[];
  ended: boolean;
  exitCode: number | null;
  reason: string | null;
  durationMs: number | null;
}

/**
 * Group the raw audit events into rounds — a command/start opens a round, the
 * next command/start opens the next. A round is ENDED by a command/end OR by
 * a terminal status (backgrounded / closed / exited:N — the same round-99/100
 * markers as groupEvents); the LAST marker in the round wins (a backgrounded
 * command can later log closed). A trailing round with no marker stays live.
 * Unlike groupEvents, a superseded round is sealed as-is (raw view: what the
 * log says) — in a well-formed log the prior command always ended before the
 * next start, and recovery appends `interrupted` after a crash.
 */
export function groupRounds(events: CommandEvent[]): TrajRound[] {
  const rounds: TrajRound[] = [];
  let pre: CommandEvent[] = []; // events before the first command/start
  let cur: CommandEvent[] | null = null;

  const seal = (evs: CommandEvent[]) => {
    const first = evs[0];
    const isCmd = first.kind === "command/start";
    let ended = false;
    let exitCode: number | null = null;
    let reason: string | null = null;
    let durationMs: number | null = null;
    let endTs: number | null = null;
    for (const ev of evs) {
      if (ev.kind === "command/end") {
        ended = true;
        exitCode = ev.exit_code ?? null;
        reason = ev.reason ?? null;
        durationMs = ev.duration_ms != null ? ev.duration_ms : null;
        endTs = ev.ts;
      } else if (ev.kind === "status" && ev.status) {
        const term = terminalStatus(ev.status);
        if (term) { ended = true; exitCode = term.exitCode; reason = term.reason; endTs = ev.ts; }
      }
    }
    // Status-ended rounds carry no duration_ms — derive it from the marker
    // ts − round start ts (same derivation as groupEvents, round-58 unit: ms).
    if (ended && durationMs == null && endTs != null) durationMs = (endTs - first.ts) * 1000;
    rounds.push({
      id: isCmd ? `r-${first.seq}` : "r-pre",
      startSeq: isCmd ? first.seq : null,
      command: isCmd ? first.command ?? "" : "(session)",
      startTs: first.ts,
      events: evs,
      ended,
      exitCode,
      reason,
      durationMs,
    });
  };

  for (const ev of events) {
    if (ev.kind === "command/start") {
      if (cur) { seal(cur); cur = null; }
      else if (pre.length) { seal(pre); pre = []; }
      cur = [ev];
    } else if (cur) {
      cur.push(ev);
    } else {
      pre.push(ev);
    }
  }
  if (cur) seal(cur);
  else if (pre.length) seal(pre);
  return rounds;
}

/** Poll the session's audit log and group it into trajectory rounds. */
export function useTrajectory(sid: string | null, pollMs = 2000): TrajRound[] {
  const events = useSessionEvents(sid, pollMs);
  return useMemo(() => groupRounds(events), [events]);
}
