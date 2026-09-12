// Recipe — beat 6 of the design's core loop ("harvest": the path becomes a
// recipe; next run reuses it).
//
// The properties worth pinning are about HONESTY, because this feature's failure
// mode is a recipe that reads like a known-good procedure when it is not:
//
//   * a run that failed or was interrupted must SAY SO inside the recipe, not
//     just in the UI that saved it — the recipe outlives that screen;
//   * the commands must be complete and in order, since that is the whole
//     payload;
//   * the recipe must land in the SHARED memory store under a findable tag,
//     because a recipe an AI client cannot find is one nobody can re-run;
//   * and it must not claim to execute anything — it does not.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PathView } from "../PathView";
import { callTool } from "../../lib/api";
import { buildRecipe, recipeWarnings, suggestedTitle, RECIPE_MARKER, RECIPE_TAG } from "../../lib/recipe";
import { derivePath, type PathStep, type SessionPath } from "../../lib/path";
import { groupRounds } from "../../hooks/useTrajectory";
import type { CommandEvent } from "../../hooks/useCommandEvents";

vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  callTool: vi.fn(() => Promise.resolve({})),
}));
const mockCallTool = callTool as unknown as ReturnType<typeof vi.fn>;

const ev = (o: Partial<CommandEvent>): CommandEvent => ({ seq: 1, ts: 1000, kind: "output", ...o });

/** A clean two-step run. */
const cleanPath: SessionPath = derivePath([
  { id: "r-1", startSeq: 1, command: "display version", startTs: 100, events: [], ended: true, exitCode: 0, reason: null, durationMs: 900 },
  { id: "r-2", startSeq: 2, command: "display ont info 0 1", startTs: 200, events: [], ended: true, exitCode: 0, reason: null, durationMs: 1100 },
]);

/** A run with a failure and an interruption. */
const messyPath: SessionPath = derivePath([
  { id: "r-1", startSeq: 1, command: "display version", startTs: 100, events: [], ended: true, exitCode: 0, reason: null, durationMs: 900 },
  { id: "r-2", startSeq: 2, command: "vlan 100", startTs: 200, events: [], ended: true, exitCode: 1, reason: null, durationMs: 200 },
  { id: "r-3", startSeq: 3, command: "save", startTs: 300, events: [], ended: true, exitCode: null, reason: "interrupted", durationMs: null },
  { id: "r-4", startSeq: 4, command: "sleep 900", startTs: 400, events: [], ended: false, exitCode: null, reason: null, durationMs: null },
]);

const step = (o: Partial<PathStep>): PathStep => ({
  id: "x", index: 1, command: "c", state: "ok", owner: "ai", stateLabel: "0",
  startedAt: 0, durationMs: 1000, exitCode: 0, reason: null, outputChars: 0, intent: null, considered: [], planStep: null, runId: null, ...o,
});

describe("buildRecipe", () => {
  it("carries a marker, the name, and every command IN ORDER", () => {
    const r = buildRecipe(cleanPath, { name: "ONU check" });
    expect(r.content).toContain(RECIPE_MARKER);
    expect(r.content).toContain("# ONU check");
    const cmds = r.content.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(cmds).toEqual(["1. display version", "2. display ont info 0 1"]);
  });

  it("records the outcome, so a recipe is not mistaken for a guarantee", () => {
    const r = buildRecipe(cleanPath, { name: "x" });
    expect(r.content).toMatch(/2 steps/);
    expect(r.content).toMatch(/2 succeeded/);
    // A clean run must NOT carry the warning line.
    expect(r.content).not.toMatch(/did not complete cleanly/);
  });

  it("WARNS inside the recipe when the run was not clean", () => {
    // The recipe outlives the screen that saved it and may be read months later
    // by someone who never saw the original run, so the caveat has to travel
    // WITH the text.
    const r = buildRecipe(messyPath, { name: "x" });
    expect(r.content).toMatch(/1 FAILED/);
    expect(r.content).toMatch(/1 interrupted/);
    expect(r.content).toMatch(/1 still running/);
    expect(r.content).toMatch(/did not complete cleanly/);
  });

  it("stamps which session the commands were run against", () => {
    const r = buildRecipe(cleanPath, { name: "x", sessionKind: "serial", sessionLabel: "192.168.1.1" });
    expect(r.content).toMatch(/Walked on serial 192\.168\.1\.1/);
  });

  it("tags the entry so a client can find it, and prefixes the title", () => {
    const r = buildRecipe(cleanPath, { name: "ONU check" });
    expect(r.tags).toEqual([RECIPE_TAG]);
    expect(r.title).toBe("Recipe: ONU check");
    // Idempotent: a name that already reads as a recipe is not doubled up.
    expect(buildRecipe(cleanPath, { name: "Recipe: ONU check" }).title).toBe("Recipe: ONU check");
  });

  it("falls back rather than producing an empty title", () => {
    expect(buildRecipe(cleanPath, { name: "   " }).title).toBe("Recipe: untitled");
  });

  it("never claims to run itself", () => {
    const r = buildRecipe(cleanPath, { name: "x" });
    expect(r.content).not.toMatch(/automatic|auto-run|will execute|replays? automatically/i);
  });
});

describe("recipeWarnings / suggestedTitle", () => {
  it("names only the problems that exist", () => {
    expect(recipeWarnings([step({ state: "ok" })])).toEqual([]);
    expect(recipeWarnings([step({ state: "fail" })])).toEqual(["1 step failed"]);
    expect(recipeWarnings([step({ state: "fail" }), step({ state: "fail" })]))
      .toEqual(["2 steps failed"]);
    expect(recipeWarnings([step({ state: "running" })])).toEqual(["the run has not finished"]);
  });

  it("suggests a title from the first command and the step count", () => {
    expect(suggestedTitle(cleanPath)).toBe("Recipe: display version (2 steps)");
  });

  it("truncates a long first command instead of producing a wall of text", () => {
    const long = derivePath([
      { id: "r-1", startSeq: 1, command: "x".repeat(200), startTs: 1, events: [], ended: true, exitCode: 0, reason: null, durationMs: 1 },
    ]);
    const t = suggestedTitle(long);
    expect(t.length).toBeLessThan(80);
    expect(t).toContain("…");
  });
});

describe("PathView recipe flow", () => {
  const session = (): CommandEvent[] => [
    ev({ seq: 1, ts: 100, kind: "command/start", command: "display version" }),
    ev({ seq: 2, ts: 101, kind: "command/end", exit_code: 0, duration_ms: 900 }),
  ];

  beforeEach(() => mockCallTool.mockClear());

  it("saves to the SHARED device memory under the recipe tag", async () => {
    render(<PathView events={session()} sessionKind="pty" sessionLabel="shell" />);
    fireEvent.click(screen.getByText("Save as recipe"));
    fireEvent.click(screen.getByText("Save to device memory"));
    await waitFor(() => expect(mockCallTool).toHaveBeenCalledTimes(1));
    const [name, body] = mockCallTool.mock.calls[0];
    // memory_save specifically: that store is the one every AI client on the
    // device can already search, which is what makes the recipe re-runnable.
    expect(name).toBe("memory_save");
    expect(body.tags).toEqual([RECIPE_TAG]);
    expect(body.content).toContain("display version");
    expect(body.content).toContain(RECIPE_MARKER);
  });

  it("prefills the name so saving is one confirm", () => {
    render(<PathView events={session()} />);
    fireEvent.click(screen.getByText("Save as recipe"));
    const input = document.querySelector("#path-recipe-name") as HTMLInputElement;
    expect(input.value).toContain("display version");
  });

  it("says the path will not finish cleanly BEFORE the operator saves it", () => {
    render(<PathView events={[
      ev({ seq: 1, ts: 1, kind: "command/start", command: "vlan 100" }),
      ev({ seq: 2, ts: 2, kind: "command/end", exit_code: 1, duration_ms: 10 }),
    ]} />);
    fireEvent.click(screen.getByText("Save as recipe"));
    expect(document.querySelector(".path-recipe-warn")!.textContent).toContain("did not finish cleanly");
  });

  it("reports a save failure instead of implying success", async () => {
    mockCallTool.mockRejectedValueOnce(new Error("HTTP 500"));
    render(<PathView events={session()} />);
    fireEvent.click(screen.getByText("Save as recipe"));
    fireEvent.click(screen.getByText("Save to device memory"));
    const err = await screen.findByText(/Could not save/);
    expect(err.textContent).toContain("500");
    // The form stays open so the operator can retry rather than losing the name.
    expect(document.querySelector("#path-recipe-name")).not.toBeNull();
  });

  it("confirms where it went, so the operator knows how to find it again", async () => {
    render(<PathView events={session()} />);
    fireEvent.click(screen.getByText("Save as recipe"));
    fireEvent.click(screen.getByText("Save to device memory"));
    const ok = await screen.findByText(/Saved as/);
    expect(ok.textContent).toContain(RECIPE_TAG);
  });

  it("states plainly that a recipe does not run itself", () => {
    render(<PathView events={session()} />);
    fireEvent.click(screen.getByText("Save as recipe"));
    expect(document.querySelector(".path-recipe-hint")!.textContent)
      .toMatch(/does not run by itself/);
  });
});

describe("recipes keep the WHY", () => {
  // A recipe is the durable artifact of a run — the thing someone re-reads a
  // week later, or hands to someone else. Commands alone teach the what and lose
  // the why, which is the difference between a script and something reusable.
  it("carries the session goal and each step's reasoning", () => {
    const path = derivePath([
      ...groupRounds([
        ev({ seq: 1, ts: 100, kind: "command/start", command: "display ont info 0 1",
             intent: "check whether the ONU is actually online",
             considered: ["reset the ONU", "check the OLT uplink"] }),
        ev({ seq: 2, ts: 101, kind: "command/end", exit_code: 0, duration_ms: 900 }),
      ]),
    ], []);
    const r = buildRecipe(path, {
      name: "ONU check",
      sessionLabel: "d1",
      sessionKind: "ssh",
      goal: "provision the ONU on VLAN 100",
    });
    expect(r.content).toContain("# Goal: provision the ONU on VLAN 100");
    expect(r.content).toContain("why: check whether the ONU is actually online");
    expect(r.content).toContain("instead of: reset the ONU | check the OLT uplink");
  });

  it("omits the why lines entirely when there is none", () => {
    // No placeholder lines: a recipe for a client that sends no reasoning must
    // look exactly as it did before this feature existed.
    const path = derivePath([
      ...groupRounds([
        ev({ seq: 1, ts: 100, kind: "command/start", command: "ls" }),
        ev({ seq: 2, ts: 101, kind: "command/end", exit_code: 0, duration_ms: 10 }),
      ]),
    ], []);
    const r = buildRecipe(path, { name: "plain" });
    expect(r.content).not.toContain("why:");
    expect(r.content).not.toContain("instead of:");
    expect(r.content).not.toContain("# Goal:");
  });
});
