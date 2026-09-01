import { describe, it, expect } from "vitest";
import { createWrapperFilter } from "../wrapperFilter";

// Real device captures (d1, PowerShell 5.1 + ConPTY, PSReadLine removed):
// - wrapper echo:  `$__VALE_6a964406_b43d18d2cf7edc96__=0; $__VALE_..._cmd='echo hi'; & { ... }` (ONE clean line)
// - markers:       `__VALE_6a964406_b43d18d2cf7edc96___S` / `__VALE_6a964406_b43d18d2cf7edc96___E:0`

const MARKER_S = "__VALE_6a964406_b43d18d2cf7edc96___S";
const MARKER_E = "__VALE_6a964406_b43d18d2cf7edc96___E:0";
const WRAPPER_ECHO =
  "$__VALE_6a964406_b43d18d2cf7edc96__=0; $__VALE_6a964406_b43d18d2cf7edc96___cmd='echo hi'; & { Write-Output '" +
  MARKER_S +
  "'; ...; Write-Output \"" +
  MARKER_E +
  "\" }";

describe("wrapperFilter (PSReadLine removed)", () => {
  it("drops the wrapper echo line and marker lines, keeps output", () => {
    const { filter } = createWrapperFilter();
    const out = filter(`${WRAPPER_ECHO}\n${MARKER_S}\nHELLO\n${MARKER_E}\nPS C:\\> \n`);
    expect(out).not.toContain("__VALE_");
    expect(out).toContain("HELLO");
    expect(out).toContain("PS C:\\>");
  });

  it("drops blank lines right after the wrapper echo", () => {
    const { filter } = createWrapperFilter();
    const out = filter(`${WRAPPER_ECHO}\n\n\n\n${MARKER_S}\nOK\n`);
    expect(out).not.toContain("__VALE_");
    expect(out).toContain("OK");
  });

  it("handles the wrapper echo split at a frame boundary (tail)", () => {
    const { filter } = createWrapperFilter();
    const half = Math.floor(WRAPPER_ECHO.length / 2);
    const out1 = filter(WRAPPER_ECHO.slice(0, half));
    const out2 = filter(WRAPPER_ECHO.slice(half) + "\n" + MARKER_S + "\nOUT\n");
    expect(out1).not.toContain("__VALE_");
    expect(out2).not.toContain("__VALE_");
    expect(out2).toContain("OUT");
  });

  it("keeps real output that does not contain the marker", () => {
    const { filter } = createWrapperFilter();
    const out = filter(`line-1\nline-2\nDONE\n`);
    expect(out).toContain("line-1");
    expect(out).toContain("DONE");
  });

  it("keeps blank lines NOT preceded by wrapper machinery", () => {
    const { filter } = createWrapperFilter();
    const out = filter(`PS C:\\> \n\n\nOK\n`);
    expect(out).toContain("OK");
    // blanks after a normal prompt are kept (not armed)
    expect(out).toContain("\n\n");
  });
});
