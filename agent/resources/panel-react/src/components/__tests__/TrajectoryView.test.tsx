import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TrajectoryView } from "../TrajectoryView";
import { callApi } from "../../lib/api";
import type { CommandEvent } from "../../hooks/useCommandEvents";

vi.mock("../../lib/api", () => ({
  callApi: vi.fn(),
}));

const mockCallApi = callApi as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockCallApi.mockReset();
});

function start(seq: number, command: string): CommandEvent {
  return { seq, ts: 100, kind: "command/start", command };
}
function output(seq: number, text: string): CommandEvent {
  return { seq, ts: 101, kind: "output", text };
}
function end(seq: number, exitCode: number, reason: string): CommandEvent {
  return { seq, ts: 102, kind: "command/end", exit_code: exitCode, reason };
}

function mockSession(events: CommandEvent[]) {
  mockCallApi.mockResolvedValue({ ok: true, id: "s1", events });
  return events;
}

// Output rows carry trailing newlines — testing-library's string matcher
// compares RAW (not normalized) against the normalized element text, so use
// regex matchers for output content.

describe("TrajectoryView", () => {
  it("renders rounds with the newest expanded and session status rows", async () => {
    const evs = mockSession([
      { seq: 1, ts: 100, kind: "status", status: "opened" },
      start(2, "echo one"),
      output(3, "OUT-ONE\n"),
      end(4, 0, "marker"),
      start(5, "echo two"),
      output(6, "OUT-TWO\n"),
    ]);
    render(<TrajectoryView events={evs} />);
    // Round headers always render; the preamble round holds the raw
    // session-level "opened" status.
    await waitFor(() => expect(screen.getByText("echo one")).toBeTruthy());
    expect(screen.getByText("echo two")).toBeTruthy();
    expect(screen.getByText("(session)")).toBeTruthy();
    // Only the newest round is expanded by default — its output row visible,
    // the older round's output collapsed.
    expect(screen.getByText(/OUT-TWO/)).toBeTruthy();
    expect(screen.queryByText(/OUT-ONE/)).toBeNull();
    // Expanding the preamble reveals its raw status row (text-only).
    fireEvent.click(screen.getByText("(session)"));
    await waitFor(() => expect(screen.getByText("opened")).toBeTruthy());
  });

  it("search filters to matching rounds and rows (text-only)", async () => {
    const evs = mockSession([
      start(1, "ping apple.com"),
      output(2, "PING apple.com (17.1.1.1)…\n"),
      end(3, 0, "marker"),
      start(4, "cat banana.txt"),
      output(5, "banana content\n"),
      end(6, 0, "marker"),
    ]);
    render(<TrajectoryView events={evs} />);
    await waitFor(() => expect(screen.getByText("ping apple.com")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("Filter output…"), { target: { value: "banana" } });
    await waitFor(() => expect(screen.queryByText("ping apple.com")).toBeNull());
    expect(screen.getByText("cat banana.txt")).toBeTruthy();
    expect(screen.getByText(/banana content/)).toBeTruthy();
    // The non-matching round's rows are filtered out of its round too.
    fireEvent.change(screen.getByPlaceholderText("Filter output…"), { target: { value: "PING" } });
    await waitFor(() => expect(screen.getByText("ping apple.com")).toBeTruthy());
    expect(screen.queryByText(/banana content/)).toBeNull();
    // Clearing restores everything.
    fireEvent.change(screen.getByPlaceholderText("Filter output…"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("cat banana.txt")).toBeTruthy());
  });

  it("collapse all folds every round; a round head toggles it back", async () => {
    const evs = mockSession([
      start(1, "echo one"),
      output(2, "OUT-ONE\n"),
      end(3, 0, "marker"),
      start(4, "echo two"),
      output(5, "OUT-TWO\n"),
      end(6, 0, "marker"),
    ]);
    render(<TrajectoryView events={evs} />);
    await waitFor(() => expect(screen.getByText(/OUT-TWO/)).toBeTruthy());
    fireEvent.click(screen.getByText("Collapse all"));
    await waitFor(() => expect(screen.queryByText(/OUT-TWO/)).toBeNull());
    // Round head (role=button) expands a round again.
    fireEvent.click(screen.getByText("echo two"));
    await waitFor(() => expect(screen.getByText(/OUT-TWO/)).toBeTruthy());
  });

  it("load earlier reveals older rounds beyond the default window", async () => {
    const events: CommandEvent[] = [];
    for (let i = 0; i < 25; i++) {
      events.push(start(i * 2 + 1, `cmd ${i}`));
      events.push(output(i * 2 + 2, `OUT-${i}\n`));
    }
    mockSession(events);
    render(<TrajectoryView events={events} />);
    await waitFor(() => expect(screen.getByText("cmd 24")).toBeTruthy());
    // Oldest round is outside the 20-round window.
    expect(screen.queryByText("cmd 0")).toBeNull();
    const btn = screen.getByRole("button", { name: /Load earlier/ });
    expect(btn.textContent).toContain("5 more rounds");
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText("cmd 0")).toBeTruthy());
    // Window now covers everything — the button disappears.
    expect(screen.queryByRole("button", { name: /Load earlier/ })).toBeNull();
  });

  it("shows the empty state before any events arrive", async () => {
    const evs = mockSession([]);
    render(<TrajectoryView events={evs} />);
    await waitFor(() => expect(screen.getByText("No commands in this session yet.")).toBeTruthy());
  });
});
