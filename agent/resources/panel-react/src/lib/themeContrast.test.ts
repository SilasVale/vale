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

  it("no background is drawn from the raw neutral scale", () => {
    const css = builtCss();
    // The dark theme does NOT override --ds-neutral-*, so any background drawn
    // from that scale keeps its LIGHT value while the text colour flips. This
    // is one defect family, found twice: --ds-neutral-50 on the recessed panes
    // (measured 1.12) and --ds-neutral-100 on the chips (measured 2.28 on the
    // view switch, plus five others). The semantic tokens name the ROLE:
    // --surface-recessed for panes, --surface-chip for pills.
    //
    // --ds-neutral-300 IS still allowed: it draws DOTS (trajectory muted, closed
    // session), which have no text and read fine as light marks on a dark
    // surface. The rule is about text-bearing surfaces, so it is written
    // against the two scale steps used as such.
    for (const step of ["50", "100"]) {
      const offenders = [
        ...css.matchAll(new RegExp(`background\\s*:\\s*var\\(--ds-neutral-${step}\\)`, "g")),
      ];
      expect(
        offenders.length,
        `a background uses the raw --ds-neutral-${step} scale: it stays light in ` +
          `dark mode while the text colour flips. Use --surface-recessed (panes) ` +
          `or --surface-chip (pills).`,
      ).toBe(0);
    }

    // ...and the leaf rules must actually reach for the semantic token. The
    // bound is the SEVEN pre-existing recessed panes (.cmd-out, .details-json,
    // .details-output, .traj-search, .traj-round-head:hover, .traj-body,
    // .plug-log) — new consumers only raise it. Deliberately not an exact
    // count: an equality here breaks every time a pane is added, which trains
    // people to bump the number instead of reading it. This half matters
    // because the assertion above only bans the SPECIFIC regression (the raw
    // scale step); a hardcoded #fafafa would slip past it.
    const uses = [...css.matchAll(/background\s*:\s*var\(--surface-recessed\)/g)];
    expect(
      uses.length,
      "recessed panes have stopped using --surface-recessed — did one revert " +
        "to a hardcoded colour?",
    ).toBeGreaterThanOrEqual(7);
    const chips = [...css.matchAll(/background\s*:\s*var\(--surface-chip\)/g)];
    expect(
      chips.length,
      "chip surfaces have stopped using --surface-chip",
    ).toBeGreaterThanOrEqual(6);
  });

  it("--surface-chip is declared in BOTH theme blocks", () => {
    const css = builtCss();
    expect(blockOf(css, ":root"), ":root must define --surface-chip").toMatch(
      /--surface-chip\s*:/,
    );
    expect(
      blockOf(css, 'body[data-theme="dark"]'),
      'body[data-theme="dark"] MUST restate --surface-chip — same computed-value ' +
        "trap as --surface-recessed: a :root-only declaration freezes against the " +
        "light value and the chips stay bright pills on a dark page.",
    ).toMatch(/--surface-chip\s*:/);
  });

  it("count chips are readable in both themes", () => {
    // These are NUMBERS the operator reads, not decoration. They carried
    // --faint first (2.34 light / 3.14 dark), then --muted — which was verified
    // only as "better than --faint" and measured 4.40 on the chip when the REAL
    // running app was audited, i.e. still under AA. A near miss is a miss.
    //
    // All four carry the identical token pair, so the measurement transfers:
    // it is a property of `--muted on --surface-chip`, not of the one element
    // that happened to be on screen.
    const css = builtCss();
    for (const sel of [".side-count", ".cmd-stream-count", ".traj-count", ".plug-count"]) {
      const block = blockOf(css, sel);
      expect(block, `${sel} must use ink that clears AA on the chip`).toMatch(
        /color\s*:\s*var\(--chrome-ink-dim\)/,
      );
      expect(block, `${sel} must sit on the theme-aware chip surface`).toMatch(
        /background\s*:\s*var\(--surface-chip\)/,
      );
    }
  });

  it("accent TEXT uses the readable weight, not the chrome accent", () => {
    // MEASURED, both themes: --accent-ink as small text on --accent-soft gives
    // 3.83 (light) / 3.23 (dark) — under AA for 10.5–11px. It is the CHROME
    // accent (icons, dots, borders) and is too light to read. Five sites carried
    // the pattern, three of them added by earlier rounds of this same work, so
    // it is pinned rather than left to be rediscovered.
    const css = builtCss();
    // The token exists in BOTH blocks — same computed-value trap as the rest.
    expect(blockOf(css, ":root")).toMatch(/--accent-on-soft\s*:/);
    expect(blockOf(css, 'body[data-theme="dark"]')).toMatch(/--accent-on-soft\s*:/);

    const sites = [
      '.cmd-badge[data-state="running"]',
      '.plug-tag[data-state="ongoing"]',
      '.path-summary-live',
      '.path-step-tag.s-running',
    ];
    // `#session-control.held` uses the same token but is asserted by the
    // component's OWN test — it ships in a separate change, and a pin that
    // spans both would make each commit fail on the other's absence.
    for (const sel of sites) {
      const block = blockOf(css, sel);
      expect(
        block,
        `${sel} must use the readable accent weight for TEXT; --accent-ink ` +
          `measures under AA on these backgrounds`,
      ).toMatch(/color\s*:\s*var\(--accent-on-soft\)/);
    }
  });

  it("status text uses the readable weight, in BOTH themes", () => {
    // MEASURED, in a real browser against both theme blocks. The bare status
    // tokens are tuned for MARKS (dots, borders, bars); as small text on their
    // own soft wash they failed AA:
    //
    //   --danger  on --danger-soft   4.27 light / 3.63 dark
    //   --success on a surface       3.45 light
    //   --warn-ink (dark)            2.25   <- the approval prompt's title,
    //                                          countdown and "not run" note
    //
    // Each row is a real site, not a token probe: a token measuring badly is
    // only a defect where something actually renders it as text.
    const css = builtCss();
    const textSites: Array<[string, string]> = [
      ['.cmd-badge[data-state="fail"]', "--danger-on-soft"],
      ['.plug-tag[data-state="error"]', "--danger-on-soft"],
      ['.path-step-tag.s-fail', "--danger-on-soft"],
      ['.path-attention-tag.s-fail', "--danger-on-soft"],
      ['.traj-ev-code[data-state="fail"]', "--danger-on-soft"],
      ['.path-summary-good', "--success-text"],
      ['.connect-probe.ok', "--success-text"],
      // The gate's own sites join the list WITH the gate (they ship together).
      ['.approval-left.urgent', "--danger-on-soft"],
      ['.approval-title', "--warn-ink"],
      ['.approval-left', "--warn-ink"],
      ['.approval-note', "--warn-ink"],
      // The grant row: the word is WHAT RUNS UNSKED and the x is the only way to
      // undo it, so neither may be the least readable thing on the line.
      // Measured before: --muted 4.31 and --faint 2.33 on the chip surface.
      ['.approval-grant code', "--chrome-ink-dim"],
      ['.approval-grant-x', "--chrome-ink-dim"],
      // The goal bar: the invitation must be readable enough to take, and the
      // primary Save carries white text (which is why it uses --accent-solid —
      // the brand orange gives white only 4.30).
      ['.path-goal-label', "--accent-on-soft"],
      ['.path-goal-text', "--accent-on-soft"],
      // The intent layer's row. The alternatives are the branches NOT taken —
      // real content and the reason the field exists — so struck-through is a
      // decoration, not a licence to be unreadable. Measured before: the label
      // 2.56, the items 4.40.
      ['.path-step-why-mark', "--chrome-ink-dim"],
      ['.path-step-alt-label', "--chrome-ink-dim"],
      ['.path-step-alt-item', "--chrome-ink-dim"],
      // Governance events in the timeline: the objective, and each approval
      // action. `armed`/`disarmed` are the accent, approvals the success ink,
      // refusals the danger ink — a single grey pill would make a revocation
      // look like an arming.
      ['.traj-ev-goal', "--accent-on-soft"],
      ['.traj-ev-goal-label', "--accent-on-soft"],
      // Comma-lists: blockOf matches the full selector text, so these are the
      // pairs as written rather than one arm of each.
      ['.traj-ev-gov[data-action="armed"], .traj-ev-gov[data-action="disarmed"]', "--accent-on-soft"],
      ['.traj-ev-gov[data-action="approved"], .traj-ev-gov[data-action="granted"]', "--success-text"],
      ['.traj-ev-gov[data-action="refused"], .traj-ev-gov[data-action="revoked"]', "--danger-on-soft"],
      ['.traj-ev-gov-sub', "--chrome-ink"],
      // CHROME TEXT — found by auditing EVERY text node in the real running app,
      // not the elements I had just written. These five had been wrong the whole
      // time and no feature-by-feature audit could see them: I only ever measured
      // what I was working on.
      //
      //   #session-count   --chrome-ink-faint   2.33 light / 3.61 dark
      //   .side-time       --faint              2.29 light / 2.82 dark  (the worst)
      //   .side-count      --muted on chip      4.40 light              (a near miss)
      //   .tab.active      --chrome-active-ink  3.83 light
      //   .view-switch-btn.active  same token   3.65 light
      //
      // The last two are the same mistake as --accent-ink earlier: a token whose
      // own doc says "the accent for CHROME — icons, dots, borders" used as TEXT.
      ['#session-count', "--chrome-ink-dim"],
      ['.side-time', "--chrome-ink-dim"],
      ['.side-count', "--chrome-ink-dim"],
      // The plan's claim count sits on the same chip surface and was written
      // with --muted out of habit the round after that pair was fixed. The pin
      // lists selectors, so a NEW chip is not covered until it is added here —
      // which is exactly how it slipped through.
      ['.path-plan-count', "--chrome-ink-dim"],
      ['.tab.active', "--chrome-active-text"],
      ['.view-switch-btn.active', "--chrome-active-text"],
    ];
    for (const [sel, token] of textSites) {
      const block = blockOf(css, sel);
      expect(
        block,
        `${sel} must use var(${token}) for TEXT — the plain status token ` +
          `measures under AA at this size`,
      ).toContain(`color: var(${token})`);
    }

    // Every readable-text token must exist in BOTH blocks: a :root-only
    // declaration freezes against the light value (the computed-value trap the
    // other tests in this file document).
    // White-on-solid buttons need a background dark enough to carry white text.
    // Both measured 4.30 with their plain counterpart, under AA at button size.
    const save = blockOf(css, ".goal-save");
    expect(save, "the primary goal action must use --accent-solid for white text")
      .toContain("var(--accent-solid)");
    expect(save).not.toMatch(/background:\s*var\(--accent\)/);

    const dark = blockOf(css, 'body[data-theme="dark"]');
    for (const t of [
      "--success-text",
      "--danger-on-soft",
      "--warn-ink",
      "--accent-solid",
      "--chrome-active-text",
    ]) {
      expect(blockOf(css, ":root"), `:root must define ${t}`).toContain(`${t}:`);
      expect(dark, `dark must restate ${t}`).toContain(`${t}:`);
    }
  });

  it("the Logs toggle does not use the dark-chrome accent on light chrome", () => {
    // --amber-bright is documented as "accent readable on DARK chrome" and
    // measured 1.9 on the light chrome this button actually sits on.
    const css = builtCss();
    const block = blockOf(css, "#cmd-toggle.active");
    expect(block).not.toContain("--amber-bright");
    expect(block).toContain("var(--warn-ink)");
  });

  it("the view-switch active pill does not hardcode the accent ink", () => {
    // --accent-ink is the SAME orange in both themes, so on dark chrome the
    // active label measured 3.27, and --chrome-active-ink replaced it — but the
    // comment on that fix noted the two are "value-identical in :root", which is
    // exactly why the LIGHT theme was never re-measured: it still failed, at
    // 3.65, until the running app was audited. `--chrome-active-text` is the
    // text-weight token; the BORDER keeps the accent, since a mark needs 3:1.
    const css = builtCss();
    const panel = blockOf(css, ".view-switch-btn.active");
    expect(panel).toMatch(/color\s*:\s*var\(--chrome-active-text\)/);
    expect(panel).not.toMatch(/color\s*:\s*var\(--chrome-active-ink\)/);
    expect(
      panel,
      "the active view-switch label must not use --accent-ink directly",
    ).not.toMatch(/color\s*:\s*var\(--accent-ink\)/);
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

describe("opacity is not used to dim text", () => {
  // THE BLIND SPOT THIS CLOSES. Element `opacity` appears in NEITHER
  // getComputedStyle(color) NOR backgroundColor, so a probe that composites
  // backgrounds — which mine did, through several rounds of "auditing" — reports
  // an opacity-reduced element at its FULL colour while it renders weaker. Six
  // text sites were dimmed this way and every one measured "ok":
  //
  //   .goal-label, .traj-ev-goal-label, .path-step-owner      opacity 0.85
  //   .browser-crash-reason                                   opacity 0.70
  //   .browser-mode-b-hint                                    opacity 0.75
  //   .browser-placeholder-sub   --faint AND 0.7              (the worst)
  //
  // and the last one hid a real defect underneath: the crash banner's `<strong>`
  // TITLE has no colour of its own and inherited the banner's --faint, measuring
  // 2.56 light.
  //
  // The rule below is checkable from the CSS alone: `font-size` only ever matters
  // for text, so a rule that sets it must not also dim itself with opacity < 1.
  // Dimming is expressed as a COLOUR token, which is greppable, pinnable, and
  // measurable.
  it("no rule that sizes text also dims it with opacity", () => {
    const css = builtCss();
    const offenders: string[] = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().split("\n").pop()!.trim();
      const body = m[2];
      if (/font-size\s*:/.test(body) && /opacity:\s*0?\.\d+/.test(body)) {
        offenders.push(`${selector} { ${body.match(/opacity:\s*[0-9.]+/)![0]} }`);
      }
    }
    expect(
      offenders,
      "text dimmed with opacity is invisible to every contrast measurement and to " +
        "whoever reads the CSS — use a colour token instead",
    ).toEqual([]);
  });

  it("no TEXT is painted with a token that only marks: the three twins", () => {
    // ONE ROOT CAUSE, THREE SYMPTOMS, ALL MEASURED ON THE LIVE PANEL at 1440x900
    // by sweeping every visible text node for anything under the AA bar:
    //
    //   .dtab.active                    3.83  (needs 4.5, 12.5px)
    //   .desktop-view-switch ...active  4.30  (needs 4.5, 11.5px)
    //   .btn-new                        4.30  (needs 4.5, 12.5px)
    //
    // Every one is a fix that ALREADY EXISTED, applied to a sibling:
    //   * `tokens.css` documents 3.83 on the active tab as a defect FIXED by
    //     `--chrome-active-text`, and `.tab.active` uses it — while
    //     `.dtab.active`, the rule the DESKTOP shell actually renders, kept
    //     `--accent-ink`;
    //   * `.view-switch-btn.active` got the same fix, but
    //     `.desktop-view-switch .view-switch-btn.active` is MORE SPECIFIC (three
    //     classes against two) and silently WON with the old token;
    //   * `components.css` says outright "White on --accent-solid, not on
    //     --accent: the brand orange gives white text 4.30, under AA at this
    //     size" — and fixed `.goal-save`, while `.btn-new`, the other primary
    //     action in the same header, kept the brand orange.
    //
    // Two surfaces, one product, and in each pair the fixed one sat next to the
    // broken one in the same file.
    const css = builtCss();
    const needReadable = [
      [".dtab.active", "--chrome-active-text"],
      [".desktop-view-switch .view-switch-btn.active", "--chrome-active-text"],
    ] as const;
    for (const [sel, token] of needReadable) {
      expect(blockOf(css, sel), `${sel} must paint its text with ${token}`).toContain(
        `color: var(${token})`,
      );
    }
    // The button carries WHITE text, so its background is what must be readable.
    expect(
      blockOf(css, ".btn-new"),
      "white on --accent measures 4.30; .btn-new must use --accent-solid like .goal-save",
    ).toContain("background: var(--accent-solid)");
  });

  it("--accent-ink and --faint never paint TEXT", () => {
    // The dark theme was NEVER SWEPT until now — every contrast measurement in
    // this file before it was taken in LIGHT mode, and the dark block holds its
    // own 39 values. Swept on the DEVICE, alpha-compositing the background stack
    // (reading `rgba(255,255,255,0.07)` raw measures a near-invisible chip as a
    // WHITE surface): **50 text elements under AA across 1434**, from two causes
    // that the repo had ALREADY WRITTEN DOWN:
    //
    //   --faint       #6f707a on #1c1d22 = 3.42   (text bar 4.5)
    //   --accent-ink  #d9480f on #3d2817 = 3.23, on #1c1d22 = 3.91, on white = 4.27
    //
    // `tokens.css` says of `--accent-ink`: "the accent for CHROME — icons, dots,
    // borders … it was also being used as TEXT on two different chrome surfaces
    // and failed on both". Sixteen call sites were still doing exactly that.
    // `--muted` (4.63 light / 6.97 dark) and `--accent-on-soft` (6.21 / 9.19) are
    // the text counterparts.
    //
    // `--faint` keeps its `background` uses — DOTS and marks, where the dark value
    // clears the 3.0 bar. The rule is written against `color:` alone.
    const css = builtCss();
    // `--faint` too: #a1a1aa in LIGHT is 2.56 — below even the 3.0 bar that
    // applies to a dot or a border — and #6f707a in dark is 3.42, below the 4.5
    // text bar. Forty more rules used it as `color:`. It keeps its `background`
    // and `border-color` uses, which the word-boundary guard leaves alone.
    for (const [tok, replacement] of [
      ["--accent-ink", "--accent-on-soft"],
      ["--faint", "--muted"],
    ]) {
      const offenders = [...css.matchAll(new RegExp(`(?<![\\w-])color:\\s*var\\(${tok}\\)`, "g"))];
      expect(
        offenders.length,
        `${offenders.length} rule(s) paint TEXT with ${tok}, a MARK weight (#a1a1aa/#6f707a for ` +
          `--faint, #d9480f for --accent-ink) that measures 2.56-4.27 wherever it is used as ` +
          `text. Use ${replacement}. It stays valid for background and border-color.`,
      ).toBe(0);
    }
    // The specific inherited-colour twin: a `<strong>` with no colour of its own
    // takes its parent's, and `.browser-placeholder` gave it --faint. The SAME
    // defect was already fixed for `.browser-crash-banner` and this sibling was
    // missed.
    expect(blockOf(css, ".browser-placeholder")).toContain("color: var(--muted)");
    expect(blockOf(css, ".plug-sub")).toContain("color: var(--muted)");
  });

  it("--chrome-ink-faint never paints TEXT or a glyph", () => {
    // MEASURED IN A REAL BROWSER on the live panel, not inferred: the steady
    // status readout (`.desktop-status.idle` — session count, release, uptime,
    // CPU, memory, and the ONLY place the release appears anywhere in the panel)
    // rendered at **2.56:1** in light mode. The numbers for this token:
    //
    //                      light (#a1a1aa)   dark (#6f707a)
    //   on --chrome-bg-2        2.56            3.45
    //   bar for text            4.5             4.5     -> fails BOTH
    //   bar for a mark/glyph    3.0             3.0     -> fails LIGHT too
    //
    // So it fails every bar on the surface it is used on, as text AND as a mark,
    // in light mode. It remains legitimate as a `background` (the rail and tab
    // DOTS) and as a `border-color` hairline, which is why the rule is written
    // against `color:` alone. The replacement, `--chrome-ink-dim`, measures
    // 7.73 light / 6.46 dark.
    const css = builtCss();
    // `border-color:` contains the substring `color:` — the boundary keeps the
    // rule about the `color` property only.
    const offenders = [...css.matchAll(/(?<![\w-])color:\s*var\(--chrome-ink-faint\)/g)];
    expect(
      offenders.length,
      `${offenders.length} declaration(s) paint with --chrome-ink-faint, which ` +
        `measures 2.56:1 in light mode — below the 4.5 text bar AND the 3.0 mark ` +
        `bar. Use --chrome-ink-dim (7.73 light / 6.46 dark). It stays valid for ` +
        `backgrounds (dots) and border-color (hairlines).`,
    ).toBe(0);

    // The specific regression, pinned by name so the message survives even if
    // the token is renamed.
    const idle = blockOf(css, ".desktop-status.idle");
    expect(idle, "the steady status readout must use the readable ink").toContain(
      "color: var(--chrome-ink-dim)",
    );
  });

  it("the crash banner's TITLE is readable, not inherited from a faint parent", () => {
    // The `<strong>` has no colour of its own (EmbeddedBrowserPane), so it takes
    // the banner's. --faint there measured 2.56 and made an error's headline the
    // least readable thing on it.
    const css = builtCss();
    const banner = blockOf(css, ".browser-crash-banner");
    expect(banner).toContain("color: var(--chrome-ink)");
    // The DECLARATION, not the raw block: the block legitimately mentions
    // --faint in the comment explaining why it is not used here.
    expect(banner).not.toMatch(/color:\s*var\(--faint\)/);
  });
});
