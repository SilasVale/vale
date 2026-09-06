// ErrorBoundary pins — the round-161 white-panel fix: a crashing page must
// show the reload card (with the real message), never unmount the tree;
// the reload button resets state AND reloads (sessions live in the agent
// service, so reloading is always safe).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";

function Boom({ message }: { message?: string }) {
  throw new Error(message);
  return null;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <span>healthy page</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy page")).toBeTruthy();
    expect(screen.queryByText("Reload panel")).toBeNull();
  });

  it("shows the crash card with the error message", () => {
    render(
      <ErrorBoundary>
        <Boom message="kaboom" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something broke")).toBeTruthy();
    expect(screen.getByText("kaboom")).toBeTruthy();
    expect(screen.queryByText("healthy page")).toBeNull();
  });

  it("falls back to Render error for empty messages", () => {
    render(
      <ErrorBoundary>
        <Boom message="" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Render error")).toBeTruthy();
  });

  it("reload button resets state and reloads the page", () => {
    // In prod location.reload() remounts everything fresh; the mock stands
    // in for the remount by clearing the failure condition, so the reset
    // render the button triggers must show the recovered tree. (Found
    // while writing this: React retries a once-throwing mount before the
    // fallback commits — a transient first-render throw self-heals with no
    // crash card; the boundary only trips on a PERSISTENT throw.)
    let fail = true;
    const MaybeBoom = () => {
      if (fail) throw new Error("once");
      return <span>recovered</span>;
    };
    const reload = vi.fn(() => {
      fail = false;
    });
    vi.stubGlobal("location", { reload });
    render(
      <ErrorBoundary>
        <MaybeBoom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something broke")).toBeTruthy();
    fireEvent.click(screen.getByText("Reload panel"));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText("recovered")).toBeTruthy();
  });
});
