// Path view — the session's work as steps plus a summary.
//
// What these pin, in order of importance:
//
//  1. NO INVENTED BRANCHES. The design's prototype drew each step with the
//     alternatives that were legal at the time ("ghost branches"). That data is
//     NOT in the audit trail — it needs the control plane's gate records and,
//     for "considered and rejected", the intent layer. The view must therefore
//     render no branches at all and SAY SO, rather than drawing an empty fork
//     that implies the data merely failed to load. A path view that fakes
//     branches is worse than no path view: it looks like the product knows what
//     the agent chose between.
//
//  2. The state vocabulary is SHARED with the command cards, not re-derived.
//     Both go through cardState, so "fail" cannot mean one thing here and
//     another there.
//
//  3. The summary is HONEST about what it cannot know: backgrounded and
//     still-running steps have no duration, so the total is a floor and says
//     "at least". And it cannot say WHO ran a step — SessionEvent carries no
//     actor field.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PathView } from "../PathView";
import { derivePath, summarizePath, attentionSteps, type PathStep } from "../../lib/path";
import { groupRounds } from "../../hooks/useTrajectory";
import type { CommandEvent } from "../../hooks/useCommandEvents";

const ev = (o: Partial<CommandEvent>): CommandEvent => ({ seq: 1, ts: 1000, kind: "output", ...o });

/** A session whose single command carries per-step reasoning. Module-scope so
 *  more than one describe block can use it (the note pin needs it too). */
function withIntent(extra: Partial<CommandEvent> = {}): CommandEvent[] {
  return [
    ev({ seq: 1, ts: 100, kind: "status", status: "opened" }),
    ev({
      seq: 2,
      ts: 200,
      kind: "command/start",
      command: "display ont info 0 1",
      ...extra,
    }),
    ev({ seq: 3, ts: 201, kind: "output", text: "ONT 0/1 online" }),
    ev({ seq: 4, ts: 202, kind: "command/end", exit_code: 0, duration_ms: 900 }),
  ];
}

/** A session: one ok command, one failed, one interrupted, one still running. */
function session(): CommandEvent[] {
  return [
    ev({ seq: 1, ts: 100, kind: "status", status: "opened" }),
    ev({ seq: 2, ts: 200, kind: "command/start", command: "display version" }),
    ev({ seq: 3, ts: 201, kind: "output", text: "VERSION 1.2" }),
    ev({ seq: 4, ts: 202, kind: "command/end", exit_code: 0, duration_ms: 900 }),
    ev({ seq: 5, ts: 300, kind: "command/start", command: "vlan 100" }),
    ev({ seq: 6, ts: 301, kind: "command/end", exit_code: 1, duration_ms: 200 }),
    ev({ seq: 7, ts: 400, kind: "command/start", command: "display ont info" }),
    ev({ seq: 8, ts: 401, kind: "command/end", reason: "interrupted" }),
    ev({ seq: 9, ts: 500, kind: "command/start", command: "sleep 900" }),
  ];
}

describe("derivePath", () => {
  it("turns each command round into a step, skipping the preamble", () => {
    const p = derivePath(
      // groupRounds is exercised through the hook elsewhere; feed rounds here.
      [
        { id: "r-pre", startSeq: null, command: "(session)", startTs: 100, events: [], ended: false, exitCode: null, reason: null, durationMs: null },
        { id: "r-2", startSeq: 2, command: "display version", startTs: 200, events: [], ended: true, exitCode: 0, reason: null, durationMs: 900 },
        { id: "r-5", startSeq: 5, command: "vlan 100", startTs: 300, events: [], ended: true, exitCode: 1, reason: null, durationMs: 200 },
      ],
    );
    expect(p.steps.map((s) => s.command)).toEqual(["display version", "vlan 100"]);
    expect(p.steps[0].index).toBe(1);
    expect(p.steps[1].index).toBe(2);
    // The session-level preamble is context, not a step along the path.
    expect(p.steps.some((s) => s.id === "r-pre")).toBe(false);
  });

  it("uses the SAME state derivation as the command cards", () => {
    const p = derivePath([
      { id: "r-1", startSeq: 1, command: "ok", startTs: 1, events: [], ended: true, exitCode: 0, reason: null, durationMs: 1 },
      { id: "r-2", startSeq: 2, command: "bad", startTs: 2, events: [], ended: true, exitCode: 3, reason: null, durationMs: 1 },
      { id: "r-3", startSeq: 3, command: "bg", startTs: 3, events: [], ended: true, exitCode: null, reason: "backgrounded", durationMs: null },
      { id: "r-4", startSeq: 4, command: "cut", startTs: 4, events: [], ended: true, exitCode: null, reason: "interrupted", durationMs: null },
      { id: "r-5", startSeq: 5, command: "live", startTs: 5, events: [], ended: false, exitCode: null, reason: null, durationMs: null },
    ]);
    // r-3 is "backgrounded" and its state is `bg`, NOT `warn`. THIS ASSERTION
    // USED TO READ `warn` HERE — it was pinning the defect: the summary's word for
    // `warn` is "interrupted", so a command the AI handed off to keep running was
    // reported to the operator as one that had stopped, and it lit the session's
    // "bad" marker. The card's own label was always "Backgrounded", which is how
    // the two surfaces came to disagree.
    expect(p.steps.map((s) => s.state)).toEqual(["ok", "fail", "bg", "warn", "running"]);
    expect(p.steps[1].stateLabel).toBe("exit 3");
  });

  it("counts output characters per step without shipping the text", () => {
    const p = derivePath([
      { id: "r-1", startSeq: 1, command: "c", startTs: 1,
        events: [ev({ kind: "output", text: "abcde" }), ev({ kind: "output", text: "fg" })],
        ended: true, exitCode: 0, reason: null, durationMs: 1 },
    ]);
    expect(p.steps[0].outputChars).toBe(7);
  });

  it("indexes steps by round id so a step can be traced back", () => {
    const p = derivePath([
      { id: "r-9", startSeq: 9, command: "c", startTs: 1, events: [], ended: true, exitCode: 0, reason: null, durationMs: 1 },
    ]);
    expect(p.indexOf["r-9"]).toBe(0);
  });
});

describe("summarizePath", () => {
  const step = (o: Partial<PathStep>): PathStep => ({
    id: "x", index: 1, command: "c", state: "ok", owner: "ai", stateLabel: "0",
    startedAt: 0, durationMs: 1000, exitCode: 0, reason: null, outputChars: 0,
    intent: null, considered: [], planStep: null, runId: null, ...o,
  });

  it("reports the total as a FLOOR when some steps have no duration", () => {
    const s = summarizePath([
      step({ id: "a", durationMs: 1000 }),
      step({ id: "b", durationMs: null, state: "warn" }),
    ]);
    expect(s.commandMs).toBe(1000);
    expect(s.untimed).toBe(1);
    // The view must not imply a total it cannot know — `summaryDuration` says
    // "at least" when untimed > 0 (asserted through the render below).
  });

  it("counts each state and flags a live run", () => {
    const s = summarizePath([
      step({ id: "a", state: "ok" }),
      step({ id: "b", state: "fail" }),
      step({ id: "c", state: "fail" }),
      step({ id: "d", state: "running", durationMs: null }),
    ]);
    expect(s.counts).toMatchObject({ ok: 1, fail: 2, running: 1, warn: 0, muted: 0 });
    expect(s.live).toBe(true);
  });

  it("measures wall-clock span, which differs from summed command time", () => {
    // Two 1s commands 10s apart: 2s of work spread over an 11s span.
    const s = summarizePath([
      step({ id: "a", startedAt: 0, durationMs: 1000 }),
      step({ id: "b", startedAt: 10, durationMs: 1000 }),
    ]);
    expect(s.commandMs).toBe(2000);
    expect(s.spanMs).toBe(11000);
  });
});

describe("attentionSteps", () => {
  it("surfaces failures first, then interruptions, then live work", () => {
    const step = (id: string, state: PathStep["state"], index: number): PathStep => ({
      id, index, command: id, state, owner: "ai", stateLabel: "", startedAt: 0,
      durationMs: null, exitCode: null, reason: null, outputChars: 0,
      intent: null, considered: [], planStep: null, runId: null,
    });
    const out = attentionSteps([
      step("ok1", "ok", 1),
      step("live", "running", 2),
      step("cut", "warn", 3),
      step("bad", "fail", 4),
      step("muted", "muted", 5),
    ]);
    expect(out.map((s) => s.id)).toEqual(["bad", "cut", "live"]);
  });
});

describe("PathView", () => {
  it("renders a step per command with the shared state dots", () => {
    render(<PathView events={session()} />);
    expect(screen.getByText("display version")).toBeTruthy();
    // "vlan 100" appears twice on purpose: once in the steps list and once in
    // the "worth a look" list. Both are the same step.
    expect(screen.getAllByText("vlan 100").length).toBeGreaterThanOrEqual(2);
    // The dots use the SAME class the command cards use, so the state palette
    // (colour + shape) has exactly one definition in the panel.
    const dots = document.querySelectorAll(".path-step-dot.cmd-dot");
    expect(dots.length).toBe(4);
    expect([...dots].map((d) => d.getAttribute("data-state"))).toEqual([
      "ok", "fail", "warn", "running",
    ]);
  });

  it("summarises the run and names the failures", () => {
    const { container } = render(<PathView events={session()} />);
    // Scope the count query — "4" also appears as a step index.
    expect(container.querySelector(".path-summary-n")!.textContent).toBe("4");
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(screen.getByText(/1 interrupted/)).toBeTruthy();
    expect(screen.getByText(/running now/)).toBeTruthy();
  });

  it("says the duration is a FLOOR when steps have no measurable time", () => {
    render(<PathView events={session()} />);
    // Two of the four steps have no duration (interrupted, still running), so a
    // bare total would be a lie of precision.
    expect(screen.getByText(/at least/)).toBeTruthy();
  });

  it("draws NO branches and states why", () => {
    const { container } = render(<PathView events={session()} />);
    // No ghost-fork affordance of any kind...
    expect(container.querySelector(".path-branch")).toBeNull();
    expect(container.querySelector("[data-branch]")).toBeNull();
    // ...and the reason is on screen, in the operator's words, so the absence
    // reads as a known limit rather than missing data.
    const note = container.querySelector(".path-note")!.textContent!;
    expect(note).toContain("alternatives");
    expect(note).toMatch(/invent/i);
  });

  it("the note does NOT claim the alternatives are absent while showing them", () => {
    // The note was written when `considered` was not in the audit trail, and it
    // said so. Once the intent layer landed the view began RENDERING those
    // alternatives — and the note kept denying they existed, contradicting the
    // content a few lines above it on the same screen. A rendered guarantee has
    // to match the rendered text, so this is asserted against the DOM rather
    // than against a phrasing.
    const { container } = render(
      <PathView
        events={withIntent({
          intent: "why this ran",
          considered: ["the other way", "a third way"],
        })}
      />,
    );
    const shown = container.querySelectorAll(".path-step-alt-item").length;
    expect(shown, "the fixture must actually render alternatives").toBe(2);
    const note = container.querySelector(".path-note")!.textContent!;
    // The false claim, in the words it was made in.
    expect(note).not.toMatch(/does not record the alternatives/i);
    expect(note).not.toMatch(/not in the audit trail/i);
    // And it must still be honest about what IS missing: the alternatives that
    // were legal but never attempted (the tree), which is why no branches.
    expect(note).toMatch(/invent/i);
  });

  it("never fabricates actor prose about a step", () => {
    // This used to be named "never claims to know WHO ran a step" — true when
    // SessionEvent had no actor field. It does now (`control` events, folded by
    // ownerAt), and the view renders a `you` tag plus a "N by you" summary, so
    // the NAME was a lie. The assertion was always the narrower, still-valid
    // property, and that is what it is called now: the view marks ownership
    // from the trail and never narrates an actor it did not read.
    const { container } = render(<PathView events={session()} />);
    const text = container.textContent!;
    expect(text).not.toMatch(/\bAI ran\b|\buser ran\b|\bby: /);
    // No control events in this fixture, so no step may be marked as human.
    expect(container.querySelector(".path-step-owner")).toBeNull();
  });

  it("shows an honest empty state before any command", () => {
    const { container } = render(<PathView events={[ev({ kind: "status", status: "opened" })]} />);
    expect(screen.getByText("No path yet")).toBeTruthy();
    expect(container.querySelectorAll(".path-step").length).toBe(0);
    // The empty state explains what will appear, so "nothing here" does not
    // read as "broken".
    expect(container.querySelector(".path-empty-body")!.textContent).toMatch(
      /command/i,
    );
  });

  it("puts failures in a 'worth a look' list that calls back with the step", () => {
    const seen: string[] = [];
    render(<PathView events={session()} onJumpToStep={(s) => seen.push(s.id)} />);
    expect(screen.getByText(/Worth a look/)).toBeTruthy();
    const first = document.querySelector(".path-attention-row") as HTMLButtonElement;
    first.click();
    // The list is ordered worst-first, so the first row is the FAILURE.
    expect(seen).toEqual(["r-5"]);
  });
});

describe("ownership (who was driving)", () => {
  const ctl = (ts: number, holder: "human" | "ai"): CommandEvent =>
    ev({ kind: "control", status: holder, ts });

  /** Two commands, handoff between them, then a hand-back. */
  const withHandoff = (): CommandEvent[] => [
    ev({ seq: 1, ts: 100, kind: "command/start", command: "ai one" }),
    ev({ seq: 2, ts: 101, kind: "command/end", exit_code: 0, duration_ms: 10 }),
    ctl(200, "human"),
    ev({ seq: 3, ts: 300, kind: "command/start", command: "human one" }),
    ev({ seq: 4, ts: 301, kind: "command/end", exit_code: 0, duration_ms: 10 }),
    ctl(400, "ai"),
    ev({ seq: 5, ts: 500, kind: "command/start", command: "ai two" }),
    ev({ seq: 6, ts: 501, kind: "command/end", exit_code: 0, duration_ms: 10 }),
  ];

  it("attributes each step to whoever held the keyboard when it STARTED", () => {
    const p = derivePath(
      groupRounds(withHandoff()),
      withHandoff(),
    );
    expect(p.steps.map((s) => [s.command, s.owner])).toEqual([
      ["ai one", "ai"],
      ["human one", "human"],
      ["ai two", "ai"],
    ]);
  });

  it("counts human steps in the summary", () => {
    const events = withHandoff();
    const p = derivePath(groupRounds(events), events);
    expect(p.summary.humanSteps).toBe(1);
    expect(p.summary.steps).toBe(3);
  });

  it("treats a session with NO handoff as entirely the agent's", () => {
    // The default reading: the audit is the record of device control, and
    // before any `control` event the agent had it.
    const p = derivePath(groupRounds(session()));
    expect(p.steps.every((s) => s.owner === "ai")).toBe(true);
    expect(p.summary.humanSteps).toBe(0);
  });

  it("does NOT reassign a command that was already running at the handoff", () => {
    // A step belongs to whoever started it. A handoff mid-command does not
    // retroactively make the agent's command the human's — it issued it.
    const events: CommandEvent[] = [
      ev({ seq: 1, ts: 100, kind: "command/start", command: "long" }),
      ctl(150, "human"),
      ev({ seq: 2, ts: 200, kind: "command/end", exit_code: 0, duration_ms: 100 }),
    ];
    const p = derivePath(groupRounds(events), events);
    expect(p.steps[0].owner).toBe("ai");
  });

  it("ignores a control event with an unknown holder", () => {
    // A future/unknown holder must not silently become "human".
    const events = [ctl(0, "human"), ev({ seq: 9, ts: 10, kind: "control", status: "robot" }),
                    ev({ seq: 1, ts: 20, kind: "command/start", command: "c" })];
    const p = derivePath(groupRounds(events), events);
    expect(p.steps[0].owner).toBe("human");
  });

  it("shows the hold on screen and explains the limit of it", () => {
    const events = withHandoff();
    const { container } = render(<PathView events={events} />);
    expect(screen.getByText("1 by you")).toBeTruthy();
    // Exactly one step carries the owner chip — the human one.
    expect(container.querySelectorAll(".path-step-owner").length).toBe(1);
    // The note must not claim the human's TYPING was reconstructed: keystrokes
    // are bytes, not command boundaries. Marking the window is the honest move.
    const note = container.querySelector(".path-note")!.textContent!;
    expect(note).toMatch(/who was driving/i);
    expect(note).toMatch(/not reconstructed/i);
  });
});

describe("the intent layer in the path", () => {
  // Events exactly as the agent now writes them: the reasoning rides the
  // command/start event. Driven through the REAL component so the test covers
  // the whole path from event shape to rendered pixels.
  it("renders the reason under the command, and the branches NOT taken", () => {
    render(
      <PathView
        events={withIntent({
          intent: "check whether the ONU is actually online",
          considered: ["reset the ONU", "check the OLT uplink"],
        })}
      />,
    );
    expect(document.querySelector(".path-step-why")!.textContent).toContain(
      "check whether the ONU is actually online",
    );
    const alts = [...document.querySelectorAll(".path-step-alt-item")].map((e) => e.textContent);
    expect(alts).toEqual(["reset the ONU", "check the OLT uplink"]);
  });

  it("stacks the reason UNDER the command, not beside it", () => {
    // The placement is the whole point, and asserting mere presence did not
    // catch it: `.path-step` is `display: flex`, so a `<p>` emitted as a direct
    // child became a flex ITEM sitting beside the command — overlapping it in
    // the render while every presence assertion stayed green. The reason must
    // live inside the same column as the body it explains.
    render(
      <PathView
        events={withIntent({ intent: "why this ran", considered: ["another way"] })}
      />,
    );
    const main = document.querySelector(".path-step-main");
    expect(main, "the step needs a column wrapper").not.toBeNull();
    expect(main!.querySelector(".path-step-body")).not.toBeNull();
    expect(main!.querySelector(".path-step-why")).not.toBeNull();
    expect(main!.querySelector(".path-step-alt")).not.toBeNull();
    // And NOT a direct child of the row, which is what broke it.
    expect(document.querySelector(".path-step > .path-step-why")).toBeNull();
    expect(document.querySelector(".path-step > .path-step-alt")).toBeNull();
  });

  it("does NOT pad a reasonless step with a placeholder", () => {
    // Most steps will have no stated reason (no client sends one yet, and not
    // every step needs one). Filling that space would bury the steps that DO
    // have one — the only information worth surfacing here.
    render(<PathView events={withIntent()} />);
    expect(document.querySelector(".path-step-why")).toBeNull();
    expect(document.querySelector(".path-step-alt")).toBeNull();
  });

  it("reads absent reasoning as absent, not as an empty string", () => {
    const p = derivePath(groupRounds(withIntent()), []);
    expect(p.steps[0].intent).toBeNull();
    expect(p.steps[0].considered).toEqual([]);
  });

  it("shows the goal above the summary it is judged against", () => {
    render(
      <PathView
        events={withIntent({ intent: "why" })}
        goal="provision the ONU on VLAN 100"
      />,
    );
    const goal = document.querySelector(".path-goal");
    expect(goal).not.toBeNull();
    expect(goal!.textContent).toContain("provision the ONU on VLAN 100");
    // ABOVE the summary in document order, so "2 failed" reads directly under
    // what the run was for — the whole point of showing them together.
    const summary = document.querySelector(".path-summary")!;
    expect(goal!.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the plan in the path", () => {
  // Events as the agent now writes them: a command names the plan step it
  // advances. Driven through the REAL component so the whole path is covered —
  // event shape, derivation and render.
  function withPlan(steps: number[]): CommandEvent[] {
    const evs: CommandEvent[] = [ev({ seq: 1, ts: 100, kind: "status", status: "opened" })];
    let seq = 2;
    for (const step of steps) {
      evs.push(ev({ seq: seq++, ts: 200, kind: "command/start", command: `cmd ${step}`, plan_step: step }));
      evs.push(ev({ seq: seq++, ts: 201, kind: "command/end", exit_code: 0, duration_ms: 10 }));
    }
    return evs;
  }

  it("shows each step with the number of commands that served it", () => {
    render(
      <PathView
        events={withPlan([1, 1, 3])}
        plan={["check the ONU is online", "create VLAN 100", "save the config"]}
      />,
    );
    const rows = [...document.querySelectorAll(".path-plan-step")].map((e) => ({
      text: e.querySelector(".path-plan-text")!.textContent,
      count: e.querySelector(".path-plan-count")!.textContent,
      zero: e.querySelector(".path-plan-count")!.getAttribute("data-zero"),
    }));
    expect(rows).toEqual([
      { text: "check the ONU is online", count: "2", zero: "no" },
      { text: "create VLAN 100", count: "0", zero: "yes" },
      { text: "save the config", count: "1", zero: "no" },
    ]);
  });

  it("marks a step NOBODY claimed, because that is the signal", () => {
    // An unclaimed step is how a run visibly departs from what was announced.
    // The count is the honest half of the plan — rendering the steps without it
    // would show an intention as if it were an accomplishment.
    render(<PathView events={withPlan([1])} plan={["did this", "did not"]} />);
    const open = document.querySelectorAll(".path-plan-step.open");
    expect(open.length).toBe(1);
    expect(open[0].querySelector(".path-plan-text")!.textContent).toBe("did not");
    // Distinguishable by SHAPE, not colour alone.
    expect(open[0].className).toContain("open");
  });

  it("does NOT silently drop a claim of a step the plan does not have", () => {
    // `plan_step` is recorded VERBATIM — the device does not validate it against
    // the declared plan — so a plan revised from 5 steps to 3 leaves earlier
    // claims pointing past the end. Counting only `planStep === n` over the
    // DECLARED steps put those in no bucket at all: they were counted on the
    // Activity row and NOWHERE in the plan view, which is exactly the "work that
    // was never announced" this block promises to surface.
    render(<PathView events={withPlan([1, 5])} plan={["one", "two", "three"]} />);
    const off = document.querySelector(".path-plan-offplan");
    expect(off, "an out-of-range claim must be visible, not dropped").not.toBeNull();
    expect(off!.getAttribute("data-count")).toBe("1");
    expect(off!.textContent).toContain("5");
    // It is NOT credited to any real step: attributing it to step 3 would invent
    // a fact about which step the command served.
    const counts = [...document.querySelectorAll(".path-plan-count")].map((e) => e.textContent);
    expect(counts).toEqual(["1", "0", "0"]);
  });

  it("renders no plan block at all when the agent declared none", () => {
    // Most sessions have no plan (no client sends one yet); an empty block would
    // be noise on every run.
    render(<PathView events={withPlan([1])} plan={[]} />);
    expect(document.querySelector(".path-plan")).toBeNull();
    render(<PathView events={withPlan([1])} />);
    expect(document.querySelector(".path-plan")).toBeNull();
  });

  it("does not credit a step to a command that claimed nothing", () => {
    // A command with no plan_step serves no step. Crediting it to step 1 by
    // position would invent a linkage the agent never stated.
    const evs = [
      ev({ seq: 1, ts: 100, kind: "command/start", command: "unplanned" }),
      ev({ seq: 2, ts: 101, kind: "command/end", exit_code: 0, duration_ms: 5 }),
    ];
    render(<PathView events={evs} plan={["the only step"]} />);
    expect(document.querySelector(".path-plan-count")!.textContent).toBe("0");
    expect(document.querySelector(".path-plan-count")!.getAttribute("data-zero")).toBe("yes");
  });
});

describe("PathView — the run a command claims to belong to", () => {
  // THE PANEL DROPPED THIS UNTIL ROUND 30. `run_id` has been on the wire since
  // runs were introduced — written onto every `command/start` executed under a
  // run — but `CommandEvent` did not declare it, so the trail reader discarded an
  // attribution the device had already recorded. `useOperationRuns.ts` even
  // stated the opposite in a comment ("carries no `run_id` at all"), which
  // explained its own second poll away and stopped anyone looking.
  const withRun = (runId: string | null) => [
    {
      seq: 1, ts: 100, kind: "command/start", command: "echo hi",
      ...(runId == null ? {} : { run_id: runId }),
    },
    { seq: 2, ts: 101, kind: "command/end", exit_code: 0, duration_ms: 5 },
  ];

  it("derives the claimed run from the event", () => {
    const p = derivePath(groupRounds(withRun("run-1789-b50f43")));
    expect(p.steps[0].runId).toBe("run-1789-b50f43");
  });

  it("treats an ABSENT or blank id as no claim, not as a run named ''", () => {
    // The device omits a blank id rather than storing it; the panel must not
    // invent a run from whitespace.
    expect(derivePath(groupRounds(withRun(null))).steps[0].runId).toBeNull();
    expect(derivePath(groupRounds(withRun("   "))).steps[0].runId).toBeNull();
  });

  it("renders it as a CLAIM, and groups nothing", () => {
    const { container } = render(<PathView events={withRun("run-1789-b50f43")} />);
    const el = container.querySelector(".path-step-run")!;
    expect(el).not.toBeNull();
    expect(el.textContent).toContain("run-1789-b50f43");
    // The title says whose claim it is. It is recorded verbatim and the device
    // never verifies it, so presenting it as a confirmed grouping would assert
    // something nobody checked.
    expect(el.getAttribute("title")).toMatch(/agent says/i);
  });

  it("draws nothing when no run was claimed", () => {
    const { container } = render(<PathView events={withRun(null)} />);
    expect(container.querySelector(".path-step-run")).toBeNull();
  });
});

describe("PathView — a backgrounded command is not an interrupted one", () => {
  // The card said "Backgrounded" while the STATE it fed was `warn`, and the path
  // summary's word for `warn` is "interrupted" — so the operator-facing line
  // reported still-running work as stopped, AND lit the session's "bad" marker
  // for a session nothing had gone wrong with. The label was right and the state
  // was wrong, which is why the two surfaces disagreed.
  const bg = [
    { seq: 1, ts: 100, kind: "command/start", command: "npm run build" },
    { seq: 2, ts: 101, kind: "command/end", reason: "backgrounded", duration_ms: 5 },
  ];

  it("derives its own state, not `warn`", () => {
    const p = derivePath(groupRounds(bg));
    expect(p.steps[0].state).toBe("bg");
    expect(p.summary.counts.warn).toBe(0);
    expect(p.summary.counts.bg).toBe(1);
  });

  it("is worded as backgrounded, and NOT counted as interrupted", () => {
    const { container } = render(<PathView events={bg} />);
    const text = container.textContent!;
    expect(text).toContain("1 backgrounded");
    expect(text).not.toContain("interrupted");
  });

  it("does not light the session's bad marker", () => {
    // `bad = fail + warn`. Backgrounded work belongs to neither.
    render(<PathView events={bg} />);
    expect(screen.queryByText(/interrupted/)).toBeNull();
  });

  it("still says interrupted for a command that really was", () => {
    // The distinction must not swallow the real case.
    const real = [
      { seq: 1, ts: 100, kind: "command/start", command: "npm run build" },
      { seq: 2, ts: 101, kind: "command/end", reason: "interrupted", duration_ms: 5 },
    ];
    const { container } = render(<PathView events={real} />);
    expect(container.textContent).toContain("1 interrupted");
  });
});
