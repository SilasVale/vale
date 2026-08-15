import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { groupEvents, useCommandEvents } from "../useCommandEvents";
import type { CommandEvent } from "../useCommandEvents";
import { callApi } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  callApi: vi.fn(),
}));

const mockCallApi = callApi as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockCallApi.mockReset();
});

function start(seq: number, command: string, ts = 100): CommandEvent {
  return { seq, ts, kind: "command/start", command };
}
function output(seq: number, text: string, ts = 100): CommandEvent {
  return { seq, ts, kind: "output", text };
}
function end(seq: number, exitCode: number | null, reason: string, durationMs?: number, ts = 105): CommandEvent {
  const ev: CommandEvent = { seq, ts, kind: "command/end", exit_code: exitCode, reason };
  if (durationMs !== undefined) ev.duration_ms = durationMs;
  return ev;
}
function status(seq: number, st: string, ts = 105): CommandEvent {
  return { seq, ts, kind: "status", status: st };
}

describe("groupEvents", () => {
  it("groups command/start → output → command/end into one card", () => {
    const cards = groupEvents([
      start(1, "ls -la"),
      output(2, "total 64\n"),
      output(3, "drwxr-xr-x\n"),
      end(4, 0, "marker", 2100),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "c-1",
      command: "ls -la",
      output: "total 64\ndrwxr-xr-x\n",
      ended: true,
      exitCode: 0,
      reason: "marker",
      durationMs: 2100,
      startedAt: 100,
    });
  });

  it("splits multiple commands into cards in seq order", () => {
    const cards = groupEvents([
      start(1, "echo one"),
      end(2, 0, "marker", 10),
      start(3, "echo two"),
      output(4, "two\n"),
      end(5, 1, "marker", 20),
    ]);
    expect(cards.map((c) => c.command)).toEqual(["echo one", "echo two"]);
    expect(cards[1].exitCode).toBe(1);
    expect(cards[1].output).toBe("two\n");
  });

  it("status backgrounded ends the command (round-99/100 semantics)", () => {
    const cards = groupEvents([
      start(1, "sleep 999"),
      output(2, "started\n"),
      status(3, "backgrounded", 105),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].ended).toBe(true);
    expect(cards[0].exitCode).toBeNull();
    expect(cards[0].reason).toBe("backgrounded");
    // duration derived from the status ts - start ts (seconds → ms)
    expect(cards[0].durationMs).toBe(5000);
  });

  it("status exited:N carries the exit code", () => {
    const cards = groupEvents([
      start(1, "npm test"),
      status(2, "exited:2", 110),
    ]);
    expect(cards[0].ended).toBe(true);
    expect(cards[0].exitCode).toBe(2);
    expect(cards[0].reason).toBe("exited:2");
  });

  it("status closed ends the command without an exit code", () => {
    const cards = groupEvents([
      start(1, "ssh host"),
      status(2, "closed", 108),
    ]);
    expect(cards[0].ended).toBe(true);
    expect(cards[0].exitCode).toBeNull();
    expect(cards[0].reason).toBe("closed");
  });

  it("session-level status (opened) does NOT end a command", () => {
    const cards = groupEvents([
      status(1, "opened"),
      start(2, "echo hi"),
      status(3, "opened"),
      output(4, "hi\n"),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].ended).toBe(false);
  });

  it("a start with no end stays live (running card)", () => {
    const cards = groupEvents([
      start(1, "tail -f /var/log/syslog"),
      output(2, "line1\n"),
      output(3, "line2\n"),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].ended).toBe(false);
    expect(cards[0].exitCode).toBeNull();
    expect(cards[0].output).toBe("line1\nline2\n");
  });

  it("a new start while the previous never ended closes it as interrupted", () => {
    const cards = groupEvents([
      start(1, "hang"),
      output(2, "stuck\n"),
      start(3, "next"),
      end(4, 0, "marker", 5),
    ]);
    expect(cards).toHaveLength(2);
    expect(cards[0].reason).toBe("interrupted");
    expect(cards[0].ended).toBe(true);
    expect(cards[1].command).toBe("next");
  });

  it("orphan output before any start is dropped", () => {
    const cards = groupEvents([output(1, "junk\n")]);
    expect(cards).toHaveLength(0);
  });

  it("caps the accumulated output, keeping the tail", () => {
    const big = "x".repeat(1_200_000);
    const cards = groupEvents([start(1, "dd if=/dev/zero"), output(2, big)]);
    expect(cards[0].output.length).toBeLessThan(1_100_000);
    expect(cards[0].output).toContain("truncated");
    expect(cards[0].output.endsWith("x".repeat(10))).toBe(true);
  });
});

describe("useCommandEvents", () => {
  it("polls the session audit log and groups events", async () => {
    mockCallApi.mockResolvedValue({
      ok: true,
      id: "s1",
      events: [
        start(1, "echo hi"),
        output(2, "hi\n"),
        end(3, 0, "marker", 5),
      ],
    });
    const { result } = renderHook(() => useCommandEvents("s1"));
    await waitFor(() => expect(result.current.cards).toHaveLength(1));
    expect(result.current.cards[0].command).toBe("echo hi");
    expect(mockCallApi).toHaveBeenCalledWith("/api/sessions/s1");
  });

  it("switching sessions resets cards + the seq watermark", async () => {
    // sA's max seq (10) is HIGHER than sB's (2) — without the per-session
    // watermark reset, sB's first poll would be skipped as "nothing new".
    mockCallApi.mockImplementation((path: string) => {
      if (path === "/api/sessions/sA") {
        return Promise.resolve({ ok: true, id: "sA", events: [start(9, "big seq"), end(10, 0, "marker", 5)] });
      }
      if (path === "/api/sessions/sB") {
        return Promise.resolve({ ok: true, id: "sB", events: [start(1, "echo hi"), end(2, 0, "marker", 5)] });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const { result, rerender } = renderHook(({ sid }: { sid: string }) => useCommandEvents(sid, 30), { initialProps: { sid: "sA" } });
    await waitFor(() => expect(result.current.cards[0]?.id).toBe("c-9"));
    rerender({ sid: "sB" });
    await waitFor(() => {
      expect(result.current.cards[0]?.command).toBe("echo hi");
    });
  });

  it("does not poll while sid is null", async () => {
    const { result } = renderHook(() => useCommandEvents(null));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.cards).toEqual([]);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it("a failed poll keeps the last good cards (no blanking)", async () => {
    // Persistent base mock (the audit log keeps answering) with ONE transient
    // rejection in the middle — the fast 30ms poll must ride through it.
    mockCallApi.mockResolvedValue({
      ok: true,
      id: "s1",
      events: [start(1, "echo hi"), end(2, 0, "marker", 5)],
    });
    const { result } = renderHook(() => useCommandEvents("s1", 30));
    await waitFor(() => expect(result.current.cards).toHaveLength(1));
    mockCallApi.mockRejectedValueOnce(new Error("HTTP 502"));
    await new Promise((r) => setTimeout(r, 80));
    expect(result.current.cards).toHaveLength(1);
    expect(result.current.cards[0].command).toBe("echo hi");
  });
});
