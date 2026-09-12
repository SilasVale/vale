import type { SessionReadState } from "../hooks/useCommandEvents";

/**
 * WHAT AN EMPTY TRAIL IS ALLOWED TO SAY — ONE WORDING, THREE VIEWS.
 *
 * A view that draws its own "nothing here yet" line makes a CLAIM about the
 * device: that the session ran nothing. That claim is only available when a read
 * actually SUCCEEDED. `useCommandEvents` has reported `readState`
 * (`"reading" | "ok" | "unreadable"`) for longer than the Archive has used it —
 * but the Archive was its ONLY consumer, so the live trajectory and path views
 * printed "No commands in this session yet." and "This session has not run a
 * command." unconditionally. Two reachable windows, one of them on EVERY session
 * switch: `useCommandEvents` resets `events` to `[]` synchronously while the new
 * read is in flight, so the operator is told the session is empty for the whole
 * round trip.
 *
 * This is round 27's defect one field over: `firstSeq` was hoisted through `App`
 * for exactly this reason and `readState` was left behind in the same object
 * literal. The Archive's header states the rule — "a session whose trail cannot
 * be read SAYS SO, and never renders as an empty history" — and it was honoured
 * in one place out of three.
 *
 * The wording lives HERE rather than in each view because three copies of one
 * sentence is how this repo's views come to disagree about what they are saying.
 * The Archive's phrasing is the original and is preserved verbatim.
 *
 * Returns `null` when the caller's own empty state is TRUE and may be shown.
 */
export function trailReadNotice(read: SessionReadState): { text: string; failed: boolean } | null {
  if (read === "ok") return null;
  if (read === "unreadable") {
    return {
      failed: true,
      // NOT "the session is empty": the read failed and nothing established
      // anything about the session. The file may be gone, or the device may be
      // unreachable — both are different from "it ran nothing".
      text:
        "This session's audit trail could not be read from the device, so nothing " +
        "is shown. This is not an empty history: the file may be gone, or the " +
        "device may be unreachable.",
    };
  }
  return { failed: false, text: "Reading this session's audit trail…" };
}
