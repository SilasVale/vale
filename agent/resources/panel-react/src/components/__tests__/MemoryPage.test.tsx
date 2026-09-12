// MemoryPage pins — the device knowledge UI over memory_* tools: initial
// list load, search (tag passed too — round-161 fix), two-step delete,
// inline edit + create (stage-n), export + copy, error surfacing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryPage } from "../MemoryPage";
import { callTool } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  callTool: vi.fn(),
}));

const entry = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  title: "Deploy notes",
  content: "restart after update",
  tags: ["ops"],
  namespace: "runbook",
  source: "ai",
  created_at: 1_700_000_000,
  updated_at: 1_700_000_100,
  ...over,
});

beforeEach(() => {
  vi.mocked(callTool).mockReset();
  vi.mocked(callTool).mockResolvedValue({ results: [entry()] });
});

describe("MemoryPage", () => {
  it("loads the list on mount and renders entries", async () => {
    render(<MemoryPage />);
    expect(await screen.findByText("Deploy notes")).toBeTruthy();
    expect(callTool).toHaveBeenCalledWith(
      "memory_list",
      expect.objectContaining({ limit: 50 }),
    );
    expect(screen.getByText("ops")).toBeTruthy();
  });

  it("search passes query+tag; empty query falls back to list", async () => {
    vi.mocked(callTool).mockResolvedValue({ results: [] });
    render(<MemoryPage />);
    await screen.findByText(
      "No memory entries yet — use + New, or let AI clients save knowledge via memory_save.",
    );
    fireEvent.change(
      screen.getByPlaceholderText("Search title/content/tags… (Enter)"),
      { target: { value: "deploy" } },
    );
    fireEvent.change(screen.getByPlaceholderText("tag"), {
      target: { value: "ops" },
    });
    fireEvent.click(screen.getByText("Search"));
    await waitFor(() =>
      expect(callTool).toHaveBeenCalledWith(
        "memory_search",
        expect.objectContaining({ query: "deploy", tag: "ops" }),
      ),
    );
    fireEvent.change(
      screen.getByPlaceholderText("Search title/content/tags… (Enter)"),
      { target: { value: "  " } },
    );
    fireEvent.click(screen.getByText("Search"));
    await waitFor(() =>
      expect(callTool).toHaveBeenCalledWith("memory_list", expect.anything()),
    );
  });

  it("two-step delete calls memory_delete and toasts", async () => {
    render(<MemoryPage />);
    await screen.findByText("Deploy notes");
    fireEvent.click(screen.getByTitle("Delete entry"));
    expect(screen.getByText("delete?")).toBeTruthy();
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() =>
      expect(callTool).toHaveBeenCalledWith("memory_delete", { id: "m1" }),
    );
    expect(await screen.findByText("deleted")).toBeTruthy();
  });

  it("inline edit prefills and saves via memory_update", async () => {
    render(<MemoryPage />);
    await screen.findByText("Deploy notes");
    fireEvent.click(screen.getByTitle("Edit entry"));
    expect(screen.getByDisplayValue("Deploy notes")).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("restart after update"), {
      target: { value: "new body" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(callTool).toHaveBeenCalledWith(
        "memory_update",
        expect.objectContaining({ id: "m1", content: "new body" }),
      ),
    );
    expect(await screen.findByText("saved")).toBeTruthy();
  });

  it("create requires title+content, then calls memory_save", async () => {
    render(<MemoryPage />);
    await screen.findByText("Deploy notes");
    fireEvent.click(screen.getByText("+ New"));
    fireEvent.click(screen.getByText("Create"));
    expect(
      await screen.findByText("title and content are required"),
    ).toBeTruthy();
    expect(callTool).not.toHaveBeenCalledWith("memory_save", expect.anything());
    fireEvent.change(screen.getByPlaceholderText("Title (required)"), {
      target: { value: "T" },
    });
    fireEvent.change(screen.getByPlaceholderText("Content (required)"), {
      target: { value: "C" },
    });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() =>
      expect(callTool).toHaveBeenCalledWith(
        "memory_save",
        expect.objectContaining({ title: "T", content: "C" }),
      ),
    );
  });

  it("export shows text with line count; copy toasts", async () => {
    vi.mocked(callTool).mockImplementation(async (tool: string) => {
      if (tool === "memory_export") return { export: "a\nb" };
      return { results: [entry()] };
    });
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
    render(<MemoryPage />);
    await screen.findByText("Deploy notes");
    fireEvent.click(screen.getByText("Export"));
    expect(await screen.findByText("Export (2 lines)")).toBeTruthy();
    fireEvent.click(screen.getByText("Copy"));
    expect(await screen.findByText("export copied")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("backend failure surfaces as an error", async () => {
    vi.mocked(callTool).mockRejectedValue(new Error("device down"));
    render(<MemoryPage />);
    expect(await screen.findByText("device down")).toBeTruthy();
  });
});
