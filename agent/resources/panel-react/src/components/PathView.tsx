// PathView — one session's work as a scannable PATH (design §2.1, §7).
//
// Read docs/adr/proposal-game-design.md §7 before changing this. Its place in
// the product is narrow and deliberate:
//
//   * It is a POST-HOC RECORD view, not a live console. The operator who would
//     watch it in real time does not exist on the device: there is one identity
//     (agent/src/web/panel.rs — possession of the token IS the device identity)
//     and the person driving the AI sits in a different application. So this
//     answers "what did it do while I was away, and how did it go", which is a
//     question that WILL be asked, rather than pretending to be a cockpit.
//
//   * It draws NO BRANCHES. The alternatives that were legal at each step are
//     not in the audit trail — that needs the control plane's gate records and,
//     for "considered and rejected", the intent layer. The empty state says so
//     explicitly instead of drawing an empty fork, because a fork would imply
//     the data exists and merely is not loaded.
//
//   * It cannot say WHO ran a step, and never guesses. `SessionEvent` has no
//     actor field and the panel's own keystrokes go through the same
//     terminal_write path as the AI's.
//
// The state dots reuse `.cmd-dot[data-state]` — the SAME classes the command
// cards use — so "what does fail look like" has exactly one answer in this
// panel, including the shape half of the palette that survives
// prefers-reduced-motion (see src/lib/statePalette.test.ts).
import { useMemo } from "react";
import { derivePath, attentionSteps, type PathStep, type PathSummary } from "../lib/path";
import { useTrajectory } from "../hooks/useTrajectory";
import { fmtDuration } from "./CommandCard";
import type { CommandEvent } from "../hooks/useCommandEvents";

/** Compact duration for the summary line ("at least 1m 12s" when some steps
 *  have no measurable duration). */
export function summaryDuration(s: PathSummary): string {
  if (s.steps === 0) return "—";
  const base = fmtDuration(s.commandMs) || "0s";
  return s.untimed > 0 ? `at least ${base}` : base;
}

export function PathView({ events, onJumpToStep }: {
  events: CommandEvent[];
  /** Select a step — the caller scrolls/highlights it in the timeline. */
  onJumpToStep?: (step: PathStep) => void;
}) {
  const rounds = useTrajectory(events);
  const path = useMemo(() => derivePath(rounds), [rounds]);
  const attention = useMemo(() => attentionSteps(path.steps), [path.steps]);

  if (path.steps.length === 0) {
    return (
      <div className="path-view">
        <div className="path-empty">
          <p className="path-empty-title">No path yet</p>
          <p className="path-empty-body">
            This session has not run a command. Once it does, each command becomes
            a step here — with its outcome, how long it took and what came back.
          </p>
        </div>
      </div>
    );
  }

  const { summary } = path;
  const bad = summary.counts.fail + summary.counts.warn;

  return (
    <div className="path-view">
      <header className="path-summary">
        <div className="path-summary-main">
          <span className="path-summary-n">{summary.steps}</span>
          <span className="path-summary-label">
            step{summary.steps === 1 ? "" : "s"}
          </span>
          {bad > 0 && (
            <span className="path-summary-bad">
              {summary.counts.fail > 0 && `${summary.counts.fail} failed`}
              {summary.counts.fail > 0 && summary.counts.warn > 0 && " · "}
              {summary.counts.warn > 0 && `${summary.counts.warn} interrupted`}
            </span>
          )}
          {bad === 0 && summary.counts.ok > 0 && (
            <span className="path-summary-good">all succeeded</span>
          )}
          {summary.live && <span className="path-summary-live">running now</span>}
        </div>
        <div className="path-summary-times">
          <span>{summaryDuration(summary)} of command time</span>
          {summary.spanMs != null && summary.spanMs > summary.commandMs && (
            <span className="path-summary-span">
              · {fmtDuration(summary.spanMs)} elapsed
            </span>
          )}
        </div>
      </header>

      {attention.length > 0 && (
        <section className="path-attention">
          <h4 className="path-attention-title">Worth a look</h4>
          <ul className="path-attention-list">
            {attention.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="path-attention-row"
                  onClick={() => onJumpToStep?.(s)}
                  title="Show this step in the timeline"
                >
                  <span className="cmd-dot" data-state={s.state} />
                  <span className="path-attention-cmd">{s.command}</span>
                  <span className={`path-attention-tag s-${s.state}`}>{s.stateLabel}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ol className="path-steps">
        {path.steps.map((s) => (
          <li key={s.id} className={`path-step s-${s.state}`}>
            <span className="path-step-rail" aria-hidden="true" />
            <span className="cmd-dot path-step-dot" data-state={s.state} />
            <button
              type="button"
              className="path-step-body"
              onClick={() => onJumpToStep?.(s)}
              title="Show this step in the timeline"
            >
              <span className="path-step-index">{s.index}</span>
              <span className="path-step-cmd">{s.command}</span>
              <span className="path-step-meta">
                <span className={`path-step-tag s-${s.state}`}>{s.stateLabel}</span>
                {s.durationMs != null && (
                  <span className="path-step-dur">{fmtDuration(s.durationMs)}</span>
                )}
                {s.outputChars > 0 && (
                  <span className="path-step-out">{s.outputChars} chars</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>

      <p className="path-note">
        A step records what ran and how it ended. It does <b>not</b> record the
        alternatives the agent passed over, or who issued the command — neither is
        in the audit trail yet, so this view does not invent them.
      </p>
    </div>
  );
}
