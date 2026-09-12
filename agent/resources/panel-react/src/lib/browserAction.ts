/** One browser action as the evidence feed records it. */
export interface BrowserActionLike {
  ts: number;
  duration_ms?: number;
  exit_code?: number | null;
  timed_out?: boolean;
  script?: string;
  screenshots?: string[];
  stdout_tail?: string;
  stderr_tail?: string;
  run_id?: string | null;
}

export type ActionState = "ok" | "timeout" | "nocode" | "fail" | "unknown";

export interface ActionVerdict {
  state: ActionState;
  /** The badge's word. */
  label: string;
  /** The text the DEVICE recorded to explain this action, when it recorded one.
   *  Rendered, not merely fetched — see the note below. */
  detail: string | null;
}

/**
 * WHAT A RECORD IN THE ACTION FEED CAN ACTUALLY BE.
 *
 * The panel collapsed `exit_code === null` into a badge reading "running" — and
 * NO RECORD IN THIS FEED CAN BE RUNNING. Every writer appends only after the
 * action is over: the playwright producer writes the result triple
 * (`agent/src/plugins/playwright/tools.rs`), and the mcp-client producers write
 * `exit_code: if ok { 0 } else { 1 }`. A `null` code therefore means "it finished
 * and there was no exit code", which happens in exactly two ways, and the device
 * distinguishes them with `timed_out`:
 *
 *   Err(_)      -> timed_out: true,  no code, stderr "timed out after Ns"
 *   Ok(Err(e))  -> timed_out: FALSE, no code, stderr "spawn failed: {e}"
 *
 * So a browser action that could not even START was shown to the operator as one
 * still in progress — the opposite of what happened — while `stderr_tail`, the
 * sentence saying "spawn failed", was declared on the type, fetched from the
 * route, and rendered NOWHERE. The device did its job; the surface dropped it.
 *
 * TWO MORE DISTINCTIONS THIS KEEPS:
 *   * `undefined` is not `null`. An absent field means the record does not carry
 *     one (an older agent); `null` means the device looked and found none. The old
 *     `=== null` test sent an absent value down the exit-code branch and rendered
 *     the literal string "exit undefined".
 *   * Success is `exit_code === 0`. Anything else is not success, and "no code"
 *     is its own answer rather than a shade of failure — the same distinction
 *     `lib/runs.ts` and `ActivityPage` already draw for commands.
 */
export function actionVerdict(a: BrowserActionLike): ActionVerdict {
  const code = a.exit_code;
  const detail = (a.stderr_tail || "").trim() || (a.stdout_tail || "").trim() || null;

  if (code === 0) return { state: "ok", label: "ok", detail: null };
  if (typeof code === "number") return { state: "fail", label: `exit ${code}`, detail };
  if (a.timed_out === true) return { state: "timeout", label: "timeout", detail };
  if (code === null) {
    // The device recorded this action, it is over, and it produced no exit code
    // without timing out — the spawn-failure arm. Name what is known and let
    // `detail` carry the device's own sentence.
    return { state: "nocode", label: "did not start", detail };
  }
  // `undefined`: this record does not carry an exit code at all. Say THAT rather
  // than inventing either verdict.
  return { state: "unknown", label: "no exit code recorded", detail };
}
