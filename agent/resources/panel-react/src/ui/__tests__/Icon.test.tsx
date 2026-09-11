// Icon pins — the ONE icon set: every IconName must have a glyph (a name
// added to the type without a PATHS entry renders an empty svg), sizing
// defaults, stroke contract, and the BrandMark gradient ids.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Icon, BrandMark, type IconName } from "../Icon";

const NAMES: IconName[] = [
  "terminal", "activity", "browser", "memory", "plugins", "settings", "sessions",
  "ssh", "serial", "plus", "close", "export", "chevron", "edit",
  "fullscreen", "search", "arrow-up", "arrow-down", "sun", "moon",
];

describe("Icon", () => {
  it("every IconName renders a non-empty svg", () => {
    for (const name of NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg")!;
      expect(svg, `${name} must render an svg`).toBeTruthy();
      expect(svg.innerHTML.trim().length, `${name} must have glyph content`).toBeGreaterThan(0);
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
  it("renders the sunrise mark with gradient defs at the given size", () => {
    const { container } = render(<BrandMark size={26} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("26");
    expect(svg.getAttribute("viewBox")).toBe("0 0 48 48");
    expect(svg.querySelector("#vale-brand-sky")).toBeTruthy();
    expect(svg.querySelector("#vale-brand-glow")).toBeTruthy();
  });
});
