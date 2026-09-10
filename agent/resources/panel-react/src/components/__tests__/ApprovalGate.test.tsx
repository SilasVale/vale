// ApprovalGate — the operator's half of the gate (design beat 3).
//
// What these pin is the part that decides whether a command runs:
//
//   * the operator sees the command they are authorising, IN FULL. A truncated
//     prompt asks someone to consent to something they cannot read, which is the
//     failure mode that makes an approval gate theatre;
//   * the two answers are distinct and neither is the default — an unanswered
//     request must never look like a "yes";
//   * a failed call does not look like it worked, in either direction: an arm
//     that did not take tells the operator the gate is on while commands run,
//     and a decision that did not land leaves them believing they answered;
//   * expiry is visible and its meaning is stated, because "nothing happened"
//     and "your click was lost" are otherwise indistinguishable.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ApprovalGate, firstWord } from "../ApprovalGate";

const pending = (over: Partial<{ id: string; command: string; expiresInMs: number }> = {}) => ({
  id: "ap-1",
  command: "vlan 100",
  expiresInMs: 60_000,
  ...over,
});

/** Every prop the gate needs, with inert defaults. A builder rather than
 *  inline literals so a future required prop is one edit, not eleven. */
const gateProps = (over: Partial<React.ComponentProps<typeof ApprovalGate>> = {}) => ({
  armed: false,
  pending: null,
  grants: [] as string[],
  onArm: vi.fn(() => Promise.resolve(true)),
  onDecide: vi.fn(() => Promise.resolve(true)),
  onRevoke: vi.fn(() => Promise.resolve([])),
  ...over,
});

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe("ApprovalGate — armed toggle", () => {
  it("arms when it is off, and disarms when it is on", async () => {
    const onArm = vi.fn(() => Promise.resolve(true));
    const { rerender } = render(
      <ApprovalGate {...gateProps({ onArm })} />,
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onArm).toHaveBeenCalledWith(true));

    rerender(<ApprovalGate {...gateProps({ armed: true, onArm })} />);
    fireEvent.click(screen.getByText("Asking first"));
    await waitFor(() => expect(onArm).toHaveBeenCalledWith(false));
  });

  it("says what arming MEANS, not what the button does", () => {
    render(<ApprovalGate {...gateProps()} />);
    // The consequence is the part an operator needs before clicking.
    expect(screen.getByRole("button").getAttribute("title")).toMatch(/without asking/i);
  });

  it("does NOT look armed when the call fails", async () => {
    // The dangerous direction: claiming the gate is on while the agent runs
    // commands unattended.
    const onArm = vi.fn(() => Promise.reject(new Error("HTTP 400")));
    render(<ApprovalGate {...gateProps({ onArm })} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onArm).toHaveBeenCalled());
    // Still offering to arm, because the server never confirmed.
    expect(screen.getByText("Ask before each command")).toBeTruthy();
    expect(screen.queryByText("Asking first")).toBeNull();
  });

  it("marks armed with a SHAPE, not only a colour", () => {
    const { container, rerender } = render(
      <ApprovalGate {...gateProps()} />,
    );
    const dot = () => container.querySelector(".ag-dot")!;
    expect(dot().getAttribute("data-state")).toBe("off");
    rerender(<ApprovalGate {...gateProps({ armed: true })} />);
    expect(dot().getAttribute("data-state")).toBe("armed");
  });
});

describe("ApprovalGate — a command waiting", () => {
  it("shows the command IN FULL, however long", () => {
    const long = "display current-configuration | include vlan | include port | include description";
    render(<ApprovalGate {...gateProps({ armed: true, pending: pending({ command: long }) })} />);
    // Rendered as a single node with the whole text: no ellipsis, no slice.
    const el = document.querySelector(".approval-cmd")!;
    expect(el.textContent).toBe(long);
  });

  it("offers both answers, and sends the right one", async () => {
    const onDecide = vi.fn(() => Promise.resolve(true));
    render(<ApprovalGate {...gateProps({ armed: true, pending: pending(), onDecide })} />);

    fireEvent.click(screen.getByText("Run it"));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap-1", true));

    onDecide.mockClear();
    fireEvent.click(screen.getByText("Refuse"));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap-1", false));
  });

  it("sends the id it was given, so the answer binds to the command shown", async () => {
    const onDecide = vi.fn(() => Promise.resolve(true));
    render(
      <ApprovalGate {...gateProps({ armed: true, pending: pending({ id: "ap-42", command: "save" }), onDecide })} />,
    );
    fireEvent.click(screen.getByText("Run it"));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap-42", true));
  });

  it("counts down, and says what expiry DOES", async () => {
    render(
      <ApprovalGate {...gateProps({ armed: true, pending: pending({ expiresInMs: 10_000 }) })} />,
    );
    expect(screen.getByText("10s")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("7s")).toBeTruthy();
    // The consequence of running out is stated, because a fail-closed expiry is
    // otherwise indistinguishable from a lost click.
    expect(document.querySelector(".approval-note")!.textContent).toMatch(/not\s+run/i);
  });

  it("restarts the countdown for a NEW request", async () => {
    // Without the id in the effect deps a second request inherits the first's
    // elapsed time and appears to expire early — which is exactly when an
    // operator would give up on a prompt that was still live.
    const { rerender } = render(
      <ApprovalGate {...gateProps({ armed: true, pending: pending({ id: "a", expiresInMs: 60_000 }) })} />,
    );
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("55s")).toBeTruthy();

    rerender(
      <ApprovalGate {...gateProps({ armed: true, pending: pending({ id: "b", expiresInMs: 60_000 }) })} />,
    );
    expect(screen.getByText("60s")).toBeTruthy();
  });

  it("shows the prompt INSTEAD of the toggle — one thing to act on", () => {
    render(<ApprovalGate {...gateProps({ armed: true, pending: pending() })} />);
    expect(screen.queryByText("Asking first")).toBeNull();
    expect(screen.queryByText("Ask before each command")).toBeNull();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("keeps the prompt visible when a decision call fails", async () => {
    // The request is still waiting on the agent; hiding it would strand the
    // command with nothing on screen to answer.
    const onDecide = vi.fn(() => Promise.reject(new Error("HTTP 500")));
    render(<ApprovalGate {...gateProps({ armed: true, pending: pending(), onDecide })} />);
    fireEvent.click(screen.getByText("Run it"));
    await waitFor(() => expect(onDecide).toHaveBeenCalled());
    expect(document.querySelector(".approval-prompt")).not.toBeNull();
  });
});

describe("ApprovalGate — grants", () => {
  it("names the WORD a grant would cover, not just \"remember this\"", () => {
    // The breadth is the operator's consent, so it has to be readable.
    render(<ApprovalGate {...gateProps({ armed: true, pending: pending({ command: "display version" }) })} />);
    const btn = screen.getByText(/Always allow/);
    expect(btn.textContent).toContain("display");
    expect(btn.getAttribute("title")).toMatch(/every "display" command/i);
  });

  it("asks the server to remember, and does not send a prefix of its own", async () => {
    // The prefix is derived SERVER-side from the shown command; the client only
    // says "and remember this". A client that sent its own word could widen its
    // own permissions.
    const onDecide = vi.fn(() => Promise.resolve(true));
    render(<ApprovalGate {...gateProps({ armed: true, pending: pending(), onDecide })} />);
    fireEvent.click(screen.getByText(/Always allow/));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap-1", true, true));
  });

  it("does NOT offer a grant for a command it cannot safely remember", () => {
    // A chained command has no honest word to grant. Offering the button would
    // imply otherwise — and the server would refuse to derive one anyway.
    render(
      <ApprovalGate
        {...gateProps({ armed: true, pending: pending({ command: "display version && rm -rf /" }) })}
      />,
    );
    expect(screen.queryByText(/Always allow/)).toBeNull();
    // The command is still shown in full, and the plain answers still exist.
    expect(document.querySelector(".approval-cmd")!.textContent).toBe("display version && rm -rf /");
    expect(screen.getByText("Run it")).toBeTruthy();
  });

  it("lists the grants in force and revokes one by name", async () => {
    const onRevoke = vi.fn(() => Promise.resolve([]));
    render(<ApprovalGate {...gateProps({ armed: true, grants: ["display", "show"], onRevoke })} />);
    expect(screen.getByText("display")).toBeTruthy();
    expect(screen.getByText("show")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Stop allowing display"));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledWith("display"));
  });

  it("shows no grant list when the gate is off", () => {
    // Grants are cleared server-side on disarm; showing stale ones here would
    // claim permissions that no longer exist.
    render(<ApprovalGate {...gateProps({ armed: false, grants: ["display"] })} />);
    expect(screen.queryByText("display")).toBeNull();
  });

  it("mirrors the server's metacharacter rule", () => {
    // The client copy is used only to decide what to OFFER, so a divergence can
    // mislabel or hide a control — it cannot widen a permission. Still pinned,
    // because a divergence would show an "Always allow" button that the server
    // then refuses to honour.
    for (const cmd of ["display version", "show gpon onu state", "ls -la /var/log"]) {
      expect(firstWord(cmd)).toBeTruthy();
    }
    for (const cmd of [
      "display version && rm -rf /",
      "display version; rm -rf /",
      "display $(id)",
      "display version | sh",
      "display version > /etc/hosts",
      "display *",
    ]) {
      expect(firstWord(cmd), `${cmd} must not be offered a grant`).toBeNull();
    }
  });
});
