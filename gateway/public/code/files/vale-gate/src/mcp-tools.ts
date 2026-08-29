/**
 * MCP tool registry for the gateway (vale-gate /mcp endpoint).
 * All tools take a `device` name; terminal tools proxy the device's existing
 * /api/tools endpoints; browser tools route via PluginHubDO → WS → the browser
 * extension, which drives the device's Chrome over CDP.
 *
 * The terminal tools mirror the agent's /api/spec (single source of truth).
 * If the agent gains/loses a tool, update BOTH this list and the toolPath map
 * in mcp.js, and refresh the spec snapshot in test/mcp-handler.test.mjs
 * (round-54: 11 tools were missing here — terminal_read/write/resize/select/
 * history, list_ports, diag_*, secret_* — invisible to console MCP clients).
 */

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TERMINAL_TOOLS: McpTool[] = [
  {
    name: "terminal_open",
    description:
      "Open a terminal connection on a device. Kind: 'pty' (local shell; target optional — blank = default shell), 'ssh' (target=user@host:port), or 'serial' (target=port_name, optional ?baud=N&parity=E&data=8&stop=1). Returns session ID.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name from the console Devices list. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        kind: { type: "string", enum: ["pty", "ssh", "serial"] },
        target: {
          type: "string",
          description:
            "pty: optional (blank = default shell); ssh: user@host:port; serial: port_name (?baud=N&parity=E&data=8&stop=1 optional)",
        },
        password: {
          type: "string",
          description: "SSH password (optional — keychain/file store fallback)",
        },
        rows: {
          type: "integer",
          description: "Initial terminal rows. Default 0 (backend default).",
        },
        cols: {
          type: "integer",
          description: "Initial terminal columns. Default 0 (backend default).",
        },
        data_bits: {
          type: "integer",
          description: "(serial) Data bits 5-8. Overrides the target string.",
        },
        parity: {
          type: "string",
          description: "(serial) Parity: none|odd|even. Overrides the target string.",
        },
        stop_bits: {
          type: "integer",
          description: "(serial) Stop bits 1 or 2. Overrides the target string.",
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "terminal_screen",
    description:
      "Get the current on-screen text of a terminal session (tail of the output buffer, ANSI-stripped). Use after terminal_execute to see the result.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        session_id: { type: "string" },
        lines: { type: "integer", description: "Number of lines from the tail. Default 60." },
      },
      required: ["session_id"],
    },
  },
  {
    name: "terminal_execute",
    description:
      "Send input to a terminal session and wait for output (prompt-marker detection on PTY shells, quiet-period fallback otherwise). Returns the accumulated output with wait_reason and exit_code.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        session_id: { type: "string" },
        input: { type: "string", description: "The command to run in the session" },
        timeout_secs: { type: "integer", description: "Max wait time in seconds. Default 30." },
        quiet_ms: {
          type: "integer",
          description:
            "(fallback) Quiet period in ms before considering output complete. Default 200.",
        },
      },
      required: ["session_id", "input"],
    },
  },
  {
    name: "terminal_write",
    description:
      "Write data to a terminal session. `data` is UTF-8 text; use `data_base64` for binary frames (control bytes, non-UTF-8 serial protocols). For shell commands the command must end with a newline (\\n; \\r\\n for PowerShell).",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        session_id: { type: "string" },
        data: {
          type: "string",
          description: "UTF-8 text to write. Required unless data_base64 is given.",
        },
        data_base64: {
          type: "string",
          description:
            "Base64-encoded bytes to write (for binary frames). Takes precedence over data.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "terminal_read",
    description:
      "Read buffered output from a terminal session. Non-destructive cursor; `offset` is an ABSOLUTE byte offset (see `start`/`end` in the response); `offset: 0` re-reads from the beginning. ANSI escapes stripped by default; pass clean:false for raw bytes.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        session_id: { type: "string" },
        offset: {
          type: "integer",
          description:
            "ABSOLUTE byte offset to start reading from. 0 = beginning. Default = last cursor position.",
        },
        clean: {
          type: "boolean",
          description: "Strip ANSI escapes and normalize \\r\\n → \\n. Default true.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "terminal_resize",
    description: "Resize a terminal session (PTY/SSH).",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        session_id: { type: "string" },
        rows: { type: "integer" },
        cols: { type: "integer" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "terminal_select",
    description:
      "Mark a session as actively watched (client-liveness heartbeat — keeps the idle sweeper from reaping a quiet-but-watched session).",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        session_id: { type: "string" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "terminal_history",
    description:
      "List closed sessions retained in history with their byte ranges (for terminal_read on finished sessions).",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" } },
      required: [],
    },
  },
  {
    name: "terminal_list",
    description: "List open terminal sessions on a device.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" } },
      required: [],
    },
  },
  {
    name: "terminal_list_ports",
    description: "List available serial ports on a device.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" } },
      required: [],
    },
  },
  {
    name: "terminal_close",
    description: "Close a terminal session on a device.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        session_id: { type: "string" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "terminal_diag_write",
    description:
      "POST a diagnostic line from the calling client (poll results, SSE status, errors). Stored in a process-lifetime ring buffer.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        line: { type: "string" },
      },
      required: ["line"],
    },
  },
  {
    name: "terminal_diag_read",
    description: "Read the panel diagnostic ring buffer (newest last).",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" } },
      required: [],
    },
  },
  {
    name: "secret_set",
    description:
      "Store a secret (e.g. SSH password) in the DEVICE agent's secret store (OS keychain / file fallback). Lives on the device agent — the browser extension is not involved.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        target: { type: "string", description: "SSH target (user@host:port)" },
        password: { type: "string" },
      },
      required: ["target", "password"],
    },
  },
  {
    name: "secret_get",
    description:
      "Retrieve a stored secret from the DEVICE agent's secret store (OS keychain / file). Returns the password or null.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        target: { type: "string" },
      },
      required: ["target"],
    },
  },
  {
    name: "secret_delete",
    description:
      "Delete a stored secret from the DEVICE agent's secret store (OS keychain / file).",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        target: { type: "string" },
      },
      required: ["target"],
    },
  },
  {
    name: "terminal_saved_connections",
    description:
      "List saved terminal connections on the device (successfully-opened sessions). Each entry: id (kind:target), kind, target, label, params — reconnect with terminal_connect_saved.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" } },
      required: [],
    },
  },
  {
    name: "terminal_connect_saved",
    description:
      "Reconnect to a saved terminal connection by id (from terminal_saved_connections). Replays the saved params; returns the new session id.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "terminal_env",
    description:
      "Environment info for driving the device's terminal (default shell, install dir, bundled node, guidance). Run before opening sessions.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" } },
      required: [],
    },
  },
  {
    name: "browser_pw_info",
    description:
      "Info about the device's BUNDLED Playwright runtime (paths, versions, template) — AI should reuse it instead of installing its own.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" } },
      required: [],
    },
  },
  {
    name: "browser_run_script",
    description:
      "Run a Node/Playwright script with the device's bundled runtime. Params: script (JS source), timeout_secs. Returns exit_code/stdout/stderr/screenshots.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        script: { type: "string" },
        timeout_secs: { type: "integer" },
      },
      required: ["script"],
    },
  },
];

const BROWSER_TOOLS: McpTool[] = [
  {
    name: "browser_open",
    description: "Open/navigate the controlled tab for a device to a URL. Returns a snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description: "Get the interactive element tree of the controlled tab.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" } },
      required: [],
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of the controlled tab (image).",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        full_page: { type: "boolean" },
      },
      required: [],
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element (by ref from a snapshot, e.g. 6 for e6) in the controlled tab. Returns a snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        element_ref: {
          type: "integer",
          description: "snapshot ref number (rendered as e<N> target)",
        },
      },
      required: ["element_ref"],
    },
  },
  {
    name: "browser_type",
    description: "Focus an element and type text into it (real input events). Returns a snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        element_ref: { type: "integer" },
        text: { type: "string" },
      },
      required: ["element_ref", "text"],
    },
  },
  {
    name: "browser_wait",
    description: "Wait for a condition (selector/text) in the controlled tab. Returns a snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
        },
        condition: { type: "string" },
        timeout_s: { type: "integer" },
      },
      required: ["condition"],
    },
  },
  {
    name: "browser_close",
    description: "Close the controlled tab for a device.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" } },
      required: [],
    },
  },
];

export function allMcpTools(): McpTool[] {
  return [...TERMINAL_TOOLS, ...BROWSER_TOOLS];
}
