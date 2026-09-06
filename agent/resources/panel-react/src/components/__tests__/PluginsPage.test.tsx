// PluginsPage pins — searchable catalog: filtered count pill (round-161),
// loading/empty states, tool-count singular/plural (stage-n), enabled
// pills, playwright control card (disabled logic, busy labels, ports),
// verbatim error log lines.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PluginsPage } from "../PluginsPage";
import type { usePlugins } from "../../hooks/usePlugins";

type Plugins = ReturnType<typeof usePlugins>;

const row = (over: Partial<Plugins["rows"][number]> = {}): Plugins["rows"][number] => ({
  name: "terminal",
  displayName: "Terminal",
  description: "PTY/SSH/serial sessions",
  enabled: true,
  state: "success",
  stateLabel: "Loaded",
  toolCount: 25,
  ...over,
});

const plugins = (over: Partial<Plugins> = {}): Plugins => ({
  rows: [row()],
  specLoaded: true,
  loadError: "",
  busy: null,
  log: [],
  start: vi.fn(),
  stop: vi.fn(),
  playwright: null,
  playwrightRow: null,
  ...over,
});

describe("PluginsPage", () => {
  it("loading state before the spec arrives", () => {
    render(<PluginsPage plugins={plugins({ specLoaded: false, rows: [] })} />);
    expect(screen.getByText("Loading inventory…")).toBeTruthy();
  });

  it("search filters rows AND the count pill (round-161)", () => {
    render(
      <PluginsPage
        plugins={plugins({ rows: [row(), row({ name: "memory", displayName: "Memory", description: "KB" })] })}
      />,
    );
    expect(screen.getByText("2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search plugins"), { target: { value: "mem" } });
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search plugins"), { target: { value: "zzz" } });
    expect(screen.getByText("No plugins match “zzz”")).toBeTruthy();
  });

  it("tool-count singular/plural + enabled pill", () => {
    render(
      <PluginsPage
        plugins={plugins({ rows: [row({ toolCount: 1 }), row({ name: "x", displayName: "X", description: "", toolCount: 2, enabled: false })] })}
      />,
    );
    expect(screen.getByText("1 tool")).toBeTruthy();
    expect(screen.getByText("2 tools")).toBeTruthy();
    expect(screen.getAllByText("Enabled")).toHaveLength(1);
  });

  it("load error surfaces", () => {
    render(<PluginsPage plugins={plugins({ loadError: "boom" })} />);
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("playwright card: pending muted, stopped enables Start, running enables Stop + port", () => {
    const stopped = plugins({
      playwrightRow: {
        name: "playwright", displayName: "Playwright", description: "",
        enabled: true, state: "warn", stateLabel: "Stopped", playwright: { running: false },
      },
    });
    const { rerender } = render(<PluginsPage plugins={plugins({ playwrightRow: null })} />);
    expect(screen.getByText("bundled playwright-mcp · Chromium (task-hosted)")).toBeTruthy();
    expect(screen.getByText("Start").closest("button")!.disabled).toBe(true);
    rerender(<PluginsPage plugins={stopped} />);
    expect(screen.getByText("Start").closest("button")!.disabled).toBe(false);
    fireEvent.click(screen.getByText("Start"));
    expect(stopped.start).toHaveBeenCalledTimes(1);
    rerender(
      <PluginsPage
        plugins={plugins({
          playwrightRow: {
            name: "playwright", displayName: "Playwright", description: "",
            enabled: true, state: "ongoing", stateLabel: "Running",
            playwright: { running: true, port: 9229, started_at: Date.now() - 65_000 },
          },
        })}
      />,
    );
    expect(screen.getByText(/port 9229 · up 1m/)).toBeTruthy();
    const stop = screen.getByText("Stop").closest("button")!;
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
  });

  it("busy labels + log lines with verbatim errors", () => {
    const { rerender } = render(<PluginsPage plugins={plugins({ busy: "start" })} />);
    expect(screen.getByText("Starting…")).toBeTruthy();
    rerender(
      <PluginsPage
        plugins={plugins({
          busy: null,
          log: [
            { ts: "t1", text: "started ok", error: false },
            { ts: "t2", text: "spawn ENOENT", error: true },
          ],
        })}
      />,
    );
    expect(screen.getByText("spawn ENOENT")).toBeTruthy();
    expect(screen.getByText("spawn ENOENT").closest("p")!.className).toContain("error");
  });
});
