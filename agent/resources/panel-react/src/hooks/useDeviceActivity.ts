// useDeviceActivity — "is this machine doing something right now?"
//
// WHY THIS IS A NEW HOOK rather than a re-wiring of useAiActivityPulse.
// That hook is consumed by exactly one component, EmbeddedBrowserPane, where it
// lights a BROWSER indicator and flashes that pane's Evidence toggle on the
// idle→active edge. Browser events are the correct input there: terminal output
// would make the browser pane light up because someone ran a shell command — a
// false claim about the browser. (The game-design doc originally called that a
// defect; the correction is recorded under Law 3.)
//
// What was actually missing is a DEVICE-level signal. The panel could say "the
// AI is driving the browser" but never "this machine is working", and the rail's
// only indicator was connected/not-connected. This hook is that signal, merged
// from both sources so the device reads as one thing.
//
// HONEST ABOUT WHAT IT MEASURES. This is an EVENT-RECENCY signal: "some activity
// arrived within the last WORKING_MS". It is deliberately not a derived "is a
// command currently running" state — deriving that needs the per-session command
// cards in global scope, and the two differ only in the tail (a command that
// finishes leaves the rail lit for the rest of the window). Recency is the
// signal a person actually reads ("it's busy"), and it cannot get STUCK lit the
// way a missing completion event would leave a derived flag.
//
// It does NOT distinguish who acted, and it must not pretend to: the audit trail
// carries no actor field (SessionEvent has no source/origin), and the panel's own
// keystrokes reach the wire through the same terminal_write path the AI uses. So
// "the machine is active" is the only claim available, and the only one made.
import { useEffect, useRef, useState } from "react";

/** How long the device stays "working" after the last activity frame. */
export const WORKING_MS = 8000;

/** Sources merged into one device-level signal.
 *
 *  Terminal output is the important addition: every command the AI runs through
 *  terminal_execute produces output here, and before this hook that work was
 *  invisible at the device level.
 *
 *  VERIFIED, because the signal is worthless otherwise: useSSE dispatches
 *  `vale-term-output` per FRAME carrying `frame.session_id`, on a stream its own
 *  code documents as "cross-session" — so output from a BACKGROUND session
 *  lights the device state too, not only the session being watched. And useSSE
 *  is mounted once in App.tsx, above both density branches, so the desktop shell
 *  and the panel receive the same events. */
export const DEVICE_ACTIVITY_EVENTS = [
  "vale-term-output",
  "vale-browser-actions-changed",
  "vale-playwright-changed",
] as const;

/** True while activity has arrived within WORKING_MS. */
export function useDeviceActivity(): boolean {
  const [active, setActive] = useState(false);
  const fadeRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const pulse = () => {
      setActive(true);
      if (fadeRef.current) window.clearTimeout(fadeRef.current);
      fadeRef.current = window.setTimeout(() => setActive(false), WORKING_MS);
    };
    for (const ev of DEVICE_ACTIVITY_EVENTS) window.addEventListener(ev, pulse);
    return () => {
      for (const ev of DEVICE_ACTIVITY_EVENTS) window.removeEventListener(ev, pulse);
      if (fadeRef.current) window.clearTimeout(fadeRef.current);
    };
  }, []);

  return active;
}
