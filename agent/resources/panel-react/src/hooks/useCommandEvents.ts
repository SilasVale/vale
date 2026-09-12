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
  /** command/start only: WHY the agent ran this, in its own words (optional). */
  intent?: string | null;
  /** command/start only: the alternatives it says it passed over. */
  considered?: string[] | null;
  /** command/start only: the 1-based plan step this command advances. */
  plan_step?: number | null;
  /** command/start only: the run this command was executed under, as the AI
   *  named it via `run_begin`. Present on the wire since runs were introduced;
   *  undeclared here until round 30, which is why the trail silently dropped an
   *  attribution the device had already recorded.
   *
   *  A LABEL, NEVER A CREDENTIAL (`runs.rs` pins this twice): it says which
   *  execution the AI CLAIMED this belonged to, and it is presented as that
   *  claim — never as a verified grouping. */
  run_id?: string | null;
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
 * How the last completed read of a session's audit log went.
 *
 *   "reading"     — no completed read yet for this sid (initial, or just switched)
 *   "ok"          — the last read SUCCEEDED. Note this says nothing about how
 *                   many events came back: a successful read of an empty file is
 *                   "ok" with zero events, and that is a DIFFERENT fact from a
 *                   read that failed. Collapsing the two is how an unreadable
 *                   session renders as "this session recorded nothing".
 *   "unreadable"  — the read failed and NO read of this sid has ever succeeded.
 *                   A failure AFTER a good read keeps "ok": the audit log is
 *                   append-only, so the events already in hand are still true.
 *
 * EVERY VIEW THAT RENDERS AN EMPTY TRAIL NEEDS THIS, not just the archive. It
 * said the live views "ignore it, exactly as they ignore the failed poll" — and
 * that is what they did, so they told the operator a session had run nothing
 * while the read was still in flight or had failed outright. `lib/trailRead.ts`
 * owns the wording; the field is REQUIRED on the slice `App` hands to them so a
 * mount cannot forget it again.
 */
export type SessionReadState = "reading" | "ok" | "unreadable";

/**
 * READ the audit log of one session and return the RAW events (in seq order)
 * together with the read state above. Not "poll": there is no timer — the 5 s
 * cadence was removed in round 163, and `pollMs` survives only as an effect
 * dependency, so a caller-supplied value has no effect on anything. Kept as a
 * parameter because removing it is a wider change than correcting the sentence.
 * Shared by the command-card grouping (useCommandEvents) and the trajectory
 * timeline (useTrajectory) — both consume /api/sessions/{sid} with the same
 * polling semantics. A FAILED poll (tunnel blip, agent restarting) keeps the
 * last good events instead of blanking the stream (same stance as
 * useSessions' poll). No polling while sid is null.
 */
export function useSessionEventsWithState(
  sid: string | null,
  pollMs = 2000,
): { events: CommandEvent[]; readState: SessionReadState; firstSeq: number } {
  const [events, setEvents] = useState<CommandEvent[]>([]);
  const [readState, setReadState] = useState<SessionReadState>("reading");
  // WHERE THE RECORD BEGINS, as the device reports it. The trail is trimmed to
  // ~2000 lines when a session closes, so a long session's head is discarded by
  // design — `firstSeq > 1` is the only signal, and a viewer that ignores it
  // presents a trimmed trail as the whole story.
  const [firstSeq, setFirstSeq] = useState(1);
  // Has ANY read of this sid succeeded? A failed later poll must not overwrite a
  // known-good state (and with an empty-but-readable session, `events.length`
  // cannot answer this — hence a ref of its own).
  const readOkRef = useRef(false);
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
    readOkRef.current = false;
    setEvents([]);
    setReadState("reading");
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
        // A COMPLETED read — mark it before the "nothing new" guard below,
        // which also short-circuits the ordinary case of a quiet session. The
        // guard is about re-rendering, not about whether the device answered.
        readOkRef.current = true;
        // The DEVICE now answers the question the client used to have to
        // hedge: `found:false` means there is no readable record for this id
        // (retention, another data dir, a stale id), which is NOT the same as
        // a session that recorded nothing. Without this the viewer would draw
        // an empty trail for a session whose file is simply gone.
        //
        // Only authoritative when the field is PRESENT: an older agent omits
        // it, and then the HTTP-level success is all we know — which is what
        // `readOkRef` already records.
        const found = res && typeof res.found === "boolean" ? res.found : true;
        // Absent on an older agent: default to 1, which claims nothing.
        const fs = res && typeof res.first_seq === "number" ? res.first_seq : 1;
        setFirstSeq((prev) => (prev === fs ? prev : fs));
        setReadState((s) => {
          if (!found) return "unreadable";
          return s === "ok" ? s : "ok";
        });
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
      } catch {
        // Transient for a live session — keep the last good events, retry next
        // tick. But a read that has NEVER succeeded is a different fact, and
        // the archive viewer must be able to say so instead of drawing the
        // session as one that recorded nothing.
        if (!readOkRef.current) setReadState((s) => (s === "unreadable" ? s : "unreadable"));
      }
    };
    tick();
    // round-163: no timer — the audit log refetches when THIS session
    // produces terminal output (debounced) or the tab regains focus. A
    // silent command still lands its cards on the next output burst.
    let timer: number | undefined;
    // SPA audit MED-3: the pure trailing-edge debounce STARVED under
    // continuous output (every burst byte-stream re-armed the 1s timer —
    // during builds/serial floods the cards froze). Max-wait pattern: a
    // pending refresh older than 5s runs immediately.
    let armedAt = 0;
    const onOutput = (e: Event) => {
      const sid = (e as CustomEvent).detail?.sid;
      if (sid !== sidRef.current) return; // another session's output
      const now = Date.now();
      if (!armedAt) armedAt = now;
      if (timer) window.clearTimeout(timer);
      if (now - armedAt >= 5000) {
        armedAt = 0;
        timer = undefined;
        void tick();
        return;
      }
      timer = window.setTimeout(() => {
        armedAt = 0;
        timer = undefined;
        void tick();
      }, 1000);
    };
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    window.addEventListener("vale-term-output", onOutput);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("vale-term-output", onOutput);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) window.clearTimeout(timer);
    };
  }, [sid, pollMs]);

  return { events, readState, firstSeq };
}

/** The raw events alone — the shape the trajectory views and their tests have
 *  always taken. Kept as its own export so adding the read state could not
 *  change what an existing consumer sees. */
export function useSessionEvents(sid: string | null, pollMs = 2000): CommandEvent[] {
  return useSessionEventsWithState(sid, pollMs).events;
}

/**
 * Command card stream for one session: READ the audit log (useSessionEvents) and
 * group the raw events into cards. A FAILED read keeps the last good cards
 * instead of blanking the stream.
 *
 * NOTHING HERE IS POLLED, and both sentences above used to say otherwise ("Cards
 * update every poll", "a FAILED poll"). The 5 s cadence was removed in round 163;
 * what re-reads is the SSE-driven path in `App` and the caller's own effect. The
 * `pollMs` parameter is inert — it appears only in one effect's dependency array,
 * so passing a different value changes no schedule. It is kept because removing a
 * parameter is a wider change than telling the truth about it, and a test that
 * "polls" at 30 ms cannot be used as evidence of a cadence that does not exist.
 */
export function useCommandEvents(sid: string | null, pollMs = 2000) {
  // round-128: the raw events are exposed so the trajectory view reuses THIS
  // read instead of mounting a second one (double fetch every 2s). `readState`
  // is the third thing the same read knows (see SessionReadState) — the archive
  // viewer needs it to tell an empty trail from an unreadable one.
  const { events, readState, firstSeq } = useSessionEventsWithState(sid, pollMs);
  const cards = useMemo(() => groupEvents(events), [events]);
  return { cards, events, readState, firstSeq };
}
