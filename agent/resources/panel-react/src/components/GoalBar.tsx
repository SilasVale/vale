// GoalBar — what this session is FOR (design beat 1, dispatch).
//
// The operator states the objective; the agent records it; the AI reads it off
// `terminal_list`. This component is the operator's end of that: the one place
// the intent behind a run is written down, so the run can later be judged against
// something rather than merely described.
//
// TWO STATES, deliberately asymmetric:
//   * nothing stated → a QUIET affordance. An unset goal is normal (most sessions
//     are someone poking at a shell) and must not nag.
//   * a goal stated → the text itself, prominent, because it is the most
//     important single piece of context about the session and the one thing a
//     returning operator needs to re-read.
//
// IT DOES NOT JUDGE. There is no "achieved" tick, here or in the path view. The
// agent has no way to know whether an objective was met — that requires reading
// the operator's intent, and inferring it from a command stream would be exactly
// the kind of confident guess this whole design keeps refusing to make. The goal
// is shown BESIDE the outcome and the operator draws the conclusion.
import { useEffect, useRef, useState } from "react";

export function GoalBar({ goal, onSet }: {
  goal: string | null;
  onSet: (goal: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal ?? "");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // A NEW session's goal must not inherit the previous draft: the panel keeps one
  // GoalBar mounted across session switches, and a stale draft would let a save
  // write the wrong objective onto the wrong session.
  useEffect(() => {
    setDraft(goal ?? "");
    setEditing(false);
  }, [goal]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = async (value: string) => {
    setBusy(true);
    try {
      await onSet(value);
      setEditing(false);
    } catch {
      // The hook reports the message; this keeps the form open so the operator
      // does not lose what they typed to a transient failure.
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return goal ? (
      <button
        type="button"
        id="goal-bar"
        className="has-goal"
        title="What this session is for — click to change"
        onClick={() => setEditing(true)}
      >
        <span className="goal-label">Goal</span>
        <span className="goal-text">{goal}</span>
      </button>
    ) : (
      <button
        type="button"
        id="goal-bar"
        className="no-goal"
        title="Say what this session is for, so the run can be judged against it"
        onClick={() => setEditing(true)}
      >
        + Set a goal for this session
      </button>
    );
  }

  return (
    <form
      id="goal-bar"
      className="editing"
      onSubmit={(e) => {
        e.preventDefault();
        void save(draft);
      }}
    >
      <input
        ref={inputRef}
        className="goal-input"
        value={draft}
        placeholder="What should this session achieve?"
        maxLength={512}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(goal ?? "");
            setEditing(false);
          }
        }}
      />
      <button type="submit" className="goal-save" disabled={busy}>
        {busy ? "…" : "Save"}
      </button>
      {/* Clearing is an explicit act, offered only when there is something to
          clear. An empty save would also work, but a named button makes the
          act visible instead of hidden in "submit an empty field". */}
      {goal && (
        <button
          type="button"
          className="goal-clear"
          disabled={busy}
          onClick={() => void save("")}
        >Clear</button>
      )}
    </form>
  );
}
