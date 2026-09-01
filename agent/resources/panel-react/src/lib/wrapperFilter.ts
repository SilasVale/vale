// Wrapper-noise filter for the panel's terminal stream (round-162).
//
// The stage-l execute wrapper prints plain-text markers (`__VALE_<ts>_<hex>___S`
// / `__VALE_<ts>_<hex>___E:<code>`) and ConPTY echoes the pasted wrapper line
// back. The MCP terminal_execute result is stripped server-side, but the
// live `/api/events/term` byte stream (what the panel / desktop app renders)
// is RAW — so users saw the marker lines and the chunked echo fragments
// (`>> ` continuation prompts, cursor-movement noise) as terminal garbage.
//
// This filter runs on the write path in TerminalPane. It drops:
//   1. Lines that are *exactly* a Vale marker (`__VALE_<ts>_<hex>___S` /
//      `__VALE_<ts>_<hex>___E:<code>`). The 64-bit random hex makes a false
//      positive from user output practically impossible.
//   2. The wrapper command echo — the whole pasted one-liner that starts
//      `$__VALE_<ts>_<hex>__=0;` (Netcatty §2.3: "避免长命令行回声泄漏成
//      终端垃圾" — the AI's command text lives in the session log/AI chat,
//      not the terminal). The echo is frequently SPLIT by the 512B ConPTY
//      chunk boundary; the first fragment starts with the wrapper prefix, so
//      it is dropped immediately and the rest of the line is skipped until
//      its newline arrives (discard mode — no unbounded carry).
//   3. A bounded run of `>>`/`> ` continuation-prompt fragments immediately
//      following the wrapper echo (the chunk-split artifact).
//
// Conservative by design: genuine `>>` multi-line input (user typing) is
// never dropped because it is not preceded by a wrapper echo; real program
// output is untouched. The only retained state is the bounded marker-prefix
// carry (≤128 bytes) and the discard/dropper flags.

const MARKER_RE = /^__VALE_[0-9a-f]+_[0-9a-f]{16}__(?:_S|_E:\d+)$/;
// The wrapper echo is a single pasted line. It starts with an optional
// prompt prefix (`PS C:\> ` / `> `) then `$__VALE_<ts>_<hex>__=0;`. NOTE:
// the prompt alternatives must NOT include a bare `$` — the wrapper echo
// itself begins with `$__VALE_`, and `\$` in the prefix would demand a
// SECOND `$` before `__VALE_` (round-162, debug-verified).
const WRAPPER_ECHO_START = /^(?:PS [^>]*>|>|C:\\[^>]*>|#)?\s*\$__VALE_[0-9a-f]+_[0-9a-f]{16}__=0;/;
const CONT_PROMPT_RE = /^\s*>>\s*$/;
const MAX_CARRY = 128;
// A partial that could still become a marker line (or the start of a wrapper
// echo). The marker shape is `__VALE_<ts-hex>_<16hex>__...` — any prefix of
// it (with an optional leading prompt) may be held across frames.
const CARRYABLE = /^(?:PS [^>]*>|>|C:\\[^>]*>|#)?\s*\$?__VALE_[0-9a-f_]{0,48}$/;

export interface WrapperFilterState {
  carry: string;
  contAfterEcho: number;
  // Discard mode: we saw the start of a wrapper-echo line (no newline yet).
  // Everything until the newline is part of that echo and must be dropped.
  discarding: boolean;
}

export function createWrapperFilter(): {
  state: WrapperFilterState;
  filter: (text: string) => string;
} {
  const state: WrapperFilterState = { carry: "", contAfterEcho: 0, discarding: false };

  function filter(text: string): string {
    const buf = state.carry + text;
    state.carry = "";
    let out = "";

    // Discard mode: the current partial line is a wrapper echo — consume
    // everything up to its newline (or the whole buffer if none yet).
    if (state.discarding) {
      const nl = buf.indexOf("\n");
      if (nl === -1) {
        // Still mid-echo — hold the discard state, emit nothing.
        state.discarding = true;
        return "";
      }
      state.discarding = false;
      const rest = buf.slice(nl + 1);
      if (rest.length === 0) return "";
      // Fall through to process `rest` normally (recurse once).
      return filter(rest);
    }

    // No newline at all: hold it ONLY if it could be a wrapper-echo or
    // marker prefix (bounded). Anything else flushes immediately.
    const nl0 = buf.indexOf("\n");
    if (nl0 === -1) {
      const clean = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r$/, "");
      if (clean.length <= MAX_CARRY && CARRYABLE.test(clean)) {
        state.carry = buf;
        return "";
      }
      if (WRAPPER_ECHO_START.test(clean)) {
        // Start of a wrapper echo without its newline yet — drop it and
        // enter discard mode (it cannot become a user-visible line).
        state.discarding = true;
        return "";
      }
      return buf;
    }

    // Process complete lines; keep the final partial in carry if it could
    // become a wrapper/marker line.
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
      const line = rawLine.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r$/, "");

      if (MARKER_RE.test(line.trim())) {
        state.contAfterEcho = 0;
        continue;
      }
      if (WRAPPER_ECHO_START.test(line)) {
        // Whole wrapper echo line — drop it and arm the fragment dropper.
        state.contAfterEcho = 6;
        continue;
      }
      if (state.contAfterEcho > 0 && (CONT_PROMPT_RE.test(line) || line.trim() === "")) {
        // Chunk-split artifact (`>>` / blank) right after the echo.
        state.contAfterEcho -= 1;
        continue;
      }
      state.contAfterEcho = 0;
      out += rawLine + "\n";
    }

    // Carry the tail only if it could still become a wrapper-echo or marker
    // line (bounded); otherwise flush it now.
    if (last.length > 0) {
      const clean = last.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r$/, "");
      if (WRAPPER_ECHO_START.test(clean)) {
        state.discarding = true;
      } else if (clean.length <= MAX_CARRY && CARRYABLE.test(clean)) {
        state.carry = last;
      } else {
        out += last;
      }
    }
    return out;
  }

  return { state, filter };
}
