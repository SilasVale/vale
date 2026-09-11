// Activity page — the visual contract for its two state pairs.
//
// WHY A CSS PIN. The component tests assert each state's WORD ("terminal" /
// "browser", "exit 0" / a non-zero code), which is the primary channel. This
// file asserts the second one — and it is the channel this repo has already been
// burned by: the discrete-state palette once shipped with two states separated
// only by an animation that `prefers-reduced-motion: reduce` switches off (the
// incident recorded in src/lib/statePalette.test.ts), and the run strip next to
// this page carries the same rule for its four run states.
//
// TWO PAIRS MATTER HERE, and both are pairs a reader must act on:
//   * the two FEEDS — a terminal command and a browser action are different
//     kinds of work, and the browser one has no session to fall back on;
//   * `exit 0` and any other exit code — and, just as important, the ABSENCE of
//     an exit code, which is not a state at all: it draws no element, so there
//     is nothing here to style and nothing to confuse with zero.
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

/** Everything that is NOT colour. Two states that differ only here are still
 *  distinguishable to a reader who cannot tell the two hues apart. */
function nonColour(block: string): string[] {
  return block
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !/^(color|background|background-color|border-color)\s*:/.test(d))
    .sort();
}

function expectNoRawHex(block: string, selector: string): void {
  const hex = block.match(/#[0-9a-fA-F]{3,8}\b/g);
  expect(hex, `${selector} hardcodes ${hex?.join(", ")} — use a token`).toBeNull();
}

describe("activity page — the two feeds", () => {
  it("styles both sources, and they are not one shared look", () => {
    const css = builtCss();
    const terminal = blockOf(css, '.activity-row-source[data-source="terminal"]');
    const browser = blockOf(css, '.activity-row-source[data-source="browser"]');
    expect(terminal, ".activity-row-source[data-source=\"terminal\"] missing").not.toBeNull();
    expect(browser, ".activity-row-source[data-source=\"browser\"] missing").not.toBeNull();
    expect(decl(terminal!, "color")).not.toBe(decl(browser!, "color"));
  });

  it("does not lean on colour alone — the border SHAPE tells them apart too", () => {
    const css = builtCss();
    const base = blockOf(css, ".activity-row-source");
    expect(base, ".activity-row-source base rule missing").not.toBeNull();
    const style = (s: string) =>
      decl(blockOf(css, `.activity-row-source[data-source="${s}"]`)!, "border-style") ??
      decl(base!, "border-style");
    // The shape channel is what survives a reader who cannot separate the two
    // inks, and it is the channel the repo already paid for (statePalette).
    expect(style("terminal")).not.toBe(style("browser"));
    expect(style("terminal")).not.toBeNull();
    expect(style("browser")).not.toBeNull();
  });

  it("uses tokens only — no raw hex in any activity rule", () => {
    const css = builtCss();
    // Every rule whose selector mentions .activity-, taken one at a time.
    for (const m of css.matchAll(/(^|\n)([^\n{}]*\.activity-[^\n{}]*)\{([^}]*)\}/g)) {
      expectNoRawHex(m[3], m[2].trim());
    }
  });
});

describe("activity page — exit codes", () => {
  it("styles zero and non-zero separately", () => {
    const css = builtCss();
    const zero = blockOf(css, '.activity-row-exit[data-exit="zero"]');
    const nonzero = blockOf(css, '.activity-row-exit[data-exit="nonzero"]');
    expect(zero, "exit-code zero rule missing").not.toBeNull();
    expect(nonzero, "exit-code nonzero rule missing").not.toBeNull();
  });

  it("keeps the two apart by SHAPE as well as by ink", () => {
    // "It exited 0" and "it exited 1" are the pair an operator scans a page
    // for. Colour alone cannot carry that for every reader — and this page
    // cannot use colour as a success/failure verdict anyway (an exit code is
    // not a judgement about whether the run was right).
    const css = builtCss();
    const base = blockOf(css, ".activity-row-exit");
    expect(base, ".activity-row-exit base rule missing").not.toBeNull();
    const zero = blockOf(css, '.activity-row-exit[data-exit="zero"]')!;
    const nonzero = blockOf(css, '.activity-row-exit[data-exit="nonzero"]')!;
    const shapeOf = (block: string) => decl(block, "border-style") ?? decl(base!, "border-style");
    expect(shapeOf(nonzero)).not.toBe(shapeOf(zero));
    // ...and not only by colour: the declarations that are not colour differ.
    expect(nonColour(zero)).not.toEqual(nonColour(nonzero));
  });

  it("does NOT dim zero into looking like an absent value", () => {
    // An absent exit code draws NO element at all (see ActivityPage), so the
    // zero element must not be the one that reads as "nothing here": it holds
    // the ordinary reading ink rather than a faint one.
    const css = builtCss();
    const zero = blockOf(css, '.activity-row-exit[data-exit="zero"]')!;
    expect(decl(zero, "color")).not.toContain("--faint");
    expect(decl(zero, "opacity")).toBeNull();
  });
});

describe("activity page — the empty state and the page frame", () => {
  it("has a styled quiet line, so the empty page is never an unstyled void", () => {
    const css = builtCss();
    const empty = blockOf(css, ".activity-empty");
    expect(empty, ".activity-empty missing from the built panel.css").not.toBeNull();
    expect(decl(empty!, "color")).toContain("--muted");
  });

  it("sets the unattributed group apart from the runs above it", () => {
    const css = builtCss();
    const bucket = blockOf(css, ".activity-group-unattributed");
    expect(bucket, ".activity-group-unattributed missing").not.toBeNull();
    expect(bucket!).toContain("var(--surface-recessed)");
  });

  it("has no live/animation state that reduced motion could erase", () => {
    // This page is a post-hoc record: nothing on it may depend on an animation
    // to be readable, and nothing may imply work is still happening.
    const css = builtCss();
    for (const m of css.matchAll(/(^|\n)([^\n{}]*\.activity-[^\n{}]*)\{([^}]*)\}/g)) {
      expect(m[3], `${m[2].trim()} animates`).not.toMatch(/animation\s*:/);
    }
  });
});
