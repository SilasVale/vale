import test from "node:test";
import assert from "node:assert/strict";
import { allMcpTools } from "../src/mcp-tools.ts";
import { DEVICE_UNREACHABLE, TIMEOUT, SESSION_NOT_FOUND, SESSION_BUSY, TOOL_ERROR, ToolErr } from "../src/mcp-errors.ts";

test("mcp tools: all tools take a device param", () => {
  const tools = allMcpTools();
  // 21 tooling tools (16 agent terminal_*/secret_* + terminal_env + 2
  // browser_* runtime tools, round-151) + 7 browser control tools.
  assert.equal(tools.length, 28);
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
