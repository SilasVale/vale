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
//   * It draws NO BRANCHES, and the reason has narrowed. `considered` (the
//     alternatives the agent says it passed over) IS in the audit trail and IS
//     rendered per step, and the declared PLAN is rendered with the number of
//     commands that served each step. What is still absent is the alternatives
//     that were legal but never attempted — those exist only if a client records
//     them at decision time. So the view shows a SEQUENCE with its reasoning and
//     refuses to draw a TREE, because a fork would imply the data exists and
//     merely is not loaded.
//
//   * It CAN say who ran a step, from the `control` audit events: ownership is
//     folded over time (`ownerAt`) and a step is attributed to whoever held the
//     keyboard when it started, defaulting to the AI. It still never guesses
//     about a step taken with NO control event in force — an unflagged step is
//     the agent's, which is what the trail means before any handoff.
//
// The state dots reuse `.cmd-dot[data-state]` — the SAME classes the command
// cards use — so "what does fail look like" has exactly one answer in this
// panel, including the shape half of the palette that survives
// prefers-reduced-motion (see src/lib/statePalette.test.ts).
//
// The RUN STRIP sits at the very top, above the goal and the summary. It is
// DEVICE-scoped while everything below it is this session's — runs are minted by
// the device and cross sessions, and the Path view is where the operator already
// reads work post-hoc, so the runs are bracketed HERE, as the context for the
// steps underneath them. That is not the same question the device-level ACTIVITY
// page answers ("what has this device been doing at all", which holds with zero
// sessions open and for browser-only work); see RunStrip's header for why both
// exist and why neither replaces the other. It renders in the empty case too:
// "this session has run nothing" and "this device has run three things" are both
// true, and the second one is what the operator came back for.
import { useMemo, useState } from "react";
import { derivePath, attentionSteps, type PathStep, type PathSummary } from "../lib/path";
import { buildRecipe, recipeWarnings, suggestedTitle, RECIPE_TAG } from "../lib/recipe";
import { callTool } from "../lib/api";
import { useTrajectory } from "../hooks/useTrajectory";
import { fmtDuration } from "./CommandCard";
import { RunStrip } from "./RunStrip";
import type { CommandEvent } from "../hooks/useCommandEvents";

/** Compact duration for the summary line ("at least 1m 12s" when some steps
 *  have no measurable duration). */
export function summaryDuration(s: PathSummary): string {
  if (s.steps === 0) return "—";
  const base = fmtDuration(s.commandMs) || "0s";
  return s.untimed > 0 ? `at least ${base}` : base;
}

export function PathView({ events, onJumpToStep, sessionKind, sessionLabel, goal, plan }: {
  events: CommandEvent[];
  /** Select a step — the caller scrolls/highlights it in the timeline. */
  onJumpToStep?: (step: PathStep) => void;
  /** Context stamped into a saved recipe, so a reader knows what the commands
   *  were run against. */
  sessionKind?: string;
  sessionLabel?: string;
  /** What the operator asked for, if they said. Shown BESIDE the outcome, never
   *  turned into a verdict: the agent cannot know whether an objective was met,
   *  and inferring it from a command stream is the confident guess this design
   *  keeps refusing to make. */
  goal?: string | null;
  /** The AGENT's declared plan. Rendered as its own block and matched against the
   *  steps, so a reader sees the plan followed — or quietly departed from. */
  plan?: string[];
}) {
  const rounds = useTrajectory(events);
  const path = useMemo(() => derivePath(rounds, events), [rounds, events]);
  const attention = useMemo(() => attentionSteps(path.steps), [path.steps]);

  // Recipe saving — beat 6 of the design's core loop ("harvest"). Local UI state
  // only; the entry itself goes to the shared device memory so AI clients can
  // find and re-run it (see lib/recipe.ts for why that store).
  const [recipeOpen, setRecipeOpen] = useState(false);
  const [recipeName, setRecipeName] = useState("");
  const [recipeBusy, setRecipeBusy] = useState(false);
  const [recipeMsg, setRecipeMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  if (path.steps.length === 0) {
  return (
      <div className="path-view">
        <RunStrip />
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
  // `bg` is deliberately NOT bad. A backgrounded command is work the AI chose to
  // leave running; nothing failed, and counting it here lit the "bad" marker for
  // a healthy session.
  const bad = summary.counts.fail + summary.counts.warn;
  const warnings = recipeWarnings(path.steps);

  const openRecipe = () => {
    setRecipeName(suggestedTitle(path));
    setRecipeMsg(null);
    setRecipeOpen(true);
  };

  /** Save the walked path into the shared device memory. Deliberately explicit
   *  about failure: a recipe the operator believes was saved but was not is
   *  worse than no recipe. */
  const saveRecipe = async () => {
    setRecipeBusy(true);
    setRecipeMsg(null);
    try {
      const draft = buildRecipe(path, { name: recipeName, sessionKind, sessionLabel, goal });
      await callTool("memory_save", {
        title: draft.title,
        content: draft.content,
        tags: draft.tags,
      });
      setRecipeOpen(false);
      setRecipeMsg({ kind: "ok", text: `Saved as "${draft.title}" — AI clients can find it with the "${RECIPE_TAG}" tag.` });
    } catch (e) {
      setRecipeMsg({ kind: "err", text: `Could not save: ${(e as Error)?.message ?? String(e)}` });
    } finally {
      setRecipeBusy(false);
    }
  };

  // Claims pointing at a step this plan does not have. Computed here rather than
  // inside the map because it is a property of the WHOLE plan, not of one step —
  // and because a `planStep` of 0 or negative is equally unattributable.
  const offPlan =
    plan && plan.length > 0
      ? path.steps.filter(
          (st) => st.planStep != null && (st.planStep < 1 || st.planStep > plan.length),
        )
      : [];

  return (
    <div className="path-view">
      <RunStrip />
      {goal && (
        <div className="path-goal" title="What this session was asked to achieve">
          <span className="path-goal-label">Goal</span>
          <span className="path-goal-text">{goal}</span>
        </div>
      )}
      {/* THE PLAN, as a plan. The goal above says what was ASKED FOR; this says
          what the agent said it would DO, and below each command states which
          step it served — so a step nobody claimed is visible as work that was
          never announced, and a step nobody did is visible as an abandoned
          intention. That comparison is the whole reason both are recorded.

          AND THE CLAIMS THE PLAN CANNOT HOLD. A command may name a step the plan
          does not have — a plan revised from 5 steps to 3 leaves earlier claims
          pointing past the end, and `plan_step` is recorded verbatim because the
          device does not validate it. Counting only `planStep === n` for the
          DECLARED steps put those claims in no bucket at all: they were counted
          on the Activity row and NOWHERE here, which is exactly the "work that
          was never announced" this block promises to surface. They get their own
          line rather than being silently dropped. */}
      {plan && plan.length > 0 && (
        <div className="path-plan">
          <span className="path-plan-label">Plan</span>
          <ol className="path-plan-steps">
            {plan.map((p, i) => {
              const n = i + 1;
              const done = path.steps.filter((st) => st.planStep === n).length;
              return (
                <li
                  key={`${n}-${p}`}
                  className={`path-plan-step ${done > 0 ? "done" : "open"}`}
                  title={
                    done > 0
                      ? `${done} command${done === 1 ? "" : "s"} served this step`
                      : "no command claimed this step"
                  }
                >
                  <span className="path-plan-n">{n}</span>
                  <span className="path-plan-text">{p}</span>
                  {/* The claim count is the honest half. ZERO is shown as
                      prominently as any number: an unclaimed step is the signal
                      that the run departed from the plan. */}
                  <span className="path-plan-count" data-zero={done === 0 ? "yes" : "no"}>
                    {done}
                  </span>
                </li>
              );
            })}
          </ol>
          {offPlan.length > 0 && (
            // Claims that point at a step this plan does not have. Shown as
            // THEIR OWN line, not folded into a numbered step: attributing them
            // to some existing step would invent a fact, and dropping them would
            // lose the signal.
            <p className="path-plan-offplan" data-count={offPlan.length}>
              <span className="path-plan-n">—</span>
              {offPlan.length} command{offPlan.length === 1 ? "" : "s"} claimed a step
              this plan does not have (
              {[...new Set(offPlan.map((st) => st.planStep))].sort((a, b) => (a ?? 0) - (b ?? 0)).join(", ")}
              ) — it was revised after they were attributed.
            </p>
          )}
        </div>
      )}
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
          {/* ITS OWN LINE, NEITHER RED NOR GREEN. A backgrounded command did not
              end — it was handed off to keep running — so it is not a failure and
              it is not a success. It used to be counted as `warn`, which made this
              line read "N interrupted" and lit the bad marker; the wording above
              was right and the STATE it consumed was not. Deliberately outside the
              `bad` block: a session whose only unusual steps are backgrounded is a
              HEALTHY session, and colouring it red would say otherwise. */}
          {summary.counts.bg > 0 && (
            <span className="path-summary-bg">{summary.counts.bg} backgrounded</span>
          )}
          {bad === 0 && summary.counts.ok > 0 && (
            <span className="path-summary-good">all succeeded</span>
          )}
          {summary.live && <span className="path-summary-live">running now</span>}
          {summary.humanSteps > 0 && (
            <span className="path-summary-human" title="Steps started while a person held the keyboard">
              {summary.humanSteps} by you
            </span>
          )}
        </div>
        <div className="path-summary-times">
          <span>{summaryDuration(summary)} of command time</span>
          {summary.spanMs != null && summary.spanMs > summary.commandMs && (
            <span className="path-summary-span">
              · {fmtDuration(summary.spanMs)} elapsed
            </span>
          )}
          {/* Harvest — save this walked path so it can be walked again. */}
          {!recipeOpen && (
            <button type="button" className="path-recipe-open" onClick={openRecipe}>
              Save as recipe
            </button>
          )}
        </div>

        {recipeOpen && (
          <div className="path-recipe">
            <label className="path-recipe-label" htmlFor="path-recipe-name">
              Recipe name
            </label>
            <input
              id="path-recipe-name"
              className="path-recipe-input"
              value={recipeName}
              onChange={(e) => setRecipeName(e.target.value)}
              disabled={recipeBusy}
            />
            {warnings.length > 0 && (
              <p className="path-recipe-warn">
                This run did not finish cleanly ({warnings.join(", ")}). The recipe
                will say so — reuse it with that in mind.
              </p>
            )}
            <div className="path-recipe-actions">
              <button type="button" className="primary" onClick={saveRecipe} disabled={recipeBusy}>
                {recipeBusy ? "Saving…" : "Save to device memory"}
              </button>
              <button type="button" onClick={() => setRecipeOpen(false)} disabled={recipeBusy}>
                Cancel
              </button>
            </div>
            <p className="path-recipe-hint">
              Saved to this device's shared memory, so any AI client here can find it
              with the <code>{RECIPE_TAG}</code> tag and walk it again. It records the
              commands and how the run went — it does not run by itself.
            </p>
          </div>
        )}

        {recipeMsg && (
          <p className={`path-recipe-msg ${recipeMsg.kind}`}>{recipeMsg.text}</p>
        )}
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
            {/* A COLUMN wrapper, because `.path-step` is itself `display: flex`
                (rail + dot + body in a row). Without this the reason and the
                alternatives become flex items BESIDE the command instead of
                under it — which is what happened, and what the render showed. */}
            <div className="path-step-main">
            <button
              type="button"
              className="path-step-body"
              onClick={() => onJumpToStep?.(s)}
              title="Show this step in the timeline"
            >
              <span className="path-step-index">{s.index}</span>
              <span className="path-step-cmd">{s.command}</span>
              <span className="path-step-meta">
                {s.owner === "human" && (
                  <span className="path-step-owner" title="A person ran this step">you</span>
                )}
                <span className={`path-step-tag s-${s.state}`}>{s.stateLabel}</span>
                {s.durationMs != null && (
                  <span className="path-step-dur">{fmtDuration(s.durationMs)}</span>
                )}
                {s.outputChars > 0 && (
                  <span className="path-step-out">{s.outputChars} chars</span>
                )}
              </span>
            </button>
            {/* THE INTENT LAYER, rendered. The reason sits UNDER the command it
                explains, and the branches not taken sit under that — a step that
                made a real choice reads as a choice rather than as an
                inevitability, which is the whole difference between a command
                log and an account of what happened.

                Both are omitted when absent, WITHOUT a placeholder. Most steps
                will have no stated reason (no client sends one yet, and not
                every step needs one), and filling that space with "no reason
                given" would bury the steps that DO have one. */}
            {s.intent && (
              <p className="path-step-why">
                <span className="path-step-why-mark" aria-hidden="true">→</span>
                {s.intent}
              </p>
            )}
            {s.runId && (
              // WHICH EXECUTION THIS BELONGED TO, as the AI claimed it. Rendered
              // as a claim — "the agent says" in the title — because `run_id` is
              // recorded VERBATIM and the device never verifies it. It is a
              // LABEL, NEVER A CREDENTIAL (`runs.rs` pins that twice), so it
              // groups nothing here: real grouping lives in `lib/runs.ts` on the
              // device-level timeline, and a second implementation would be two
              // reads of one fact.
              //
              // It is worth showing at all because this trail is the 30-day
              // record while `/api/operation` keeps a DAY: "which execution was
              // this?" is answerable only from here once the run strip's window
              // has passed.
              <p className="path-step-run" title="The run the agent says this command belonged to">
                <span className="path-step-run-label">run</span>
                <code className="path-step-run-id">{s.runId}</code>
              </p>
            )}
            {s.considered.length > 0 && (
              <p className="path-step-alt" title="Alternatives the agent says it passed over">
                <span className="path-step-alt-label">instead of</span>
                {s.considered.map((c) => (
                  <span key={c} className="path-step-alt-item">{c}</span>
                ))}
              </p>
            )}
            </div>
          </li>
        ))}
      </ol>

      <p className="path-note">
        A step records what ran and how it ended, and <b>who was driving</b> when it
        started — a handoff is marked, so a step with no marker is the agent's. Where
        the agent said why, the reason and the alternatives it passed over are shown
        under the command; where it said nothing, none are invented. Typing done
        while a person held the keyboard is not reconstructed into commands: keystrokes
        are bytes, not command boundaries, so this view marks the window rather than
        inventing steps in it.
      </p>
    </div>
  );
}
