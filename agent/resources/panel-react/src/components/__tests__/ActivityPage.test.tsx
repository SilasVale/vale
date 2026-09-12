// ActivityPage — what the operator actually sees on the device-level timeline.
//
// This is the surface that closes the hole the strip left open: the records
// `GET /api/operation` returns were fetched, counted and DISCARDED, and the only
// thing that read them was unreachable without an active terminal session. So
// these tests come in four groups, each pinning a way that hole could reopen:
//
//   (a) WHAT ran is on screen — the command text, the browser script, the
//       intent, the alternatives, the screenshots;
//   (b) the unattributed records are a group of their OWN, after the runs and
//       never folded into one;
//   (c) an absent field renders as ABSENCE — no "—", no stand-in word — and an
//       exit code of zero renders as the VALUE it is, differently;
//   (d) the page renders with ZERO sessions, which is the entire point.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { ActivityPage } from "../ActivityPage";
import { PanelApp } from "../PanelApp";
import { callApi } from "../../lib/api";
import type { OperationEvent, RunBoundary } from "../../lib/runs";

// Partial mock via importOriginal (the pattern the other shell tests use): a
// factory listing only the exports this file happens to touch breaks the moment
// a new consumer appears inside a mounted shell.
vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  callApi: vi.fn(),
  callTool: vi.fn(() => Promise.resolve({})),
}));

const mockCallApi = callApi as unknown as ReturnType<typeof vi.fn>;

const T0 = 1_700_000_000_000;

const ev = (o: Partial<OperationEvent>): OperationEvent => ({
  source: "terminal",
  ts_ms: T0,
  kind: "command/start",
  ...o,
});
const begin = (run_id: string, ts_ms: number, extra: Partial<RunBoundary> = {}): RunBoundary => ({
  kind: "run/begin", run_id, ts_ms, ...extra,
});
const end = (run_id: string, ts_ms: number, extra: Partial<RunBoundary> = {}): RunBoundary => ({
  kind: "run/end", run_id, ts_ms, ...extra,
});

/** Answer every /api/operation poll with the same payload. */
function device(events: OperationEvent[], runs: RunBoundary[] = []) {
  mockCallApi.mockResolvedValue({
    events,
    runs,
    since_ms: 0,
    cursor_ms: events.reduce((m, e) => Math.max(m, e.ts_ms ?? 0), 0),
  });
}

async function mount(ui: React.ReactElement) {
  const r = render(ui);
  await waitFor(() => expect(mockCallApi).toHaveBeenCalled());
  return r;
}

beforeEach(() => {
  mockCallApi.mockReset();
});

describe("ActivityPage — (a) WHAT ran is on screen", () => {
  it("renders the command text, the browser script, the intent, the alternatives and the shots", async () => {
    device(
      [
        ev({
          ts_ms: T0 + 10,
          run_id: "r-a",
          command: "display version",
          intent: "check the firmware before the upgrade",
          considered: ["reboot the ONU first", "read the log instead"],
        }),
        ev({ ts_ms: T0 + 20, run_id: "r-a", kind: "command/end", exit_code: 0, duration_ms: 1_250 }),
        ev({
          ts_ms: T0 + 30,
          run_id: "r-a",
          source: "browser",
          kind: "action",
          script: "await page.click('#login')",
          exit_code: 2,
          duration_ms: 40,
          screenshots: ["run-1-before.png", "run-1-after.png"],
        }),
      ],
      [begin("r-a", T0, { label: "provision the ONU" }), end("r-a", T0 + 60_000, { outcome: "done" })],
    );
    const { container } = await mount(<ActivityPage pollMs={60_000} />);

    // The three records are on screen under the run they declared.
    const rows = [...container.querySelectorAll(".activity-row")];
    expect(rows).toHaveLength(3);
    const texts = [...container.querySelectorAll(".activity-row-what")].map((n) => n.textContent);
    expect(texts).toEqual([
      "display version",
      // A command/end carries no command text of its own, so no body line is
      // invented for it — its outcome is in the facts, not in a fake payload.
      "await page.click('#login')",
    ]);

    // The intent is rendered — the thing that was previously thrown away.
    expect(container.querySelector(".activity-row-intent")!.textContent).toContain(
      "check the firmware before the upgrade",
    );
    // ...as are the alternatives it says it passed over.
    expect([...container.querySelectorAll(".activity-row-alt-item")].map((n) => n.textContent)).toEqual([
      "reboot the ONU first",
      "read the log instead",
    ]);
    // ...and the screenshots, by NAME (the evidence drawer owns the picture).
    expect([...container.querySelectorAll(".activity-row-shot")].map((n) => n.textContent)).toEqual([
      "run-1-before.png",
      "run-1-after.png",
    ]);
    // Outcomes and durations, per record.
    expect([...container.querySelectorAll(".activity-row-exit")].map((n) => n.textContent)).toEqual([
      "exit 0",
      "exit 2",
    ]);
    expect([...container.querySelectorAll(".activity-row-dur")].map((n) => n.textContent)).toEqual([
      "1.3s",
      "40ms",
    ]);
    // The group header is the SHARED one, so it reads exactly as the strip's.
    expect(container.querySelector(".activity-group .run-row-label")!.textContent).toBe("provision the ONU");
    expect(container.querySelector(".run-row-outcome")!.textContent).toContain("done");
  });

  it("marks a browser record as the browser's, and a terminal one with its session", async () => {
    device([
      ev({ ts_ms: T0, session: "s-1", command: "ls" }),
      ev({ ts_ms: T0 + 1, source: "browser", kind: "action", script: "click" }),
    ]);
    const { container } = await mount(<ActivityPage pollMs={60_000} />);
    const sources = [...container.querySelectorAll(".activity-row-source")].map((n) => n.textContent);
    expect(sources).toEqual(["terminal", "browser"]);
    // The session id is shown where it is known, and the browser row — which
    // has no session by construction — does not borrow one.
    expect(container.querySelector(".activity-row-session")!.textContent).toBe("s-1");
    expect(container.querySelectorAll(".activity-row-session")).toHaveLength(1);
  });

  it("renders the facts some kinds carry in `status` (a handoff, an approval)", async () => {
    device([
      ev({ ts_ms: T0, kind: "goal", text: "get the ONU online" }),
      ev({ ts_ms: T0 + 1, kind: "control", status: "human" }),
      ev({ ts_ms: T0 + 2, kind: "approval", status: "armed", text: "reboot*" }),
    ]);
    const { container } = await mount(<ActivityPage pollMs={60_000} />);
    const notes = [...container.querySelectorAll(".activity-row-kindnote")].map((n) => n.textContent);
    expect(notes).toEqual(["keyboard: human", "approval armed"]);
    const bodies = [...container.querySelectorAll(".activity-row-what")].map((n) => n.textContent);
    expect(bodies).toEqual(["get the ONU online", "reboot*"]);
  });
});

describe("ActivityPage — (b) the unattributed bucket stays SEPARATE", () => {
  it("is its own group, after the runs, and the run's rows are untouched by it", async () => {
    device(
      [
        ev({ ts_ms: T0 + 10, run_id: "r-a", command: "inside the run" }),
        ev({ ts_ms: T0 + 20, run_id: "r-a", command: "also inside" }),
        ev({ ts_ms: T0 + 30, command: "nobody's command" }),
        ev({ ts_ms: T0 + 40, source: "browser", kind: "action", script: "click" }),
      ],
      [begin("r-a", T0, { label: "the run" }), end("r-a", T0 + 25)],
    );
    const { container } = await mount(<ActivityPage pollMs={60_000} />);

    const groups = [...container.querySelectorAll(".activity-group")];
    expect(groups).toHaveLength(2);
    // The run group carries exactly its own records...
    const runText = groups[0].textContent!;
    expect(runText).toContain("inside the run");
    expect(runText).toContain("also inside");
    expect(runText).not.toContain("nobody's command");
    // ...and the bucket is LAST, marked as its own kind of group, with the
    // records that declared no run.
    expect(groups[1].getAttribute("data-state")).toBe("unattributed");
    expect(groups[1].className).toContain("activity-group-unattributed");
    expect(groups[1].textContent).toContain("nobody's command");
    expect(groups[1].textContent).toContain("click");
    // The header's count says how many records are in the separate bucket, so
    // the split is visible before scrolling.
    expect(container.querySelector(".activity-stat-unattributed")!.textContent).toBe(
      "2 records with no run",
    );
  });

  it("says WHY the bucket is apart, in the same words the run strip uses", async () => {
    // One vocabulary, two surfaces: the sentence comes from lib/runs.ts
    // (`runStateNote`), so a reader who learned it beside a session reads the
    // same thing here. A bucket shown silently would invite exactly the
    // assumption it exists to prevent.
    device([ev({ ts_ms: T0, command: "loose" })]);
    const { container } = await mount(<ActivityPage pollMs={60_000} />);
    expect(container.querySelector(".run-row-note")!.textContent).toBe(
      "these events declared no run — shown apart rather than assumed into one",
    );
  });

  it("shows the bucket ALONE when the device recorded no runs at all", async () => {    // The browser-only case: actions with no run declared and no terminal
    // session anywhere on the device.
    device([ev({ ts_ms: T0, source: "browser", kind: "action", script: "navigate" })]);
    const { container } = await mount(<ActivityPage pollMs={60_000} />);
    expect(container.querySelectorAll(".activity-group")).toHaveLength(1);
    expect(container.querySelector(".activity-group")!.getAttribute("data-state")).toBe("unattributed");
    expect(container.textContent).toContain("navigate");
    // No count is drawn for runs that do not exist.
    expect(container.querySelector(".activity-stat")!.textContent).toBe("0 runs");
  });
});

describe("ActivityPage — (c) absence is rendered as ABSENCE", () => {
  it("draws NOTHING where an absent intent, exit code, duration or shot would go", async () => {
    device([
      ev({ ts_ms: T0, command: "whoami" }),
      ev({ ts_ms: T0 + 1, source: "browser", kind: "action", script: "click" }),
    ]);
    const { container } = await mount(<ActivityPage pollMs={60_000} />);
    expect(container.querySelectorAll(".activity-row")).toHaveLength(2);
    for (const cls of [
      ".activity-row-intent",
      ".activity-row-alt",
      ".activity-row-shots",
      ".activity-row-exit",
      ".activity-row-dur",
      ".activity-row-timeout",
    ]) {
      expect(container.querySelector(cls), `${cls} must not be drawn for an absent value`).toBeNull();
    }
    // ...and no stand-in word was put in their place. A "—" or a "failed" in
    // that slot reads as a value the device never sent. Checked per ROW: the
    // GROUP may carry a sentence about the group (the unattributed bucket says
    // why it is apart), but a record's own missing field gets nothing at all.
    for (const row of container.querySelectorAll(".activity-row")) {
      const text = row.textContent!;
      expect(text).not.toContain("—");
      expect(text).not.toMatch(/failed|unknown|n\/a|no intent|not recorded/i);
    }
    expect(container.querySelector(".activity-rows")!.textContent).not.toContain("—");
  });

  it("draws exit 0 as the VALUE it is, differently from an absent code", async () => {
    device([
      ev({ ts_ms: T0, kind: "command/end", exit_code: 0 }),
      ev({ ts_ms: T0 + 1, kind: "command/end" }),
    ]);
    const { container } = await mount(<ActivityPage pollMs={60_000} />);
    const exits = [...container.querySelectorAll(".activity-row-exit")];
    // Exactly one of the two records has a code, and it says what it is.
    expect(exits).toHaveLength(1);
    expect(exits[0].textContent).toBe("exit 0");
    expect(exits[0].getAttribute("data-exit")).toBe("zero");
    const rows = [...container.querySelectorAll(".activity-row")];
    expect(rows[0].querySelector(".activity-row-exit")).not.toBeNull();
    expect(rows[1].querySelector(".activity-row-exit")).toBeNull();
  });

  it("marks a non-zero exit apart from zero, not merely in a different colour", async () => {
    device([
      ev({ ts_ms: T0, kind: "command/end", exit_code: 0 }),
      ev({ ts_ms: T0 + 1, kind: "command/end", exit_code: 1 }),
    ]);
    const { container } = await mount(<ActivityPage pollMs={60_000} />);
    const exits = [...container.querySelectorAll(".activity-row-exit")];
    expect(exits.map((n) => n.textContent)).toEqual(["exit 0", "exit 1"]);
    // The two carry different state attributes, which the stylesheet uses to
    // give them different SHAPES as well as different ink (pinned in
    // src/styles/__tests__/activityPage.test.ts).
    expect(exits.map((n) => n.getAttribute("data-exit"))).toEqual(["zero", "nonzero"]);
  });

  it("says a run has no records rather than drawing an empty list", async () => {
    // A run whose begin and end were recorded with nothing in between: an empty
    // <ul> there would read as a rendering failure.
    device([], [begin("r-a", T0, { label: "declared, then nothing" }), end("r-a", T0 + 5)]);
    const { container } = await mount(<ActivityPage pollMs={60_000} />);
    expect(container.querySelector(".activity-rows")).toBeNull();
    expect(container.querySelector(".activity-group-empty")!.textContent).toBe(
      "No records carry this run id.",
    );
  });

  it("renders a quiet line — not an empty container — when nothing has been read", async () => {
    device([], []);
    const { container } = await mount(<ActivityPage pollMs={60_000} />);
    expect(container.querySelector(".activity-groups")).toBeNull();
    const empty = container.querySelector(".activity-empty")!;
    expect(empty.textContent!.length).toBeGreaterThan(0);
    // The page still names itself; it does not vanish.
    expect(screen.getByText("Activity")).toBeTruthy();
  });

  it("never claims the AI is still running", async () => {
    // The one claim this panel refuses to make (see RunStrip's header and
    // lib/runs.ts): an open run means "no end was recorded", nothing more.
    device([ev({ ts_ms: T0, run_id: "r-a", command: "long job" })], [begin("r-a", T0)]);
    const { container } = await mount(<ActivityPage pollMs={60_000} />);
    expect(container.querySelector(".run-row-note")!.textContent).toBe("no end recorded");
    expect(container.textContent).not.toMatch(/still running|in progress|is running|live\b/i);
  });
});

describe("ActivityPage — (d) the page works with ZERO sessions", () => {
  it("renders the device's timeline without any session, active or otherwise", async () => {
    // The whole point of the page. ActivityPage takes no session at all — there
    // is nothing it could require one from.
    device([ev({ ts_ms: T0, run_id: "r-a", command: "browser-only work" })], [begin("r-a", T0)]);
    const { container } = await mount(<ActivityPage pollMs={60_000} />);
    expect(container.querySelector(".activity-page")).not.toBeNull();
    expect(container.textContent).toContain("browser-only work");
  });

  it("is reachable from the rail with NO sessions open, and shows what ran", async () => {
    // The reachability half: the page must be on the rail and it must mount
    // through the real shell, or the feature is implemented and invisible.
    device([ev({ ts_ms: T0, run_id: "r-a", command: "the AI drove the browser" })], [begin("r-a", T0)]);
    render(
      <PanelApp
        sessions={[]}
        activeSid={null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onExport={vi.fn()}
        onViewChange={vi.fn()}
        onSetControl={vi.fn(() => Promise.resolve(false))}
        onSetApproval={vi.fn(() => Promise.resolve(false))}
        onDecideApproval={vi.fn(() => Promise.resolve(true))}
        onRevokeGrants={vi.fn(() => Promise.resolve([]))}
        onSetGoal={vi.fn(() => Promise.resolve(null))}
        registerWrite={vi.fn(() => vi.fn())}
        onNewSession={vi.fn()}
        status=""
        sseState="connected"
        token="t"
        plugins={{ rows: [], specLoaded: true, loadError: "", busy: null, log: [], start: vi.fn(), stop: vi.fn() } as any}
        cmdEvents={{ cards: [], events: [], readState: "ok", firstSeq: 1 }}
        connModal={null}
        onConnClose={vi.fn()}
        onConnConnect={vi.fn(() => Promise.resolve("s1"))}
      />,
    );
    // With zero sessions the terminal page is the empty state it always was…
    // (scoped to the canvas: the session rail says the same thing, and the
    // point here is which PAGE is mounted).
    const canvas = document.querySelector("#panel-main")!;
    expect(within(canvas as HTMLElement).getByText("No sessions yet")).toBeTruthy();
    // …and the rail offers Activity anyway.
    const railBtn = screen.getByTitle("Activity");
    expect(railBtn.getAttribute("aria-current")).toBeNull();
    fireEvent.click(railBtn);
    await waitFor(() => expect(document.querySelector(".activity-page")).not.toBeNull());
    await waitFor(() =>
      expect(document.querySelector(".activity-page")!.textContent).toContain(
        "the AI drove the browser",
      ),
    );
    expect(railBtn.getAttribute("aria-current")).toBe("page");
    // The session list is still empty — nothing was invented to make this work.
    expect(within(canvas as HTMLElement).queryByText("No sessions yet")).toBeNull();
  });
});
