import { describe, it, expect } from "vitest";
import { adoptNeedsAnotherPage, adoptPageExceeded, MAX_ADOPT_PAGES, splitWriteSlices, WRITE_SLICE_CHARS } from "../terminalAdopt";

// round-246 (terminal-display audit HIGH-3): the adopt-read paging decision.
// A single terminal_read is capped at 1 MiB; these tests pin WHEN the panel
// must chain another read so a big AI session's head is never dropped.
describe("adoptNeedsAnotherPage", () => {
  it("pages when the server end cursor is ahead of rendered (truncated read)", () => {
    // Read returned bytes [0, 1MiB); rendered advanced to 1MiB; end says
    // the buffer holds more → next page needed.
    expect(adoptNeedsAnotherPage({ start: 0, end: 2 * 1024 * 1024, raw: "x" }, 1024 * 1024, true)).toBe(true);
  });

  it("stops when end equals rendered (single read covered everything)", () => {
    expect(adoptNeedsAnotherPage({ start: 0, end: 500, raw: "x" }, 500, true)).toBe(false);
  });

  it("stops when the response advanced nothing (SSE already delivered it)", () => {
    // rendered moved past the response during the await (SSE frames) —
    // advanced=false means we wrote nothing; no point re-reading.
    expect(adoptNeedsAnotherPage({ start: 0, end: 2000, raw: "x" }, 2000, false)).toBe(false);
  });

  it("stops on evicted (server reset — caller zeroes the cursor)", () => {
    expect(adoptNeedsAnotherPage({ evicted: true, start: 0, end: 999 }, 0, true)).toBe(false);
  });

  it("stops on a legacy response without an end cursor", () => {
    expect(adoptNeedsAnotherPage({ start: 0, raw: "x" }, 10, true)).toBe(false);
  });

  it("stops on null/empty responses (end of buffer)", () => {
    expect(adoptNeedsAnotherPage(null, 0, false)).toBe(false);
    expect(adoptNeedsAnotherPage(undefined, 0, false)).toBe(false);
  });

  it("handles string cursors (JSON numbers can arrive as strings)", () => {
    expect(adoptNeedsAnotherPage({ start: "0", end: "2048" }, 1024, true)).toBe(true);
    expect(adoptNeedsAnotherPage({ start: "0", end: "1024" }, 1024, true)).toBe(false);
  });
});

describe("adoptPageExceeded", () => {
  it("allows up to MAX_ADOPT_PAGES chained reads", () => {
    expect(adoptPageExceeded(MAX_ADOPT_PAGES)).toBe(false);
    expect(adoptPageExceeded(MAX_ADOPT_PAGES + 1)).toBe(true);
  });
});

describe("splitWriteSlices (P1-4 backpressure)", () => {
  it("returns small payloads as a single slice", () => {
    expect(splitWriteSlices("hello")).toEqual(["hello"]);
  });

  it("splits large payloads at the slice bound without losing bytes", () => {
    const text = "ab".repeat(100 * 1024); // 200 KiB
    const slices = splitWriteSlices(text);
    expect(slices.length).toBe(Math.ceil(text.length / WRITE_SLICE_CHARS));
    expect(slices.join("")).toBe(text);
    for (const s of slices.slice(0, -1)) expect(s.length).toBe(WRITE_SLICE_CHARS);
  });

  it("returns [] for empty input", () => {
    expect(splitWriteSlices("")).toEqual([]);
  });
});
