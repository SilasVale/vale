// GoalBar — the operator's statement of what a session is FOR (beat 1).
//
// The failure modes worth pinning are about the DRAFT rather than the display:
//
//   * a stale draft. The panel keeps one GoalBar mounted across session
//     switches, so a draft that survives a switch would let Save write one
//     session's objective onto another — the worst kind of silent
//     cross-contamination, because the goal then describes work nobody asked for;
//   * losing what was typed to a transient failure;
//   * clear being a real, findable act rather than a hidden consequence of an
//     empty field.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GoalBar } from "../GoalBar";

const props = (over: Partial<React.ComponentProps<typeof GoalBar>> = {}) => ({
  goal: null as string | null,
  onSet: vi.fn(() => Promise.resolve(null)),
  ...over,
});

describe("GoalBar", () => {
  it("is a quiet affordance when nothing is stated", () => {
    // Most sessions have no goal and must not be nagged about it.
    render(<GoalBar {...props()} />);
    expect(screen.getByText(/Set a goal/)).toBeTruthy();
    expect(document.querySelector("#goal-bar")!.className).toContain("no-goal");
  });

  it("shows the stored goal prominently, wrapping rather than clipping", () => {
    render(<GoalBar {...props({ goal: "provision the ONU on VLAN 100" })} />);
    const el = document.querySelector("#goal-bar")!;
    expect(el.className).toContain("has-goal");
    // The objective is the payload: truncating it makes it unactionable.
    expect(document.querySelector(".goal-text")!.textContent).toBe(
      "provision the ONU on VLAN 100",
    );
  });

  it("saves what was typed", async () => {
    const onSet = vi.fn(() => Promise.resolve("x"));
    render(<GoalBar {...props({ onSet })} />);
    fireEvent.click(screen.getByText(/Set a goal/));
    fireEvent.change(document.querySelector(".goal-input")!, {
      target: { value: "roll back the VLAN" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith("roll back the VLAN"));
  });

  it("does NOT carry a draft across a SESSION SWITCH", async () => {
    // The bar stays mounted while the operator moves between sessions. A draft
    // that survived would let Save stamp one session's objective onto another.
    const onSet = vi.fn(() => Promise.resolve("x"));
    const { rerender } = render(<GoalBar {...props({ goal: "first objective", onSet })} />);
    fireEvent.click(screen.getByTitle(/click to change/));
    fireEvent.change(document.querySelector(".goal-input")!, {
      target: { value: "half-typed edit" },
    });

    // Same component, different session: a new goal arrives.
    rerender(<GoalBar {...props({ goal: "second objective", onSet })} />);
    // The edit is abandoned, and the new session's objective is what shows.
    expect(document.querySelector(".goal-input")).toBeNull();
    expect(document.querySelector(".goal-text")!.textContent).toBe("second objective");
  });

  it("resets the draft when the goal changes under it", () => {
    const { rerender } = render(<GoalBar {...props({ goal: "a" })} />);
    fireEvent.click(screen.getByTitle(/click to change/));
    expect((document.querySelector(".goal-input") as HTMLInputElement).value).toBe("a");
    rerender(<GoalBar {...props({ goal: "b" })} />);
    fireEvent.click(screen.getByTitle(/click to change/));
    expect((document.querySelector(".goal-input") as HTMLInputElement).value).toBe("b");
  });

  it("offers Clear only when there is something to clear", () => {
    const { rerender } = render(<GoalBar {...props({ goal: null })} />);
    fireEvent.click(screen.getByText(/Set a goal/));
    expect(screen.queryByText("Clear")).toBeNull();
    rerender(<GoalBar {...props({ goal: "something" })} />);
    fireEvent.click(screen.getByTitle(/click to change/));
    expect(screen.getByText("Clear")).toBeTruthy();
  });

  it("clears through the named button", async () => {
    const onSet = vi.fn(() => Promise.resolve(null));
    render(<GoalBar {...props({ goal: "old objective", onSet })} />);
    fireEvent.click(screen.getByTitle(/click to change/));
    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(""));
  });

  it("Escape abandons the edit without saving", () => {
    const onSet = vi.fn();
    render(<GoalBar {...props({ goal: "keep me", onSet })} />);
    fireEvent.click(screen.getByTitle(/click to change/));
    fireEvent.change(document.querySelector(".goal-input")!, { target: { value: "discard" } });
    fireEvent.keyDown(document.querySelector(".goal-input")!, { key: "Escape" });
    expect(onSet).not.toHaveBeenCalled();
    expect(document.querySelector(".goal-text")!.textContent).toBe("keep me");
  });

  it("keeps the form open when the save FAILS, so nothing typed is lost", async () => {
    const onSet = vi.fn(() => Promise.reject(new Error("HTTP 400")));
    render(<GoalBar {...props({ onSet })} />);
    fireEvent.click(screen.getByText(/Set a goal/));
    fireEvent.change(document.querySelector(".goal-input")!, { target: { value: "important" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSet).toHaveBeenCalled());
    expect((document.querySelector(".goal-input") as HTMLInputElement).value).toBe("important");
  });

  it("says what the goal is FOR, not what the button does", () => {
    render(<GoalBar {...props()} />);
    expect(screen.getByRole("button").getAttribute("title")).toMatch(
      /judged against it/i,
    );
  });
});
