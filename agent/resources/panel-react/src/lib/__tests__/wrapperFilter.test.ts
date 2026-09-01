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

describe("wrapperFilter console wrap segments (1.0.144 real bytes)", () => {
  it("drops a wrapper wrapped into CSI-prefixed segments", () => {
    const { filter } = createWrapperFilter();
    // Real d1 bytes: the long wrapper at 80 cols is wrapped into segments,
    // each prefixed with \u001b[23;80H (cursor move). Only the FIRST segment
    // carries the `$__VALE_` prefix; later segments carry marker fragments.
    const raw =
      "PS C:\\WINDOWS\\system32\\config\\systemprofile> $__VALE_6a9676cc_c9fe92d68e0a9361__\r\n" +
      "\u001b[23;80H_=0; $__VALE_6a9676cc_c9fe92d68e0a9361___cmd='Get-ChildItem D:\\Vale -Name | Selec\r\n" +
      "\u001b[23;80Hct-Object -First 3; Write-Output \"AGAIN-OK\"'; & { Write-Output '__VALE_6a9676cc_c\r\n" +
      "\u001b[23;80Hc9fe92d68e0a9361___S'; ... }\r\n" +
      "__VALE_6a9676cc_c9fe92d68e0a9361___S\r\nplaywright\r\npwout\r\nsessions\r\nAGAIN-OK\r\n" +
      "__VALE_6a9676cc_c9fe92d68e0a9361___E:0\r\nPS C:\\WINDOWS\\system32\\config\\systemprofile>\r\n";
    const out = filter(raw);
    expect(out).not.toContain("__VALE_");
    expect(out).not.toContain("c9fe92d68e0a9361");
    expect(out).toContain("playwright");
    expect(out).toContain("AGAIN-OK");
    expect(out).toContain("PS C:\\WINDOWS");
  });

  it("keeps output lines that merely share hex-looking text", () => {
    const { filter } = createWrapperFilter();
    const out = filter(`c9fe92d68e0a9361\nplain\n`);
    expect(out).toContain("c9fe92d68e0a9361");
    expect(out).toContain("plain");
  });
});
