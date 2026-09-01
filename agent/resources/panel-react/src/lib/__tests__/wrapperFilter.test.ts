import { describe, it, expect } from "vitest";
import { createWrapperFilter } from "../wrapperFilter";

// Real device captures (d1, PowerShell 5.1 + ConPTY, 1.0.132):
// - wrapper echo:  `$__VALE_6a964406_b43d18d2cf7edc96__=0; $__VALE_..._cmd='echo WRAPPED-VERIFY-1'; & { ... }`
// - markers:       `__VALE_6a964406_b43d18d2cf7edc96___S` / `__VALE_6a964406_b43d18d2cf7edc96___E:0`
// - chunk-split:   `>> ` continuation prompts interleaved between the echo halves

const MARKER_S = "__VALE_6a964406_b43d18d2cf7edc96___S";
const MARKER_E = "__VALE_6a964406_b43d18d2cf7edc96___E:0";
const WRAPPER_ECHO =
  "$__VALE_6a964406_b43d18d2cf7edc96__=0; $__VALE_6a964406_b43d18d2cf7edc96___cmd='echo WRAPPED-VERIFY-1'; & { Write-Output '" +
  MARKER_S +
  "'; $env:PAGER='cat'; ...; Write-Output \"" +
  MARKER_E +
  "\" }";

describe("wrapperFilter", () => {
  it("drops exact marker lines and the wrapper echo", () => {
    const { filter } = createWrapperFilter();
    const out = filter(`PS C:\\> ${WRAPPER_ECHO}\n${MARKER_S}\nWRAPPED-VERIFY-1\n${MARKER_E}\nPS C:\\> \n`);
    expect(out).not.toContain("__VALE_");
    expect(out).toContain("WRAPPED-VERIFY-1");
    expect(out).toContain("PS C:\\>");
  });

  it("keeps user output that merely mentions a marker-like string (not exact)", () => {
    const { filter } = createWrapperFilter();
    const out = filter(`echo __VALE_6a964406_b43d18d2cf7edc96___S was typed\n`);
    expect(out).toContain("was typed");
    // the echo line is not an exact marker nor a wrapper echo → kept as-is
    expect(out).toContain("echo __VALE_");
  });

  it("drops the ConPTY chunk-split `>>` fragments after the wrapper echo", () => {
    const { filter } = createWrapperFilter();
    // Device capture: the 512B chunk boundary splits the wrapper mid-line;
    // ConPTY echoes `>> ` continuation prompts between the halves.
    const chunk1 = `PS C:\\> ${WRAPPER_ECHO.slice(0, 500)}\n>> \n`;
    const chunk2 = `${WRAPPER_ECHO.slice(500)}\n${MARKER_S}\nOK\n${MARKER_E}\nPS C:\\> \n`;
    const out1 = filter(chunk1);
    const out2 = filter(chunk2);
    expect(out1).not.toContain("__VALE_");
    expect(out1).not.toContain(">>");
    expect(out2).not.toContain(">>");
    expect(out2).toContain("OK");
    expect(out2).toContain("PS C:\\>");
  });

  it("does NOT drop genuine `>>` multi-line input (no wrapper echo before it)", () => {
    const { filter } = createWrapperFilter();
    const out = filter(`PS C:\\> foreach ($i in 1..3) {\n>> $i\n>> }\nPS C:\\> \n`);
    expect(out).toContain(">>");
    expect(out).toContain("foreach");
  });

  it("handles a marker split across frames (carry)", () => {
    const { filter } = createWrapperFilter();
    // Split at a point that lands mid-hex (includes the `_` separator).
    const at = MARKER_S.indexOf("_b43d");
    expect(at).toBeGreaterThan(0);
    const out1 = filter(MARKER_S.slice(0, at));
    const out2 = filter(MARKER_S.slice(at) + "\nHELLO\n");
    expect(out1).not.toContain("__VALE_");
    expect(out2).not.toContain("__VALE_");
    expect(out2).toContain("HELLO");
  });

  it("handles a wrapper echo split across frames (carry)", () => {
    const { filter } = createWrapperFilter();
    const half = Math.floor(WRAPPER_ECHO.length / 2);
    const out1 = filter(WRAPPER_ECHO.slice(0, half)); // no newline yet
    const out2 = filter(WRAPPER_ECHO.slice(half) + "\n" + MARKER_S + "\nOUT\n" + MARKER_E + "\n");
    expect(out1).not.toContain("__VALE_");
    expect(out2).not.toContain("__VALE_");
    expect(out2).toContain("OUT");
  });

  it("keeps user output that merely mentions a marker-like string (not exact)", () => {
    const { filter } = createWrapperFilter();
    const out = filter(`echo __VALE_6a964406_b43d18d2cf7edc96___S was typed\n`);
    expect(out).toContain("was typed");
    // the echo line is not an exact marker nor a wrapper echo → kept as-is
    expect(out).toContain("echo __VALE_");
  });

  it("is bounded: a long random partial line is not retained in carry", () => {
    const { filter } = createWrapperFilter();
    const noise = "x".repeat(300);
    const out = filter(noise);
    expect(out).toContain(noise); // flushed, not held
  });

  it("strips ANSI SGR codes before classifying marker lines", () => {
    const { filter } = createWrapperFilter();
    const out = filter(`\u001b[92m${MARKER_S}\u001b[m\nOUT\n`);
    expect(out).not.toContain(MARKER_S);
    expect(out).toContain("OUT");
  });
});
