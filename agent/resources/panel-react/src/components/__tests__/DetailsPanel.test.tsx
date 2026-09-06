// DetailsPanel pins — the single-call inspector: empty hint when nothing
// selected, command/meta/params/output rows for a card, close wiring,
// em-dash placeholders for missing exit/reason/duration.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DetailsPanel } from "../DetailsPanel";
import type { CommandCard as CardData } from "../../hooks/useCommandEvents";

const card = (over: Partial<CardData> = {}): CardData => ({
  id: "c-7",
  seq: 7,
  command: "npm test",
  output: "ok 1",
  startedAt: 1_700_000_000,
  ended: true,
  exitCode: 0,
  reason: null,
  durationMs: 1500,
  ...over,
});

describe("DetailsPanel", () => {
  it("no selection → hint; close button notifies", () => {
    const onClose = vi.fn();
    render(<DetailsPanel card={null} onClose={onClose} />);
    expect(screen.getByText("Select a command card to inspect its parameters, output, and exit code.")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Close details"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ended card shows command, status, exit, duration, params, output", () => {
    render(<DetailsPanel card={card()} onClose={() => {}} />);
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText("Success (exit 0)")).toBeTruthy();
    expect(screen.getByText("1.5s")).toBeTruthy();
    expect(screen.getByText('"npm test"')).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("ok 1")).toBeTruthy();
    expect(screen.getByTitle("Copy output")).toBeTruthy();
  });

  it("running card shows Running + em-dash placeholders", () => {
    render(<DetailsPanel card={card({ ended: false, exitCode: null })} onClose={() => {}} />);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("failed card surfaces exit code and reason", () => {
    render(<DetailsPanel card={card({ exitCode: 3, reason: "exited:3" })} onClose={() => {}} />);
    expect(screen.getByText("Failed (exit 3)")).toBeTruthy();
    expect(screen.getByText("exited:3")).toBeTruthy();
  });
});
