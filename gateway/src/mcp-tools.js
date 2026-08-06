/**
 * MCP tool registry for the gateway (vale-gate /mcp endpoint).
 * All tools take a `device` name; terminal tools proxy the device's existing
 * /api/tools endpoints; browser tools route via PluginHubDO → WS → the browser
 * extension, which drives the device's Chrome over CDP.
 */

const TERMINAL_TOOLS = [
  {
    name: "terminal_open",
    description: "Open a terminal session on a device (PTY shell / SSH / serial). kind: pty|ssh|serial; target: cmd or host; returns session_id.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: "Device name from the console Devices list" },
        kind: { type: "string", enum: ["pty", "ssh", "serial"] },
        target: { type: "string", description: "For pty: command (e.g. powershell). For ssh: host. For serial: port." },
        rows: { type: "integer" },
        cols: { type: "integer" },
      },
      required: ["device", "kind", "target"],
    },
  },
  {
    name: "terminal_screen",
    description: "Get the current on-screen text of a terminal session (tail of the output buffer, ANSI-stripped). Use after terminal_send to see the result.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string" },
        session_id: { type: "string" },
        lines: { type: "integer", description: "Number of lines from the tail. Default 60." },
      },
      required: ["device", "session_id"],
    },
  },
  {
    name: "terminal_send",
    description: "Send input to a terminal session and wait for output to stabilize (quiet period), then return the accumulated screen text. Use for command-and-observe.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string" },
        session_id: { type: "string" },
        input: { type: "string" },
        quiet_ms: { type: "integer", description: "Quiet period before declaring output stable. Default 400." },
      },
      required: ["device", "session_id", "input"],
    },
  },
  {
    name: "terminal_list",
    description: "List open terminal sessions on a device.",
    inputSchema: { type: "object", properties: { device: { type: "string" } }, required: ["device"] },
  },
  {
    name: "terminal_close",
    description: "Close a terminal session on a device.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" }, session_id: { type: "string" } },
      required: ["device", "session_id"],
    },
  },
];

const BROWSER_TOOLS = [
  { name: "browser_open", description: "Open/navigate the controlled tab for a device to a URL. Returns a snapshot.", inputSchema: { type: "object", properties: { device: { type: "string" }, url: { type: "string" } }, required: ["device", "url"] } },
  { name: "browser_snapshot", description: "Get the interactive element tree of the controlled tab.", inputSchema: { type: "object", properties: { device: { type: "string" } }, required: ["device"] } },
  { name: "browser_screenshot", description: "Capture a PNG screenshot of the controlled tab (image).", inputSchema: { type: "object", properties: { device: { type: "string" }, full_page: { type: "boolean" } }, required: ["device"] } },
  { name: "browser_click", description: "Click an element (by ref from a snapshot) in the controlled tab. Returns a snapshot.", inputSchema: { type: "object", properties: { device: { type: "string" }, element_ref: { type: "integer" } }, required: ["device", "element_ref"] } },
  { name: "browser_type", description: "Focus an element and type text into it (real input events). Returns a snapshot.", inputSchema: { type: "object", properties: { device: { type: "string" }, element_ref: { type: "integer" }, text: { type: "string" } }, required: ["device", "element_ref", "text"] } },
  { name: "browser_wait", description: "Wait for a condition (selector/text) in the controlled tab. Returns a snapshot.", inputSchema: { type: "object", properties: { device: { type: "string" }, condition: { type: "string" }, timeout_s: { type: "integer" } }, required: ["device", "condition"] } },
  { name: "browser_close", description: "Close the controlled tab for a device.", inputSchema: { type: "object", properties: { device: { type: "string" } }, required: ["device"] } },
];

export function allMcpTools() {
  return [...TERMINAL_TOOLS, ...BROWSER_TOOLS];
}
