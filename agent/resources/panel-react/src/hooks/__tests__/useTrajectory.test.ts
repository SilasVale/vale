import { describe, it, expect } from "vitest";
import { groupRounds } from "../useTrajectory";
import type { CommandEvent } from "../useCommandEvents";

function start(seq: number, command: string, ts = 100): CommandEvent {
  return { seq, ts, kind: "command/start", command };
}
function output(seq: number, text: string, ts = 100): CommandEvent {
  return { seq, ts, kind: "output", text };
}
function end(seq: number, exitCode: number | null, reason: string, durationMs?: number, ts = 105): CommandEvent {
  const ev: CommandEvent = { seq, ts, kind: "command/end", exit_code: exitCode, reason };
  if (durationMs !== undefined) ev.duration_ms = durationMs;
  return ev;
}
function status(seq: number, st: string, ts = 105): CommandEvent {
  return { seq, ts, kind: "status", status: st };
}

describe("groupRounds", () => {
  it("groups events into rounds by command/start, keeping every raw event", () => {
    const rounds = groupRounds([
      start(1, "ls -la"),
      output(2, "total 64\n"),
      end(3, 0, "marker", 2100),
      start(4, "echo two"),
      output(5, "two\n"),
      end(6, 1, "marker", 20),
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].id).toBe("r-1");
    expect(rounds[0].command).toBe("ls -la");
    expect(rounds[0].events.map((e) => e.kind)).toEqual(["command/start", "output", "command/end"]);
    expect(rounds[0]).toMatchObject({ ended: true, exitCode: 0, reason: "marker", durationMs: 2100 });
    expect(rounds[1]).toMatchObject({ id: "r-4", command: "echo two", exitCode: 1 });
  });

  it("preamble events before the first command/start form a session round", () => {
    const rounds = groupRounds([
      status(1, "opened", 90),
      start(2, "echo hi"),
      output(3, "hi\n"),
      end(4, 0, "marker", 5),
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ id: "r-pre", startSeq: null, command: "(session)", ended: false });
    expect(rounds[0].events).toHaveLength(1);
    expect(rounds[0].events[0].status).toBe("opened");
    expect(rounds[1].id).toBe("r-2");
  });

  it("derives round state from terminal statuses (round-99/100 semantics)", () => {
    const rounds = groupRounds([
      start(1, "sleep 999"),
      output(2, "started\n"),
      status(3, "backgrounded", 105),
      start(4, "npm test"),
      status(5, "exited:2", 110),
      start(6, "ssh host"),
      status(7, "closed", 108),
    ]);
    expect(rounds).toHaveLength(3);
    expect(rounds[0]).toMatchObject({ ended: true, exitCode: null, reason: "backgrounded", durationMs: 5000 });
    expect(rounds[1]).toMatchObject({ ended: true, exitCode: 2, reason: "exited:2" });
    expect(rounds[2]).toMatchObject({ ended: true, exitCode: null, reason: "closed" });
  });

  it("session-level status (opened) does not end a round", () => {
    const rounds = groupRounds([
      start(1, "echo hi"),
      status(2, "opened"),
      output(3, "hi\n"),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].ended).toBe(false);
  });

  it("a trailing start with no marker stays live", () => {
    const rounds = groupRounds([
      start(1, "tail -f /var/log/syslog"),
      output(2, "line1\n"),
      output(3, "line2\n"),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].ended).toBe(false);
    expect(rounds[0].exitCode).toBeNull();
    expect(rounds[0].events).toHaveLength(3);
  });

  it("a superseded round with no marker is sealed raw (not synthesized)", () => {
    // Impossible in a well-formed log (recovery appends interrupted), but the
    // raw view must not invent events: the old round stays as the log says.
    const rounds = groupRounds([
      start(1, "hang"),
      output(2, "stuck\n"),
      start(3, "next"),
      end(4, 0, "marker", 5),
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].ended).toBe(false);
    expect(rounds[0].events.map((e) => e.kind)).toEqual(["command/start", "output"]);
    expect(rounds[1].command).toBe("next");
  });

  it("the last terminal marker in a round wins", () => {
    const rounds = groupRounds([
      start(1, "bg && shell dies"),
      status(2, "backgrounded", 110),
      status(3, "closed", 120),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].reason).toBe("closed");
  });

  it("empty input yields no rounds", () => {
    expect(groupRounds([])).toEqual([]);
  });
});
