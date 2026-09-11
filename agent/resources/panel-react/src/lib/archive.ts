// Session archive — the pure half of "what has this device recorded".
//
// WHAT THIS IS FOR. The device keeps one JSONL audit file per terminal session
// for 30 days (agent/src/session_log.rs), and `GET /api/sessions` has served the
// list of those files since round-56 — with NO consumer anywhere in the panel.
// The panel built its session list from `terminal_list` instead, which returns
// LIVE sessions only, so a closed session's tab went inert and a page reload or
// an agent restart put every past session out of reach. This module is the
// ordering/parsing half of the archive surface that closes that hole; the
// rendering half is components/ArchivePage.tsx.
//
// HONEST EMPTIES (this panel's documented discipline, and the reason this file
// refuses to invent values):
//   * a field the device did not write maps to `null`, and `null` draws
//     NOTHING — never 0, never "unknown", never "—";
//   * a row whose `id` is not a non-empty string is DROPPED rather than
//     rendered under a fabricated name: a session list entry the panel cannot
//     name is not a session it can open;
//   * a manifest the panel does not understand is NOT an empty archive — the
//     caller must be able to tell those apart, so `archiveEntries` throws
//     instead of returning `[]` for a shape it did not recognise.
//
// ORDER is derived, never inherited: `list_sessions` walks the directory
// (`read_dir` order), which is neither chronological nor stable across devices.
// The only time value the route carries is the LAST recorded event's `ts`,
// folded into `state` by `session_log::terminal_state_of`, so that stamp is the
// ordering key — and a record without one sorts LAST rather than being placed
// by guess.

/** The last event of a session, folded by the device
 *  (`session_log::terminal_state_of`): kind/ts/reason/exit_code/status. Every
 *  field is optional on the wire, so every field is `null` when it is missing
 *  or of a type this panel cannot use. */
export interface ArchiveLastEvent {
  /** The audit event's own kind, e.g. "command/end" | "status" | "control". */
  kind: string;
  /** Unix SECONDS of the last recorded event (the audit log's unit). */
  ts: number | null;
  /** `status` events: the value itself — "opened", "closed", "exited:0", … */
  status: string | null;
  /** `command/end` events: the exit code, when one was recorded. */
  exitCode: number | null;
  /** `command/end` / terminal status events: the reason, when one was given. */
  reason: string | null;
}

export interface ArchiveEntry {
  sid: string;
  /** The folded last event, or `null` when the device folded nothing usable. */
  last: ArchiveLastEvent | null;
}

/** How many recorded sessions one page of the list renders.
 *
 *  A device may hold hundreds of files (d1 had 167 at the time of writing) and
 *  the route folds EVERY file to answer, so the panel renders a bounded page
 *  and says how many more there are — the same honest bound the trajectory view
 *  uses, rather than an unbounded list. */
export const ARCHIVE_PAGE = 50;

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** One `state` object from the route → its usable fields. */
function mapLast(state: unknown): ArchiveLastEvent | null {
  if (!state || typeof state !== "object") return null;
  const s = state as Record<string, unknown>;
  const kind = nonEmptyString(s.kind) ?? "";
  const last: ArchiveLastEvent = {
    kind,
    ts: finiteNumber(s.ts),
    status: nonEmptyString(s.status),
    exitCode: finiteNumber(s.exit_code),
    reason: nonEmptyString(s.reason),
  };
  // A state object carrying NOTHING usable is absence, not an empty event: the
  // component then draws no state word at all.
  if (!kind && last.ts == null && last.status == null && last.exitCode == null && last.reason == null) {
    return null;
  }
  return last;
}

/**
 * `GET /api/sessions` → `{ ok, sessions: [{ id, state }] }` → entries.
 *
 * Throws when the response is not the manifest this panel knows how to read.
 * That is deliberate: returning `[]` would render as "this device has recorded
 * no sessions", which is a claim about the DEVICE drawn from a response the
 * panel failed to understand — the same class of lie as a failed poll
 * tombstoning every live session (round-113).
 */
export function archiveEntries(payload: unknown): ArchiveEntry[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("session archive: response is not an object");
  }
  const list = (payload as Record<string, unknown>).sessions;
  if (!Array.isArray(list)) {
    throw new Error("session archive: response carries no sessions array");
  }
  const out: ArchiveEntry[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const sid = nonEmptyString((row as Record<string, unknown>).id);
    if (!sid) continue; // unnameable — the panel cannot open what it cannot name
    out.push({ sid, last: mapLast((row as Record<string, unknown>).state) });
  }
  return out;
}

/**
 * Newest first, by the last recorded event's stamp.
 *
 * The tie-break is the session id, DESCENDING, so the order is total and stable
 * across reads: `read_dir` order is not, and a list that reshuffles under the
 * operator's cursor is a list they cannot click reliably. A session whose stamp
 * is absent sorts after every stamped one — its position is then a fact about
 * the data (nothing was recorded), not a guess about when it happened.
 */
export function newestFirst(entries: ArchiveEntry[]): ArchiveEntry[] {
  return [...entries].sort((a, b) => {
    const at = a.last?.ts ?? null;
    const bt = b.last?.ts ?? null;
    if (at != null && bt != null && at !== bt) return bt - at;
    if (at != null && bt == null) return -1;
    if (at == null && bt != null) return 1;
    return a.sid < b.sid ? 1 : a.sid > b.sid ? -1 : 0;
  });
}

/** The bounded page: the first `count` entries and how many are held back. */
export function pageOf(entries: ArchiveEntry[], count: number): { shown: ArchiveEntry[]; more: number } {
  const n = Math.max(0, Math.floor(count));
  return { shown: entries.slice(0, n), more: Math.max(0, entries.length - n) };
}

/** Local absolute stamp for a unix-SECONDS audit timestamp.
 *
 *  Absolute, not relative: "3 minutes ago" is a claim about the reader's clock
 *  as much as the device's, and this panel has no business asserting it about a
 *  record that may be 30 days old. Returns `null` for an absent stamp so the
 *  caller draws nothing. */
export function archiveClock(ts: number | null): string | null {
  if (ts == null) return null;
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * The last recorded event, as words — or `null` when there is nothing to say.
 *
 * The words are the LOG'S OWN vocabulary wherever the log has one (`status`
 * carries its value verbatim, kinds keep their names). The one place this
 * function interprets is `command/start` with no end after it: the file simply
 * stops mid-command, which is what an agent restart, a crash or a live session
 * looks like from disk. Saying "ended mid-command" would assert WHY; the honest
 * form states the record ("no end recorded") and leaves the cause alone.
 */
export function lastEventWords(last: ArchiveLastEvent | null): { label: string; detail: string | null } | null {
  if (!last) return null;
  if (last.kind === "status") {
    // The status VALUE is the payload ("opened", "closed", "exited:3", …). A
    // status event whose value the device did not write says only that a status
    // event was last — never a stand-in word in the value's place.
    return last.status ? { label: last.status, detail: null } : { label: "status", detail: null };
  }
  if (last.kind === "command/end") {
    // exit 0 is a VALUE and draws in its own right; "no exit code recorded" is
    // the absence of that value, not a code of its own.
    const label = last.exitCode != null ? `exit ${last.exitCode}` : "command ended";
    return { label, detail: last.reason };
  }
  if (last.kind === "command/start") {
    return { label: "command started — no end recorded", detail: null };
  }
  if (last.kind === "output") {
    return { label: "output — no end recorded", detail: null };
  }
  if (last.kind) return { label: last.kind, detail: last.reason };
  // kind absent: the stamp (if any) is still worth showing, and it is drawn by
  // the caller — no label is invented here.
  return null;
}
