/**
 * Every `Page` must be RENDERED BY BOTH SHELLS.
 *
 * The panel has two shells — `PanelApp` (the browser panel at `/panel/`) and
 * `DesktopShell` (the Electron window at `/desktop/`) — and each dispatches pages
 * with its own chain of `{page === "x" && <XPage />}` conditions. Nothing connects
 * those chains to the `Page` union:
 *
 *   * `PAGE_ICONS` is `Record<Page, IconName>`, so the TYPE-CHECK forces the RAIL to
 *     have an icon for every page;
 *   * it does NOT force either shell to render one.
 *
 * So adding a member to `Page` gives you a rail button that opens a blank content
 * area, and the compiler is happy. The failure would land on one shell and not the
 * other — this log's most repeated shape ("a fix that already existed, applied to one
 * of a pair": rounds 45, 47, 55).
 *
 * Checked statically, no DOM: parse the union from `Shell.tsx`, then require each
 * member to appear as `page === "<member>"` in BOTH shells.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "..", "components");
const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");

const shell = read("Shell.tsx");
const union = /export type Page =([^;]+);/.exec(shell)?.[1] ?? "";
const pages = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);

const renderedIn = (file: string): Set<string> =>
  new Set([...read(file).matchAll(/page === "([a-z]+)"/g)].map((m) => m[1]));

const SHELLS = ["PanelApp.tsx", "DesktopShell.tsx"] as const;

describe("panel page rendering", () => {
  it("parsed the Page union and both shells", () => {
    // A comparison over an empty set passes for ever — the guard every contract
    // check in this repo carries.
    expect(
      pages.length,
      "could not parse the Page union from Shell.tsx",
    ).toBeGreaterThanOrEqual(5);
    for (const s of SHELLS) {
      expect(
        renderedIn(s).size,
        `${s} renders no page branches — the parser read the wrong thing`,
      ).toBeGreaterThanOrEqual(5);
    }
  });

  it("both shells render EVERY page in the union", () => {
    for (const s of SHELLS) {
      const rendered = renderedIn(s);
      // `terminal` is the default view and may be expressed through the workspace
      // component rather than a `page ===` branch in one shell; the assertion below
      // reports anything genuinely absent.
      const missing = pages.filter((p) => !rendered.has(p));
      expect(
        missing,
        `${s} renders no branch for ${missing.join(", ")} — that rail button opens a blank ` +
          `content area, and PAGE_ICONS' Record<Page,…> does not catch it because it only ` +
          `forces the RAIL to have an icon`,
      ).toEqual([]);
    }
  });

  it("the two shells agree on which pages exist", () => {
    const [a, b] = SHELLS.map(renderedIn);
    const onlyA = [...a].filter((p) => !b.has(p));
    const onlyB = [...b].filter((p) => !a.has(p));
    expect(onlyA, `rendered by ${SHELLS[0]} but not ${SHELLS[1]}`).toEqual([]);
    expect(onlyB, `rendered by ${SHELLS[1]} but not ${SHELLS[0]}`).toEqual([]);
  });
});
