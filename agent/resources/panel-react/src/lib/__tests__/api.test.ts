import { describe, it, expect, vi, beforeEach } from "vitest";
import { callApi, callTool, initTransport } from "../api";

describe("callApi", () => {
  beforeEach(() => {
    initTransport("d1.test", "tok", () => {});
    vi.restoreAllMocks();
  });

  it("throws on non-2xx (R86: 502/500 must not be treated as success)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 502 }));
    await expect(callApi("/api/status")).rejects.toThrow("HTTP 502");
  });

  it("throws on 401 and calls onUnauthorized", async () => {
    let unauthorized = false;
    initTransport("d1.test", "tok", () => { unauthorized = true; });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(callApi("/api/status")).rejects.toThrow("unauthorized");
    expect(unauthorized).toBe(true);
  });

  it("parses JSON on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const j = await callApi("/api/status");
    expect(j).toEqual({ ok: true });
  });

  it("callTool unwraps result and throws on ok:false", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"ok":false,"error":"session not found"}', { status: 200 }));
    await expect(callTool("terminal_list", {})).rejects.toThrow("session not found");
  });

  it("callTool returns result on ok:true", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true,"result":[1,2]}', { status: 200 }));
    const r = await callTool("terminal_list", {});
    expect(r).toEqual([1, 2]);
  });
});
