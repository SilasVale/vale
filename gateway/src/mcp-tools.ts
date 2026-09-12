/**
 * MCP tool registry for the gateway (vale-gate /mcp endpoint).
 * All tools take a `device` name; terminal/secret tools proxy the device's
 * existing /api/tools endpoints; browser tools route through the device's
 * playwright-mcp bridge (mcp_client), which drives the embedded Electron
 * view over CDP 9333 (round-262 removed the browser-extension path).
 *
 * The terminal tools mirror the agent's /api/spec (single source of truth).
 * If the agent gains/loses a tool, update BOTH this list and the toolPath map
 * in mcp.ts, and refresh the spec snapshot in test/mcp-handler.test.mjs
 * (round-54: 11 tools were missing here — terminal_read/write/resize/select/
 * history, list_ports, diag_*, secret_* — invisible to console MCP clients).
 *
 * ROUND-554 — that comment's "refresh the snapshot" step is now FORCED. The
 * snapshot it referred to was a hand-typed copy of THIS list, so it could
 * never notice a device tool missing here: 21 of the agent's 49 tools
 * (the entire system_, memory_, mcp_client_ families, agent_update,
 * page_view, terminal_sftp/jobs/forget_saved) were invisible AND uncalled
 * — tools/call looks the name up in this registry before routing — with
 * every gate green. test/mcp-handler.test.mjs now reads the agent-generated
 * ../agent/spec-tools.json (dumped from the live PluginRegistry by
 * web::tests::spec_snapshot…) and fails on any device tool that is neither
 * registered here nor explicitly listed as not-exposed in that test. Adding
 * a device tool therefore requires an explicit exposure decision, not an
 * optional copy-paste.
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

/**
 * The device-selector field shared by every MCP tool schema (a tool runs
 * against ONE registered device; omit when only one is registered). Used to
 * be copy-pasted into every inputSchema — one source now.
 */
const DEVICE_PARAM: Record<string, unknown> = {
  device: {
    type: "string",
    description:
      "Device name. OPTIONAL — omit when only one device is registered (it is used automatically).",
  },
};

/**
 * The `run_id` parameter, shared by every browser control tool.
 *
 * One definition rather than seven copies: these tools all reach the device
 * through the SAME bridge (`mcp-browser.ts`), and the bridge lifts `run_id` out
 * of the playwright arguments to the device call's top level. A tool whose
 * schema omitted it could not be attributed to a run — and a per-tool copy is
 * how such an omission survives review.
 */
const RUN_PARAM: Record<string, unknown> = {
  run_id: {
    type: "string",
    description:
      "Optional: the id returned by run_begin, naming the execution this browser action belongs to. One run spans browser actions AND terminal commands, so this is what lets an operator see a coherent piece of work instead of the day's traffic. Pass back the id run_begin gave you.",
  },
};

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
        key_path: {
          type: "string",
          description:
            "(ssh) Path to a private key file. When set, public-key auth is used; password (if any) is the key passphrase.",
        },
        auto_reconnect: {
          type: "boolean",
          description:
            "(serial) Auto-reconnect when the port disappears (unplug / device reboot): the session stays open and re-opens the SAME port with the SAME framing when it reappears. Default false.",
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
        ...DEVICE_PARAM,
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
        ...DEVICE_PARAM,
        session_id: { type: "string" },
        input: { type: "string", description: "The command to run in the session" },
        timeout_secs: { type: "integer", description: "Max wait time in seconds. Default 30." },
        quiet_ms: {
          type: "integer",
          description:
            "(fallback) Quiet period in ms before considering output complete. Default 200.",
        },
        run_in_background: {
          type: "boolean",
          description:
            "(Session mode) Write the command and return immediately with a read_from cursor; collect via terminal_read. Default false.",
        },
        intent: {
          type: "string",
          description:
            "Optional: WHY you are running this, in one sentence. Recorded with the command and shown to the operator on the session's path — it is what turns a list of commands into a readable account of what you were doing and why. Send it whenever the reason is not obvious from the command itself.",
        },
        considered: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: the alternatives you passed over for this step (short labels, max 8). Recorded and shown as the branches NOT taken, which is the part a command log can never reconstruct. Send it when you made a real choice — not for the only way to do something.",
        },
        plan_step: {
          type: "integer",
          description:
            "Optional: which step of your declared terminal_plan this command advances (1-based). Lets the operator see the plan being followed — or quietly abandoned — instead of having to guess which command served which step.",
        },
        run_id: {
          type: "string",
          description:
            "Optional: the id returned by run_begin, naming the execution this command belongs to. One run spans many commands AND browser actions, so this is what lets an operator see a coherent piece of work instead of the day's traffic. Pass back the id verbatim.",
        },
        approval_id: {
          type: "string",
          description:
            "Optional: the approval id from a result whose state was `awaiting_approval`. If the operator has since approved, the command runs without asking again; the permit covers exactly this command text, once. Omit it for a normal execute.",
        },
      },
      // `session_id` is NOT required: the device makes it optional and has a
      // whole non-session branch, and the relay never injects one — so requiring
      // it here forbade a schema-validating client from making a call the device
      // supports. The device's own `required` is `["command"]`, which is `input`
      // on this side of the declared rename.
      required: ["input"],
    },
  },
  {
    name: "terminal_write",
    description:
      "Write data to a terminal session. `data` is UTF-8 text; use `data_base64` for binary frames (control bytes, non-UTF-8 serial protocols). For shell commands the command must end with a newline (\\n; \\r\\n for PowerShell).",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
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
      // The claim that `offset: 0` "re-reads from the beginning" was FALSE past
      // 1 MiB of spill and was corrected on the device in round 21 — while this
      // hand-copied string kept serving it to every console client. A single
      // read returns AT MOST 1 MiB and then the window's TAIL, so a `start`
      // greater than the offset you asked for is the only signal that the head
      // was withheld, and no offset can retrieve it.
      "Read buffered output from a terminal session. Non-destructive cursor; `offset` is an ABSOLUTE byte offset and `start`/`end` are the absolute span actually returned. A single read returns AT MOST 1 MiB: for a longer stream the OLDEST bytes in the window are withheld, so a `start` GREATER than your `offset` means the head is unavailable and cannot be fetched by any offset. ANSI escapes stripped by default; pass clean:false for raw bytes.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
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
        ...DEVICE_PARAM,
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
        ...DEVICE_PARAM,
        session_id: { type: "string" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "terminal_plan",
    description:
      "Declare, revise, clear or read this session's PLAN — the steps you intend to take, in order. Call it before starting a multi-step task so the operator can see what you are about to do and judge it; call it again with a revised list when the plan changes. Pass an empty array to clear it. With `plan` omitted it just returns the current plan. Steps are short labels, not explanations — put the reasoning for a specific command in terminal_execute's `intent`, and name the step a command advances with terminal_execute's `plan_step`.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
        session_id: { type: "string", description: "The session this plan is for." },
        plan: {
          type: "array",
          items: { type: "string" },
          description:
            "The steps, in order (max 24, each a short line). An empty array CLEARS the plan. Omit the key entirely to read the current plan without changing it.",
        },
        run_id: {
          type: "string",
          description:
            "Optional: the id returned by run_begin, naming the execution this plan belongs to. A declared plan belongs to the run that declared it, so passing the id lets an operator see what a run said it would do next to what it actually did.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "terminal_history",
    description:
      'List terminal sessions with their byte ranges: LIVE sessions AND closed ones retained in history. (This said "closed sessions" only, contradicting its own `limit` parameter below and the device, which always includes live sessions.)',
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
        limit: {
          type: "integer",
          description: "Max entries to return (default 20; live sessions are always included).",
        },
      },
      required: [],
    },
  },
  {
    name: "terminal_list",
    description: "List open terminal sessions on a device.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
      },
      required: [],
    },
  },
  {
    name: "terminal_list_ports",
    description: "List available serial ports on a device.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
      },
      required: [],
    },
  },
  {
    name: "terminal_close",
    description: "Close a terminal session on a device.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
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
        ...DEVICE_PARAM,
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
      properties: {
        ...DEVICE_PARAM,
      },
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
        ...DEVICE_PARAM,
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
        ...DEVICE_PARAM,
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
        ...DEVICE_PARAM,
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
      properties: {
        ...DEVICE_PARAM,
      },
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
        ...DEVICE_PARAM,
        id: { type: "string" },
        rows: { type: "integer", description: "Override the saved row count." },
        cols: { type: "integer", description: "Override the saved column count." },
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
      properties: {
        ...DEVICE_PARAM,
      },
      required: [],
    },
  },
  {
    name: "browser_pw_info",
    description:
      "Info about the device's BUNDLED Playwright runtime (paths, versions, template) — AI should reuse it instead of installing its own.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
      },
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
        ...DEVICE_PARAM,
        script: { type: "string" },
        timeout_secs: { type: "integer" },
        run_id: {
          type: "string",
          description:
            "Optional: the id returned by run_begin, naming the execution this browser action belongs to. One run spans browser actions AND terminal commands. This is NOT VALE_RUN_ID (the per-call env stem used for screenshot namespacing) — pass back the id run_begin gave you.",
        },
      },
      required: ["script"],
    },
  },
];

/**
 * The device-direct file-transfer pair — the ONE sanctioned way to move a
 * file between a device and anything else (Linux workstation, another
 * device, a CDN URL). Bytes never touch the AI context in either direction,
 * so the 100 MB firmware image that `system_file_write` (≤4 MiB, inline)
 * cannot carry works here.
 *
 * Registration is a POLICY decision, not a capability one: the device serves
 * 49 tools, this file used to mirror 28 of them by hand, and everything
 * unmirrored was uncalled (`tools/call` looks the name up here before
 * routing). test/mcp-handler.test.mjs now reads the agent's generated
 * spec-tools.json and fails on any name that is neither registered here nor
 * explicitly listed as not-exposed.
 */
const SYSTEM_TOOLS: McpTool[] = [
  {
    name: "system_file_upload",
    description:
      "Send a file FROM the device to the Vale relay and return its one-time download URL (any other machine or device can then pull it). THE BYTES NEVER PASS THROUGH THE AI CONTEXT, so 100 MB is fine. The device reads the file into memory before relaying, so the cost is bounded by the 100 MiB cap and the upload is NOT streamed from disk (the download direction is). The relay holds the file until first download or 24 h. Returns {ok, url, bytes}. Pair: system_file_download.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
        path: {
          type: "string",
          description: "Absolute path of the file on the device to send.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "system_file_download",
    description:
      "Land a URL ON the device (the receive half of the relay pair — hand it the url from system_file_upload, or any HTTP(S) URL). The device fetches directly, so the bytes never pass through the AI context and 100 MB works; the write is staged as <path>.part and renamed, so a truncated transfer never appears complete. Returns {ok, path, bytes}. IP-literal hosts are refused (SSRF guard) — use a hostname.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
        url: {
          type: "string",
          description: "HTTP/HTTPS URL to fetch (a relay URL from system_file_upload).",
        },
        path: {
          type: "string",
          description:
            "Destination on the device (absolute recommended, e.g. D:\\Vale\\downloads\\fw.bin). Parent dirs are created; a relative name lands under <data dir>/downloads.",
        },
      },
      required: ["url", "path"],
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
        ...DEVICE_PARAM,
        ...RUN_PARAM,
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
      properties: {
        ...DEVICE_PARAM,
        ...RUN_PARAM,
      },
      required: [],
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of the controlled tab (image).",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
        ...RUN_PARAM,
        // `fullPage`, not `full_page`: arguments are forwarded VERBATIM, and the
        // shipped server declares `fullPage`. The snake_case spelling was
        // silently dropped, so a full-page request returned a viewport shot and
        // nothing said so.
        fullPage: { type: "boolean" },
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
        ...DEVICE_PARAM,
        ...RUN_PARAM,
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
        ...DEVICE_PARAM,
        ...RUN_PARAM,
        element_ref: { type: "integer" },
        text: { type: "string" },
      },
      required: ["element_ref", "text"],
    },
  },
  {
    name: "browser_wait",
    // SPEAKS THE SHIPPED SERVER'S LANGUAGE. This advertised `condition` as
    // REQUIRED plus a `timeout_s` — and the playwright-mcp the agent installs
    // (`@playwright/mcp` 0.0.79, read out of vale-playwright.zip) has NEITHER:
    // `browser_wait_for` takes `time`, `text` and `textGone`, all optional.
    // Arguments are forwarded verbatim, so the console was advertising a call
    // whose ONLY required argument the server does not have, and a
    // schema-validating client could not have made a working one.
    //
    // The description now says what the server does — wait for text to appear or
    // disappear, or for a time to pass — instead of promising a selector wait
    // that does not exist.
    description:
      "Wait in the controlled tab: for `text` to appear, for `text_gone` to disappear, or for `time` seconds to pass. The server requires at least one; none is marked required here so its rule is the one that applies. Returns a snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
        ...RUN_PARAM,
        text: { type: "string", description: "Wait for this text to appear." },
        text_gone: { type: "string", description: "Wait for this text to disappear." },
        time: { type: "number", description: "Seconds to wait." },
      },
      // NOTHING IS REQUIRED: the server accepts any one of the three, so marking
      // one required would forbid the other two valid calls.
    },
  },
  {
    name: "browser_close",
    description: "Close the controlled tab for a device.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
        ...RUN_PARAM,
      },
      required: [],
    },
  },
];

/**
 * RUN IDENTITY — declaring the boundaries of one AI execution on the device.
 *
 * A run crosses the terminal/browser boundary, so these belong to no existing
 * group; they are device-direct (relayed to `/api/tools/<name>`) and must also
 * match `isDeviceDirectTool()` in mcp.ts, which is a SEPARATE gate: registering
 * here without that predicate reaches `throw ToolErr(TOOL_ERROR, "No route for
 * registered tool …")` at call time.
 *
 * `run_id` is a LABEL the device mints, never a credential — see
 * `agent/src/runs.rs`. The console advertises these so a model can group its own
 * work; the gateway stores nothing.
 */
const RUNS_TOOLS: McpTool[] = [
  {
    name: "run_begin",
    description:
      "Declare the start of ONE run — one execution of your work on this device — and get back the `run_id` that names it. Call it when you begin a piece of work that spans more than a single command, then pass the id to run_end when you stop. The device cannot tell two AIs apart (the token identifies the device, not the caller), so this declared boundary is what lets an operator see that a set of commands and browser actions belonged to one execution rather than to the day's whole traffic. The id is minted by the device and embeds its start time; store it and pass it back verbatim.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
        label: {
          type: "string",
          description:
            'Optional: a short human-readable name for this run, e.g. "provision the ONU on VLAN 100". Shown to the operator, so keep it to a phrase. A blank label is recorded as absent, not as an empty string.',
        },
        goal: {
          type: "string",
          description:
            "Optional: the objective this run is pursuing, when you know it. Distinct from the session goal the OPERATOR sets — one goal can span several runs (a retry after a failure), and a run can have no goal at all.",
        },
      },
      required: [],
    },
  },
  {
    name: "run_end",
    description:
      "Declare that a run started with run_begin is finished, so an operator sees a closed interval instead of work that never stopped. Pass back the `run_id` run_begin gave you. A run left unclosed is NOT an error — the device renders it as open with the extent of the events it actually carries, because a client may still be working, may have stopped, or the agent may have restarted. `known` in the reply says whether this id was ever minted here; it is information for you, never a permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...DEVICE_PARAM,
        run_id: { type: "string", description: "The id returned by run_begin." },
        outcome: {
          type: "string",
          description:
            'Optional: how it ended, in a word or a short phrase ("done", "failed: ONU did not register"). Omit it rather than guessing — an absent outcome is rendered as nothing, never as a failure.',
        },
      },
      required: ["run_id"],
    },
  },
];

export function allMcpTools(): McpTool[] {
  return [...TERMINAL_TOOLS, ...SYSTEM_TOOLS, ...BROWSER_TOOLS, ...RUNS_TOOLS];
}
