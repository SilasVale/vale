import { useEffect, useMemo, useRef, useState } from "react";
import { callApi } from "../lib/api";
import { stripAnsi } from "../lib/ansi";

// Command event stream for one session (round-admin-ui Task 4): polls
// GET /api/sessions/{sid} — the audit JSONL (command/start → output →
// command/end, per session_log.rs SessionEvent) — and groups the raw events
// into command cards. The grouping mirrors the agent's round-99/100 terminal
// markers (session_log.rs recover_interrupted): a command is ENDED by
// command/end OR by a status of "backgrounded" / "closed" / "exited:N" — a
// backgrounded command never logs command/end, and a session that dies logs
// "closed" / "exited:<code>" instead. Other status values ("opened", …) are
// session-level and do not end a command.
//
// The cards feed the command card stream + details panel; all rendering
// downstream is TEXT-ONLY (never innerHTML).

export interface CommandEvent {
  seq: number;
  ts: number;
  kind: string;
  command?: string;
  text?: string;
  exit_code?: number | null;
  reason?: string | null;
  status?: string | null;
  duration_ms?: number | null;
}

export interface CommandCard {
  /** `c-<start seq>` — stable across polls (selection survives re-fetch). */
  id: string;
  seq: number;
  command: string;
  /** Accumulated output text (tail-capped, see MAX_OUTPUT_CHARS). */
  output: string;
  /** Unix seconds of command/start. */
  startedAt: number;
  ended: boolean;
  exitCode: number | null;
  reason: string | null; // marker / idle / timeout / interrupted / backgrounded / closed / exited:N
  durationMs: number | null;
}

// Per-card accumulation cap: a long-running command (tail -f, loops, binary
// streams) can produce unbounded output — the audit file itself caps each
// chunk at 4 KiB but not the total while the session is open. Keep the card's
// memory bounded; the TAIL wins (the newest output is what the operator
// needs to see; the audit file on disk still holds the head).
const MAX_OUTPUT_CHARS = 1_000_000;
// round-128: tail cap for the raw event array (see setEvents below).
const MAX_RAW_EVENTS = 20_000;
const TRUNC_MARK = "\n…[output truncated — older lines dropped]…\n";

/** Map a status event's value to a command end, or null if session-level.
 *  Exported for the trajectory view (useTrajectory) — the round state uses
 *  the same round-99/100 terminal markers. */
export function terminalStatus(st: string): { exitCode: number | null; reason: string } | null {
  if (st === "backgrounded" || st === "closed") return { exitCode: null, reason: st };
  if (st.startsWith("exited:")) {
    const code = Number(st.slice("exited:".length));
    return { exitCode: Number.isFinite(code) ? code : null, reason: st };
  }
  return null;
}

function finishCard(start: CommandEvent, outputs: string[], ended: boolean, exitCode: number | null, reason: string | null, durationMs: number | null): CommandCard {
  // Raw SSE bytes carry ANSI/OSC control sequences — strip for text cards.
  let output = stripAnsi(outputs.join(""));
  if (output.length > MAX_OUTPUT_CHARS) output = TRUNC_MARK + output.slice(-MAX_OUTPUT_CHARS);
  return {
    id: `c-${start.seq}`,
    seq: start.seq,
    command: start.command ?? "",
    output,
    startedAt: start.ts,
    ended,
    exitCode,
    reason,
    durationMs,
  };
}

/** Group a session's raw audit events (in seq order) into command cards. */
export function groupEvents(events: CommandEvent[]): CommandCard[] {
  const cards: CommandCard[] = [];
  let start: CommandEvent | null = null;
  let outputs: string[] = [];

  for (const ev of events) {
    switch (ev.kind) {
      case "command/start": {
        // A new start while the previous command never ended — close it as
        // interrupted so it can't stay "running" forever (recovery appends
        // interrupted server-side, but a mid-stream start must not orphan
        // the prior card).
        if (start) cards.push(finishCard(start, outputs, true, null, "interrupted", null));
        start = ev;
        outputs = [];
        break;
      }
      case "output": {
        if (start && ev.text) outputs.push(ev.text);
        break;
      }
      case "command/end": {
        if (start) {
          cards.push(finishCard(start, outputs, true, ev.exit_code ?? null, ev.reason ?? null, ev.duration_ms ?? null));
          start = null;
          outputs = [];
        }
        break;
      }
      case "status": {
        if (!start || !ev.status) break;
        const term = terminalStatus(ev.status);
        if (term) {
          // Status ends carry no duration_ms — derive it from the event ts
          // (round-58 unit: ms).
          cards.push(finishCard(start, outputs, true, term.exitCode, term.reason, (ev.ts - start.ts) * 1000));
          start = null;
          outputs = [];
        }
        break;
      }
    }
  }
  // A trailing start with no end: still running (or the agent died before
  // recovery appended interrupted) — surface it as a LIVE card.
  if (start) cards.push(finishCard(start, outputs, false, null, null, null));
  return cards;
}

/**
 * Poll the audit log of one session and return the RAW events (in seq order).
 * Shared by the command-card grouping (useCommandEvents) and the trajectory
 * timeline (useTrajectory) — both consume /api/sessions/{sid} with the same
 * polling semantics. A FAILED poll (tunnel blip, agent restarting) keeps the
 * last good events instead of blanking the stream (same stance as
 * useSessions' poll). No polling while sid is null.
 */
export function useSessionEvents(sid: string | null, pollMs = 2000): CommandEvent[] {
  const [events, setEvents] = useState<CommandEvent[]>([]);
  // A fetch in flight when the sid switches must not land its result under
  // the new session's stream — tick() checks the live sid before setState.
  const sidRef = useRef(sid);
  sidRef.current = sid;
  // Skip re-render when no new events arrived since the last poll (the
  // audit log is append-only; seq is per-session monotonic, seeded from the
  // file's max seq on agent restart — it never regresses while a file is
  // appended, and trim keeps the tail's max seq).
  const lastSeqRef = useRef(0);
  // Session switch: drop the previous session's events + seq watermark
  // SYNCHRONOUSLY (render-time ref diff) — no stale frame from the old
  // stream, and the new session's lower seqs can't be skipped by the guard.
  const lastSidRef = useRef(sid);
  if (lastSidRef.current !== sid) {
    lastSidRef.current = sid;
    lastSeqRef.current = 0;
    setEvents([]);
  }

  useEffect(() => {
    if (!sid) return; // nothing to poll; clearing already happened on switch
    const tick = async () => {
      if (sidRef.current !== sid) return; // stale tick after a sid switch
      try {
        const res = await callApi(`/api/sessions/${encodeURIComponent(sid)}`);
        // round-138: re-check AFTER the await — a slow poll for the OLD
        // session resolving after the user switched would land the old
        // session's events under the new tab and poison its seq watermark
        // (new session's polls then always return 'nothing new').
        if (sidRef.current !== sid) return;
        const evs: CommandEvent[] = res && Array.isArray(res.events) ? res.events : [];
        let maxSeq = 0;
        for (const e of evs) maxSeq = Math.max(maxSeq, e.seq || 0);
        // `<=` not `===`: a degraded response (empty/malformed events,
        // transient blip that returns a 200 shell) must NOT rewind the
        // watermark and blank the stream — the audit log only grows.
        if (maxSeq <= lastSeqRef.current) return; // nothing new
        lastSeqRef.current = maxSeq;
        // round-128/129: tail-cap the RAW events — a chatty long-lived
        // session (serial console ~11.5KB/s → ~40MB/hour) grew browser
        // memory unbounded. The cap respects ROUND BOUNDARIES: a command
        // still running at the cut point must keep its command/start, or
        // groupEvents drops the whole live card (output without a start is
        // discarded) and the trajectory relabels it '(session)'.
        let tail = evs;
        if (tail.length > MAX_RAW_EVENTS) {
          const cut = tail.length - MAX_RAW_EVENTS;
          // Walk back to the newest command/start at or before the cut
          // (keep a running round's start so the live card isn't orphaned).
          let start = cut;
          for (let i = cut; i >= 0; i--) {
            if (tail[i].kind === "command/start") { start = i; break; }
          }
          tail = tail.slice(start);
          // round-131: if the anchored round STILL exceeds the cap (one
          // command running for the whole window — no newer start ever
          // appears), drop the round's OLDEST output events, keeping the
          // start (groupEvents/groupRounds need it for the live card).
          // The audit file on the server still holds the full history.
          if (tail.length > MAX_RAW_EVENTS) {
            const keep = tail.filter((e, i) => i === 0 || i >= tail.length - MAX_RAW_EVENTS);
            tail = keep;
          }
        }
        setEvents(tail);
      } catch { /* transient — keep the last good events, retry next tick */ }
    };
    tick();
    const t = window.setInterval(tick, pollMs);
    return () => clearInterval(t);
  }, [sid, pollMs]);

  return events;
}

/**
 * Command card stream for one session: poll the audit log (useSessionEvents)
 * and group the raw events into cards. Cards update every poll; a FAILED
 * poll keeps the last good cards instead of blanking the stream.
 */
export function useCommandEvents(sid: string | null, pollMs = 2000) {
  const events = useSessionEvents(sid, pollMs);
  const cards = useMemo(() => groupEvents(events), [events]);
  // round-128: expose the raw events so the trajectory view reuses THIS
  // poll instead of mounting a second one (double fetch every 2s).
  return { cards, events };
}
