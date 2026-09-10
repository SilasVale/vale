// useActiveTabVisible pins — the active tab must stay on screen when the
// activation is PROGRAMMATIC (SOLID R131).
//
// The bug this covers is invisible to a manual click: `overflow-x: auto` makes
// the browser scroll a tab into view when YOU click it, so the strip looks
// correct while driven by hand. Every activation this app performs is
// programmatic — closing the active session selects a neighbour, a new
// terminal_open appends and activates, the AI opens sessions, a deep link
// selects — and none of those move the scroll position. The tab you are
// looking at could then differ from the tab you are typing into.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useActiveTabVisible } from "../useActiveTabVisible";

/** A minimal strip mirroring how both real callers mark the active tab. */
function Strip({ activeSid, tabCount }: { activeSid: string | null; tabCount: number }) {
  const ref = useActiveTabVisible(activeSid, tabCount);
  return (
    <div ref={ref} data-testid="strip">
      {Array.from({ length: tabCount }, (_, i) => (
        <span key={i} data-active={i === Number(activeSid) ? "1" : undefined}>
          tab{i}
        </span>
      ))}
    </div>
  );
}

describe("useActiveTabVisible", () => {
  let spy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    // jsdom has no layout, so scrollIntoView does not exist. Installing a spy
    // is how the CALL is asserted — which is the contract: the hook's job is
    // to ask the browser to reveal the tab, not to compute the geometry.
    spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as () => void;
  });
  afterEach(() => {
    // @ts-expect-error — removing the shim restores jsdom's (absent) method.
    delete Element.prototype.scrollIntoView;
  });

  it("reveals the active tab, requesting MINIMUM movement in both axes", () => {
    render(<Strip activeSid="2" tabCount={8} />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("does nothing when no tab is active", () => {
    render(<Strip activeSid={null} tabCount={8} />);
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-reveals when the active tab CHANGES (the programmatic case)", () => {
    const { rerender } = render(<Strip activeSid="1" tabCount={8} />);
    expect(spy).toHaveBeenCalledTimes(1);
    rerender(<Strip activeSid="5" tabCount={8} />);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("re-reveals when the TAB COUNT changes without the active tab moving", () => {
    // Appending or closing a tab shifts every later tab's position, so the
    // active one can drift out of view while its IDENTITY is unchanged. A
    // hook keyed only on activeSid would miss this.
    const { rerender } = render(<Strip activeSid="2" tabCount={4} />);
    expect(spy).toHaveBeenCalledTimes(1);
    rerender(<Strip activeSid="2" tabCount={9} />);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does NOT re-reveal on an unrelated re-render", () => {
    // The strip must not twitch on every session poll: a re-render with the
    // same active id and count is a no-op. This is what `inline: "nearest"`
    // plus the dependency list buy, and it is why the session ARRAY is not a
    // dependency (its identity changes on every poll).
    const { rerender } = render(<Strip activeSid="2" tabCount={4} />);
    expect(spy).toHaveBeenCalledTimes(1);
    rerender(<Strip activeSid="2" tabCount={4} />);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("renders without scrollIntoView available (jsdom / older engines)", () => {
    // @ts-expect-error — simulate an engine without the method.
    delete Element.prototype.scrollIntoView;
    // Optional-chained on purpose: revealing a tab is a nicety, and a missing
    // method must never throw during render.
    expect(() => render(<Strip activeSid="1" tabCount={3} />)).not.toThrow();
    expect(screen.getByTestId("strip")).toBeTruthy();
  });
});

describe("both tab strips mark the active tab for the hook", () => {
  // The hook locates the tab via `[data-active="1"]`, so the ATTRIBUTE is the
  // contract between it and its two callers. Pinned here rather than trusting
  // each component's own suite: a caller that drops the attribute would leave
  // the hook silently doing nothing, with every other test still green.
  it("TabBar and DesktopShell both set data-active on the active session", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "components");
    for (const file of ["TabBar.tsx", "DesktopShell.tsx"]) {
      const src = readFileSync(path.join(dir, file), "utf8");
      expect(src, `${file} must set data-active`).toContain('data-active={s.sid === activeSid ? "1" : undefined}');
      expect(src, `${file} must call the shared hook`).toContain("useActiveTabVisible(");
      expect(src, `${file} must attach the hook's ref to the strip`).toContain("ref={tabsRef}");
    }
  });

  it("the ref is on the SCROLLING element of each strip, not its wrapper", async () => {
    // THE CONTRACT THIS PINS. `scrollIntoView` acts on whatever the browser
    // considers scrollable, so the ref has to sit on the element that carries
    // `overflow-x: auto` — not on the flex wrapper around it. Both callers
    // have a wrapper/container pair and they differ in WHICH is which:
    //
    //   TabBar        .tabrow (wrapper)      > #tabs        (scroller)
    //   DesktopShell  .desktop-header (…)    > .desktop-tabs (scroller)
    //
    // I got this wrong while writing the test (asserted the wrapper), which is
    // exactly why it is written down: putting the ref on the wrong element
    // leaves the hook quietly scrolling nothing while every other test passes.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "components");
    for (const [file, scroller] of [
      ["TabBar.tsx", 'id="tabs"'],
      ["DesktopShell.tsx", 'className="desktop-tabs"'],
    ] as const) {
      const src = readFileSync(path.join(dir, file), "utf8");
      const at = src.indexOf(scroller);
      expect(at, `${file}: ${scroller} (the scrolling element) not found`).toBeGreaterThan(-1);
      const opening = src.slice(at, src.indexOf(">", at));
      expect(opening, `${file}: ${scroller} is missing ref={tabsRef}`).toContain("ref={tabsRef}");
    }
  });

  it("both scrolling elements really do scroll (CSS is part of the contract)", async () => {
    // The hook only works if the element it holds actually overflows; a ref on
    // a non-scrolling div would call scrollIntoView on something with nothing
    // to scroll. Read the BUILT stylesheet, so a hand-edit of panel.css cannot
    // quietly drop the overflow rule either.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const built = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..", "..", "..", "..", "panel", "panel.css",
      ),
      "utf8",
    );
    for (const sel of ["#tabs", ".desktop-tabs"]) {
      const block = built.match(new RegExp(sel.replace(".", "\\.") + "\\s*\\{([^}]*)\\}"));
      expect(block, `${sel} missing from the built panel.css`).not.toBeNull();
      expect(block![1], `${sel} must scroll horizontally`).toContain("overflow-x: auto");
    }
    // ...and the name cap that decides how many tabs fit must be present in
    // BOTH strips, or one of them silently reverts to unbounded tabs.
    for (const sel of [".tab-name", ".dtab-name"]) {
      const block = built.match(new RegExp(sel.replace(".", "\\.") + "\\s*\\{([^}]*)\\}"));
      expect(block, `${sel} missing from the built panel.css`).not.toBeNull();
      expect(block![1], `${sel} must cap its width`).toContain("max-width:");
      expect(block![1], `${sel} must truncate, not clip`).toContain("text-overflow: ellipsis");
    }
  });
});
