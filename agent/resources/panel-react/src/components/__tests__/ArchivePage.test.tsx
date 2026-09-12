// ArchivePage — the device's RECORDED sessions, and the audit trail of one that
// is already gone.
//
// THE HOLE THESE TESTS PIN SHUT. `GET /api/sessions` served the durable list for
// rounds and NOTHING in the panel consumed it; the session list came from
// `terminal_list`, which knows live sessions only. So a closed session's tab was
// an inert tombstone, a page reload or an agent restart put every past session
// out of reach, and the panel asserted history it could not show. Each group
// below is one way that hole could reopen:
//
//   (a) the list comes from the ROUTE, never from the live tool;
//   (b) a recorded session opens through the EXISTING reader and the EXISTING
//       trajectory renderer — no second timeline;
//   (c) live and archived are distinguishable, as WORDS (this repo has shipped
//       two states that differed only by an animation reduced motion removes);
//   (d) a session whose trail cannot be read SAYS SO and never renders as an
//       empty history, and an empty ARCHIVE is a different sentence again.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ArchivePage } from "../ArchivePage";
import { PanelApp } from "../PanelApp";
import { callApi, callTool } from "../../lib/api";
import type { Session } from "../../hooks/useSessions";
import { ARCHIVE_PAGE } from "../../lib/archive";

vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  callApi: vi.fn(),
  callTool: vi.fn(),
}));

const mockCallApi = callApi as unknown as ReturnType<typeof vi.fn>;
const mockCallTool = callTool as unknown as ReturnType<typeof vi.fn>;

const T0 = 1_700_000_000;

const session = (over: Partial<Session> = {}): Session => ({
  sid: "s1",
  label: "shell",
  kind: "pty",
  closed: false,
  savedOnly: false,
  active: true,
  openedAt: Date.now(),
  closedAt: null,
  heldByHuman: false,
  approvalRequired: false,
  pendingApproval: null,
  approvalGrants: [],
  goal: null,
  plan: [],
  ...over,
});

/** The device, as this page sees it:
 *   * `/api/sessions`        → the durable manifest (id + folded last event);
 *   * `/api/sessions/{sid}`  → that session's audit events, or a failure.
 *  `terminal_list` is answered with the LIVE set and counts the calls, so a test
 *  can prove the archive never read it. */
function device(opts: {
  sessions?: Array<{ id: string; state?: unknown }>;
  events?: Record<string, unknown[]>;
  failEventsFor?: string[];
  /** Per-session `first_seq` — >1 means the device trimmed the trail's head. */
  firstSeqFor?: Record<string, number>;
  listFails?: boolean;
  listPending?: boolean;
  live?: Array<{ id: string }>;
}) {
  mockCallApi.mockImplementation((path: string) => {
    if (path === "/api/sessions") {
      if (opts.listPending) return new Promise(() => { /* never settles */ });
      if (opts.listFails) return Promise.reject(new Error("HTTP 502"));
      return Promise.resolve({ ok: true, sessions: opts.sessions ?? [] });
    }
    const m = /^\/api\/sessions\/(.+)$/.exec(path);
    if (m) {
      const sid = decodeURIComponent(m[1]);
      if (opts.failEventsFor?.includes(sid)) return Promise.reject(new Error("HTTP 404"));
      return Promise.resolve({
        ok: true,
        id: sid,
        found: !opts.failEventsFor?.includes(sid),
        first_seq: opts.firstSeqFor?.[sid] ?? 1,
        events: opts.events?.[sid] ?? [],
      });
    }
    return Promise.resolve({});
  });
  mockCallTool.mockResolvedValue(opts.live ?? []);
}

/** One command's worth of audit events (start → output → end). */
const trail = (command: string, text: string) => [
  { seq: 1, ts: T0, kind: "command/start", command },
  { seq: 2, ts: T0 + 1, kind: "output", text },
  { seq: 3, ts: T0 + 2, kind: "command/end", exit_code: 0, duration_ms: 900 },
];

/** Open a row by its session id and return the row element. */
async function open(sid: string): Promise<void> {
  const row = await screen.findByText(sid);
  fireEvent.click(row.closest("button")!);
}

beforeEach(() => {
  mockCallApi.mockReset();
  mockCallTool.mockReset();
});

describe("ArchivePage — (a) the list is the device's RECORDED sessions", () => {
  it("reads GET /api/sessions and never the live terminal_list", async () => {
    device({
      sessions: [{ id: "recorded-1", state: { kind: "status", ts: T0, status: "closed" } }],
      live: [{ id: "live-only" }],
    });
    render(<ArchivePage sessions={[session({ sid: "live-only" })]} />);

    expect(await screen.findByText("recorded-1")).toBeTruthy();
    expect(mockCallApi).toHaveBeenCalledWith("/api/sessions");
    // The one thing this page must NOT do: build its list from the live set.
    expect(mockCallTool).not.toHaveBeenCalled();
    // ...and a session the device never recorded does not appear, however live.
    expect(screen.queryByText("live-only")).toBeNull();
  });

  it("lists newest first, by the last recorded event", async () => {
    device({
      sessions: [
        // Directory order (what the route returns) is deliberately NOT the order
        // the operator should read.
        { id: "oldest", state: { kind: "status", ts: T0 - 900, status: "closed" } },
        { id: "newest", state: { kind: "status", ts: T0, status: "closed" } },
        { id: "middle", state: { kind: "status", ts: T0 - 400, status: "closed" } },
      ],
    });
    const { container } = render(<ArchivePage sessions={[]} />);
    await screen.findByText("newest");
    const names = [...container.querySelectorAll(".archive-row-name")].map((n) => n.textContent);
    expect(names).toEqual(["newest", "middle", "oldest"]);
  });
});

describe("ArchivePage — (b) a recorded session opens through the EXISTING reader", () => {
  it("renders an archived session's events with the trajectory renderer the live views use", async () => {
    device({
      sessions: [{ id: "s-old", state: { kind: "command/end", ts: T0 + 2, exit_code: 0 } }],
      events: { "s-old": trail("display version", "V1.2.325") },
    });
    // The panel holds NO sessions: this is the reload/restart case, where the
    // session is reachable only because its file survived.
    render(<ArchivePage sessions={[]} />);
    await open("s-old");

    // The command text arrives...
    expect(await screen.findByText("display version")).toBeTruthy();
    // ...inside the SHARED renderer's frame (#traj-view / .traj-round-cmd), not
    // a second timeline written for this page.
    expect(document.querySelector("#traj-view")).toBeTruthy();
    expect(document.querySelector(".traj-round-cmd")?.textContent).toBe("display version");
    // And it came from the audit route, read by the shared hook.
    expect(mockCallApi).toHaveBeenCalledWith("/api/sessions/s-old");
  });

  it("counts the rounds with the renderer's own counter", async () => {
    device({
      sessions: [{ id: "s-two", state: { kind: "command/end", ts: T0 + 5 } }],
      events: {
        "s-two": [
          ...trail("first", "a"),
          { seq: 4, ts: T0 + 3, kind: "command/start", command: "second" },
          { seq: 5, ts: T0 + 5, kind: "command/end", exit_code: 1, duration_ms: 10 },
        ],
      },
    });
    render(<ArchivePage sessions={[]} />);
    await open("s-two");
    await screen.findByText("first");
    expect(document.querySelector(".traj-count")?.textContent).toBe("2");
  });
});

describe("ArchivePage — (c) live and archived are distinguishable", () => {
  it("calls a recorded session that is still open LIVE, and words the marks differently", async () => {
    device({
      sessions: [
        { id: "still-open", state: { kind: "status", ts: T0, status: "opened" } },
        { id: "long-gone", state: { kind: "status", ts: T0 - 500, status: "closed" } },
      ],
    });
    render(<ArchivePage sessions={[session({ sid: "still-open" })]} />);

    const liveRow = (await screen.findByText("still-open")).closest("button")!;
    const goneRow = screen.getByText("long-gone").closest("button")!;
    expect(within(liveRow).getByText("live")).toBeTruthy();
    expect(within(goneRow).getByText("archived")).toBeTruthy();
    // The marks are WORDS in the DOM, and each row carries only its own — a
    // reader who cannot separate two inks still reads which is which.
    expect(within(liveRow).queryByText("archived")).toBeNull();
    expect(within(goneRow).queryByText("live")).toBeNull();
    // The distinction reaches the stylesheet as a state, for the shape channel.
    expect(liveRow.getAttribute("data-state")).toBe("live");
    expect(goneRow.getAttribute("data-state")).toBe("archived");
  });

  it("treats a session the panel has TOMBSTONED as archived, not as live", async () => {
    device({ sessions: [{ id: "dead", state: { kind: "status", ts: T0, status: "closed" } }] });
    // Closed in this panel = the live set no longer contains it, however recently
    // it was in the tab strip.
    render(<ArchivePage sessions={[session({ sid: "dead", closed: true })]} />);
    const row = (await screen.findByText("dead")).closest("button")!;
    expect(within(row).getByText("archived")).toBeTruthy();
    expect(within(row).queryByText("live")).toBeNull();
  });

  it("keeps the live/archived mark on the trail header too", async () => {
    device({
      sessions: [{ id: "still-open", state: { kind: "status", ts: T0, status: "opened" } }],
      events: { "still-open": trail("uptime", "3 days") },
    });
    const { container } = render(<ArchivePage sessions={[session({ sid: "still-open" })]} />);
    await open("still-open");
    await screen.findByText("uptime");
    const head = container.querySelector(".archive-trail-head")!;
    expect(within(head as HTMLElement).getByText("live")).toBeTruthy();
  });
});

describe("ArchivePage — a TRIMMED trail is not presented as complete", () => {
  // When a session closes, `trim_file` DRAINS EVERYTHING BEFORE THE LAST
  // `command/start` — a session that ran commands keeps only its most recent one
  // onward, and only that window is then capped. So a trimmed session HAS events,
  // which is why this fixture has one; the route reports `first_seq` for exactly
  // this case, and a viewer that ignores it tells the operator the trail is the
  // whole story when it is not.
  it("says earlier events are not recorded when the trail does not begin at 1", async () => {
    device({
      sessions: [{ id: "long", state: { kind: "status", ts: T0, status: "closed" } }],
      events: { long: trail("echo late", "late\n") },
      firstSeqFor: { long: 1734 },
    });
    render(<ArchivePage sessions={[]} />);
    await open("long");

    expect(await screen.findByText(/Earlier events are not recorded/i)).toBeTruthy();
    expect(screen.getByText(/begins at event 1734/)).toBeTruthy();
    // It states the device's REAL rule. The old wording said "the last 2000
    // lines", which overstates what survived by an order of magnitude on a real
    // session (d1: 33 discarded, 26 surviving).
    expect(screen.getByText(/keeps its most recent command onward/i)).toBeTruthy();
    expect(screen.queryByText(/last 2000 lines/i)).toBeNull();
  });

  it("stays silent for a trail that DOES begin at 1", async () => {
    device({
      sessions: [{ id: "short", state: { kind: "status", ts: T0, status: "closed" } }],
      firstSeqFor: { short: 1 },
    });
    render(<ArchivePage sessions={[]} />);
    await open("short");
    // Wait for the trail to have SETTLED on a real read — the empty-record line
    // is the positive signal that `events` arrived, so the absence assertion
    // below is about a rendered trail rather than about a pending one.
    await screen.findByText(/holds no events/i);
    expect(screen.queryByText(/Earlier events are not recorded/i)).toBeNull();
  });
});

describe("ArchivePage — (d) an unreadable trail is not an empty history", () => {
  it("says the trail could not be read, and does NOT draw the renderer's empty state", async () => {
    device({
      sessions: [{ id: "ghost", state: { kind: "status", ts: T0, status: "closed" } }],
      failEventsFor: ["ghost"],
    });
    render(<ArchivePage sessions={[]} />);
    await open("ghost");

    expect(await screen.findByText(/could not be read from the device/i)).toBeTruthy();
    // The renderer's own empty line is a CLAIM about the session ("no commands
    // in this session yet") and must not stand in for a failed read.
    expect(screen.queryByText(/No commands in this session yet/i)).toBeNull();
    expect(document.querySelector("#traj-view")).toBeNull();
  });

  it("distinguishes 'the device returned no events' from a failed read", async () => {
    device({
      sessions: [{ id: "empty-trail", state: { kind: "status", ts: T0, status: "closed" } }],
      events: { "empty-trail": [] },
    });
    render(<ArchivePage sessions={[]} />);
    await open("empty-trail");

    // The wording narrowed in round 23: the route now separates "no readable
    // record" (`found:false`, the branch ABOVE) from "recorded nothing", so this
    // line may only claim the latter. The assertion keeps its original job —
    // telling the two apart — with the text the device actually justifies.
    expect(await screen.findByText(/has a record for this session and it holds no events/i)).toBeTruthy();
    // A read that SUCCEEDED and a read that FAILED are different sentences.
    expect(screen.queryByText(/could not be read from the device/i)).toBeNull();
    expect(screen.queryByText(/No commands in this session yet/i)).toBeNull();
  });

  it("says the ARCHIVE could not be read rather than that the device recorded nothing", async () => {
    device({ listFails: true });
    render(<ArchivePage sessions={[]} />);

    expect(await screen.findByText(/session archive could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/has recorded no sessions yet/i)).toBeNull();
    expect(document.querySelector(".archive-rows")).toBeNull();
  });

  it("says it is still reading — never an empty archive, never a failure", async () => {
    device({ listPending: true });
    render(<ArchivePage sessions={[]} />);

    expect(screen.getByText(/Reading the device's session archive/i)).toBeTruthy();
    expect(screen.queryByText(/has recorded no sessions yet/i)).toBeNull();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it("a device with nothing recorded gets a quiet line, not an empty container", async () => {
    device({ sessions: [] });
    const { container } = render(<ArchivePage sessions={[]} />);

    expect(await screen.findByText(/has recorded no sessions yet/i)).toBeTruthy();
    // No titled empty list that reads as a broken feature.
    expect(container.querySelector(".archive-rows")).toBeNull();
  });
});

describe("ArchivePage — the bounded list", () => {
  it("renders one page of a large archive and says how many are held back", async () => {
    const sessions = Array.from({ length: 167 }, (_, i) => ({
      id: `s-${String(i).padStart(3, "0")}`,
      state: { kind: "status", ts: T0 - i, status: "closed" },
    }));
    device({ sessions });
    const { container } = render(<ArchivePage sessions={[]} />);

    await screen.findByText("s-000");
    expect(container.querySelectorAll(".archive-row").length).toBe(ARCHIVE_PAGE);
    expect(screen.getByText(`showing ${ARCHIVE_PAGE} of 167`)).toBeTruthy();
    // The device may hold hundreds of files: the page never renders them all.
    expect(screen.getByText(/117 held back/)).toBeTruthy();
  });

  it("widens the window by one page on demand, still bounded", async () => {
    const sessions = Array.from({ length: 167 }, (_, i) => ({
      id: `s-${String(i).padStart(3, "0")}`,
      state: { kind: "status", ts: T0 - i, status: "closed" },
    }));
    device({ sessions });
    const { container } = render(<ArchivePage sessions={[]} />);
    await screen.findByText("s-000");

    fireEvent.click(screen.getByRole("button", { name: /Show .* more/ }));
    expect(container.querySelectorAll(".archive-row").length).toBe(ARCHIVE_PAGE * 2);
    expect(screen.getByText(`showing ${ARCHIVE_PAGE * 2} of 167`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Show .* more/ }));
    expect(container.querySelectorAll(".archive-row").length).toBe(ARCHIVE_PAGE * 3);
    fireEvent.click(screen.getByRole("button", { name: /Show .* more/ }));
    // The last page is short: the window is bounded by the archive, not by the
    // page size, and nothing is invented to fill it.
    expect(container.querySelectorAll(".archive-row").length).toBe(167);
    expect(screen.getByText("showing 167 of 167")).toBeTruthy();
    // Nothing left to reveal — the control is gone rather than offering "0 more".
    expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull();
  });
});

describe("ArchivePage — honest absences on a row", () => {
  it("draws nothing where the device recorded nothing", async () => {
    device({
      // No folded state at all, and a state with no timestamp.
      sessions: [{ id: "bare" }, { id: "no-stamp", state: { kind: "status", status: "closed" } }],
    });
    render(<ArchivePage sessions={[]} />);

    const bare = (await screen.findByText("bare")).closest("button")!;
    // An absent value is ABSENCE — no "—", no "unknown", no invented clock.
    expect(bare.querySelector(".archive-row-when")).toBeNull();
    expect(bare.querySelector(".archive-row-last")).toBeNull();
    expect(bare.textContent).not.toMatch(/unknown|—|never|no data/i);

    const noStamp = screen.getByText("no-stamp").closest("button")!;
    expect(noStamp.querySelector(".archive-row-when")).toBeNull();
    // The status VALUE the device did write is still drawn.
    expect(noStamp.querySelector(".archive-row-last")?.textContent).toBe("closed");
  });

  it("keeps exit 0 a value on the row", async () => {
    device({ sessions: [{ id: "done", state: { kind: "command/end", ts: T0, exit_code: 0 } }] });
    render(<ArchivePage sessions={[]} />);
    const row = (await screen.findByText("done")).closest("button")!;
    expect(row.querySelector(".archive-row-last")?.textContent).toBe("exit 0");
  });
});

describe("the archive is reachable from the rail", () => {
  it("mounts on the panel density's Archive page — the one surface that works with NO session", async () => {
    device({ sessions: [{ id: "from-before-the-reload", state: { kind: "status", ts: T0, status: "closed" } }] });
    // The panel density, with ZERO sessions: this is the state a reload or an
    // agent restart leaves an operator in, and exactly where the archive has to
    // be reachable or the past is unreachable entirely.
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
    fireEvent.click(screen.getByTitle("Archive"));
    expect(await screen.findByText("from-before-the-reload")).toBeTruthy();
    expect(document.querySelector(".archive-page")).toBeTruthy();
    expect(mockCallApi).toHaveBeenCalledWith("/api/sessions");
  });
});
