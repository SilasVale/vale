// ArchivePage — the device's RECORDED sessions, and the audit trail of any one
// of them, read back after the session itself is gone.
//
// THE HOLE THIS FILLS. The device writes one JSONL audit file per terminal
// session and `GET /api/sessions` has listed them since round-56 — and nothing
// in the panel ever called it. The session list came from `terminal_list`, which
// knows LIVE sessions only, so:
//   * a closed tab was an inert tombstone whose tooltip promised history that
//     no view could show (there was no Logs view — see ViewSwitch);
//   * after a page reload or an agent restart, every past session was
//     unreachable from the panel entirely;
//   * `/api/operation` could not backfill it — it is a device-level merge with a
//     bounded, forward-only window.
// This page is that missing consumer, and it is READ-ONLY: it opens a session's
// audit trail, and there is deliberately no rename, no delete, no approvals
// inbox, no second timeline merge and no search over the archive (each is a
// separate concern; the per-session filter below is the trajectory renderer's
// own, unchanged).
//
// WHAT IT REUSES RATHER THAN RE-IMPLEMENTS:
//   * the LIST comes from `GET /api/sessions` (lib/archive parses it);
//   * the TRAIL comes from the SAME reader the live trajectory views use —
//     `useCommandEvents`, i.e. `GET /api/sessions/{sid}` and the same grouping —
//     and is handed to the SAME renderer (`TrajectoryView`). There is no second
//     event reader and no second timeline in this file.
//
// LIVE vs ARCHIVED. A recorded session may still be open RIGHT NOW (a live tab
// and its audit file are two views of one session), so every row and every trail
// header carries the word — "live" or "archived" — as TEXT, keyed off the live
// set the panel already holds from `terminal_list`. Colour is a second channel
// here, never the only one (src/lib/statePalette.test.ts records the incident
// where two states differed only by an animation that reduced motion removes).
//
// HONEST EMPTIES (this panel's discipline):
//   * an absent value (no timestamp, no exit code, no folded state) draws
//     NOTHING — no placeholder that reads like a value;
//   * "the device recorded no sessions", "the archive could not be read" and
//     "still reading" are three different sentences, never one empty container;
//   * a session whose trail cannot be read SAYS SO, and never renders as an
//     empty history — which is why the trail body is only handed to
//     TrajectoryView once a read has actually succeeded.
import { useMemo, useState } from "react";
import type { Session } from "../hooks/useSessions";
import { useSessionArchive } from "../hooks/useSessionArchive";
import { useCommandEvents } from "../hooks/useCommandEvents";
import {
  ARCHIVE_PAGE,
  archiveClock,
  lastEventWords,
  newestFirst,
  pageOf,
  type ArchiveEntry,
} from "../lib/archive";
import { TrajectoryView } from "./TrajectoryView";

/** LIVE or ARCHIVED, as a word — the channel that survives a reader who cannot
 *  separate the two inks, and the one the tests assert. `data-state` carries the
 *  same fact to the stylesheet. */
function StateMark({ live }: { live: boolean }) {
  return (
    <span className="archive-state" data-state={live ? "live" : "archived"}>
      {live ? "live" : "archived"}
    </span>
  );
}

/** One row of the recorded list. The whole row is a BUTTON: opening a trail is
 *  the only action here, and a div with a click handler is unreachable by
 *  keyboard. */
function ArchiveRow({ entry, live, onOpen }: { entry: ArchiveEntry; live: boolean; onOpen: (sid: string) => void }) {
  const words = lastEventWords(entry.last);
  const when = archiveClock(entry.last?.ts ?? null);
  return (
    <li className="archive-row-item">
      <button
        type="button"
        className="archive-row"
        data-state={live ? "live" : "archived"}
        onClick={() => onOpen(entry.sid)}
        title={`Open the recorded audit trail of ${entry.sid}`}
      >
        <span className="archive-row-name">{entry.sid}</span>
        <StateMark live={live} />
        {/* Both facts are optional: an entry whose last event carries no stamp
            or no usable kind draws neither, rather than a stand-in. */}
        {words && <span className="archive-row-last">{words.label}</span>}
        {words?.detail && <span className="archive-row-reason">{words.detail}</span>}
        {when && <span className="archive-row-when">{when}</span>}
      </button>
    </li>
  );
}

/** The trail of one recorded session.
 *
 *  A component of its own because the READER is a hook and hooks cannot be
 *  called conditionally: the page mounts this only once a session is chosen, so
 *  exactly one audit poll exists at a time and it is torn down on "back". */
function ArchiveTrail({ entry, live, onBack }: { entry: ArchiveEntry; live: boolean; onBack: () => void }) {
  const { events, readState, firstSeq } = useCommandEvents(entry.sid);
  const words = lastEventWords(entry.last);
  const when = archiveClock(entry.last?.ts ?? null);
  return (
    <div className="archive-trail">
      <div className="archive-trail-head">
        <button
          type="button"
          className="archive-back"
          onClick={onBack}
          title="Back to every recorded session"
        >‹ All recorded sessions</button>
        <span className="archive-trail-sid" title={entry.sid}>{entry.sid}</span>
        <StateMark live={live} />
        {words && <span className="archive-row-last">{words.label}</span>}
        {when && <span className="archive-trail-when">last recorded {when}</span>}
      </div>
      {firstSeq > 1 && (
        // THE TRAIL IS NOT THE WHOLE STORY. `close_session` trims a session's
        // file to ~2000 lines, so a long session's head is discarded by design
        // and the survivors cannot say so on their own. Without this line the
        // viewer would present a trimmed trail as complete — the quiet version
        // of telling the operator something false.
        <p className="archive-note archive-note-trimmed">
          Earlier events are not recorded: this trail begins at event {firstSeq}, and
          the device keeps roughly the last 2000 lines of a closed session.
        </p>
      )}
      <div className="archive-trail-body">
        {readState === "reading" ? (
          <p className="archive-note">Reading this session's audit trail…</p>
        ) : readState === "unreadable" ? (
          // The trailing read failed and no read of this session ever
          // succeeded. Saying nothing here would render as a session that
          // recorded nothing, which is a different — and unverified — claim.
          <p className="archive-note archive-note-fail">
            This session's audit trail could not be read from the device, so nothing
            is shown. This is not an empty history: the file may be gone, or the
            device may be unreachable.
          </p>
        ) : events.length === 0 ? (
          // A SUCCESSFUL read with no events AND `found: true` — the route now
          // separates "no readable record" from "recorded nothing" (round 10),
          // and the `unreadable` branch above handles the former. So this is the
          // narrower claim: the record is there and holds no events. (The old
          // wording called the two indistinguishable, which the `found` flag
          // made untrue.)
          <p className="archive-note">
            The device has a record for this session and it holds no events.
          </p>
        ) : (
          // The SAME renderer the live Trajectory view mounts, fed by the same
          // reader. No second timeline exists in this file.
          <TrajectoryView key={entry.sid} events={events} />
        )}
      </div>
    </div>
  );
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function ArchivePage({ sessions }: {
  /** The panel's LIVE session list (`terminal_list`). Used ONLY to label a
   *  recorded session live vs archived — never as the source of the archive
   *  itself, which is the durable route. */
  sessions: Session[];
}) {
  const { entries, state } = useSessionArchive();
  const [openSid, setOpenSid] = useState<string | null>(null);
  // Bounded page: the list renders ARCHIVE_PAGE rows at a time and says how
  // many are held back. Reset never — "show more" only widens the window.
  const [windowCount, setWindowCount] = useState(ARCHIVE_PAGE);

  const ordered = useMemo(() => newestFirst(entries), [entries]);
  const { shown, more } = pageOf(ordered, windowCount);
  const liveSids = useMemo(
    () => new Set(sessions.filter((s) => !s.closed).map((s) => s.sid)),
    [sessions],
  );
  const liveCount = ordered.filter((e) => liveSids.has(e.sid)).length;

  // The open session's entry, resolved from the list. When it is gone from a
  // later read the trail still renders (its sid does not depend on the list),
  // but no state word is invented for it.
  const openEntry: ArchiveEntry | null = openSid
    ? entries.find((e) => e.sid === openSid) ?? { sid: openSid, last: null }
    : null;

  return (
    <section
      className="archive-page"
      aria-label="Session archive"
      // Drives ONE stylesheet rule: with a trail open the page stops scrolling
      // and the trajectory renderer's own scroll region owns the pane (two
      // nested scrollers make the round list unreachable).
      data-view={openEntry ? "trail" : "list"}
    >
      <header className="archive-head">
        <div className="archive-head-line">
          <h2 className="archive-title">Archive</h2>
          <span className="archive-scope">this device · recorded sessions</span>
        </div>
        <p className="archive-lede">
          Every session this device has written to disk, newest first. These files
          outlive the session and the agent process, so a session that is closed —
          or one from before a restart — opens here with its full audit trail.
        </p>
        {entries.length > 0 && (
          <div className="archive-stats">
            <span className="archive-stat">{plural(entries.length, "recorded session", "recorded sessions")}</span>
            {liveCount > 0 && (
              <span className="archive-stat archive-stat-live">{plural(liveCount, "live now", "live now")}</span>
            )}
            <span className="archive-showing">
              showing {shown.length} of {entries.length}
            </span>
          </div>
        )}
      </header>

      {openEntry ? (
        <ArchiveTrail
          entry={openEntry}
          live={liveSids.has(openEntry.sid)}
          onBack={() => setOpenSid(null)}
        />
      ) : state === "reading" ? (
        // Not "no sessions": nothing has been read yet.
        <p className="archive-empty">Reading the device's session archive…</p>
      ) : state === "unreadable" && entries.length === 0 ? (
        <p className="archive-empty archive-empty-fail">
          The device's session archive could not be read. Nothing is listed here —
          this is a failed read, not an empty device.
        </p>
      ) : entries.length === 0 ? (
        // A quiet line, never an empty container: a titled empty list reads as a
        // broken feature. The wording is about the DEVICE's disk, which is what
        // this list actually reads.
        <p className="archive-empty">
          This device has recorded no sessions yet. A session is written to disk
          when it opens, so the first one appears here as soon as it exists.
        </p>
      ) : (
        <>
          {state === "unreadable" && (
            // Stale-but-known is not the same as current: the durable files the
            // list names are still real, and the failed refresh is stated rather
            // than hidden behind them.
            <p className="archive-note archive-note-fail">
              The last refresh of this list failed — what is shown is the most
              recent list that was read successfully.
            </p>
          )}
          <ol className="archive-rows">
            {shown.map((e) => (
              <ArchiveRow key={e.sid} entry={e} live={liveSids.has(e.sid)} onOpen={setOpenSid} />
            ))}
          </ol>
          {more > 0 && (
            <button
              type="button"
              className="archive-more"
              title="Show the next older page of recorded sessions"
              onClick={() => setWindowCount((n) => n + ARCHIVE_PAGE)}
            >Show {Math.min(more, ARCHIVE_PAGE)} more — {more} held back</button>
          )}
        </>
      )}
    </section>
  );
}
