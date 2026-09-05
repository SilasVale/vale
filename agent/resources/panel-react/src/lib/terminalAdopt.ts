// Pure adopt-paging decision for TerminalPane (round-246, HIGH-3).
//
// A single terminal_read is capped at 1 MiB server-side (read_spill), so a
// chatty AI session's head used to be silently dropped when a human opened
// its tab late. The server response carries absolute cursors:
//   start  — offset the read actually began at
//   end    — offset just past the last byte returned
//   evicted— the server reset the buffer (cursor must go to 0)
// This helper decides whether ANOTHER read is needed to catch up. Pure and
// timer-free: it only inspects one response.

export const MAX_ADOPT_PAGES = 64;

export interface AdoptResponse {
  start?: number | string;
  end?: number | string;
  evicted?: boolean;
  text?: string;
  raw?: string;
}

/** True when the response proves more history exists past what we rendered. */
export function adoptNeedsAnotherPage(
  resp: AdoptResponse | null | undefined,
  rendered: number,
  advanced: boolean,
): boolean {
  if (!resp) return false;
  if (resp.evicted) return false; // reset handled by the caller
  if (!advanced) return false;    // nothing new written (SSE already caught up)
  const end = Number(resp.end);
  if (!Number.isFinite(end)) return false; // no cursor → legacy server, stop
  return end > rendered;
}

/** Page bound: never chain more than this many reads (wedged-server guard). */
export function adoptPageExceeded(page: number): boolean {
  return page > MAX_ADOPT_PAGES;
}

// P1-4 (terminal backpressure): one term.write of a full 1 MiB adopt page (or
// a burst of SSE frames) blocks the main thread while xterm parses + lays out
// the text. Slice payloads into per-frame budgets — TerminalPane queues the
// slices and writes (at most) one budget per animation frame, so a chatty
// session can never freeze the UI in a single call.

/** Max characters handed to xterm in a single animation frame. */
export const WRITE_SLICE_CHARS = 64 * 1024;

/** Split text into per-frame write slices (pure, unit-tested). */
export function splitWriteSlices(text: string, size: number = WRITE_SLICE_CHARS): string[] {
  if (!text) return [];
  const n = Math.max(1, Math.floor(size));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}
