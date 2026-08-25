// Strip ANSI escape sequences for plain-text rendering. The live terminal
// interprets these via xterm.js; text surfaces (trajectory timeline, command
// cards) must not print them raw — raw bytes rendered as text showed cursor
// moves ([2J[H), SGR color runs ([93m), OSC titles and semantic-prompt
// markers (]133;D;) as visible garbage (round-134).
const CSI = "\\x1b\\[[0-9;?]*[ -/]*[@-~]";
// OSC terminated by BEL or ST — OR running to end of input (streams often
// end mid-sequence; an unterminated ]133;D; otherwise leaks as text).
const OSC = "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\|$)";
const DCS = "\\x1b[P^_].*?\\x1b\\\\";
const SINGLE = "\\x1b[=>786MNOc]";
const ANSI_RE = new RegExp(`${CSI}|${OSC}|${DCS}|${SINGLE}`, "g");

/** Remove ANSI escapes; any stray ESC that survived pattern matching is
 *  dropped too, so control bytes can never reach the DOM as text. */
export function stripAnsi(s: string | undefined): string {
  return (s ?? "").replace(ANSI_RE, "").replace(/\x1b/g, "");
}
