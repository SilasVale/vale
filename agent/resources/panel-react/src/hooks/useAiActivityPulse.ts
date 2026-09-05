// useAiActivityPulse — event-driven "AI is operating" indicator (round-253).
//
// P1-3 (three-streams-into-one): this hook used to open its OWN /api/events
// SSE fetch alongside useSSE's /api/events/term stream (plus EvidenceDrawer's
// own copy — three streams doing one job). useSSE already re-dispatches every
// control frame as a `vale-<ev>` window event, so this hook now just subscribes
// to those (browser-actions-changed / playwright-changed) and keeps its UI
// fade timer. No fetch, no backoff, no token needed.
//
// Signature kept as () — callers pass nothing; the pulse is purely local UI.
import { useCallback, useEffect, useRef, useState } from "react";

/** Active for this long after the last activity push (UI fade window). */
export const PULSE_MS = 8000;

/** Window events (dispatched by useSSE) that mean "the AI is operating". */
export const AI_ACTIVITY_EVENTS = [
  "vale-browser-actions-changed",
  "vale-playwright-changed",
] as const;

export function useAiActivityPulse(): boolean {
  const [active, setActive] = useState(false);
  const fadeRef = useRef<number | undefined>(undefined);

  const pulse = useCallback(() => {
    setActive(true);
    if (fadeRef.current) window.clearTimeout(fadeRef.current);
    fadeRef.current = window.setTimeout(() => {
      // Only clear if no newer pulse arrived (each pulse resets the timer).
      setActive(false);
    }, PULSE_MS);
  }, []);

  useEffect(() => {
    const onActivity = () => pulse();
    for (const ev of AI_ACTIVITY_EVENTS) window.addEventListener(ev, onActivity);
    return () => {
      for (const ev of AI_ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
      if (fadeRef.current) window.clearTimeout(fadeRef.current);
    };
  }, [pulse]);

  return active;
}
