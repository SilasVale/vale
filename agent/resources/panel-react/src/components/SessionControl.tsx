// SessionControl — hand this session's keyboard to a person, or back to the AI.
//
// WHY A HUMAN NEEDS THIS. The agent serialises AI-vs-AI executes with a busy
// flag, but a person typing into the same session was invisible to it: an AI
// execute would interleave with their keystrokes over one buffer cursor. Taking
// control makes the handover explicit — the AI's next `terminal_execute` is
// refused with `human_in_control`, so it is TOLD a person is driving instead of
// racing them.
//
// WHAT IT IS NOT. It is coordination, not enforcement. `terminal_write` is not
// gated (the panel's keystrokes and the AI's use that same path, so gating it
// would lock the human out of the keyboard they just took). An AI that ignores
// the handover can still type raw bytes. The button must never be described to a
// user as a security control — see `term_set_control`'s doc on the manager.
//
// STATE IS SERVER-OWNED. `heldByHuman` arrives on the session record from
// `terminal_list`, so another client taking the session shows up here too. The
// button never flips locally before the server agrees.
import { useState } from "react";

export function SessionControl({ held, onSet }: {
  held: boolean;
  onSet: (human: boolean) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const flip = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await onSet(!held);
    } catch {
      // The hook already reported the message; this only keeps the button from
      // looking like it worked. It stays in the old state because the SERVER
      // never confirmed the change.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      id="session-control"
      className={`${held ? "held" : ""}${failed ? " failed" : ""}`}
      disabled={busy}
      aria-pressed={held}
      title={
        held
          ? "You have this session's keyboard — the AI's commands are refused until you hand it back"
          : "Take this session's keyboard so the AI stops issuing commands into it"
      }
      onClick={flip}
    >
      <span className="sc-dot" data-state={held ? "human" : "ai"} />
      {busy ? "…" : held ? "Hand back" : "Take control"}
    </button>
  );
}
