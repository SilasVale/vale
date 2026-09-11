// useSessionArchive — the panel's read of `GET /api/sessions`: the sessions
// THIS DEVICE has recorded, durable on disk for 30 days, surviving agent
// restarts and page reloads.
//
// WHY A HOOK OF ITS OWN (and not `terminal_list`). The panel's session list
// comes from the `terminal_list` MCP tool, which answers for LIVE sessions
// only: once a session closes, its tab is inert and nothing else can reach it,
// and after a reload or a restart the past is unreachable entirely. The agent
// has served the durable list all along; nothing consumed it. This hook is that
// consumer, and it deliberately reads the ROUTE rather than a tool, because the
// route is the durable corpus and the tool is the live registry.
//
// WHY THERE IS NO POLL TIMER. Answering `/api/sessions` folds EVERY session file
// on the device (`session_log::list_sessions` → `terminal_state_of` per file),
// so a timer here would re-read hundreds of JSONL files from disk on a fixed
// cadence for a surface that is, by definition, about the past. Refreshes are
// event-driven instead, mirroring round-163's removal of the terminal list's 3 s
// poll: mount (which also happens on every page switch), the agent's
// `sessions-changed` push, and the tab regaining focus.
//
// HONEST STATE. The list has three distinguishable conditions and the component
// renders a different sentence for each: still reading, read OK (empty is an
// empty ARCHIVE), and the read FAILED. A failed read never reports "no sessions
// recorded" — that is a claim about the device drawn from a failure to reach it.
import { useEffect, useRef, useState } from "react";
import { callApi } from "../lib/api";
import { archiveEntries, type ArchiveEntry } from "../lib/archive";

/** Mirrors SessionReadState in useCommandEvents — the same three words for the
 *  same three facts, so a reader of either surface meets one vocabulary. */
export type ArchiveListState = "reading" | "ok" | "unreadable";

export function useSessionArchive(): { entries: ArchiveEntry[]; state: ArchiveListState } {
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [state, setState] = useState<ArchiveListState>("reading");
  // Only the newest read may write: two overlapping refreshes (mount + a
  // sessions-changed push) must not let the slower one land last and rewind the
  // list. Same stance as useCommandEvents' post-await sid re-check.
  const inFlightRef = useRef(0);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const seq = ++inFlightRef.current;
      try {
        const res = await callApi("/api/sessions");
        if (!alive || seq !== inFlightRef.current) return;
        // archiveEntries THROWS on a response this panel does not understand.
        // That is the point: `[]` from a malformed body would render as "this
        // device has recorded no sessions".
        setEntries(archiveEntries(res));
        setState("ok");
      } catch {
        if (!alive || seq !== inFlightRef.current) return;
        // Keep the last good list on screen (the files it names are durable),
        // but say the refresh failed rather than passing stale data off as
        // current.
        setState((s) => (s === "unreadable" ? s : "unreadable"));
      }
    };
    void tick();
    const onChange = () => { void tick(); };
    // Focus only, not every visibility change: going HIDDEN is not a reason to
    // re-read every session file on the device.
    const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
    window.addEventListener("vale-sessions-changed", onChange);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.removeEventListener("vale-sessions-changed", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { entries, state };
}
