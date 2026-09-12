import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TrajectoryView } from "../TrajectoryView";
import { PathView } from "../PathView";
import { trailReadNotice } from "../../lib/trailRead";
import type { CommandEvent } from "../../hooks/useCommandEvents";

// THE LIVE VIEWS CLAIMED A SESSION HAD RUN NOTHING, from a read that had not
// happened yet or had failed. `useCommandEvents` has reported `readState` since
// before the Archive used it, and the Archive was its ONLY consumer: the live
// slice dropped it — the same object literal in `App` that round 27 taught to
// carry `firstSeq`, one line away from this field.
//
// The Archive's own header states the rule — "a session whose trail cannot be
// read SAYS SO, and never renders as an empty history" — and it was honoured in
// one place out of three. One of the two windows is on EVERY session switch:
// `useCommandEvents` resets `events` to `[]` synchronously while the new read is
// in flight.
const none: CommandEvent[] = [];

describe("an empty trail says only what the read supports", () => {
  it("a FAILED read never renders as an empty session", () => {
    for (const [name, el] of [
      ["trajectory", <TrajectoryView events={none} readState="unreadable" />],
      ["path", <PathView events={none} readState="unreadable" />],
    ] as const) {
      const { container, unmount } = render(el);
      const text = container.textContent!;
      expect(text, `${name} must not claim the session ran nothing`).not.toContain(
        "has not run a command",
      );
      expect(text).not.toContain("No commands in this session yet");
      expect(text.toLowerCase(), `${name} must say the read failed`).toMatch(
        /could not be read/,
      );
      unmount();
    }
  });

  it("a read STILL IN FLIGHT never renders as an empty session either", () => {
    // The window that needs no failure at all: every session switch.
    for (const [name, el] of [
      ["trajectory", <TrajectoryView events={none} readState="reading" />],
      ["path", <PathView events={none} readState="reading" />],
    ] as const) {
      const { container, unmount } = render(el);
      const text = container.textContent!;
      expect(text, `${name} must not claim the session ran nothing`).not.toContain(
        "has not run a command",
      );
      expect(text).not.toContain("No commands in this session yet");
      expect(text.toLowerCase(), `${name} must say it is reading`).toMatch(/reading/);
      unmount();
    }
  });

  it("a SUCCESSFUL empty read still says the session ran nothing", () => {
    // The distinction must not swallow the real case — an empty session whose
    // read worked is exactly what the original line is for.
    const { container } = render(<PathView events={none} readState="ok" />);
    expect(container.textContent).toContain("This session has not run a command");
    const t = render(<TrajectoryView events={none} readState="ok" />);
    expect(t.container.textContent).toContain("No commands in this session yet");
  });

  it("ONE wording, not three", () => {
    // Three views render this sentence. Three copies of one sentence is how this
    // repo's surfaces come to disagree about what they are saying, so the words
    // live in lib/trailRead.ts and every view asks for them.
    expect(trailReadNotice("ok")).toBeNull();
    expect(trailReadNotice("reading")!.text).toBe("Reading this session's audit trail…");
    const failed = trailReadNotice("unreadable")!;
    expect(failed.failed).toBe(true);
    expect(failed.text).toContain("could not be read");
    expect(failed.text).toContain("not an empty history");
    // And both views really use it, rather than a lookalike.
    for (const el of [
      <TrajectoryView events={none} readState="unreadable" />,
      <PathView events={none} readState="unreadable" />,
    ]) {
      const { container, unmount } = render(el);
      expect(container.textContent).toContain(failed.text);
      unmount();
    }
  });
});
