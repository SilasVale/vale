// Session archive — the visual contract for its state pair.
//
// WHY A CSS PIN. The component tests assert the state's WORD ("live" /
// "archived"), which is the primary channel. This file asserts the second one —
// and it is the channel this repo has already been burned by: the discrete-state
// palette once shipped with two states separated only by an animation that
// `prefers-reduced-motion: reduce` switches off (the incident recorded in
// src/lib/statePalette.test.ts). Here the second channel is SHAPE (a solid pill
// against a dashed one), the same pairing the activity page's two feed badges
// use, and it is read from the BUILT stylesheet — the artifact the agent embeds
// via include_str! — so a hand-edit of panel.css that diverges from
// src/styles/ cannot pass silently.
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

/** Every rule in the built stylesheet whose selector mentions `.archive-`. */
function archiveRules(css: string): Array<{ selector: string; block: string }> {
  return [...css.matchAll(/(^|\n)([^\n{}]*\.archive-[^\n{}]*)\{([^}]*)\}/g)].map((m) => ({
    selector: m[2].trim(),
    block: m[3],
  }));
}

describe("session archive — live vs archived", () => {
  it("styles both states, and they are not one shared look", () => {
    const css = builtCss();
    const live = blockOf(css, '.archive-state[data-state="live"]');
    const archived = blockOf(css, '.archive-state[data-state="archived"]');
    expect(live, '.archive-state[data-state="live"] missing').not.toBeNull();
    expect(archived, '.archive-state[data-state="archived"] missing').not.toBeNull();
    expect(decl(live!, "color")).not.toBe(decl(archived!, "color"));
  });

  it("does not lean on colour alone — the pill SHAPE tells them apart too", () => {
    // The word is drawn by the component; this is the second non-colour channel,
    // and it is the one a reader who cannot separate the inks still reads.
    const css = builtCss();
    const base = blockOf(css, ".archive-state");
    expect(base, ".archive-state base rule missing").not.toBeNull();
    const shape = (s: string) =>
      decl(blockOf(css, `.archive-state[data-state="${s}"]`)!, "border-style") ?? decl(base!, "border-style");
    expect(shape("live")).not.toBe(shape("archived"));
    expect(shape("live")).not.toBeNull();
    expect(shape("archived")).not.toBeNull();
    // ...and not only by colour: the declarations that are not colour differ.
    expect(nonColour(blockOf(css, '.archive-state[data-state="live"]')!))
      .not.toEqual(nonColour(blockOf(css, '.archive-state[data-state="archived"]')!));
  });

  it("uses tokens only — no raw hex in any archive rule", () => {
    const css = builtCss();
    const rules = archiveRules(css);
    expect(rules.length).toBeGreaterThan(0);
    for (const { selector, block } of rules) {
      const hex = block.match(/#[0-9a-fA-F]{3,8}\b/g);
      expect(hex, `${selector} hardcodes ${hex?.join(", ")} — use a token`).toBeNull();
    }
  });

  it("has no animation at all — this surface is a record, not a live process", () => {
    // Same rule the activity page carries: nothing here may depend on motion to
    // be readable, and nothing may imply work is still happening.
    const css = builtCss();
    for (const { selector, block } of archiveRules(css)) {
      expect(block, `${selector} animates`).not.toMatch(/animation\s*:/);
    }
  });
});

describe("session archive — the honest empties", () => {
  it("has a styled quiet line, so an empty archive is never an unstyled void", () => {
    const css = builtCss();
    const empty = blockOf(css, ".archive-empty");
    expect(empty, ".archive-empty missing from the built panel.css").not.toBeNull();
    expect(decl(empty!, "color")).toContain("--muted");
  });

  it("gives a FAILED read its own shape, not just a different ink", () => {
    // "The archive could not be read" and "the archive is empty" are different
    // facts; the sentence carries the difference and the left bar carries it for
    // a reader skimming past the words.
    const css = builtCss();
    const fail = blockOf(css, ".archive-empty-fail");
    expect(fail, ".archive-empty-fail missing").not.toBeNull();
    expect(decl(fail!, "border-left")).not.toBeNull();
    // It must not be styled as the ordinary quiet line.
    const plain = blockOf(css, ".archive-empty")!;
    expect(nonColour(fail!)).not.toEqual(nonColour(plain));
  });

  it("keeps the trail pane a single scroller (no nested scroll region)", () => {
    const css = builtCss();
    const trail = blockOf(css, '.archive-page[data-view="trail"]');
    expect(trail, '.archive-page[data-view="trail"] missing').not.toBeNull();
    expect(decl(trail!, "overflow")).toBe("hidden");
  });

  it("styles the bounded list's own control and target", () => {
    const css = builtCss();
    expect(blockOf(css, ".archive-more"), ".archive-more missing").not.toBeNull();
    expect(blockOf(css, ".archive-back"), ".archive-back missing").not.toBeNull();
    expect(blockOf(css, ".archive-trail-head"), ".archive-trail-head missing").not.toBeNull();
    // A row is a BUTTON and must show a keyboard focus ring.
    expect(decl(blockOf(css, ".archive-row:focus-visible") ?? "", "outline")).toContain("--focus-ring");
  });
});
