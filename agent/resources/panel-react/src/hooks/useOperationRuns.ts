// useOperationRuns — the device's operation timeline, polled for the run strip.
//
// WHY A SECOND POLL RATHER THAN A PROP. `useCommandEvents` reads ONE session's
// audit log (`/api/sessions/{sid}`), which carries no `run_id` at all; a run is
// DEVICE-level and crosses sessions (the same AI execution may open three
// sessions and drive the browser in between). So the strip has its own source:
// `GET /api/operation`, which merges the terminal audit trail and the browser
// action feed onto one ordered axis and reports the run boundaries beside them.
//
// Polling follows the panel's established discipline:
//   * `since_ms` is the reply's own `cursor_ms`, so each poll asks only for what
//     it has not seen and the accumulated list stays bounded by traffic, not by
//     uptime;
//   * a FAILED poll keeps the last good snapshot instead of blanking the strip
//     (a tunnel blip must not erase runs the operator is reading — the same
//     stance as useSessions and useCommandEvents);
//   * an in-flight reply that lands after unmount is dropped rather than
//     calling setState on a dead component.
import { useEffect, useRef, useState } from "react";
import { callApi } from "../lib/api";
import type { OperationEvent, RunBoundary } from "../lib/runs";

export interface OperationSnapshot {
  events: OperationEvent[];
  boundaries: RunBoundary[];
}

/** How often to ask while the Path view is on screen. A run boundary is a
 *  low-frequency event (a client declares one, works, declares the end), so
 *  this is a freshness floor, not a stream: the panel's live views keep their
 *  own faster paths. */
export const OPERATION_POLL_MS = 5000;

/** Rows per request. Bounded so one poll cannot walk an unbounded log — the
 *  device caps the reply too, and this only has to be small enough to be cheap
 *  and large enough that a run's events are not cut in half. */
const PAGE_LIMIT = 500;

/** Tail caps on what the strip accumulates between polls. The device's own
 *  reads are capped, so these only bite on a very long-lived panel; the tail
 *  wins for the same reason it does in useCommandEvents — the newest work is
 *  what the operator is looking at. */
const MAX_EVENTS = 2000;
const MAX_BOUNDARIES = 200;

const EMPTY: OperationSnapshot = { events: [], boundaries: [] };

/** Identity of one event for de-duplication.
 *
 *  The boundary records are re-sent whenever they sit exactly ON the cursor
 *  (`since_ms` filters `ts_ms < since_ms`, so an event stamped at the cursor is
 *  sent again), and the terminal half is re-read from whole files. `seq`
 *  disambiguates the terminal feed; the browser feed has no sequence, so its key
 *  falls back to the script text. */
function eventKey(e: OperationEvent): string {
  return [
    e?.source ?? "",
    e?.ts_ms ?? 0,
    e?.session ?? "",
    e?.kind ?? "",
    e?.seq ?? "",
    e?.command ?? e?.script ?? "",
  ].join("\u0000");
}

function boundaryKey(b: RunBoundary): string {
  return [b?.kind ?? "", b?.run_id ?? "", b?.ts_ms ?? 0].join("\u0000");
}

/** Merge a reply into the accumulated events, keeping arrival order and
 *  dropping only records already held.
 *
 *  Returns `prev` ITSELF when nothing was added: the poll runs every few
 *  seconds against a mostly-static log, and a fresh array each time would
 *  re-render the whole strip (and the Path view around it) for no new fact —
 *  the same "nothing new, skip the render" rule useCommandEvents follows. */
function mergeEvents(prev: OperationEvent[], incoming: OperationEvent[]): OperationEvent[] {
  const seen = new Set(prev.map(eventKey));
  const next = [...prev];
  for (const e of incoming) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    next.push(e);
  }
  if (next.length === prev.length) return prev;
  return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
}

/** Merge run boundaries, keyed by (kind, run_id, ts_ms) so a boundary already
 *  seen is never counted twice. Returns `prev` itself when nothing changed. */
function mergeBoundaries(prev: RunBoundary[], incoming: RunBoundary[]): RunBoundary[] {
  const byKey = new Map<string, RunBoundary>();
  for (const b of prev) byKey.set(boundaryKey(b), b);
  let added = false;
  for (const b of incoming) {
    if (typeof b?.run_id !== "string" || typeof b?.ts_ms !== "number") continue;
    const k = boundaryKey(b);
    if (!byKey.has(k)) added = true;
    byKey.set(k, b);
  }
  if (!added) return prev;
  const out = [...byKey.values()];
  if (out.length <= MAX_BOUNDARIES) return out;
  return out
    .sort((a, b) => (a.ts_ms ?? 0) - (b.ts_ms ?? 0))
    .slice(out.length - MAX_BOUNDARIES);
}

/**
 * The accumulated operation timeline: events plus run boundaries.
 *
 * Returns an empty snapshot until the first reply lands, and keeps returning
 * the last good one after a failed poll.
 */
export function useOperationRuns(pollMs: number = OPERATION_POLL_MS): OperationSnapshot {
  const [snapshot, setSnapshot] = useState<OperationSnapshot>(EMPTY);
  // The newest stamp the device has already given us. Held in a ref because it
  // must survive re-renders without re-arming the effect.
  const cursorRef = useRef(0);
  // A reply that resolves after unmount must not reach setState.
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const tick = async () => {
      try {
        const res = await callApi(
          `/api/operation?since_ms=${cursorRef.current}&limit=${PAGE_LIMIT}`,
        );
        if (!aliveRef.current) return;
        const events: OperationEvent[] = Array.isArray(res?.events) ? res.events : [];
        const boundaries: RunBoundary[] = Array.isArray(res?.runs) ? res.runs : [];
        // `cursor_ms` falls back to the requested `since_ms` on the device, so
        // it can never rewind; the guard makes that a property of the client
        // too, since a rewind would re-request (and re-merge) old history.
        const cursor = Number(res?.cursor_ms);
        if (Number.isFinite(cursor) && cursor >= cursorRef.current) {
          cursorRef.current = cursor;
        }
        setSnapshot((prev) => {
          const merged = mergeEvents(prev.events, events);
          const bounds = mergeBoundaries(prev.boundaries, boundaries);
          if (merged === prev.events && bounds === prev.boundaries) return prev;
          return { events: merged, boundaries: bounds };
        });
      } catch {
        // Transient (tunnel blip, agent restarting) — keep the last good
        // snapshot and try again on the next tick.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), pollMs);
    // Coming back to the tab is worth an immediate look: the operator who
    // returns after a while is exactly who wants to know what ran meanwhile.
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollMs]);

  return snapshot;
}
