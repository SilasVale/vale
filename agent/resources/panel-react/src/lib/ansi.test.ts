// stripAnsi pins — the text surfaces (trajectory timeline, command cards)
// must never print raw escapes: cursor moves, SGR runs, OSC titles and
// semantic-prompt markers showed as visible garbage (round-134).
import { describe, it, expect } from "vitest";
import { stripAnsi } from "./ansi";

describe("stripAnsi", () => {
  it("strips SGR color runs but keeps the text", () => {
    expect(stripAnsi("\x1b[93mhello\x1b[0m")).toBe("hello");
    expect(stripAnsi("\x1b[1;31merr\x1b[m")).toBe("err");
  });

  it("strips cursor moves and clears", () => {
    expect(stripAnsi("\x1b[2J\x1b[Hready")).toBe("ready");
    expect(stripAnsi("a\x1b[Ab")).toBe("ab");
  });

  it("strips OSC titles and semantic-prompt markers", () => {
    expect(stripAnsi("\x1b]0;my title\x07done")).toBe("done");
    expect(stripAnsi("\x1b]133;D;0\x07ok")).toBe("ok");
  });

  it("strips an unterminated OSC running to end of input (stream cut)", () => {
    expect(stripAnsi("out\x1b]133;D;")).toBe("out");
  });

  it("drops stray ESC bytes and tolerates undefined", () => {
    expect(stripAnsi("a\x1bb")).toBe("ab");
    expect(stripAnsi(undefined)).toBe("");
    expect(stripAnsi("plain")).toBe("plain");
  });
});
