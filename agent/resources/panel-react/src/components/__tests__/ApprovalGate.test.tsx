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
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { ApprovalGate, firstWord } from "../ApprovalGate";
import { mapPending } from "../../hooks/useSessions";

/** A question whose deadline is `expiresInMs` from NOW.
 *
 *  The component's shape is ABSOLUTE (`expiresAtMs`) because the device reports
 *  a budget that SHRINKS on every read; the fixtures state a budget and let the
 *  clock place it, exactly as `mapPending` does at the wire edge. */
const pending = (
  over: Partial<{
    id: string;
    command: string;
    expiresInMs: number;
    expiresAtMs: number;
  }> = {},
) => {
  const { expiresInMs = 60_000, ...rest } = over;
  return {
    id: "ap-1",
    command: "vlan 100",
    expiresAtMs: Date.now() + expiresInMs,
    ...rest,
  };
};

/** Every prop the gate needs, with inert defaults. A builder rather than
 *  inline literals so a future required prop is one edit, not eleven. */
const gateProps = (
  over: Partial<React.ComponentProps<typeof ApprovalGate>> = {},
) => ({
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
    const { rerender } = render(<ApprovalGate {...gateProps({ onArm })} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onArm).toHaveBeenCalledWith(true));

    rerender(<ApprovalGate {...gateProps({ armed: true, onArm })} />);
    fireEvent.click(screen.getByText("Asking first"));
    await waitFor(() => expect(onArm).toHaveBeenCalledWith(false));
  });

  it("says what arming MEANS, not what the button does", () => {
    render(<ApprovalGate {...gateProps()} />);
    // The consequence is the part an operator needs before clicking.
    expect(screen.getByRole("button").getAttribute("title")).toMatch(
      /without asking/i,
    );
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
    const { container, rerender } = render(<ApprovalGate {...gateProps()} />);
    const dot = () => container.querySelector(".ag-dot")!;
    expect(dot().getAttribute("data-state")).toBe("off");
    rerender(<ApprovalGate {...gateProps({ armed: true })} />);
    expect(dot().getAttribute("data-state")).toBe("armed");
  });
});

describe("ApprovalGate — a command waiting", () => {
  it("shows the command IN FULL, however long", () => {
    const long =
      "display current-configuration | include vlan | include port | include description";
    render(
      <ApprovalGate
        {...gateProps({ armed: true, pending: pending({ command: long }) })}
      />,
    );
    // Rendered as a single node with the whole text: no ellipsis, no slice.
    const el = document.querySelector(".approval-cmd")!;
    expect(el.textContent).toBe(long);
  });

  it("offers both answers, and sends the right one", async () => {
    const onDecide = vi.fn(() => Promise.resolve(true));
    render(
      <ApprovalGate
        {...gateProps({ armed: true, pending: pending(), onDecide })}
      />,
    );

    fireEvent.click(screen.getByText("Run it"));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap-1", true));

    onDecide.mockClear();
    fireEvent.click(screen.getByText("Refuse"));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap-1", false));
  });

  it("sends the id it was given, so the answer binds to the command shown", async () => {
    const onDecide = vi.fn(() => Promise.resolve(true));
    render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ id: "ap-42", command: "save" }),
          onDecide,
        })}
      />,
    );
    fireEvent.click(screen.getByText("Run it"));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap-42", true));
  });

  it("counts down, and says what expiry DOES", async () => {
    render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ expiresInMs: 10_000 }),
        })}
      />,
    );
    expect(screen.getByText("10s")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("7s")).toBeTruthy();
    // The consequence of running out is stated, because a fail-closed expiry is
    // otherwise indistinguishable from a lost click.
    expect(document.querySelector(".approval-note")!.textContent).toMatch(
      /not\s+run/i,
    );
  });

  it("restarts the countdown for a NEW request", async () => {
    // Without the id in the effect deps a second request inherits the first's
    // elapsed time and appears to expire early — which is exactly when an
    // operator would give up on a prompt that was still live.
    const { rerender } = render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ id: "a", expiresInMs: 60_000 }),
        })}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("55s")).toBeTruthy();

    rerender(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ id: "b", expiresInMs: 60_000 }),
        })}
      />,
    );
    // A full minute left reads as "1m" — whole minutes with a ceiling.
    expect(screen.getByText("1m")).toBeTruthy();
  });

  it("shows the prompt INSTEAD of the toggle — one thing to act on", () => {
    render(
      <ApprovalGate {...gateProps({ armed: true, pending: pending() })} />,
    );
    expect(screen.queryByText("Asking first")).toBeNull();
    expect(screen.queryByText("Ask before each command")).toBeNull();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("keeps the prompt visible when a decision call fails", async () => {
    // The request is still waiting on the agent; hiding it would strand the
    // command with nothing on screen to answer.
    const onDecide = vi.fn(() => Promise.reject(new Error("HTTP 500")));
    render(
      <ApprovalGate
        {...gateProps({ armed: true, pending: pending(), onDecide })}
      />,
    );
    fireEvent.click(screen.getByText("Run it"));
    await waitFor(() => expect(onDecide).toHaveBeenCalled());
    expect(document.querySelector(".approval-prompt")).not.toBeNull();
  });
});

describe("ApprovalGate — grants", () => {
  it('names the WORD a grant would cover, not just "remember this"', () => {
    // The breadth is the operator's consent, so it has to be readable.
    render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ command: "display version" }),
        })}
      />,
    );
    const btn = screen.getByText(/Always allow/);
    expect(btn.textContent).toContain("display");
    expect(btn.getAttribute("title")).toMatch(/every "display" command/i);
  });

  it("asks the server to remember, and does not send a prefix of its own", async () => {
    // The prefix is derived SERVER-side from the shown command; the client only
    // says "and remember this". A client that sent its own word could widen its
    // own permissions.
    const onDecide = vi.fn(() => Promise.resolve(true));
    render(
      <ApprovalGate
        {...gateProps({ armed: true, pending: pending(), onDecide })}
      />,
    );
    fireEvent.click(screen.getByText(/Always allow/));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith("ap-1", true, true),
    );
  });

  it("does NOT offer a grant for a command it cannot safely remember", () => {
    // A chained command has no honest word to grant. Offering the button would
    // imply otherwise — and the server would refuse to derive one anyway.
    render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ command: "display version && rm -rf /" }),
        })}
      />,
    );
    expect(screen.queryByText(/Always allow/)).toBeNull();
    // The command is still shown in full, and the plain answers still exist.
    expect(document.querySelector(".approval-cmd")!.textContent).toBe(
      "display version && rm -rf /",
    );
    expect(screen.getByText("Run it")).toBeTruthy();
  });

  it("lists the grants in force and revokes one by name", async () => {
    const onRevoke = vi.fn(() => Promise.resolve([]));
    render(
      <ApprovalGate
        {...gateProps({ armed: true, grants: ["display", "show"], onRevoke })}
      />,
    );
    expect(screen.getByText("display")).toBeTruthy();
    expect(screen.getByText("show")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Stop allowing display"));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledWith("display"));
  });

  it("shows no grant list when the gate is off", () => {
    // Grants are cleared server-side on disarm; showing stale ones here would
    // claim permissions that no longer exist.
    render(
      <ApprovalGate {...gateProps({ armed: false, grants: ["display"] })} />,
    );
    expect(screen.queryByText("display")).toBeNull();
  });

  it("mirrors the server's metacharacter rule", () => {
    // The client copy is used only to decide what to OFFER, so a divergence can
    // mislabel or hide a control — it cannot widen a permission. Still pinned,
    // because a divergence would show an "Always allow" button that the server
    // then refuses to honour.
    for (const cmd of [
      "display version",
      "show gpon onu state",
      "ls -la /var/log",
    ]) {
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

describe("ApprovalGate — the deadline is absolute (the double-speed regression)", () => {
  it("does NOT fall twice as fast when a re-read reports a smaller budget", async () => {
    // THE REGRESSION THIS FILE EXISTS FOR NOW. The device reports
    // `expires_in_ms` — a countdown that SHRINKS on every read — and the panel
    // re-reads it every 2 s while the gate is armed. A component that keeps the
    // shrinking budget AND accumulates its own elapsed time counts every second
    // twice. Against the old 60 s block that was invisible; at the gate's real
    // ~15-minute TTL the operator would be told the question had minutes left
    // when it had half an hour's worth.
    const TTL = 15 * 60_000;
    const view = (elapsed: number) => (
      <ApprovalGate
        {...gateProps({
          armed: true,
          // The SAME question, mapped from the wire exactly as useSessions does.
          pending: mapPending({
            pending_approval: {
              id: "ap-ttl",
              command: "reload",
              expires_in_ms: TTL - elapsed,
            },
          }),
        })}
      />
    );
    const { rerender } = render(view(0));
    expect(screen.getByText("15m")).toBeTruthy();

    // A minute of the loop, in the tick steps the component itself uses.
    for (let elapsed = 30_000; elapsed <= 60_000; elapsed += 30_000) {
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      rerender(view(elapsed));
    }

    // 14 minutes left. A double-counting display shows 13m: it subtracts its own
    // accumulated 60 s from the fresh 840 s budget.
    expect(screen.getByText("14m")).toBeTruthy();
    expect(screen.queryByText("13m")).toBeNull();
  });

  it("counts DOWN in real time — a 15-minute question still has ~14m a minute later", async () => {
    // The other half: the display must actually move. A frozen deadline would
    // pass the test above and fail the operator.
    render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ expiresInMs: 15 * 60_000 }),
        })}
      />,
    );
    expect(screen.getByText("15m")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(90_000);
    });
    expect(screen.getByText("14m")).toBeTruthy();
  });
});

describe("ApprovalGate — 0 s is settled, not answerable", () => {
  it("replaces the prompt with a status row that has NO buttons and no timer", async () => {
    const { container } = render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ expiresInMs: 2_000 }),
        })}
      />,
    );
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2_500);
    });

    // NOT alertdialog any more: there is nothing to answer.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const row = screen.getByRole("status");
    expect(row.textContent).toContain("Expired — the command was not run.");
    expect(container.querySelector(".approval-expired")).toBeTruthy();
    // A disabled "Run it" at 0 s reads as answerable, and the device would
    // refuse it — so the row renders no button of any kind.
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByText("Run it")).toBeNull();
    expect(screen.queryByText("Refuse")).toBeNull();
    // No frozen "0s" either: a stopped countdown still looks like a countdown.
    expect(container.querySelector(".approval-left")).toBeNull();
    expect(container.querySelector(".approval-prompt")).toBeNull();
  });

  it("treats a question that arrives already expired as settled", () => {
    // A panel that first reads the list after the TTL has run out must not
    // render a fresh, answerable prompt for a question the device retired.
    const { container } = render(
      <ApprovalGate
        {...gateProps({ armed: true, pending: pending({ expiresInMs: 0 }) })}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Expired");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("clears to NOTHING when the next list read drops the id", () => {
    const { container, rerender } = render(
      <ApprovalGate
        {...gateProps({ armed: true, pending: pending({ expiresInMs: 0 }) })}
      />,
    );
    expect(container.querySelector(".approval-expired")).toBeTruthy();
    // The device retired the question and terminal_list stopped reporting it.
    rerender(<ApprovalGate {...gateProps({ armed: true, pending: null })} />);
    expect(container.querySelector(".approval-expired")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    // The armed toggle is what is left — no residue of the answered question.
    expect(screen.getByText("Asking first")).toBeTruthy();
  });
});

describe("ApprovalGate — a countdown a screen reader can live with", () => {
  it("reads whole minutes with a ceiling, then seconds in the last minute", () => {
    const at = (ms: number, id: string) => (
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ id, expiresInMs: ms }),
        })}
      />
    );
    const { rerender } = render(at(15 * 60_000, "a"));
    expect(screen.getByText("15m")).toBeTruthy();
    rerender(at(2 * 60_000, "b"));
    expect(screen.getByText("2m")).toBeTruthy();
    // Ceiling, not floor: 61 s is closer to two minutes than to one, and
    // rounding DOWN would retire the question in the operator's head early.
    rerender(at(61_000, "c"));
    expect(screen.getByText("2m")).toBeTruthy();
    rerender(at(59_000, "d"));
    expect(screen.getByText("59s")).toBeTruthy();
  });

  it("ticks once a second only inside the last minute", async () => {
    // The observable half: with 45 s left, five seconds of real time must move
    // the display. A 30 s ticker would still say "45s".
    const { rerender } = render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ id: "slow", expiresInMs: 15 * 60_000 }),
        })}
      />,
    );
    rerender(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ id: "fast", expiresInMs: 45_000 }),
        })}
      />,
    );
    expect(screen.getByText("45s")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("40s")).toBeTruthy();
  });

  it("asks for a 30 s tick before the last minute and a 1 s tick inside it", () => {
    // The other half of the same requirement, pinned at the source: the old
    // fixed 500 ms interval re-rendered the whole workspace 1800 times per
    // question to display a number that changes once a minute.
    const spy = vi.spyOn(window, "setInterval");
    const { unmount } = render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ id: "long", expiresInMs: 15 * 60_000 }),
        })}
      />,
    );
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(spy).not.toHaveBeenCalledWith(expect.any(Function), 500);
    unmount();
    spy.mockClear();
    render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ id: "last", expiresInMs: 45_000 }),
        })}
      />,
    );
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 1_000);
    spy.mockRestore();
  });

  it("keeps the ticking number OUT of the alertdialog's live region", async () => {
    // role="alertdialog" inherits from `alert` — an ASSERTIVE live region. A
    // 1 Hz text change inside it would machine-gun a screen reader for the
    // question's whole TTL, so the countdown is aria-hidden and the description
    // is a STATIC sentence naming the wall-clock deadline.
    const { container } = render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ expiresInMs: 45_000 }),
        })}
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    const left = container.querySelector(".approval-left")!;
    expect(left.getAttribute("aria-hidden")).toBe("true");
    expect(left.textContent).toBe("45s");

    const descId = dialog.getAttribute("aria-describedby");
    expect(descId, "the alertdialog needs a static description").toBeTruthy();
    const desc = document.getElementById(descId!)!;
    const text = desc.textContent!;
    expect(text).toMatch(/Waiting for your answer\./);
    expect(text).toMatch(/Expires at \d{2}:\d{2}\./);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.querySelector(".approval-left")!.textContent).toBe("40s");
    // ...and the description did not move with it.
    expect(document.getElementById(descId!)!.textContent).toBe(text);
  });

  it("announces the last minute exactly once", async () => {
    const { container } = render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ expiresInMs: 2 * 60_000 }),
        })}
      />,
    );
    const statuses = () => [...container.querySelectorAll('[role="status"]')];
    expect(statuses()).toHaveLength(1);
    expect(statuses()[0].textContent).toBe("");

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(statuses()[0].textContent).toBe(
      "Less than a minute left to answer.",
    );

    // Ten more ticks, one announcement: the region's text does not change, so
    // a polite live region has nothing new to say.
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(statuses()).toHaveLength(1);
    expect(statuses()[0].textContent).toBe(
      "Less than a minute left to answer.",
    );
  });

  it("says the last minute in WORDS, not only in ink", async () => {
    // The urgent threshold moved from the last 10 s to the last minute, and it
    // is colour + TEXT — this repo has a recorded incident where two states
    // differed only by an animation that prefers-reduced-motion disables.
    const { container } = render(
      <ApprovalGate
        {...gateProps({
          armed: true,
          pending: pending({ expiresInMs: 45_000 }),
        })}
      />,
    );
    expect(container.querySelector(".approval-urgent")!.textContent).toMatch(
      /last minute/i,
    );
    expect(container.querySelector(".approval-left")!.className).toContain(
      "urgent",
    );
  });
});

describe("ApprovalGate — copy that is true whether the AI is blocked or parked", () => {
  it("does not claim the AI is blocked, and explains the late yes", () => {
    const { container } = render(
      <ApprovalGate {...gateProps({ armed: true, pending: pending() })} />,
    );
    // A claim about the OPERATOR, which is true either way.
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    const note = container.querySelector(".approval-note")!.textContent!;
    expect(note).toMatch(/not\s+run/i);
    // Without this sentence a late yes mints a permit, shows no run, and reads
    // as a broken button.
    expect(note).toMatch(/still counts/i);
    expect(note).toMatch(/next time the AI asks/i);
    // The panel cannot tell "blocked" from "gave up and parked" — there is no
    // such bit on the wire — so it must not assert either.
    expect(note).not.toMatch(/paused|blocked|stopped waiting for good/i);
  });
});
