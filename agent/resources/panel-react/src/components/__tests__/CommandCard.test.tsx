// CommandCard pins — the dsh ToolCallTree-style cards: duration/state
// helpers, auto-expand-while-running with sticky expansion, selection,
// toggle, empty-stream copy, and the clipboard-API fallback for
// non-secure LAN contexts.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { fmtDuration, cardState, CommandCard, CommandStream } from "../CommandCard";
import type { CommandCard as CardData } from "../../hooks/useCommandEvents";

const card = (over: Partial<CardData> = {}): CardData => ({
  id: "c-1",
  seq: 1,
  command: "ls -la",
  output: "total 0",
  startedAt: Math.floor(Date.now() / 1000) - 5,
  ended: false,
  exitCode: null,
  reason: null,
  durationMs: null,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fmtDuration", () => {
  it("formats null/ms/seconds/minutes/hours", () => {
    expect(fmtDuration(null)).toBe("");
    expect(fmtDuration(250)).toBe("250ms");
    expect(fmtDuration(1500)).toBe("1.5s");
    expect(fmtDuration(125_000)).toBe("2m 5s");
    expect(fmtDuration(120_000)).toBe("2m");
    expect(fmtDuration(3_700_000)).toBe("1h 1m");
  });
});

describe("cardState", () => {
  it("maps running/exit/reason to dot state + labels", () => {
    expect(cardState(card())).toEqual({ state: "running", label: "Running", compact: "running" });
    expect(cardState(card({ ended: true, exitCode: 0 }))).toMatchObject({ state: "ok", compact: "0" });
    expect(cardState(card({ ended: true, exitCode: 2 }))).toMatchObject({ state: "fail", compact: "exit 2" });
    expect(cardState(card({ ended: true, reason: "backgrounded" }))).toMatchObject({ state: "warn" });
    expect(cardState(card({ ended: true, reason: "interrupted" }))).toMatchObject({ state: "warn" });
    expect(cardState(card({ ended: true, reason: "closed" }))).toMatchObject({ state: "muted" });
    expect(cardState(card({ ended: true, reason: "mystery" }))).toMatchObject({ state: "muted", compact: "mystery" });
  });
});

describe("CommandCard", () => {
  it("auto-expands a running card and shows live output", () => {
    render(<CommandCard card={card()} selected={false} onSelect={() => {}} />);
    expect(screen.getByText("total 0")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("renders an ended card collapsed; toggle expands it", () => {
    render(<CommandCard card={card({ ended: true, exitCode: 0, output: "done", durationMs: 1500 })} selected={false} onSelect={() => {}} />);
    expect(screen.queryByText("done")).toBeNull();
    expect(screen.getByText("0")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Expand"));
    expect(screen.getByText("done")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Collapse"));
    expect(screen.queryByText("done")).toBeNull();
  });

  it("head click selects; toggle click does not select", () => {
    const onSelect = vi.fn();
    render(<CommandCard card={card({ ended: true, exitCode: 0 })} selected={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByTitle("Show details"));
    expect(onSelect).toHaveBeenCalledWith("c-1");
    onSelect.mockClear();
    fireEvent.click(screen.getByTitle("Expand"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selected card carries the selected class and close-details title", () => {
    const { container } = render(<CommandCard card={card()} selected={true} onSelect={() => {}} />);
    expect(container.querySelector(".cmd-card.selected")).toBeTruthy();
    expect(screen.getByTitle("Close details")).toBeTruthy();
  });

  it("copy button uses the clipboard API and confirms", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CommandCard card={card()} selected={false} onSelect={() => {}} />);
    fireEvent.click(screen.getByTitle("Copy output"));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("total 0");
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("copy button falls back to execCommand without the clipboard API", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn(() => true);
    (document as any).execCommand = execCommand;
    render(<CommandCard card={card()} selected={false} onSelect={() => {}} />);
    fireEvent.click(screen.getByTitle("Copy output"));
    await act(async () => {});
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(screen.getByText("Copied")).toBeTruthy();
    delete (document as any).execCommand;
  });
});

describe("CommandStream", () => {
  it("empty stream shows the hint; count tracks cards", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<CommandStream cards={[]} selectedId={null} onSelect={onSelect} />);
    expect(screen.getByText("Commands run in this session appear here.")).toBeTruthy();
    rerender(<CommandStream cards={[card(), card({ id: "c-2", command: "pwd" })]} selectedId="c-2" onSelect={onSelect} />);
    expect(screen.getByText("2")).toBeTruthy();
    fireEvent.click(screen.getByTitle("pwd"));
    expect(onSelect).toHaveBeenCalledWith("c-2");
  });
});
