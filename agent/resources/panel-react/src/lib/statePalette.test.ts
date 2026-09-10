// ============================================================================
// Discrete state palette — the visual contract for the five AI/command states.
//
// WHY THIS FILE EXISTS. "running" and "ok" used to be the SAME colour
// (`var(--accent)`) and differed ONLY by the `cmd-pulse` animation. The panel
// also honours `prefers-reduced-motion: reduce`, which sets `animation: none`
// on .cmd-dot, .traj-ev-dot and .plug-dot. So for anyone with that setting —
// a standard accessibility preference, not an edge case — "the AI is still
// working" and "the AI has finished" rendered IDENTICALLY, in three separate
// components at once.
//
// The defect was invisible to every existing gate: the tests were green, the
// stylesheet was valid, and the two rules LOOKED different when read side by
// side (one had an animation).
//
// So the contract pinned here is deliberately narrow and mechanical:
//
//     two states that a user must be able to tell apart may not differ ONLY
//     by animation.
//
// That is exactly the property whose absence caused the bug, and it is the
// one thing a future edit is most likely to break — by "simplifying" two
// nearby rules back into one shared colour.
// ============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The built stylesheet — the artifact the agent embeds via include_str!.
 *  Read from the BUILD, like the tab-visibility pin: a hand-edit of panel.css
 *  that diverges from src/styles/ must not pass silently. */
function builtCss(): string {
  return readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "..", "..", "panel", "panel.css",
    ),
    "utf8",
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Declaration block for an EXACT selector. Returns null when absent, so a
 *  renamed selector fails loudly instead of silently comparing "" to "". */
function blockOf(css: string, selector: string): string | null {
  const m = css.match(new RegExp(escapeRe(selector) + "\\s*\\{([^}]*)\\}"));
  return m ? m[1] : null;
}

/** Declarations that survive with animation switched off — i.e. everything a
 *  user with `prefers-reduced-motion` still sees. This is the whole point:
 *  if two states are identical here, they are identical for that user. */
function withoutAnimation(block: string): string[] {
  return block
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !/^animation(-duration|-name)?\s*:/.test(d))
    .sort();
}

/** Each entry is one component's "in progress" state against its "settled
 *  successfully" state. All three carried the identical defect, so all three
 *  are pinned — fixing one and missing the others is how they drifted. */
const PAIRS: Array<{ component: string; active: string; done: string }> = [
  { component: "command card", active: ".cmd-dot", done: ".cmd-dot" },
  { component: "trajectory rail", active: ".traj-ev-dot", done: ".traj-ev-dot" },
  { component: "plugin page", active: ".plug-dot", done: ".plug-dot" },
];

/** State values differ per component: the plugin page uses
 *  ongoing/success, the other two use running/ok. */
const STATES: Record<string, { active: string; done: string }> = {
  ".cmd-dot": { active: "running", done: "ok" },
  ".traj-ev-dot": { active: "running", done: "ok" },
  ".plug-dot": { active: "ongoing", done: "success" },
};

describe("discrete state palette", () => {
  describe.each(PAIRS)("$component", ({ active }) => {
    const { active: aState, done: dState } = STATES[active];
    const selA = `${active}[data-state="${aState}"]`;
    const selD = `${active}[data-state="${dState}"]`;

    it(`${aState} and ${dState} differ WITHOUT relying on animation`, () => {
      const css = builtCss();
      const a = blockOf(css, selA);
      const d = blockOf(css, selD);

      // Absent rules must fail as themselves, not as "" vs "".
      expect(a, `${selA} missing from built panel.css`).not.toBeNull();
      expect(d, `${selD} missing from built panel.css`).not.toBeNull();

      const aStatic = withoutAnimation(a!);
      const dStatic = withoutAnimation(d!);

      expect(
        aStatic,
        `${selA} and ${selD} are IDENTICAL once animation is removed.\n` +
          `A user with prefers-reduced-motion cannot tell "${aState}" from ` +
          `"${dState}". Give them different COLOUR or different SHAPE — ` +
          `animation alone is not a state channel.`,
      ).not.toEqual(dStatic);
    });
  });

  it("the four VERDICT states agree across both renderers", () => {
    // The command stream and the trajectory rail are two renderers of one
    // vocabulary, so a verdict must not mean one colour in one place and
    // another colour in the other. `muted` is excluded on purpose — see the
    // next test for why its density differs.
    const css = builtCss();
    for (const s of ["running", "ok", "fail", "warn"]) {
      const a = blockOf(css, `.cmd-dot[data-state="${s}"]`);
      const b = blockOf(css, `.traj-ev-dot[data-state="${s}"]`);
      expect(a, `.cmd-dot ${s} missing`).not.toBeNull();
      expect(b, `.traj-ev-dot ${s} missing`).not.toBeNull();
      const colour = (block: string) =>
        (block.match(/background\s*:\s*([^;]+)/) || [, "<none>"])[1].trim();
      expect(colour(b!), `.traj-ev-dot ${s} disagrees with .cmd-dot ${s}`)
        .toBe(colour(a!));
    }
  });

  it("no two states collapse onto one colour in either renderer", () => {
    // Colour alone cannot carry five states in this palette (three of the five
    // hues share one red-orange band), which is why SHAPE carries part of the
    // difference too — but no two of the five may share a colour, or the shape
    // work would be doing all the lifting on its own.
    const css = builtCss();
    for (const c of [".cmd-dot", ".traj-ev-dot"]) {
      const seen = ["running", "ok", "fail", "warn", "muted"].map((s) => {
        const b = blockOf(css, `${c}[data-state="${s}"]`);
        expect(b, `${c}[data-state="${s}"] missing`).not.toBeNull();
        return (b!.match(/background\s*:\s*([^;]+)/) || [, "<none>"])[1].trim();
      });
      const painted = seen.filter((v) => v !== "transparent");
      expect(new Set(painted).size, `${c} duplicate state colours: ${seen.join(" | ")}`)
        .toBe(painted.length);
    }
  });

  it("muted reads as ABSENCE, tailored to each renderer's density", () => {
    // The one deliberate asymmetry, pinned so it stays a decision:
    //   command card — muted is rare (a command ended without a verdict), so
    //                  it is a HOLLOW ring: "nothing concluded here".
    //   trajectory   — muted is the MAJORITY (every raw output line), so it is
    //                  a quiet FILLED dot: texture, not a marker.
    const css = builtCss();
    const cardMuted = blockOf(css, `.cmd-dot[data-state="muted"]`)!;
    expect(cardMuted, "card muted should be unfilled").toContain("transparent");
    expect(cardMuted, "card muted should keep a visible outline")
      .toMatch(/box-shadow\s*:\s*inset/);

    const railMuted = blockOf(css, `.traj-ev-dot[data-state="muted"]`)!;
    expect(railMuted, "rail muted should be a quiet FILLED dot, not a ring")
      .not.toContain("transparent");
    expect(railMuted, "rail muted must not borrow a verdict colour")
      .toContain("--ds-neutral");
  });

  it("the reduced-motion premise still holds for every state dot", () => {
    // This test documents WHY the rule above is necessary. If a future edit
    // drops these selectors from the reduced-motion block, the premise
    // changes — and that should be a deliberate decision, not a silent one.
    const css = builtCss();
    const media = css.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(media, "the prefers-reduced-motion block is gone").not.toBeNull();
    for (const sel of [".cmd-dot", ".traj-ev-dot", ".plug-dot"]) {
      expect(media![1], `${sel} must still honour reduced motion`).toContain(sel);
    }
    expect(media![1], "the block must actually disable animation").toMatch(
      /animation\s*:\s*none/,
    );
  });
});
