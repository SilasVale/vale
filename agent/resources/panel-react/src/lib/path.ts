// lib/path.ts — derive the PATH of a session from its audit rounds.
//
// WHY THIS EXISTS (design: docs/adr/proposal-game-design.md §2.1, §7).
//
// The design's central claim is that Vale records tool calls and the operator
// thinks in goals, and the layer between them is empty. This module builds the
// smallest honest piece of that layer: one session's work as a single scannable
// PATH with a summary, instead of a timeline the operator has to read and count.
//
// WHAT IT DELIBERATELY DOES NOT DO — and this is the important part.
//
// The prototype on branch `prototype/control-path` drew each step with the
// ALTERNATIVES that were legal at that moment ("ghost branches"). That
// information DOES NOT EXIST in the audit trail; it needs the control plane's
// gate records (proposal-control-path.md) and, for "considered and rejected",
// the intent layer. So this module produces no branches, and the view says so
// out loud rather than drawing an empty fork that would imply the data was
// merely unavailable right now. A path view that fakes branches would be worse
// than none: it would look like the product already knows what the AI chose
// between.
//
// It reuses `groupRounds` (hooks/useTrajectory) rather than re-segmenting the
// event stream: rounds are already the ONE definition of "one command", and a
// second definition here would drift from the trajectory view's.
//
// It also cannot say WHO ran a step. `SessionEvent` carries no actor field, and
// the panel's own keystrokes use the same terminal_write path the AI does — so
// "who" is unknown by construction, not by omission.
import { cardState } from "../components/CommandCard";
import type { CommandCard as CardData } from "../hooks/useCommandEvents";
import type { CommandEvent } from "../hooks/useCommandEvents";
import type { TrajRound } from "../hooks/useTrajectory";

/** The five-state vocabulary, re-exported so the path view and the command
 *  cards cannot drift apart on what a state is called. */
export const PATH_STATES = ["running", "ok", "fail", "warn", "bg", "muted"] as const;

export type PathState = (typeof PATH_STATES)[number];

export type Owner = "ai" | "human";

export interface PathStep {
  /** The round id it came from (`r-<seq>`), so a step can be traced back. */
  id: string;
  /** 1-based position along the path. */
  index: number;
  command: string;
  state: PathState;
  /** WHO was driving when this step started, from the session's `control`
   *  events. Defaults to "ai", which is what the trail means before any
   *  handoff — an unflagged step is the agent's. */
  owner: Owner;
  /** Short label for the state, from cardState (e.g. "exit 1"). */
  stateLabel: string;
  /** Unix seconds. */
  startedAt: number;
  durationMs: number | null;
  exitCode: number | null;
  reason: string | null;
  /** Output character count — a cheap size signal without shipping the text. */
  outputChars: number;
  /** WHY the agent says it ran this. Null for every step logged before the
   *  intent surface existed, and for clients that do not send one — the view
   *  must render those two cases identically, because to a reader they are the
   *  same thing: no reason was given. */
  intent: string | null;
  /** The alternatives the agent says it passed over. The branches NOT taken —
   *  the one thing a command log can never reconstruct, and the reason this
   *  field exists at all. */
  considered: string[];
  /** The 1-based plan step this command claimed, or null if it claimed none.
   *  Null is the interesting case as much as a number: an unclaimed step is how
   *  a run visibly departs from what the agent said it would do. */
  planStep: number | null;
  /** The run this command claimed to belong to, or null. A LABEL, NEVER A
   *  CREDENTIAL — it is the AI's own attribution, recorded verbatim because the
   *  device does not verify it — so it is rendered as a claim and never used to
   *  GROUP anything. Grouping lives in `lib/runs.ts` on the device-level
   *  timeline; a second grouping here would be two implementations of one read. */
  runId: string | null;
}

export interface PathSummary {
  /** Command steps (the preamble round is not a step). */
  steps: number;
  counts: Record<PathState, number>;
  /** Sum of the KNOWN per-step durations. Not wall-clock: backgrounded and
   *  still-running steps have no duration, and two steps can overlap. */
  commandMs: number;
  /** Steps whose duration is unknown — so `commandMs` is a floor, and the view
   *  can say "at least" instead of implying a total it cannot know. */
  untimed: number;
  /** Steps a PERSON drove. Surfaced because an operator returning to a session
   *  needs to know which work was theirs and which was the agent's — the whole
   *  reason the handoff is recorded. */
  humanSteps: number;
  /** Wall-clock span from the first step's start to the last known end. Null
   *  when nothing has finished. */
  spanMs: number | null;
  /** True while at least one step is still running. */
  live: boolean;
}

export interface SessionPath {
  steps: PathStep[];
  summary: PathSummary;
  /** Round id → step index, for jumping from the path into the timeline. */
  indexOf: Record<string, number>;
}

/** A session-level status before any command (e.g. "opened") forms the
 *  preamble round; it is context, not a step along the path. */
export const PREAMBLE_ID = "r-pre";

/**
 * Who was driving at a given moment, from the session's `control` events.
 *
 * The fold is deliberately "most recent event at or before `ts`", not "any
 * event in the window": a step belongs to whoever held the keyboard when it
 * STARTED. A handoff mid-command therefore does not retroactively reassign the
 * command that was already running, which is the honest reading — the agent
 * issued it.
 *
 * Before the first control event the answer is "ai", because that is what the
 * trail means: the header documents the audit as the record of device control,
 * and a session with no handoff was the agent's throughout.
 */
export function ownershipTimeline(
  events: CommandEvent[],
): Array<{ ts: number; holder: Owner }> {
  return events
    .filter((e) => e.kind === "control" && (e.status === "human" || e.status === "ai"))
    .map((e) => ({ ts: e.ts, holder: e.status as Owner }))
    .sort((a, b) => a.ts - b.ts);
}

/** The holder in effect at `ts`; "ai" before any handoff. */
export function ownerAt(timeline: Array<{ ts: number; holder: Owner }>, ts: number): Owner {
  let holder: Owner = "ai";
  for (const t of timeline) {
    if (t.ts > ts) break;
    holder = t.holder;
  }
  return holder;
}

export function derivePath(rounds: TrajRound[], controlEvents: CommandEvent[] = []): SessionPath {
  const timeline = ownershipTimeline(controlEvents);
  const steps: PathStep[] = [];
  const indexOf: Record<string, number> = {};

  for (const r of rounds) {
    if (r.id === PREAMBLE_ID || r.startSeq === null) continue;
    // Same derivation the command cards use, so a state means one thing
    // everywhere. cardState takes the card shape; only these fields matter.
    const asCard: CardData = {
      id: r.id,
      seq: r.startSeq,
      command: r.command,
      output: "",
      startedAt: r.startTs,
      ended: r.ended,
      exitCode: r.exitCode,
      reason: r.reason,
      durationMs: r.durationMs,
    };
    const st = cardState(asCard);
    // The reasoning rides the round's own command/start event, so it needs no
    // new plumbing — a step and its reason arrive together or not at all.
    const start = r.events.find((e) => e.kind === "command/start");
    indexOf[r.id] = steps.length;
    steps.push({
      id: r.id,
      index: steps.length + 1,
      command: r.command,
      owner: ownerAt(timeline, r.startTs),
      state: st.state,
      stateLabel: st.compact,
      startedAt: r.startTs,
      durationMs: r.durationMs,
      exitCode: r.exitCode,
      reason: r.reason,
      outputChars: r.events.reduce((n, e) => n + (e.kind === "output" ? (e.text?.length ?? 0) : 0), 0),
      intent: start?.intent ?? null,
      considered: Array.isArray(start?.considered) ? start!.considered! : [],
      planStep:
        typeof start?.plan_step === "number" && start.plan_step > 0
          ? start.plan_step
          : null,
      // Blank is ABSENT, not a run named "" — the same rule the device applies
      // when it writes the field (a blank id is omitted from the JSONL rather
      // than stored).
      runId: typeof start?.run_id === "string" && start.run_id.trim() !== "" ? start.run_id : null,
    });
  }

  return { steps, summary: summarizePath(steps), indexOf };
}

/** Fold the steps into the numbers a person actually wants: how much work, how
 *  much of it failed, and how long it took. */
export function summarizePath(steps: PathStep[]): PathSummary {
  const counts: Record<PathState, number> = { running: 0, ok: 0, fail: 0, warn: 0, bg: 0, muted: 0 };
  let humanSteps = 0;
  let commandMs = 0;
  let untimed = 0;
  let firstStart = Infinity;
  let lastEnd = -Infinity;

  for (const s of steps) {
    counts[s.state] += 1;
    if (s.owner === "human") humanSteps += 1;
    if (s.durationMs == null) {
      untimed += 1;
    } else {
      commandMs += s.durationMs;
      lastEnd = Math.max(lastEnd, s.startedAt * 1000 + s.durationMs);
    }
    firstStart = Math.min(firstStart, s.startedAt * 1000);
  }

  return {
    steps: steps.length,
    counts,
    commandMs,
    untimed,
    humanSteps,
    spanMs: lastEnd > -Infinity && firstStart < Infinity ? lastEnd - firstStart : null,
    live: counts.running > 0,
  };
}

/** Steps worth a second look, worst first: a failure or interruption is what an
 *  operator returning to a session is looking for. Ordered by position within a
 *  severity band so the list reads along the path. */
export function attentionSteps(steps: PathStep[]): PathStep[] {
  // `bg` ranks with `running`: both are "not finished", and neither is a problem
  // to draw the operator's eye.
  const rank: Record<PathState, number> = { fail: 0, warn: 1, running: 2, bg: 2, muted: 3, ok: 4 };
  return steps
    .filter((s) => s.state === "fail" || s.state === "warn" || s.state === "running")
    .sort((a, b) => rank[a.state] - rank[b.state] || a.index - b.index);
}
