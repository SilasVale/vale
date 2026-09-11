// ApprovalGate — arm the gate, and answer it when a command is waiting.
//
// THE OPERATOR'S HALF OF DESIGN BEAT 3. The agent refuses to run a command until
// a person says yes; without this the gate can only ever time out, which would
// make it a delay rather than a gate.
//
// TWO STATES IN ONE CONTROL, because they are one feature:
//   * ARMED with nothing waiting — a quiet toggle, so the operator can see at a
//     glance whether this session asks before it acts;
//   * a REQUEST WAITING — the command itself, with approve/refuse, because a
//     prompt that does not show WHAT it will run asks the operator to guess.
//
// THE COUNTDOWN IS NOT DECORATION. The question stays answerable for the gate's
// full TTL (~15 minutes) and expiry is fail-closed: an expired question is NOT
// run. Showing the remaining time is what stops the operator from being
// surprised by a refusal they never saw, and it makes the deadline visible
// instead of something they discover by being late.
//
// THE DEADLINE IS ABSOLUTE (`expiresAtMs`, converted once in `mapPending`).
// The device reports a SHRINKING `expires_in_ms` on every read; a component
// that kept that number and also accumulated its own elapsed time would count
// the same seconds twice and fall at double speed — harmless against the old
// 60 s block, wrong by minutes here.
//
// ACCESSIBILITY, and this one is load-bearing rather than polish: the prompt is
// `role="alertdialog"`, whose superclass is `alert` — an ASSERTIVE live region.
// Letting the 1 Hz countdown text live inside it would make a screen reader
// re-announce the whole prompt every second for fifteen minutes. So the ticking
// span is `aria-hidden`, the description is a STATIC sentence, and the last
// minute is announced exactly once through a separate polite `role="status"`.
import { useEffect, useId, useLayoutEffect, useState } from "react";
import type { PendingApproval } from "../hooks/useSessions";

/** The last minute: seconds instead of minutes, danger ink, and the only
 *  announcement the gate ever makes. It used to be the last 10 s, which is
 *  inside a human's reaction time for a decision this consequential. */
export const URGENT_MS = 60_000;

/** Tick once a second only where a second is the unit on screen. Before that,
 *  a 500 ms interval would recompute (and re-render the workspace) 1800 times
 *  per question to display a number that changes once a minute. */
export const SLOW_TICK_MS = 30_000;
export const FAST_TICK_MS = 1_000;

/** How a remaining budget reads to a person: whole MINUTES with a ceiling while
 *  there is more than a minute left ("15m", "2m", "1m" — never "14m" when the
 *  truth is closer to 15), whole SECONDS in the last minute. */
export function formatRemaining(ms: number): string {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  return secs >= 60 ? `${Math.ceil(secs / 60)}m` : `${secs}s`;
}

/** The clock time the question retires, for the STATIC description. Fixed
 *  24-hour HH:MM so it cannot change as the seconds tick. */
export function expiresAtClock(expiresAtMs: number): string {
  const d = new Date(expiresAtMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ApprovalGate({ armed, pending, grants, onArm, onDecide, onRevoke }: {
  armed: boolean;
  pending: PendingApproval | null;
  /** First words currently allowed without asking. */
  grants: string[];
  onArm: (required: boolean) => Promise<unknown>;
  onDecide: (id: string, approve: boolean, grant?: boolean) => Promise<unknown>;
  /** Revoke one word, or every one when omitted. */
  onRevoke: (grant?: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  // The last moment we LOOKED at the clock. The deadline itself never moves, so
  // this is the only ticking state — no elapsed accumulator to double-count.
  const [now, setNow] = useState(() => Date.now());
  // Whether this question's last minute has already been announced. At most one
  // polite announcement per question, ever.
  const [announcedLow, setAnnouncedLow] = useState(false);
  // A DOM id for the STATIC description; useId keeps two gates (or a gate beside
  // another panel copy) from colliding.
  const describedById = useId();

  const id = pending?.id ?? null;
  const expiresAtMs = pending?.expiresAtMs ?? 0;
  const hasPending = pending != null;
  const left = hasPending ? Math.max(0, expiresAtMs - now) : 0;
  const expired = hasPending && left <= 0;
  const urgent = hasPending && !expired && left <= URGENT_MS;

  // A NEW question resets the clock reading and re-arms the announcement; a
  // second question must not inherit the first one's "last minute" state (which
  // would suppress its announcement, or fire one for a question already gone).
  // Keyed on the id ALONE: re-reads of the SAME question carry a shrinking
  // budget, and resetting on those would re-arm the announcement every poll.
  // A LAYOUT effect, not a passive one: while no question is pending this
  // component never ticks, so `now` can be hours stale when one arrives — and a
  // passive effect would let the browser paint one frame of a countdown measured
  // from that stale reading.
  useLayoutEffect(() => {
    setNow(Date.now());
    setAnnouncedLow(false);
  }, [id]);

  useEffect(() => {
    if (!hasPending || expired) return;
    const t = window.setInterval(
      () => setNow(Date.now()),
      urgent ? FAST_TICK_MS : SLOW_TICK_MS,
    );
    return () => window.clearInterval(t);
    // `left`/`urgent` are derived from `now`, so the period is re-evaluated on
    // every tick and the interval swaps to 1 s exactly when the last minute
    // starts (within one slow tick of it).
  }, [hasPending, id, expiresAtMs, expired, urgent]);

  useEffect(() => {
    if (urgent) setAnnouncedLow(true);
  }, [urgent, id]);

  // A hidden tab has its timers throttled, so the last tick can be a minute
  // stale when the operator comes back — long enough for a question to have
  // expired while the prompt still said "20s". Re-read the clock on wake.
  useEffect(() => {
    const onVisible = () => setNow(Date.now());
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // The hook already reported the message; this only keeps the control from
      // looking like it worked.
    } finally {
      setBusy(false);
    }
  };

  if (expired) {
    // THE ZERO-SECOND RULE. At 0 s the question is settled and nothing can be
    // answered: the device has retired it (and would refuse a late decision).
    // A "Run it" button here — even disabled — reads as answerable, which is
    // the one thing this row must not say. No timer either: there is nothing
    // left to count, and a frozen 0s is just noise.
    return (
      <div className="approval-expired" role="status">
        Expired — the command was not run.
      </div>
    );
  }

  if (pending) {
    return (
      <div
        className="approval-prompt"
        role="alertdialog"
        aria-label="Command awaiting approval"
        aria-describedby={describedById}
      >
        <div className="approval-head">
          {/* A claim about the OPERATOR, not about the AI: the panel cannot
              tell "the AI is blocked waiting" from "the AI gave up and parked"
              — the wire carries no such bit — and guessing would be wrong half
              the time. */}
          <span className="approval-title">Waiting for you</span>
          {urgent && <span className="approval-urgent">last minute</span>}
          {/* aria-hidden: see the header. The ticking number is for eyes; the
              static sentence below is what a screen reader hears. */}
          <span className={`approval-left${urgent ? " urgent" : ""}`} aria-hidden="true">
            {formatRemaining(left)}
          </span>
        </div>
        {/* The COMMAND, verbatim. Truncation here would hide the thing being
            authorised — the operator cannot consent to what they cannot read. */}
        <code className="approval-cmd">{pending.command}</code>
        <div className="approval-actions">
          <button
            type="button"
            className="approval-approve"
            disabled={busy}
            onClick={() => void run(() => onDecide(pending.id, true))}
          >Run it</button>
          {/* The grant names the WORD it will cover, derived from the command
              above — so the operator consents to a breadth they can read, not to
              "remember this" in the abstract. Hidden when the command is not a
              simple one: there would be nothing safe to remember, and offering
              it would imply otherwise. */}
          {firstWord(pending.command) && (
            <button
              type="button"
              className="approval-remember"
              disabled={busy}
              title={`Allow every "${firstWord(pending.command)}" command in this session without asking again`}
              onClick={() => void run(() => onDecide(pending.id, true, true))}
            >Always allow <b>{firstWord(pending.command)}</b></button>
          )}
          <button
            type="button"
            className="approval-refuse"
            disabled={busy}
            onClick={() => void run(() => onDecide(pending.id, false))}
          >Refuse</button>
        </div>
        {/* Says what expiry DOES, because "nothing happened" is otherwise
            indistinguishable from a lost click — and says what a late YES does,
            because a late yes mints a one-shot permit: without that second
            sentence the operator answers, sees no command run, and concludes
            the button is broken. It does NOT claim the AI is still blocked (it
            may have parked); the sentence is true either way. */}
        <p className="approval-note">
          If it expires first, the command is <b>not</b> run. Answering after the
          AI has stopped waiting still counts — it runs the next time the AI asks.
        </p>
        {/* STATIC text, in the description, so the alertdialog's implicit
            assertive region never has to carry a 1 Hz update. It names the
            deadline as a clock time instead of a countdown. */}
        <span className="approval-sr" id={describedById}>
          Waiting for your answer. Expires at {expiresAtClock(expiresAtMs)}.
        </span>
        {/* The ONE polite announcement. Present (empty) from the start so the
            live region exists before its content changes, and it never changes
            again for this question. */}
        <span className="approval-sr" role="status">
          {announcedLow ? "Less than a minute left to answer." : ""}
        </span>
      </div>
    );
  }

  return (
    <>
    <button
      type="button"
      id="approval-arm"
      className={armed ? "armed" : ""}
      aria-pressed={armed}
      disabled={busy}
      title={
        armed
          ? "Every command in this session waits for you before it runs"
          : "Let the AI run commands here without asking"
      }
      onClick={() => void run(() => onArm(!armed))}
    >
      <span className="ag-dot" data-state={armed ? "armed" : "off"} />
      {armed ? "Asking first" : "Ask before each command"}
    </button>
    {armed && grants.length > 0 && (
      <span className="approval-grants" title="These commands run without asking">
        {grants.map((g) => (
          <span key={g} className="approval-grant">
            <code>{g}</code>
            <button
              type="button"
              className="approval-grant-x"
              disabled={busy}
              aria-label={`Stop allowing ${g}`}
              title={`Stop allowing ${g} commands`}
              onClick={() => void run(() => onRevoke(g))}
            >×</button>
          </span>
        ))}
      </span>
    )}
    </>
  );
}

/** The word a grant would cover, or null when the command is not a simple one.
 *
 *  A CLIENT-SIDE MIRROR of `approval.rs::grant_for`, used only to decide whether
 *  to OFFER the control and what to label it. The server derives the real grant
 *  from the stored command, so a divergence here can mislabel a button or hide
 *  one — it cannot widen a permission. Kept deliberately conservative and in sync
 *  with the Rust list; the two are cross-checked by a test.
 */
const UNSAFE_CHARS = /[;&|\n\r`$<>(){}"'\\*?[\]!#~]/;

export function firstWord(cmd: string): string | null {
  const t = cmd.trim();
  if (!t || UNSAFE_CHARS.test(t)) return null;
  return t.split(/\s+/)[0] || null;
}
