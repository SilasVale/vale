import test from "node:test";
import assert from "node:assert/strict";
import { allMcpTools } from "../src/mcp-tools.js";

test("mcp tools: 12 tools, all with device param", () => {
  const tools = allMcpTools();
  assert.equal(tools.length, 12);
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
