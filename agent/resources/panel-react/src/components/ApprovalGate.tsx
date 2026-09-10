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
// THE COUNTDOWN IS NOT DECORATION. The request expires on the agent's clock and
// an expired request is NOT run (fail-closed). Showing the remaining time is what
// stops the operator from being surprised by a refusal they never saw, and it
// makes the deadline visible instead of something they discover by being late.
import { useEffect, useState } from "react";

export interface PendingApproval {
  id: string;
  command: string;
  expiresInMs: number;
}

/** Seconds left, floored at 0. Local ticking only — the agent owns the truth and
 *  will drop the request when it expires; this is a display of the budget it
 *  reported, not a second source of it. */
function secondsLeft(expiresInMs: number, elapsedMs: number): number {
  return Math.max(0, Math.ceil((expiresInMs - elapsedMs) / 1000));
}

export function ApprovalGate({ armed, pending, onArm, onDecide }: {
  armed: boolean;
  pending: PendingApproval | null;
  onArm: (required: boolean) => Promise<unknown>;
  onDecide: (id: string, approve: boolean) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Reset the local countdown whenever a NEW request arrives; without the id in
  // the deps a second request would inherit the first one's elapsed time and
  // appear to expire early.
  useEffect(() => {
    setElapsed(0);
    if (!pending) return;
    const t = window.setInterval(() => setElapsed((e) => e + 500), 500);
    return () => window.clearInterval(t);
  }, [pending?.id]);

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

  if (pending) {
    const left = secondsLeft(pending.expiresInMs, elapsed);
    return (
      <div className="approval-prompt" role="alertdialog" aria-label="Command awaiting approval">
        <div className="approval-head">
          <span className="approval-title">Waiting for you</span>
          <span className={`approval-left${left <= 10 ? " urgent" : ""}`}>
            {left}s
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
          <button
            type="button"
            className="approval-refuse"
            disabled={busy}
            onClick={() => void run(() => onDecide(pending.id, false))}
          >Refuse</button>
        </div>
        {/* Says what expiry DOES, because "nothing happened" is otherwise
            indistinguishable from a lost click. */}
        <p className="approval-note">
          If this runs out, the command is <b>not</b> run.
        </p>
      </div>
    );
  }

  return (
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
  );
}
