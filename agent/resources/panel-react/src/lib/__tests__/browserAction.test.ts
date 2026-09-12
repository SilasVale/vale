import { describe, it, expect } from "vitest";
import { actionVerdict } from "../browserAction";

// A RECORD IN THE ACTION FEED CANNOT BE RUNNING. Every writer appends after the
// action ends: the playwright producer writes the result triple, and the
// mcp-client producers write `exit_code: if ok { 0 } else { 1 }`. The panel
// nevertheless mapped `exit_code === null` to a badge reading "running" — so a
// browser action that could not even START was shown as one still in progress,
// the opposite of what happened, while `stderr_tail` (the device's own sentence
// "spawn failed: …") was declared on the type, fetched from the route, and
// rendered nowhere.
describe("what a browser action's record supports", () => {
  it("a SPAWN FAILURE is not 'running'", () => {
    const v = actionVerdict({
      ts: 1,
      exit_code: null,
      timed_out: false,
      stderr_tail: "spawn failed: ENOENT",
    });
    expect(v.label).not.toBe("running");
    expect(v.state).toBe("nocode");
    expect(v.label).toBe("did not start");
    // And the device's own explanation comes with it.
    expect(v.detail).toBe("spawn failed: ENOENT");
  });

  it("a TIMEOUT keeps its own word, and its reason", () => {
    const v = actionVerdict({ ts: 1, exit_code: null, timed_out: true, stderr_tail: "timed out after 30s" });
    expect(v.state).toBe("timeout");
    expect(v.label).toBe("timeout");
    expect(v.detail).toBe("timed out after 30s");
  });

  it("an ABSENT code is not a null one", () => {
    // `=== null` never matched `undefined`, so a record without the field fell
    // through to the exit-code branch and rendered the literal "exit undefined".
    const v = actionVerdict({ ts: 1 });
    expect(v.label).toBe("no exit code recorded");
    expect(v.label).not.toContain("undefined");
    expect(v.state).toBe("unknown");
  });

  it("success is exit 0, and nothing else is", () => {
    expect(actionVerdict({ ts: 1, exit_code: 0 }).state).toBe("ok");
    expect(actionVerdict({ ts: 1, exit_code: 0 }).label).toBe("ok");
    const bad = actionVerdict({ ts: 1, exit_code: 1, stderr_tail: "boom" });
    expect(bad.state).toBe("fail");
    expect(bad.label).toBe("exit 1");
    expect(bad.detail).toBe("boom");
  });

  it("no detail is invented for a success", () => {
    // A successful action has nothing to explain, and showing a stale tail
    // beside "ok" would read as a warning.
    expect(actionVerdict({ ts: 1, exit_code: 0, stdout_tail: "fine" }).detail).toBeNull();
  });

  it("falls back to stdout when there is no stderr", () => {
    expect(actionVerdict({ ts: 1, exit_code: 1, stdout_tail: "partial output" }).detail).toBe(
      "partial output",
    );
  });
});
