import test from "node:test";
import assert from "node:assert/strict";
import { allMcpTools } from "../src/mcp-tools.ts";
import { DEVICE_UNREACHABLE, TIMEOUT, SESSION_NOT_FOUND, SESSION_BUSY, TOOL_ERROR, ToolErr } from "../src/mcp-errors.ts";

test("mcp tools: all tools take a device param", () => {
  const tools = allMcpTools();
  // 22 tooling tools (17 agent terminal_*/secret_* + terminal_env + 2
  // browser_* runtime tools, round-151) + 7 browser control tools + the 2
  // relay file-transfer tools (round-554). The DEVICE side is pinned by
  // ../agent/spec-tools.json (50 tools) in mcp-handler.test.mjs: this
  // registry is a POLICY SUBSET of the device, so every device name missing
  // here must be justified in that test's NOT_EXPOSED map, not silently.
  //
  // 30 -> 31 when `terminal_plan` was registered: the plan surface is a TOOL
  // the AI client calls, so leaving it out would have made the whole feature
  // unreachable from console MCP (unlisted = uncalled).
  //
  // 31 -> 33 when `run_begin`/`run_end` were registered: run identity is the
  // same shape of decision. The device mints the id and stamps it onto the
  // records; if the console cannot CALL run_begin, a console-driven execution
  // can never be attributed — and the console is the primary consumer.
  assert.equal(tools.length, 33);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.inputSchema.properties.device, `${t.name} must take device`);
  }
});

test("mcp tools: browser + terminal sets", () => {
  const names = allMcpTools().map((t) => t.name);
  for (const n of ["browser_open","browser_snapshot","browser_screenshot","browser_click","browser_type","browser_wait","browser_close","terminal_open","terminal_screen","terminal_execute","terminal_list","terminal_close"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

test("mcp-errors: code family distinct; ToolErr carries code on an Error", () => {
  // Round-434: the stable failure codes MCP clients retry on had zero
  // direct pins — a renamed constant would silently break client retry.
  const codes = [DEVICE_UNREACHABLE, TIMEOUT, SESSION_NOT_FOUND, SESSION_BUSY, TOOL_ERROR];
  assert.equal(new Set(codes).size, codes.length, "codes must stay distinct");
  for (const c of codes) assert.ok(c && c === c.toUpperCase(), `code shape: ${c}`);
  const e = ToolErr(SESSION_BUSY, "terminal busy");
  assert.ok(e instanceof Error);
  assert.equal(e.message, "terminal busy");
  assert.equal(e.code, SESSION_BUSY);
});
