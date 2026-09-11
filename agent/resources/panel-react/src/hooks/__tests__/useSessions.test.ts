import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSessions, mapPending, pendingApprovalCount, type Session } from "../useSessions";
import { callTool } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  callTool: vi.fn(),
}));

const mockCallTool = callTool as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockCallTool.mockReset();
  // Default: the 3s poll calls terminal_list — return [] (no sessions) so it
  // does not consume the open/close mock sequences. Tests override per name.
  mockCallTool.mockImplementation((name: string) => {
    if (name === "terminal_list") return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected tool: ${name}`));
  });
});

// Track opened sessions so terminal_list (the 3s poll) reports them as live —
// a [] list would make the poll tombstone sessions opened in the test.
const liveSids = new Set<string>();
function mockOpen(sid: string) {
  liveSids.add(sid);
  mockCallTool.mockImplementation((name: string) => {
    if (name === "terminal_list") return Promise.resolve([...liveSids].map((id) => ({ id, label: id, kind: "pty" })));
    if (name === "terminal_open") return Promise.resolve(sid);
    if (name === "terminal_close") return Promise.resolve({ ok: true });
    return Promise.reject(new Error(`unexpected tool: ${name}`));
  });
}
beforeEach(() => { liveSids.clear(); });

describe("useSessions", () => {
  it("openSession activates the new session (R86: blank terminal fix)", async () => {
    mockOpen("term-1");
    const { result } = renderHook(() => useSessions(true));
    await act(async () => {
      await result.current.openSession("pty", "");
    });
    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0]?.active).toBe(true);
    });
    expect(result.current.activeSid).toBe("term-1");
  });

  it("openSession deactivates previous sessions (R86)", async () => {
    mockOpen("term-1");
    const { result } = renderHook(() => useSessions(true));
    await act(async () => { await result.current.openSession("pty", ""); });
    mockOpen("term-2");
    await act(async () => { await result.current.openSession("pty", ""); });
    await waitFor(() => {
      expect(result.current.sessions.find((s) => s.sid === "term-1")?.active).toBe(false);
      expect(result.current.sessions.find((s) => s.sid === "term-2")?.active).toBe(true);
    });
  });

  it("closeSession switches to the next live session (R86)", async () => {
    mockOpen("term-1");
    const { result } = renderHook(() => useSessions(true));
    await act(async () => { await result.current.openSession("pty", ""); });
    mockOpen("term-2");
    await act(async () => { await result.current.openSession("pty", ""); });
    await act(async () => { await result.current.closeSession("term-2"); });
    await waitFor(() => {
      expect(result.current.sessions.find((s) => s.sid === "term-1")?.active).toBe(true);
      expect(result.current.activeSid).toBe("term-1");
    });
  });

  it("closeSession failure keeps the session open (R83)", async () => {
    mockOpen("term-1");
    const { result } = renderHook(() => useSessions(true));
    await act(async () => { await result.current.openSession("pty", ""); });
    mockCallTool.mockImplementation((name: string) => {
      if (name === "terminal_list") return Promise.resolve([]);
      if (name === "terminal_close") return Promise.reject(new Error("busy"));
      return Promise.reject(new Error(`unexpected tool: ${name}`));
    });
    await act(async () => { await result.current.closeSession("term-1"); });
    await waitFor(() => { expect(result.current.sessions[0]?.closed).toBe(false); });
  });

  it("closing the LAST live session clears active (R88)", async () => {
    mockOpen("term-1");
    const { result } = renderHook(() => useSessions(true));
    await act(async () => { await result.current.openSession("pty", ""); });
    await act(async () => { await result.current.closeSession("term-1"); });
    await waitFor(() => {
      expect(result.current.activeSid).toBe(null);
      expect(result.current.sessions[0]?.active).toBe(false);
    });
  });

  it("sessions-changed event marks server-dead sessions closed and releases focus (R88)", async () => {
    mockOpen("term-1");
    const { result } = renderHook(() => useSessions(true));
    await act(async () => { await result.current.openSession("pty", ""); });
    await waitFor(() => { expect(result.current.sessions[0]?.active).toBe(true); });
    // The server-side session dies (PTY exit) — the agent pushes the
    // sessions-changed SSE event (round-163 replaced the 3s poll with it),
    // terminal_list now returns [] (term-1 gone).
    liveSids.delete("term-1");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("vale-sessions-changed"));
    });
    await waitFor(() => {
      expect(result.current.sessions[0]?.closed).toBe(true);
    });
    expect(result.current.activeSid).toBe(null);
  });

  it("revives a tombstoned session whose sid reappears live (round-245 HIGH-1)", async () => {
    mockOpen("term-1");
    const { result } = renderHook(() => useSessions(true));
    await act(async () => { await result.current.openSession("pty", ""); });
    await waitFor(() => { expect(result.current.sessions[0]?.active).toBe(true); });
    // Server-side death → tombstoned.
    liveSids.delete("term-1");
    await act(async () => { window.dispatchEvent(new CustomEvent("vale-sessions-changed")); });
    await waitFor(() => { expect(result.current.sessions[0]?.closed).toBe(true); });
    // The SAME sid comes back live (agent restarted a re-used session, or a
    // race tombstoned it while it was still open) — the next list must
    // REVIVE it, not keep a dead tab.
    liveSids.add("term-1");
    await act(async () => { window.dispatchEvent(new CustomEvent("vale-sessions-changed")); });
    await waitFor(() => {
      const s = result.current.sessions.find((x) => x.sid === "term-1");
      expect(s?.closed).toBe(false);
    });
    expect(result.current.sessions.filter((x) => x.sid === "term-1")).toHaveLength(1);
  });

  it("retries terminal_list once after a transient failure on sessions-changed (round-245 HIGH-1)", async () => {
    vi.useFakeTimers();
    try {
      liveSids.add("term-ai");
      mockCallTool.mockImplementation((name: string) => {
        if (name === "terminal_open") return Promise.resolve("term-ai");
        return Promise.reject(new Error(`unexpected tool: ${name}`));
      });
      const { result } = renderHook(() => useSessions(true));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      // From now on: the first terminal_list fails (transient), the retry
      // (1.2s later) succeeds and discovers the AI-opened session.
      let listCalls = 0;
      mockCallTool.mockImplementation((name: string) => {
        if (name === "terminal_list") {
          listCalls += 1;
          if (listCalls === 1) return Promise.reject(new Error("tunnel blip"));
          return Promise.resolve([...liveSids].map((id) => ({ id, label: id, kind: "pty" })));
        }
        return Promise.reject(new Error(`unexpected tool: ${name}`));
      });
      await act(async () => {
        window.dispatchEvent(new CustomEvent("vale-sessions-changed"));
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(result.current.sessions.some((s) => s.sid === "term-ai" && !s.closed)).toBe(true);
      expect(listCalls).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("background sweep discovers AI-opened sessions never announced by an event (round-245 HIGH-1)", async () => {
    vi.useFakeTimers();
    try {
      liveSids.add("term-ai-1");
      mockCallTool.mockImplementation((name: string) => {
        if (name === "terminal_list") {
          return Promise.resolve([...liveSids].map((id) => ({ id, label: id, kind: "pty" })));
        }
        return Promise.reject(new Error(`unexpected tool: ${name}`));
      });
      const { result } = renderHook(() => useSessions(true));
      // The AI opens a session while the SSE event was missed entirely.
      liveSids.add("term-ai-2");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(result.current.sessions.some((s) => s.sid === "term-ai-2" && !s.closed)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// The approval deadline is ABSOLUTE.
//
// The device reports `expires_in_ms`: a budget that SHRINKS on every read. The
// panel polls it while the gate is armed (2 s), and the gate's real TTL is
// ~15 minutes. Keeping that shrinking number in React state while the component
// ALSO accumulated its own elapsed time counted every second twice — the
// displayed time fell at about double speed, which against the old 60 s block
// was invisible and against a 15-minute TTL is the difference between "you have
// 8 minutes" and "you have 15".
//
// So the conversion happens exactly once, at the wire edge: `mapPending` turns
// the budget into a wall-clock deadline, and nothing downstream ever adds to it.
// ============================================================================
describe("pending approval — the shrinking budget becomes one absolute deadline", () => {
  it("stores Date.now() + expires_in_ms, not the budget itself", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
      const p = mapPending({
        pending_approval: { id: "g1", command: "reload", expires_in_ms: 900_000 },
      });
      expect(p).not.toBeNull();
      expect(p!.expiresAtMs).toBe(Date.now() + 900_000);
      // ABSOLUTE, not relative. A bare 900_000 fails this by three orders of
      // magnitude, and that relative shape is what the double-count needed.
      expect(p!.expiresAtMs).toBeGreaterThan(1e12);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a re-read reporting a SMALLER budget for the same id does not shorten the deadline by double", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
      const first = mapPending({
        pending_approval: { id: "g1", command: "reload", expires_in_ms: 900_000 },
      })!;
      // 60 s of wall clock later the SAME question reports 60 s less budget.
      vi.setSystemTime(new Date("2026-03-01T10:01:00Z"));
      const second = mapPending({
        pending_approval: { id: "g1", command: "reload", expires_in_ms: 840_000 },
      })!;

      expect(second.expiresAtMs).toBe(first.expiresAtMs);
      // 14 minutes left — not the 13 a double-counting display reaches by
      // subtracting the elapsed minute from the fresh budget as well.
      expect(second.expiresAtMs - Date.now()).toBe(840_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the session carries that deadline, and a poll cannot pull it earlier", async () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-03-01T10:00:00Z").getTime();
      vi.setSystemTime(t0);
      let budget = 900_000;
      mockCallTool.mockImplementation((name: string) => {
        if (name === "terminal_list") {
          return Promise.resolve([
            {
              id: "term-1",
              label: "shell",
              kind: "pty",
              approval_required: true,
              pending_approval: { id: "g1", command: "reload", expires_in_ms: budget },
            },
          ]);
        }
        return Promise.reject(new Error(`unexpected tool: ${name}`));
      });
      const { result } = renderHook(() => useSessions(true));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      const first = result.current.sessions[0]?.pendingApproval;
      expect(first?.expiresAtMs).toBe(t0 + 900_000);

      // A minute of the armed fast-poll, with the device now reporting the
      // SMALLER remaining budget.
      budget = 840_000;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
        window.dispatchEvent(new CustomEvent("vale-sessions-changed"));
        await vi.advanceTimersByTimeAsync(10);
      });

      const second = result.current.sessions[0]?.pendingApproval;
      expect(second?.expiresAtMs).toBe(first?.expiresAtMs);
      // Still ~14 minutes of wall clock left, not 13.
      expect((second?.expiresAtMs ?? 0) - Date.now()).toBeGreaterThan(830_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pendingApprovalCount — the badge input", () => {
  const withPending = (over: Partial<Session> = {}) => ({
    sid: "s1",
    label: "s1",
    kind: "pty",
    closed: false,
    savedOnly: false,
    active: true,
    openedAt: 0,
    closedAt: null,
    heldByHuman: false,
    approvalRequired: false,
    pendingApproval: { id: "g1", command: "reload", expiresAtMs: 1 },
    approvalGrants: [],
    goal: null,
    plan: [],
    ...over,
  });

  it("counts QUESTIONS, never the armed posture", () => {
    // Keying a badge off `approvalRequired` would make every armed session
    // shout forever — an indicator that is always on is one nobody reads.
    expect(pendingApprovalCount([withPending({ approvalRequired: true, pendingApproval: null })])).toBe(0);
    expect(pendingApprovalCount([withPending()])).toBe(1);
    expect(pendingApprovalCount([withPending(), withPending({ sid: "s2" })])).toBe(2);
  });

  it("does not count a closed tombstone's question", () => {
    // A closed session's question is history; the device has retired it.
    expect(pendingApprovalCount([withPending({ closed: true })])).toBe(0);
  });
});
