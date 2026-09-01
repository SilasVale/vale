// Wrapper-noise filter for the panel's terminal stream (round-162, FINAL).
//
// Vale renders the RAW PTY stream to a user while injecting an execute
// wrapper into that same stream — a problem unique to Vale (Netcatty
// strips server-side for AI output only, no UI; VS Code runs AI commands
// in separate processes). The mechanism below combines Netcatty's
// stripJobMarkerLines + visibleMarkerCarry with a discard-mode state
// machine, validated against real d1 bytes (PowerShell 5.1 + ConPTY,
// PSReadLine removed, 80-col console wrap):
//
//   A long wrapper is hard-wrapped by the console into segments separated
//   by `\r\n` + a CSI cursor move (`\u001b[23;80H`). The marker appears
//   ~9x, so MOST segments contain `__VALE_` — but a segment can land
//   EXACTLY on a marker split (hex tail without the `__VALE_` prefix),
//   which a per-line contains-check misses.
//
// Fix: on the first line containing `__VALE_`, enter discard mode and drop
// EVERY following line (they are wrapped segments of the SAME logical
// wrapper line) until the standalone START marker line (`<marker>_S` —
// always a complete line in the real stream) ends the wrapper, or a
// bounded segment count is exceeded (safety). Blanks right after are
// console edit-line clears — dropped.
//
// The 64-bit per-execute marker makes false positives from user output
// effectively impossible.

const STRIP_ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const MARKER_IN_LINE = /__VALE_[0-9a-f]+/;
const START_MARKER_LINE = /^\s*__VALE_[0-9a-f]+_[0-9a-f]{16}___S\s*$/;
const END_MARKER_LINE = /^\s*__VALE_[0-9a-f]+_[0-9a-f]{16}___E:\d+\s*$/;
const MAX_CARRY = 128;
const MAX_WRAP_SEGMENTS = 24;

export interface WrapperFilterState {
  carry: string;
  discarding: boolean;
  segments: number;
  blanks: number;
}

export function createWrapperFilter(): {
  state: WrapperFilterState;
  filter: (text: string) => string;
} {
  const state: WrapperFilterState = { carry: "", discarding: false, segments: 0, blanks: 0 };

  function filter(text: string): string {
    const buf = state.carry + text;
    state.carry = "";
    let out = "";

    // Split into complete lines + a trailing partial (no newline yet).
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
      const stripped = rawLine.replace(STRIP_ANSI, "").replace(/\r$/, "");
      if (state.discarding) {
        // Inside a wrapped wrapper echo: drop everything until the START
        // marker line (the wrapper finished echoing and the command began).
        if (START_MARKER_LINE.test(stripped)) {
          state.discarding = false;
          state.segments = 0;
          state.blanks = 4;
          continue;
        }
        state.segments += 1;
        if (state.segments > MAX_WRAP_SEGMENTS) {
          // Safety valve — too many segments, stop discarding.
          state.discarding = false;
          state.segments = 0;
        }
        continue;
      }
      if (END_MARKER_LINE.test(stripped)) {
        // The END marker line — drop it but do NOT enter discard mode (the
        // command finished; what follows is real output / the prompt).
        state.blanks = 2;
        continue;
      }
      if (MARKER_IN_LINE.test(stripped)) {
        // Start of a wrapper echo (or a marker line / fragment) — enter
        // discard mode.
        state.discarding = true;
        state.segments = 1;
        state.blanks = 4;
        continue;
      }
      if (state.blanks > 0 && stripped.trim() === "") {
        state.blanks -= 1;
        continue;
      }
      state.blanks = 0;
      out += rawLine + "\n";
    }

    // Hold the tail only if it could become a marker line (bounded);
    // otherwise flush it now.
    if (last.length > 0) {
      const stripped = last.replace(STRIP_ANSI, "").replace(/\r$/, "");
      if (stripped.length <= MAX_CARRY && /^[\s]*__VALE_[0-9a-f_]*$/.test(stripped)) {
        state.carry = last;
      } else {
        out += last;
      }
    }
    return out;
  }

  return { state, filter };
}
