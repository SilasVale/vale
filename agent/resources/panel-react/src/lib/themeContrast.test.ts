// ============================================================================
// Theme contrast — the recessed-surface contract.
//
// A REAL, MEASURED DEFECT motivates this file. Eight blocks (command output,
// details panes, the trajectory body, the plugin log, the MCP config snippet)
// painted their background with `var(--ds-neutral-50)`. That token is part of
// the raw neutral scale, which the dark theme does NOT override — so in dark
// mode those blocks kept a #fafafa (near-white) background while the text
// colour flipped to #ecedef (near-white). Measured in a real browser on the
// built stylesheet: contrast **1.12**, i.e. unreadable.
//
// The bug survived a hand-built visual gallery because that gallery redefined
// the CSS variables itself instead of using the app's real
// `body[data-theme="dark"]`. The lesson is in the second test below.
//
// The fix is a semantic token, `--surface-recessed`, declared as `var(--bg)` —
// which resolves to #fafafa in light (byte-identical to before) and #131418 in
// dark. It must be declared in BOTH blocks, and THAT is the trap this file
// exists to guard: custom properties substitute at computed-value time on the
// element that DECLARES them and then inherit as that computed value, so the
// `:root` declaration freezes against the LIGHT --bg and the body's dark
// override never reaches it. The first fix attempt omitted the dark restatement
// for exactly that reason and re-measured 1.12.
// ============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function builtCss(): string {
  return readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "..", "..", "panel", "panel.css",
    ),
    "utf8",
  );
}

/** Declarations of one top-level block, by exact selector. */
function blockOf(css: string, selector: string): string {
  const m = css.match(
    new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([\\s\\S]*?)\\n\\}"),
  );
  expect(m, `block ${selector} not found in built panel.css`).not.toBeNull();
  return m![1];
}

describe("recessed content surfaces", () => {
  it("--surface-recessed is declared in BOTH theme blocks", () => {
    const css = builtCss();
    const root = blockOf(css, ":root");
    const dark = blockOf(css, 'body[data-theme="dark"]');

    expect(root, ":root must define --surface-recessed").toMatch(
      /--surface-recessed\s*:/,
    );
    // THE TRAP. Without this restatement the :root value is frozen against the
    // light --bg and inherits unchanged into the dark theme — which is how the
    // first fix attempt still measured 1.12.
    expect(
      dark,
      "body[data-theme=\"dark\"] MUST restate --surface-recessed.\n" +
        "Custom properties substitute on the element that declares them and " +
        "then inherit as that computed value, so a :root-only declaration " +
        "cannot follow the dark --bg. Removing this line reintroduces " +
        "near-white text on a near-white background (measured contrast 1.12).",
    ).toMatch(/--surface-recessed\s*:/);
  });

  it("recessed blocks resolve against --bg, not the raw neutral scale", () => {
    const css = builtCss();
    // The dark theme does not override --ds-neutral-*, so any background drawn
    // from that scale keeps its LIGHT value in dark mode. --surface-recessed is
    // the theme-aware name for exactly this role.
    const offenders = [...css.matchAll(/background\s*:\s*var\(--ds-neutral-50\)/g)];
    expect(
      offenders.length,
      "a background uses the raw --ds-neutral-50 scale: it will stay light in " +
        "dark mode while the text colour flips. Use --surface-recessed.",
    ).toBe(0);

    // ...and the leaf rules must actually reach for the semantic token. The
    // bound is the SEVEN pre-existing recessed panes (.cmd-out, .details-json,
    // .details-output, .traj-search, .traj-round-head:hover, .traj-body,
    // .plug-log) — new consumers only raise it. Deliberately not an exact
    // count: an equality here breaks every time a pane is added, which trains
    // people to bump the number instead of reading it.
    const uses = [...css.matchAll(/background\s*:\s*var\(--surface-recessed\)/g)];
    expect(
      uses.length,
      "recessed panes have stopped using --surface-recessed — did one revert " +
        "to the raw neutral scale?",
    ).toBeGreaterThanOrEqual(7);
  });

  it("the token follows the theme (light #fafafa, dark #131418)", () => {
    // Both blocks say `var(--bg)`; the point is that they EACH say it, so each
    // resolves against its own --bg. This asserts the shape of the declaration
    // rather than a resolved colour, because the built sheet is static text.
    const css = builtCss();
    for (const sel of [":root", 'body[data-theme="dark"]']) {
      const block = blockOf(css, sel);
      expect(block).toMatch(/--surface-recessed\s*:\s*var\(--bg\)/);
      expect(block, `${sel} must also define --bg itself`).toMatch(/--bg\s*:/);
    }
  });
});
