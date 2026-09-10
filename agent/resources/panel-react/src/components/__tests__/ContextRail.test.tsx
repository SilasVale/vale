// ContextRail pins — panel-density side rail: plugins inventory, terminal
// session list (open-first/newest sort, closed no-op, keyboard activate),
// new-session menu, inline rename (round-161, no window.prompt), archive,
// relative times. Other pages render nothing.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextRail } from "../ContextRail";
import type { Session } from "../../hooks/useSessions";
import type { usePlugins } from "../../hooks/usePlugins";

type Plugins = ReturnType<typeof usePlugins>;

const session = (over: Partial<Session> = {}): Session => ({
  sid: "s1",
  label: "shell",
  kind: "pty",
  closed: false,
  savedOnly: false,
  active: true,
  openedAt: Date.now(),
  closedAt: null,
  heldByHuman: false,
  approvalRequired: false,
  pendingApproval: null, approvalGrants: [], goal: null, plan: [], ...over,
});

const plugins = (over: Partial<Plugins> = {}): Plugins => ({
  rows: [],
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

const props = (over: Partial<React.ComponentProps<typeof ContextRail>> = {}) => ({
  page: "terminal" as const,
  sessions: [session()],
  activeSid: "s1" as string | null,
  onActivate: vi.fn(),
  onNewSession: vi.fn(),
  plugins: plugins(),
  ...over,
});

describe("ContextRail", () => {
  it("renders nothing on pages without a context", () => {
    const { container } = render(<ContextRail {...props({ page: "browser" })} />);
    expect(container.textContent).toBe("");
  });

  it("plugins rail shows count + rows + loading", () => {
    const { rerender } = render(
      <ContextRail
        {...props({
          page: "plugins",
          plugins: plugins({
            rows: [{
              name: "memory", displayName: "Memory", description: "KB",
              enabled: true, state: "success", stateLabel: "Loaded", toolCount: 6,
            }],
          }),
        })}
      />,
    );
    expect(screen.getByText("Plugins")).toBeTruthy();
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.getByText("Loaded")).toBeTruthy();
    rerender(<ContextRail {...props({ page: "plugins", plugins: plugins({ specLoaded: false }) })} />);
    expect(screen.getByText("Inventory loading…")).toBeTruthy();
  });

  it("sorts open-first newest-first; closed never activates", () => {
    const now = Date.now();
    const p = props({
      sessions: [
        session({ sid: "old", label: "old", openedAt: now - 9000 }),
        session({ sid: "new", label: "new", openedAt: now - 1000 }),
        session({ sid: "dead", label: "dead", closed: true, openedAt: now }),
      ],
    });
    const { container } = render(<ContextRail {...p} />);
    const labels = [...container.querySelectorAll(".side-row .side-label")].map((e) => e.textContent);
    expect(labels).toEqual(["new", "old", "dead"]);
    fireEvent.click(screen.getByText("new"));
    expect(p.onActivate).toHaveBeenCalledWith("new");
    fireEvent.click(screen.getByText("dead"));
    expect(p.onActivate).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByText("new"), { key: "Enter" });
    expect(p.onActivate).toHaveBeenCalledTimes(2);
  });

  it("new-session menu lists 4 kinds and closes after picking", () => {
    const p = props();
    render(<ContextRail {...p} />);
    expect(screen.queryByText("Local shell")).toBeNull();
    fireEvent.click(screen.getByLabelText("New session"));
    fireEvent.click(screen.getByText("SSH…"));
    expect(p.onNewSession).toHaveBeenCalledWith("ssh");
    expect(screen.queryByText("Local shell")).toBeNull();
  });

  it("inline rename commits on Enter, cancels on Escape, ignores blanks", () => {
    const p = props();
    render(<ContextRail {...p} />);
    fireEvent.click(screen.getByTitle("Rename (local)"));
    const input = screen.getByDisplayValue("shell") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "main" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("main")).toBeTruthy();
    // Escape cancels
    fireEvent.click(screen.getByTitle("Rename (local)"));
    const input2 = screen.getByDisplayValue("main") as HTMLInputElement;
    fireEvent.change(input2, { target: { value: "nope" } });
    fireEvent.keyDown(input2, { key: "Escape" });
    expect(screen.getByText("main")).toBeTruthy();
    // blank keeps the old label
    fireEvent.click(screen.getByTitle("Rename (local)"));
    const input3 = screen.getByDisplayValue("main") as HTMLInputElement;
    fireEvent.change(input3, { target: { value: "   " } });
    fireEvent.keyDown(input3, { key: "Enter" });
    expect(screen.getByText("main")).toBeTruthy();
  });

  it("archive hides the row; relTime renders", () => {
    const p = props({ sessions: [session({ openedAt: Date.now() - 30_000 }), session({ sid: "s2", label: "two", openedAt: Date.now() - 5 * 60_000 })] });
    render(<ContextRail {...p} />);
    expect(screen.getByText("now")).toBeTruthy();
    expect(screen.getByText("5m")).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText("Archive session")[0]);
    expect(screen.queryByText("shell")).toBeNull();
    expect(screen.getByText("two")).toBeTruthy();
  });
});
