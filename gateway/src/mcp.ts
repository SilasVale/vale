/**
 * Minimal MCP (streamable HTTP) server for the gateway — hand-rolled JSON-RPC 2.0,
 * zero deps (the repo's gateway has no runtime dependencies; @modelcontextprotocol/sdk
 * would need a fetch-to-node bridge on Workers). Supports the subset Claude Code
 * uses: initialize, notifications/initialized, ping, tools/list, tools/call.
 * GET returns a keep-alive SSE stream (Claude Code v2.1.84+ probes GET first;
 * 405 is treated as server failure). Stateless.
 */
import { getDevice, findUserByToken, listDevices } from "./store.ts";
import { allMcpTools } from "./mcp-tools.ts";
import { deviceFetch } from "./device-fetch.ts";

export async function handleMcp(request: Request, env: any): Promise<Response> {
  const auth = String(request.headers.get("authorization") || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const user = token ? await findUserByToken(env, token) : null;
  if (!user || user.role !== "admin") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: admin token required" },
        id: null,
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  if (request.method === "GET") {
    return mcpSseStream();
  }
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Method not allowed" },
        id: null,
      }),
      { status: 405, headers: { "content-type": "application/json" } },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const { method, params, id } = body;
  if (method === "initialize") {
    return mcpJson(
      {
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "vale-gate", version: "0.1.0" },
      },
      id,
    );
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return new Response(null, { status: 202 }); // JSON-RPC 2.0 notifications are not answered; streamable HTTP: 202, empty body
  }
  if (method === "ping") return mcpJson({}, id);
  if (method === "tools/list") {
    return mcpJson({ tools: allMcpTools() }, id);
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const tool = allMcpTools().find((t) => t.name === name);
    if (!tool) return mcpError(-32602, `Unknown tool: ${name}`, id);
    // round-160: models guess device names ("local", "og", "undefined" — 43
    // wasted calls/week). A missing or unmatched name resolves to the device
    // when exactly ONE is registered; with several, the error lists them so
    // the caller can pick instead of guessing again.
    const deviceName = args?.device;
    let device = deviceName ? await getDevice(env, deviceName) : null;
    if (!device) {
      const all = await listDevices(env);
      // audit I6a: a TYPO'D device name silently executed on the one
      // registered device when exactly one existed. Fallback applies only
      // when the caller named NO device.
      if (!deviceName && all.length === 1) device = all[0]!;
      else if (!deviceName)
        return mcpError(
          -32602,
          "No devices registered — register one on the console Devices page first",
          id,
        );
      else
        return mcpError(
          -32602,
          `Unknown device: ${deviceName}. Registered devices: ${all.map((d) => d.name).join(", ")}`,
          id,
        );
    }

    try {
      const result = await callTool(tool, env, device, args);
      return mcpJson({ content: formatResult(result) }, id);
    } catch (e: any) {
      // Stable error code in data (round-55): a flat "-32603 Tool failed: ..."
      // string hides whether the device is offline / the session is gone / a
      // timeout / the extension is offline — the model needs the distinction
      // to retry smartly.
      return mcpError(-32603, `Tool ${name} failed: ${e.message}`, id, e.code);
    }
  }
  return mcpError(-32601, `Method not found: ${method}`, id);
}

/** Browser tools → agent's mcp_client_call → playwright-mcp.
 *   Replaces the old PluginHubDO/extension path. playwright-mcp must run on the device. */
async function callMcpClientBridge(name: string, _env: any, device: any, args: any): Promise<any> {
  const token = device.token || "";
  const base = `https://${device.hostname}`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  // Tool name mapping: gateway name → playwright-mcp name
  const toolMap: Record<string, string> = {
    browser_open: "browser_navigate",
    browser_snapshot: "browser_snapshot",
    browser_screenshot: "browser_take_screenshot",
    browser_click: "browser_click",
    browser_type: "browser_type",
    browser_wait: "browser_wait_for",
    browser_close: "browser_close",
  };
  const pmTool = toolMap[name] || name;
  // round-138: playwright-mcp's new click/type use the {element?, target} protocol
  // (target = a snapshot reference "eN" or a unique selector); the gateway's old declaration took element_ref integers.
  // We translate to target here, so callers' habits don't change; type's text passes through as-is.
  const pmArgs: any = { ...args };
  // Extension audit M2: timeout_secs was forwarded UNCLAMPED and the fetch
  // below had NO signal — a hung playwright-mcp (modal CDP block) pinned the
  // worker request AND an isolate for the platform ceiling. Clamp + bound.
  if (typeof pmArgs.timeout_secs === "number") {
    pmArgs.timeout_secs = Math.min(Math.max(Math.trunc(pmArgs.timeout_secs) || 1, 1), 300);
  }
  const callBudgetMs = ((pmArgs.timeout_secs as number) || 120) * 1000 + 20_000;
  if ((name === "browser_click" || name === "browser_type") && args?.element_ref != null) {
    pmArgs.target = /^e?\d+$/.test(String(args.element_ref))
      ? String(args.element_ref).replace(/^(\d+)$/, "e$1")
      : String(args.element_ref);
    if (!pmArgs.element) pmArgs.element = "target element";
    delete pmArgs.element_ref;
  }
  const invoke = async (): Promise<any> => {
    const res = await fetch(`${base}/api/tools/mcp_client_call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: pmTool, arguments: pmArgs }),
      signal: AbortSignal.timeout(callBudgetMs),
    });
    // The agent's tool API always returns 200 + {ok:false,error,code} (web.rs api_call_tool);
    // the failure info is in the body, so res.ok alone can't be trusted.
    try {
      return await res.json();
    } catch {
      throw new Error(`mcp_client_call failed: ${res.status}`);
    }
  };
  let out = await invoke();
  if (out && out.ok === false) {
    const msg = String(out.error || "");
    // round-118 self-healing: after a device reboot nothing relaunches playwright-mcp and nobody
    // creates a client session — the first browser_* is bound to be "not connected", requiring manual
    // intervention. Here we do start → connect → retry once, so the browser chain self-heals on boot.
    // round-132: "Session not found" is also covered by self-healing — playwright-mcp 0.0.79
    // reclaims sessions server-side after ~15s idle; resending connect restores them.
    if (/not connected|server running|refused|timed out|session not found/i.test(msg)) {
      await fetch(`${base}/api/plugins/playwright/start`, { method: "POST", headers, signal: AbortSignal.timeout(callBudgetMs) });
      await fetch(`${base}/api/tools/mcp_client_connect`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(callBudgetMs) });
      out = await invoke();
    }
    if (out && out.ok === false) {
      throw new Error(String(out.error || "mcp_client_call failed"));
    }
  }
  return out;
}

export async function callTool(tool: any, env: any, device: any, args: any): Promise<any> {
  // round-160: secret_* lives on the DEVICE agent (keyring/file via
  // /api/tools/secret_*), not in the browser extension — the extension route
  // failed 9/9 calls in a week of real usage whenever Chrome wasn't running
  // with the Vale extension. The toolPath map below already had the routes;
  // the dispatcher just never sent secret_* here.
  if (tool.name.startsWith("terminal_") || tool.name.startsWith("secret_")) {
    return callTerminalTool(tool.name, env, device, args);
  }
  // round-161: browser_pw_info / browser_run_script are DEVICE tools (the
  // bundled playwright runner, toolPath map below) — the playwright-mcp
  // bridge rejects them ("Tool browser_pw_info not found", 50% of real DSH
  // calls). Everything else browser_* goes through the bridge.
  if (tool.name === "browser_pw_info" || tool.name === "browser_run_script") {
    return callTerminalTool(tool.name, env, device, args);
  }
  // Browser tools route through Playwright (mcp_client) on the device.
  if (tool.name.startsWith("browser_")) {
    return callMcpClientBridge(tool.name, env, device, args);
  }
  // Browser tools route via PluginHubDO → WS → extension (chrome.debugger) on
  // the device's browser. The DO resolves with the extension's response frame
  // {id, type:"response", ok, result|error}; unwrap to the inner result so
  // formatResult turns {image:...} into an MCP image block.
  const id = env.PLUGIN_HUB.idFromName(device.name);
  const hub = env.PLUGIN_HUB.get(id);
  const headers: Record<string, string> = { "content-type": "application/json" };
  // DO_AUTH gate: the DO 401s any request without x-do-auth when configured —
  // WITHOUT this header the call failed silently (empty success result, no
  // error) and browser tools appeared to do nothing.
  if (env.DO_AUTH) headers["x-do-auth"] = env.DO_AUTH;
  const res = await hub.fetch("https://hub/call", {
    method: "POST",
    headers,
    body: JSON.stringify({ tool: tool.name, params: args, requestId: crypto.randomUUID() }),
  });
  // Never let a failure masquerade as success. Round-115: the DO returns a
  // 500 (plain-text body) when the extension socket closed between the
  // socket check and ws.send — res.json() fails, j={}, and j.result was
  // undefined → a JSON-RPC SUCCESS with no text told the model the browser
  // action ran when nothing executed. Treat every non-2xx as an extension
  // failure.
  if (res.status === 401) throw new Error("hub auth misconfigured (x-do-auth)");
  const j = await res.json().catch(() => ({}));
  if (res.status === 503)
    throw ToolErr(
      EXTENSION_OFFLINE,
      "extension_offline — is the Vale extension running on the device browser?",
    );
  if (res.status < 200 || res.status >= 300) {
    throw ToolErr(
      EXTENSION_OFFLINE,
      `extension unavailable (hub ${res.status}) — is the Vale extension running on the device browser?`,
    );
  }
  if (j.error) throw new Error(`extension error: ${j.error}`);
  return j.result;
}

// Stable error codes (round-55) — carried in the JSON-RPC error data so MCP
// clients can distinguish failure classes and retry smartly.
export const DEVICE_UNREACHABLE = "DEVICE_UNREACHABLE";
export const EXTENSION_OFFLINE = "EXTENSION_OFFLINE";
export const TIMEOUT = "TIMEOUT";
export const SESSION_NOT_FOUND = "SESSION_NOT_FOUND";
export const SESSION_BUSY = "SESSION_BUSY";
export const TOOL_ERROR = "TOOL_ERROR";
function ToolErr(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Terminal tools with stale-session self-healing (round-160). Agent restarts
 * wipe the PTY registry while MCP clients keep holding old session_ids —
 * 153 wasted calls/week bounced "Session not found" back to the model with
 * no recovery path (the browser bridge already had this self-heal; terminal
 * didn't). On SESSION_NOT_FOUND for a session-taking tool: list the device's
 * live sessions and retarget ONCE when exactly one exists; with several,
 * return the list; with none, point at terminal_open. terminal_close on a
 * dead session is a success (the intent was already satisfied).
 */
async function callTerminalTool(name: string, env: any, device: any, args: any): Promise<any> {
  try {
    return await callTerminalToolOnce(name, env, device, args);
  } catch (e: any) {
    if (e.code !== SESSION_NOT_FOUND || !args?.session_id) throw e;
    if (name === "terminal_close") {
      return {
        ok: true,
        note: `session ${args.session_id} was already gone (agent restart?) — nothing to close`,
      };
    }
    const list = await callTerminalToolOnce("terminal_list", env, device, {});
    const live: string[] = (list?.result || list?.sessions || [])
      .map((s: any) => s?.id)
      .filter(Boolean);
    if (live.length === 1 && live[0] !== args.session_id) {
      const data = await callTerminalToolOnce(name, env, device, { ...args, session_id: live[0] });
      return {
        ...data,
        note: `session_id ${args.session_id} was stale (agent restart?) — call retargeted to the live session ${live[0]}`,
      };
    }
    if (live.length === 0) {
      throw ToolErr(
        SESSION_NOT_FOUND,
        `session ${args.session_id} not found and the device has no live sessions — open one with terminal_open first`,
      );
    }
    throw ToolErr(
      SESSION_NOT_FOUND,
      `session ${args.session_id} not found. Live sessions on ${device.name}: ${live.join(", ")} — pass one of these as session_id`,
    );
  }
}

async function callTerminalToolOnce(name: string, env: any, device: any, args: any): Promise<any> {
  // Every terminal tool on the device is reachable here (round-54: only 5 of
  // 16 were mapped — write/read/resize/select/history/list_ports/diag/secret
  // were invisible to MCP clients through the console). Keep in sync with
  // TERMINAL_TOOLS in mcp-tools.js.
  const toolPath: string | undefined = {
    terminal_open: "/api/tools/terminal_open",
    terminal_screen: "/api/tools/terminal_screen",
    terminal_execute: "/api/tools/terminal_execute",
    terminal_write: "/api/tools/terminal_write",
    terminal_read: "/api/tools/terminal_read",
    terminal_resize: "/api/tools/terminal_resize",
    terminal_select: "/api/tools/terminal_select",
    terminal_history: "/api/tools/terminal_history",
    terminal_list: "/api/tools/terminal_list",
    terminal_list_ports: "/api/tools/terminal_list_ports",
    terminal_close: "/api/tools/terminal_close",
    terminal_diag_write: "/api/tools/terminal_diag_write",
    terminal_diag_read: "/api/tools/terminal_diag_read",
    secret_set: "/api/tools/secret_set",
    secret_get: "/api/tools/secret_get",
    secret_delete: "/api/tools/secret_delete",
    terminal_saved_connections: "/api/tools/terminal_saved_connections",
    terminal_connect_saved: "/api/tools/terminal_connect_saved",
    terminal_env: "/api/tools/terminal_env",
    browser_pw_info: "/api/tools/browser_pw_info",
    browser_run_script: "/api/tools/browser_run_script",
  }[name];
  if (!toolPath) throw new Error(`Unknown device tool: ${name}`);
  const body: any = { ...args };
  delete body.device;
  if (name === "terminal_execute") {
    body.command = body.input;
    delete body.input;
    // Default must match the agent (200) — a gateway-side 400 invented a
    // different quiet window than the device actually uses (round-54).
    body.quiet_ms = body.quiet_ms ?? 200;
  }
  const { ok, resp, error } = await deviceFetch(env, device, toolPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp) {
    // Distinct code for a timeout vs a hard unreachable (round-55).
    const code = /timeout/i.test(String(error || "")) ? TIMEOUT : DEVICE_UNREACHABLE;
    throw ToolErr(code, error || "Device unreachable");
  }
  const data: any = await resp.json().catch(() => ({}));
  // round-58: deviceFetch's `ok` is the HTTP status — the agent returns
  // tool errors as HTTP 200 + {"ok":false,"error":...} (web.rs api_call_tool),
  // so the old `if (!ok)` never fired and the error-code mapping below was
  // DEAD CODE: "Session not found" sailed back to the model as a successful
  // tool result. Check the agent's own ok flag.
  if (!ok || data.ok === false) {
    // The agent now ships a typed `code` (round-59: DeviceError variant →
    // stable code); fall back to message-text guessing only for older
    // agents that predate it.
    const msg = data?.error || `Device returned ${resp.status}`;
    const code =
      data?.code === "session_not_found"
        ? SESSION_NOT_FOUND
        : data?.code === "session_busy"
          ? SESSION_BUSY
          : data?.code === "ssh_timeout"
            ? TIMEOUT
            : // round-64: the agent ships NINE typed codes (round-59) but only three
              // were mapped — ssh_connect_failed / serial_port_not_found /
              // serial_port_not_open / invalid_params / keychain / internal ALL fell
              // into DEVICE_UNREACHABLE. A live device reporting "serial port not
              // found" read as "device offline", sending clients on a device-recovery
              // detour instead of fixing the parameter. Any typed code that is not
              // one of the mapped ones is a device-UP tool failure.
              data?.code
              ? TOOL_ERROR
              : /Session not found/i.test(msg)
                ? SESSION_NOT_FOUND
                : /Session busy/i.test(msg)
                  ? SESSION_BUSY
                  : /timed out/i.test(msg)
                    ? TIMEOUT
                    : DEVICE_UNREACHABLE;
    throw ToolErr(code, msg);
  }
  // No heartbeat here (round-54): the agent's own execute wait-loop pings
  // the session every poll, and the panel pings terminal_select every 30s —
  // the MCP path is covered by the execute loop. The gateway simulating
  // presence was a workaround for the old model where output activity kept
  // sessions alive; presence now comes from the agent-side loops only.
  return data;
}

/**
 * Wrap a tool result into MCP content blocks. Terminal tools return JSON/text;
 * browser tools return { image: { data, mimeType } } (base64 PNG) → an MCP
 * image block. Plain objects are stringified so the model sees the full shape.
 */
function formatResult(result: any) {
  if (result && typeof result === "object" && result.image) {
    return [
      { type: "image", data: result.image.data, mimeType: result.image.mimeType || "image/png" },
    ];
  }
  // round-118: the mcp_client bridge returns screenshots as data-URL text (the agent renders image
  // content as "data:image/png;base64,..."); unwrap them back into an MCP image block so the model
  // doesn't chew on a whole screen of base64 text.
  if (
    result &&
    typeof result === "object" &&
    result.ok === true &&
    typeof result.result === "string" &&
    result.result.startsWith("data:image/")
  ) {
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(result.result);
    if (m) return [{ type: "image", mimeType: m[1], data: m[2] }];
  }
  return [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }];
}

function mcpJson(result: any, id: any): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", result, id }), {
    headers: { "content-type": "application/json" },
  });
}
function mcpError(code: number, message: string, id: any, data?: any): Response {
  const error: any = { code, message };
  if (data) error.data = { code: data };
  return new Response(JSON.stringify({ jsonrpc: "2.0", error, id }), {
    headers: { "content-type": "application/json" },
  });
}

function mcpSseStream(): Response {
  const encoder = new TextEncoder();
  let timer: number | null = null;
  const stream = new ReadableStream({
    start(controller) {
      // Keep the timer in the source's closure: `this` in start/cancel is the
      // underlying source, not the controller, so controller._timer would be
      // unreachable from cancel() → leaked interval per ended session.
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // stream already cancelled — a tick racing cancel() must not throw
        }
      }, 15000);
    },
    cancel() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
