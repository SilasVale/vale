// Run strip — the visual contract for the four row states.
//
// WHY THIS IS A CSS PIN AND NOT A RENDER PIN. The component tests assert each
// state's WORD ("closed" / "open" / "unregistered" / "unattributed"), which is
// the primary channel. This file asserts the second one: the four states must
// stay distinguishable to someone who is not reading the word — and, on this
// panel, they must stay distinguishable WITHOUT colour alone.
//
// That is not a hypothetical here. The discrete-state palette already shipped
// once with two states separated only by an animation that
// `prefers-reduced-motion: reduce` switches off (the incident documented in
// src/lib/statePalette.test.ts), so "two states that a user must tell apart may
// not differ by one channel only" is a rule this codebase has paid for.
//
// Read from the BUILT stylesheet — the artifact the agent embeds via
// include_str! — like the other pins in this directory, so a hand-edit of
// panel.css that diverges from src/styles/ cannot pass silently.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function builtCss(): string {
  return readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      // __tests__/ → styles/ → src/ → panel-react/ → .. (agent/resources/) → panel/panel.css
      "..", "..", "..", "..", "panel", "panel.css",
    ),
    "utf8",
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Declarations of one rule, by exact selector. `null` when absent, so a
 *  renamed selector fails loudly instead of comparing "" to "". */
function blockOf(css: string, selector: string): string | null {
  const m = css.match(new RegExp(escapeRe(selector) + "\\s*\\{([^}]*)\\}"));
  return m ? m[1] : null;
}

/** The LAST declaration of a property — what the cascade actually applies. */
function decl(block: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`, "g");
  let out: string | null = null;
  for (const m of block.matchAll(re)) out = m[1].trim();
  return out;
}

const STATES = ["closed", "open", "unregistered", "unattributed"] as const;

describe("run strip state palette", () => {
  it("draws every state — no state is silently unstyled", () => {
    const css = builtCss();
    for (const s of STATES) {
      expect(
        blockOf(css, `.run-row-state[data-state="${s}"]`),
        `.run-row-state[data-state="${s}"] is missing: a state with no rule ` +
          `renders as the base chip, i.e. identically to every other state`,
      ).not.toBeNull();
    }
  });

  it("gives the four states four DIFFERENT appearances, not one shared look", () => {
    // A user must be able to tell "still open" from "closed" from "we never saw
    // it begin" from "no run at all" at a glance: they mean different things
    // about what the device recorded.
    const css = builtCss();
    const base = blockOf(css, ".run-row-state");
    expect(base, ".run-row-state base rule missing").not.toBeNull();

    const looks = STATES.map((s) => {
      const block = blockOf(css, `.run-row-state[data-state="${s}"]`)!;
      // The base rule carries the shared border WIDTH and colour-source
      // (`currentColor`); each state may override only the style.
      const style = decl(block, "border-style") ?? decl(base!, "border-style");
      const colour = decl(block, "color");
      return { s, style, colour, key: `${colour}|${style}` };
    });

    for (const l of looks) {
      expect(l.colour, `state ${l.s} has no colour of its own`).not.toBeNull();
    }
    const keys = looks.map((l) => l.key);
    expect(
      new Set(keys).size,
      `two run states render identically: ${looks.map((l) => `${l.s}=${l.key}`).join(" | ")}`,
    ).toBe(STATES.length);
  });

  it("does not lean on colour alone — the border SHAPE carries part of it", () => {
    // Four colours from one warm/grey palette are not four distinguishable
    // states for every reader, and this panel has already made that mistake
    // once. The shape channel is what survives.
    const css = builtCss();
    const styles = STATES.map(
      (s) => decl(blockOf(css, `.run-row-state[data-state="${s}"]`)!, "border-style"),
    );
    expect(
      styles.every((v) => v != null),
      "every state must state its own border style rather than inheriting one",
    ).toBe(true);
    // Not four different styles — but not one either: "unregistered" and
    // "unattributed" are the two states a reader is most likely to confuse
    // ("we lost the beginning" vs "there was never a run"), so they must differ
    // by more than their ink.
    expect(new Set(styles).size).toBeGreaterThanOrEqual(3);
  });
});
