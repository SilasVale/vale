// lib/recipe.ts — turn a walked path into a RECIPE.
//
// This is beat 6 of the design's core loop (docs/adr/proposal-game-design.md §2):
// "HARVEST — the path becomes a recipe; next run reuses it". The six-beat table
// records it as HALF-done, with the gap stated as "no recipe". This closes it.
//
// WHY DEVICE MEMORY IS THE RIGHT STORE, not a new table:
//
//   * Recipes land in the memory plugin, which is ALREADY shared across every AI
//     client on the device. That is what makes a recipe re-runnable without any
//     protocol change: the operator saves it here, and an AI client can find it
//     with the memory_search tool it already has. A private panel-only store
//     would be a recipe the AI cannot see — i.e. one nobody can actually run.
//   * The memory store already sanitizes credential-shaped values on write, so a
//     recipe cannot become a place secrets leak from.
//   * No new Rust, no new endpoint, no schema migration.
//
// WHAT A RECIPE IS, AND IS NOT. It is a durable record of a sequence that was
// actually walked on this device, with the outcome it had at the time. It is NOT
// an executable script and this module does not pretend otherwise: re-running it
// still goes through the AI (or the operator), because automatic re-execution is
// the control plane's job (proposal-control-path.md), which is a separate and
// much larger piece of work. The design's own rule applies — say what is true.
import type { SessionPath, PathStep } from "./path";

/** Marker line so a recipe is identifiable in the shared store, and greppable
 *  by a client that only has the raw text. */
export const RECIPE_MARKER = "vale-recipe/v1";

/** Tag every recipe carries, so `memory_search` with tags finds them. */
export const RECIPE_TAG = "recipe";

export interface RecipeDraft {
  /** Short title — becomes the memory entry title. */
  title: string;
  /** The entry body. */
  content: string;
  tags: string[];
}

/** Title shown in the save form, derived from the path so the operator usually
 *  only has to confirm it. Uses the FIRST command (what the run was about) and
 *  the step count. */
export function suggestedTitle(path: SessionPath): string {
  const first = path.steps[0]?.command ?? "empty path";
  const short = first.length > 48 ? `${first.slice(0, 45)}…` : first;
  return `Recipe: ${short} (${path.steps.length} steps)`;
}

export interface RecipeInput {
  name: string;
  /** Which session this was walked on — shell kind and label, so a reader knows
   *  what the commands were run against. */
  sessionLabel?: string;
  sessionKind?: string;
}

/**
 * Render the recipe body.
 *
 * The shape is deliberate: a machine-readable marker line, the outcome summary
 * (so a recipe that half-failed is honest about it rather than presenting itself
 * as a known-good procedure), then the commands one per line in order.
 */
export function buildRecipe(path: SessionPath, input: RecipeInput): RecipeDraft {
  const name = input.name.trim() || "untitled";
  const s = path.summary;

  const outcome: string[] = [`${s.steps} step${s.steps === 1 ? "" : "s"}`];
  if (s.counts.ok) outcome.push(`${s.counts.ok} succeeded`);
  if (s.counts.fail) outcome.push(`${s.counts.fail} FAILED`);
  if (s.counts.warn) outcome.push(`${s.counts.warn} interrupted`);
  if (s.counts.running) outcome.push(`${s.counts.running} still running`);
  if (s.counts.muted) outcome.push(`${s.counts.muted} with no verdict`);

  const where = input.sessionLabel
    ? ` on ${input.sessionKind ? `${input.sessionKind} ` : ""}${input.sessionLabel}`
    : input.sessionKind
      ? ` on a ${input.sessionKind} session`
      : "";

  const lines: string[] = [
    RECIPE_MARKER,
    `# ${name}`,
    `# Walked${where}. Outcome: ${outcome.join(", ")}.`,
  ];
  if (s.counts.fail > 0 || s.counts.warn > 0) {
    lines.push(
      "# NOTE: this run did not complete cleanly — review the marked steps before reusing it.",
    );
  }
  lines.push("#", "# Commands, in order:");
  path.steps.forEach((st, i) => {
    lines.push(`${i + 1}. ${st.command}`);
  });

  return {
    title: name.startsWith("Recipe:") ? name : `Recipe: ${name}`,
    content: lines.join("\n"),
    tags: [RECIPE_TAG],
  };
}

/** Steps that make a recipe questionable — surfaced in the save form so the
 *  operator is not silently saving a broken procedure as a good one. */
export function recipeWarnings(steps: PathStep[]): string[] {
  const out: string[] = [];
  const failed = steps.filter((s) => s.state === "fail").length;
  const cut = steps.filter((s) => s.state === "warn").length;
  const live = steps.filter((s) => s.state === "running").length;
  if (failed) out.push(`${failed} step${failed === 1 ? "" : "s"} failed`);
  if (cut) out.push(`${cut} step${cut === 1 ? "" : "s"} was interrupted`);
  if (live) out.push("the run has not finished");
  return out;
}
