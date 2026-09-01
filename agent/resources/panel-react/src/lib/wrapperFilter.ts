// Wrapper-noise filter for the panel's terminal stream (round-162).
//
// The stage-l execute wrapper prints plain-text markers (`__VALE_<ts>_<hex>___S`
// / `__VALE_<ts>_<hex>___E:<code>`) and ConPTY echoes the pasted wrapper line
// back. The MCP terminal_execute result is stripped server-side, but the
// live `/api/events/term` byte stream (what the panel / desktop app renders)
// is RAW.
//
// round-162 FINAL: PSReadLine is removed at session open (tool_open), so
// the wrapper echoes as ONE clean physical line at any width — no soft
// wrap, no `>>` continuation, no `$`-residue, no CSI redraw sequences.
// The filter therefore only needs to drop:
//   1. Lines that contain THIS session's wrapper machinery — the marker
//      lines (`__VALE_<ts>_<hex>___S` / `..._E:<code>`) and the wrapper
//      echo line itself. Both carry the 64-bit per-execute marker, so ANY
//      line containing `__VALE_<hex>` is wrapper machinery; a false
//      positive from user output is effectively impossible.
//   2. A bounded run of blank lines immediately after the echo (the
//      console clears the edit line once the paste lands).
//
// Conservative by design: real program output is untouched; only lines
// carrying the random marker (or blanks right after such a line) are
// dropped. State is minimal (no carry — the marker cannot be split because
// the line is not soft-wrapped anymore; the 8-byte tail window handles a
// frame split at the very end of a chunk).

const MARKER_IN_LINE = /__VALE_[0-9a-f]{4,}/;
const MAX_TAIL = 16;

export interface WrapperFilterState {
  // Bytes held back because the line may continue into the next frame.
  tail: string;
  // Blank lines to drop right after a wrapper line.
  blanks: number;
}

export function createWrapperFilter(): {
  state: WrapperFilterState;
  filter: (text: string) => string;
} {
  const state: WrapperFilterState = { tail: "", blanks: 0 };

  function filter(text: string): string {
    const buf = state.tail + text;
    state.tail = "";
    let out = "";

    // Split into complete lines; hold a short tail (no newline yet) in case
    // it is the end of a wrapper line split across frames.
    let rest = buf;
    let last = "";
    {
      const i = rest.lastIndexOf("\n");
      if (i !== -1 && i < rest.length - 1) {
        last = rest.slice(i + 1);
        rest = rest.slice(0, i + 1);
      }
    }

    for (const rawLine of rest.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (MARKER_IN_LINE.test(line)) {
        // Wrapper echo or marker line — drop it and arm blank suppression.
        state.blanks = 4;
        continue;
      }
      if (state.blanks > 0 && line.trim() === "") {
        // Console clears the edit line after the paste — blanks are noise.
        state.blanks -= 1;
        continue;
      }
      state.blanks = 0;
      out += rawLine + "\n";
    }

    // Hold the tail only if it is short and could be a marker fragment;
    // otherwise flush it now.
    if (last.length > 0) {
      if (last.length <= MAX_TAIL && /^[\s]*__VALE_[0-9a-f]{0,20}$/.test(last.replace(/\r$/, ""))) {
        state.tail = last;
      } else {
        out += last;
      }
    }
    return out;
  }

  return { state, filter };
}
