// updateDiagnosis — read `vale-update.log` and answer "did the update take?".
//
// THE QUESTION THIS EXISTS FOR. A device update goes: the CLI writes an
// `update requested X -> Y` receipt, hands a PowerShell swap script to WMI, and
// the connection drops ~10s mid-swap. That drop is the DOCUMENTED signature of a
// successful swap — which makes it useless as evidence, because a transport
// failure that never delivered the command looks identical from the caller's
// side. Observed on d1: the update returned a connection error, was read as "the
// swap is running", and had never reached the device at all.
//
// The repo's own answer is a FOUR-WAY table over `vale-update.log`, and until now
// reading it meant a `Get-Content` on the box. The device already serves the file
// (`GET /api/logs`) and nothing consumed it. This turns the tail into the verdict.
//
// The table, verbatim from the release docs:
//
//   receipt | `update start` | what it means
//   --------+----------------+-----------------------------------------------
//   present | absent         | the CLI reached the device, the swap never launched
//   present | present        | the CLI's swap launched; check copy/restart below
//   absent  | present        | the swap was launched by `agent_update` (Rust)
//   absent  | absent         | the command never reached the device at all
//
// PURE ON PURPOSE: no fetch, no React, no clock. The four-way logic is the part
// worth testing, and every input is a string.

export type UpdateVerdict =
  | "cli-swap-launched"
  | "cli-only"
  | "rust-swap"
  | "never-arrived"
  | "no-log";

export interface UpdateDiagnosis {
  verdict: UpdateVerdict;
  /** One sentence an operator can act on, in product vocabulary. */
  summary: string;
  /** Whether an `update requested` receipt is the LAST thing of its kind. */
  receipt: string | null;
  /** The last completed swap's outcome lines, when the script got that far. */
  copyOk: boolean | null;
  restarted: boolean | null;
}

/** Lines matching `update requested <from> -> <to>`, newest last. */
function receipts(lines: string[]): string[] {
  return lines.filter((l) => l.includes("update requested"));
}

/** `update start` lines — written by the swap script, whichever caller launched it. */
function starts(lines: string[]): string[] {
  return lines.filter((l) => l.includes("update start"));
}

/**
 * Read a `copy ok=` line, the swap script's own verdict on the file copy.
 *
 * Returns `null` when the line is absent rather than guessing: "the script never
 * got there" and "the copy failed" are different, and only one of them means the
 * device is running the old binary.
 */
function copyOkFrom(lines: string[]): boolean | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /copy ok\s*=\s*(true|false)/i.exec(lines[i]);
    if (m) return m[1].toLowerCase() === "true";
  }
  return null;
}

/** `task restarted` — the swap's last step; its absence is the interesting case. */
function restartedFrom(lines: string[]): boolean | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/task restarted/i.test(lines[i])) return true;
  }
  return null;
}

/**
 * The four-way verdict.
 *
 * PRESENCE IS DECIDED PER KIND, not by position: a receipt and a start can be
 * interleaved with other lines and with each other over several updates, and the
 * question is only whether each kind appears at all. Ordering them by line index
 * would answer a different question ("was the LAST thing a receipt?") and would
 * report `cli-only` for a device whose most recent update succeeded.
 *
 * An empty/absent log is its own verdict — `no-log` — NOT `never-arrived`: on a
 * device that has never been updated there is nothing to have arrived, and
 * collapsing the two would tell an operator their update was lost when none was
 * attempted.
 */
export function diagnoseUpdate(log: string | null | undefined): UpdateDiagnosis {
  if (log == null || log.trim() === "") {
    return {
      verdict: "no-log",
      summary:
        "This device has no update log, so no update has been attempted here (or the log was removed).",
      receipt: null,
      copyOk: null,
      restarted: null,
    };
  }
  const lines = log.split(/\r?\n/);
  const rs = receipts(lines);
  const ss = starts(lines);
  const receipt = rs.length > 0 ? rs[rs.length - 1] : null;
  const copyOk = copyOkFrom(lines);
  const restarted = restartedFrom(lines);

  if (receipt && ss.length > 0) {
    // Say what the SCRIPT reported, not just that it ran: a launched swap that
    // failed to copy leaves the device on the old binary, and "launched" alone
    // would read as success.
    const detail =
      copyOk === false
        ? " The copy did NOT succeed, so the device is still running the previous build."
        : restarted === true
          ? " The copy succeeded and the agent was restarted."
          : " The swap started but the log does not say it finished — check the lines below.";
    return {
      verdict: "cli-swap-launched",
      summary: `The CLI reached this device and the swap launched.${detail}`,
      receipt,
      copyOk,
      restarted,
    };
  }
  if (receipt) {
    return {
      verdict: "cli-only",
      summary:
        "The CLI reached this device but the swap never launched — nothing was replaced. Re-running the update is safe.",
      receipt,
      copyOk,
      restarted,
    };
  }
  if (ss.length > 0) {
    return {
      verdict: "rust-swap",
      summary:
        "A swap was launched by the agent itself (the console/auto channel), which writes no receipt. The lines below are its record.",
      receipt: null,
      copyOk,
      restarted,
    };
  }
  return {
    verdict: "never-arrived",
    summary:
      "No update was ever requested through either channel. If you just asked for one, the command did not reach this device — the connection drop is NOT proof it started.",
    receipt: null,
    copyOk,
    restarted,
  };
}
