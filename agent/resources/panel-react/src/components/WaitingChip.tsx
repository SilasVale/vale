// WaitingChip — the DEVICE-LEVEL "a decision is waiting" count.
//
// WHY IT EXISTS. The approval prompt lives inside the terminal pane of ONE
// session, which is exactly where an operator is not looking when the AI asks
// in a background session. Without a device-level mark the question is
// discoverable only by staring at the right tab — and a gate nobody notices is
// a gate that always times out.
//
// A COUNT, not a mark, because a device has several sessions and the operator
// needs to know how many questions are stacked up (one per session at most).
// It renders ONLY when there is something to say: a permanent "0 waiting" is
// chrome that trains people to stop reading it — and it would claim the panel
// knows the future, since "0" is also what a stale read looks like.
//
// Keyed on `pendingApproval`, never on `approvalRequired` (see
// `pendingApprovalCount`): "armed" is a standing posture and would make every
// armed session shout forever.
//
// The mark is a SHAPE (a rotated square, like the rail's waiting dot), so the
// chip is not a colour-only signal — this repo has a recorded incident where two
// states differed only by an animation that prefers-reduced-motion disables.
import { pendingApprovalCount, type Session } from "../hooks/useSessions";

export function WaitingChip({ sessions }: { sessions: Session[] }) {
  const count = pendingApprovalCount(sessions);
  if (count <= 0) return null;
  return (
    <span
      className="waiting-chip"
      title={`${count} command${count === 1 ? "" : "s"} waiting for your answer`}
    >
      <span className="waiting-mark" aria-hidden="true" />
      {count} waiting
    </span>
  );
}
