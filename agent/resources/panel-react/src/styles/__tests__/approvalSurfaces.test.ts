// The approval gate's two settled/urgent surfaces and the waiting badges —
// read from the BUILT stylesheet, the bytes the agent embeds via include_str!.
// A hand-edit of panel.css that diverges from src/styles/ must not pass, and
// neither must a "small cleanup" that quietly turns the retired row back into a
// live-looking prompt or makes a waiting mark differ from its neighbours only
// by animation (the incident this repo already has on record).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function builtCss(): string {
  return readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "..", "..", "..", "panel", "panel.css",
    ),
    "utf8",
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact selector's declaration block, or null when absent (so a renamed
 *  selector fails loudly instead of silently comparing "" to ""). */
function blockOf(css: string, selector: string): string | null {
  const m = css.match(new RegExp(escapeRe(selector) + "\\s*\\{([^}]*)\\}"));
  return m ? m[1] : null;
}

/** Everything a user with `prefers-reduced-motion` still sees. */
function withoutAnimation(block: string): string[] {
  return block
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !/^animation(-duration|-name)?\s*:/.test(d))
    .sort();
}

function expectNoRawHex(block: string, selector: string): void {
  const hex = block.match(/#[0-9a-fA-F]{3,8}\b/g);
  expect(hex, `${selector} hardcodes ${hex?.join(", ")} — use a token`).toBeNull();
}

describe("the retired question (0 s)", () => {
  it("is demoted to a quiet chip, NOT the live prompt's warning treatment", () => {
    const css = builtCss();
    const expired = blockOf(css, ".approval-expired");
    expect(expired, ".approval-expired missing from the built panel.css").not.toBeNull();
    expect(expired!).toContain("var(--surface-chip)");
    expect(expired!).toMatch(/border:\s*1px solid var\(--line\)/);
    // --chrome-ink-dim, not --muted: --muted measured 4.40 on this surface
    // (the repo's own recorded near miss on the count chips).
    expect(expired!).toContain("color: var(--chrome-ink-dim)");
    // The warning wash belongs to a LIVE question. On a settled row it would
    // read as "still your move" — the exact misreading the row exists to stop.
    expect(expired!).not.toContain("--warn");
    expectNoRawHex(expired!, ".approval-expired");

    // ...and the live prompt keeps the treatment that was taken away.
    const prompt = blockOf(css, ".approval-prompt")!;
    expect(prompt).toContain("var(--warn)");
    expect(prompt).toContain("var(--warn-soft)");
  });
});

describe("the gate's screen-reader plumbing", () => {
  it("has a clipped (not display:none) utility for the static description", () => {
    // display:none would drop the text out of the accessibility tree entirely,
    // so the alertdialog's aria-describedby would resolve to nothing.
    const sr = blockOf(builtCss(), ".approval-sr");
    expect(sr, ".approval-sr missing").not.toBeNull();
    expect(sr!).toMatch(/position:\s*absolute/);
    expect(sr!).toMatch(/clip:\s*rect\(0 0 0 0\)/);
    expect(sr!).not.toMatch(/display:\s*none/);
  });

  it("says the LAST MINUTE in words, in the readable danger weight", () => {
    const urgent = blockOf(builtCss(), ".approval-urgent");
    expect(urgent, ".approval-urgent missing — the urgent state would be colour-only").not.toBeNull();
    expect(urgent!).toContain("var(--danger-on-soft)");
    // Never animation alone: a state whose only difference is motion vanishes
    // for anyone with prefers-reduced-motion.
    expect(urgent!).not.toMatch(/animation\s*:/);
  });
});

describe("waiting badges", () => {
  it("the rail's waiting dot is a different SHAPE, not just another colour", () => {
    const css = builtCss();
    const waiting = blockOf(css, '.rail-dot[data-state="waiting"]');
    const working = blockOf(css, '.rail-dot[data-state="working"]');
    const idle = blockOf(css, '.rail-dot[data-state="idle"]');
    expect(waiting, '.rail-dot[data-state="waiting"] missing').not.toBeNull();
    expect(working, '.rail-dot[data-state="working"] missing').not.toBeNull();
    expect(idle, '.rail-dot[data-state="idle"] missing').not.toBeNull();

    // --state-warn and --state-running share one orange band at 8px, so colour
    // cannot carry waiting-vs-working on its own.
    expect(waiting!).toContain("var(--state-warn)");
    expect(waiting!).toMatch(/rotate\(45deg\)/);
    // Distinguishable with animation removed (and this rule has no animation to
    // begin with — pinned so that stays true).
    expect(withoutAnimation(waiting!)).not.toEqual(withoutAnimation(working!));
    expect(withoutAnimation(waiting!)).not.toEqual(withoutAnimation(idle!));
    expectNoRawHex(waiting!, '.rail-dot[data-state="waiting"]');
  });

  it("the desktop rail carries the same waiting shape", () => {
    const css = builtCss();
    const desktop = blockOf(css, '.desktop-rail-status[data-state="waiting"] .dot');
    expect(desktop, "the desktop rail has no waiting state — the two densities would drift")
      .not.toBeNull();
    expect(desktop!).toContain("var(--state-warn)");
    expect(desktop!).toMatch(/rotate\(45deg\)/);
    expectNoRawHex(desktop!, '.desktop-rail-status[data-state="waiting"] .dot');
  });

  it("the tab's waiting mark is a distinct shape from the lane dot", () => {
    const css = builtCss();
    const lane = blockOf(css, ".tab-dot")!;
    const wait = blockOf(css, ".tab-wait");
    expect(wait, ".tab-wait missing").not.toBeNull();
    // .tab-dot is already a circle; a second circle beside it reads as another
    // lane, which is a different claim.
    expect(lane).toMatch(/border-radius:\s*50%/);
    expect(wait!).toMatch(/rotate\(45deg\)/);
    expect(withoutAnimation(wait!)).not.toEqual(withoutAnimation(lane));
    expect(wait!).toContain("var(--state-warn)");
    expectNoRawHex(wait!, ".tab-wait");
  });

  it("the device-level chip uses the chip surface and a token mark", () => {
    const css = builtCss();
    const chip = blockOf(css, ".waiting-chip");
    const mark = blockOf(css, ".waiting-mark");
    expect(chip, ".waiting-chip missing").not.toBeNull();
    expect(mark, ".waiting-mark missing").not.toBeNull();
    expect(chip!).toContain("var(--surface-chip)");
    expect(chip!).toContain("color: var(--chrome-ink-dim)");
    expect(mark!).toContain("var(--state-warn)");
    expect(mark!).toMatch(/rotate\(45deg\)/);
    expectNoRawHex(chip!, ".waiting-chip");
    expectNoRawHex(mark!, ".waiting-mark");
  });
});
