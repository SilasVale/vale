import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSessions } from "../useSessions";
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
