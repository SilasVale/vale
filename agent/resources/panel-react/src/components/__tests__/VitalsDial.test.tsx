// The instrument's contract: it summarises, it never invents, and it never makes
// colour the only channel.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { VitalsDial } from "../VitalsDial";

const arcs = (root: HTMLElement) => [...root.querySelectorAll(".dial-arc")];

describe("VitalsDial", () => {
  it("draws one arc per reading, in the fixed order CPU then memory", () => {
    const { container } = render(<VitalsDial cpu={10} mem={80} />);
    const a = arcs(container);
    expect(a).toHaveLength(2);
    // Outer arc (r=16) is CPU, inner (r=11.5) is memory — the order IS the legend,
    // so a swap would silently relabel the instrument.
    expect(a[0].getAttribute("r")).toBe("16");
    expect(a[1].getAttribute("r")).toBe("11.5");
  });

  it("fills the arc in proportion, measured against its own circumference", () => {
    const { container } = render(<VitalsDial cpu={25} mem={null} />);
    const [cpu] = arcs(container);
    const c = 2 * Math.PI * 16;
    expect(Number(cpu.getAttribute("stroke-dasharray"))).toBeCloseTo(c, 3);
    // 25% filled => 75% of the circumference left undrawn.
    expect(Number(cpu.getAttribute("stroke-dashoffset"))).toBeCloseTo(c * 0.75, 3);
  });

  it("NEVER INVENTS A ZERO: an unknown reading draws no arc and says unknown", () => {
    const { container } = render(<VitalsDial cpu={null} mem={null} />);
    expect(arcs(container)).toHaveLength(0);
    const dial = container.querySelector(".vitals-dial")!;
    expect(dial.getAttribute("aria-label")).toContain("CPU unknown");
    expect(dial.getAttribute("aria-label")).toContain("memory unknown");
  });

  it("carries the value as TEXT as well as colour, so the bands are redundant", () => {
    // The whole point of the band colours is that losing them loses nothing: the
    // number is in the accessible name, and the strip prints it too.
    const { container } = render(<VitalsDial cpu={93} mem={78} />);
    const dial = container.querySelector(".vitals-dial")!;
    expect(dial.getAttribute("aria-label")).toBe("CPU 93%, memory 78%");
  });

  it("bands at 75 and 90, and only the arc's tone changes", () => {
    const tone = (cpu: number) => {
      const { container } = render(<VitalsDial cpu={cpu} mem={null} />);
      return arcs(container)[0].getAttribute("data-tone");
    };
    expect(tone(0)).toBe("ok");
    expect(tone(74)).toBe("ok");
    expect(tone(75)).toBe("warn");
    expect(tone(89)).toBe("warn");
    expect(tone(90)).toBe("crit");
    expect(tone(100)).toBe("crit");
  });

  it("clamps out-of-range input instead of drawing past the ring", () => {
    const { container } = render(<VitalsDial cpu={140} mem={-20} />);
    const [cpu] = arcs(container);
    expect(Number(cpu.getAttribute("stroke-dashoffset"))).toBe(0);
  });
});
