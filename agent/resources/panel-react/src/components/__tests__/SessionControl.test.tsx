// SessionControl — handing the session's keyboard to a person.
//
// The behaviour worth pinning is that this button never LIES about who holds the
// keyboard. It drives a server-owned state, and the failure modes are asymmetric:
//
//   * claiming a hold the server refused tells the operator the AI is stopped
//     when it is still issuing commands into their session;
//   * claiming the hand-back succeeded when it did not leaves them surprised by
//     an AI command arriving mid-typing.
//
// So: the label follows the SERVER's answer, a failure keeps the previous state
// and says so, and the button is never optimistic.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionControl } from "../SessionControl";

describe("SessionControl", () => {
  it("offers to take control when the AI holds the session", () => {
    render(<SessionControl held={false} onSet={vi.fn()} />);
    expect(screen.getByText("Take control")).toBeTruthy();
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("offers to hand back when a person holds it, and says so", () => {
    render(<SessionControl held={true} onSet={vi.fn()} />);
    expect(screen.getByText("Hand back")).toBeTruthy();
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "true",
    );
    // The tooltip is where the CONSEQUENCE is stated — a held session makes the
    // agent refuse the AI's commands, which is the part a user needs to know.
    expect(screen.getByRole("button").getAttribute("title")).toMatch(
      /refused/i,
    );
  });

  it("asks for the OPPOSITE of the current state", async () => {
    const onSet = vi.fn(() => Promise.resolve(true));
    render(<SessionControl held={false} onSet={onSet} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(true));
  });

  it("hands back when it currently holds", async () => {
    const onSet = vi.fn(() => Promise.resolve(false));
    render(<SessionControl held={true} onSet={onSet} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(false));
  });

  it("does NOT look like it worked when the call fails", async () => {
    // The label must stay on the OLD state: the server never confirmed the
    // change, so the keyboard is still where it was.
    const onSet = vi.fn(() => Promise.reject(new Error("HTTP 400")));
    render(<SessionControl held={false} onSet={onSet} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("button").className).toContain("failed"),
    );
    expect(screen.getByText("Take control")).toBeTruthy();
    expect(screen.queryByText("Hand back")).toBeNull();
  });

  it("will not fire twice while a change is in flight", async () => {
    let release: (v: boolean) => void = () => {};
    const onSet = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          release = res;
        }),
    );
    render(<SessionControl held={false} onSet={onSet} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    // A second click mid-flight would post a conflicting holder value.
    fireEvent.click(btn);
    expect(onSet).toHaveBeenCalledTimes(1);
    release(true);
    await waitFor(() =>
      expect((btn as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("carries the hold as a SHAPE, not only a colour", () => {
    // prefers-reduced-motion removes transitions, and colour alone is a single
    // channel — the same reasoning as the discrete state palette.
    const { container, rerender } = render(
      <SessionControl held={false} onSet={vi.fn()} />,
    );
    const dot = () => container.querySelector(".sc-dot")!;
    expect(dot().getAttribute("data-state")).toBe("ai");
    rerender(<SessionControl held={true} onSet={vi.fn()} />);
    expect(dot().getAttribute("data-state")).toBe("human");
  });

  it("the held state uses the READABLE accent weight", () => {
    // --accent-ink is the chrome accent and measures 3.83 (light) / 3.23 (dark)
    // as small text on --accent-soft — under AA. The held state is the most
    // consequential one on this control, so it must not be the least readable.
    const built = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "..",
        "panel",
        "panel.css",
      ),
      "utf8",
    );
    const block = built.match(/#session-control\.held\s*\{([^}]*)\}/);
    expect(
      block,
      "#session-control.held missing from the built stylesheet",
    ).not.toBeNull();
    expect(block![1]).toMatch(/color\s*:\s*var\(--accent-on-soft\)/);
    expect(block![1]).not.toMatch(/color\s*:\s*var\(--accent-ink\)/);
  });
});
