// Icon pins — the ONE icon set: every IconName must have a glyph (a name
// added to the type without a PATHS entry renders an empty svg), sizing
// defaults, stroke contract, and the BrandMark gradient ids.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Icon, BrandMark, type IconName } from "../Icon";

const NAMES: IconName[] = [
  "terminal",
  "activity",
  "browser",
  "memory",
  "plugins",
  "settings",
  "sessions",
  "ssh",
  "serial",
  "plus",
  "close",
  "export",
  "chevron",
  "edit",
  "fullscreen",
  "search",
  "arrow-up",
  "arrow-down",
  "sun",
  "moon",
];

describe("Icon", () => {
  it("every IconName renders a non-empty svg", () => {
    for (const name of NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg")!;
      expect(svg, `${name} must render an svg`).toBeTruthy();
      expect(
        svg.innerHTML.trim().length,
        `${name} must have glyph content`,
      ).toBeGreaterThan(0);
      unmount();
    }
  });

  it("honors size, defaults to 18, keeps the stroke contract", () => {
    const { container } = render(<Icon name="close" />);
    const d = container.querySelector("svg")!;
    expect(d.getAttribute("width")).toBe("18");
    expect(d.getAttribute("fill")).toBe("none");
    expect(d.getAttribute("stroke")).toBe("currentColor");
    const { container: c2 } = render(<Icon name="close" size={12} />);
    expect(c2.querySelector("svg")!.getAttribute("width")).toBe("12");
  });
});

describe("BrandMark", () => {
  it("renders the aurora mark with its gradient defs at the given size", () => {
    const { container } = render(<BrandMark size={26} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("26");
    expect(svg.getAttribute("viewBox")).toBe("0 0 48 48");
    for (const id of [
      "valeSky",
      "valeAurora",
      "valeAurora2",
      "valeGlow",
      "valeSheen",
      "valeRim",
    ]) {
      expect(
        svg.querySelector(`#${id}`),
        `missing gradient def #${id}`,
      ).toBeTruthy();
    }
  });

  it("matches the canonical mark in brand/logo-aurora.svg", () => {
    // THERE ARE THREE COPIES OF THIS MARK and nothing kept them together: this React
    // component, the console's `public/favicon.svg`, and the landing page's inline
    // data-URI. When the mark changed, two of the three were updated and the panel's
    // was MISSED — the build stayed green, every test passed, and the device would
    // have shipped the old logo beside two new ones.
    //
    // This compares the STRUCTURE that makes the drawing (every gradient id, every
    // path shape, every stop colour) against the canonical file, so a change to one
    // copy that is not made to the other fails by name.
    const canonical = readFileSync(
      resolve(process.cwd(), "../../../brand/logo-aurora.svg"),
      "utf8",
    );
    const ids = (src: string) =>
      [...src.matchAll(/id="([A-Za-z0-9]+)"/g)].map((m) => m[1]).sort();
    const shape = (src: string) =>
      [...src.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]).sort();
    const stops = (src: string) =>
      [...src.matchAll(/stop-color="(#[0-9a-fA-F]{3,8})"/g)]
        .map((m) => m[1].toLowerCase())
        .sort();

    const { container } = render(<BrandMark />);
    const mine = container.querySelector("svg")!.innerHTML;

    expect(ids(mine)).toEqual(ids(canonical));
    expect(shape(mine)).toEqual(shape(canonical));
    expect(stops(mine)).toEqual(stops(canonical));
  });
});
