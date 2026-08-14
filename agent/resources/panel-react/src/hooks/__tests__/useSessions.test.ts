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

  it("poll marks server-dead sessions closed and releases focus (R88)", async () => {
    mockOpen("term-1");
    const { result } = renderHook(() => useSessions(true));
    await act(async () => { await result.current.openSession("pty", ""); });
    await waitFor(() => { expect(result.current.sessions[0]?.active).toBe(true); });
    // The server-side session dies (PTY exit) — the poll's terminal_list now
    // returns [] (term-1 gone).
    liveSids.delete("term-1");
    await waitFor(() => {
      expect(result.current.sessions[0]?.closed).toBe(true);
    }, { timeout: 5000 });
    expect(result.current.activeSid).toBe(null);
  });
});
