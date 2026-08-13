/**
 * Minimal MCP (streamable HTTP) server for the gateway — hand-rolled JSON-RPC 2.0,
 * zero deps (the repo's gateway has no runtime dependencies; @modelcontextprotocol/sdk
 * would need a fetch-to-node bridge on Workers). Supports the subset Claude Code
 * uses: initialize, notifications/initialized, ping, tools/list, tools/call.
 * GET returns a keep-alive SSE stream (Claude Code v2.1.84+ probes GET first;
 * 405 is treated as server failure). Stateless.
 */
import { getDevice, findUserByToken } from "./store.js";
import { allMcpTools } from "./mcp-tools.js";
import { deviceFetch } from "./device-fetch.js";

export async function handleMcp(request, env) {
  const auth = String(request.headers.get("authorization") || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const user = token ? await findUserByToken(env, token) : null;
  if (!user || user.role !== "admin") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: admin token required" }, id: null }), { status: 401, headers: { "content-type": "application/json" } });
  }

  if (request.method === "GET") {
    return mcpSseStream();
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Method not allowed" }, id: null }), { status: 405, headers: { "content-type": "application/json" } });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const { method, params, id } = body;
  if (method === "initialize") {
    return mcpJson({
      protocolVersion: params?.protocolVersion || "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "vale-gate", version: "0.1.0" },
    }, id);
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
    const deviceName = args?.device;
    const device = deviceName ? await getDevice(env, deviceName) : null;
    if (!device) return mcpError(-32602, `Unknown device: ${deviceName}`, id);

    try {
      const result = await callTool(tool, env, device, args);
      return mcpJson({ content: formatResult(result) }, id);
    } catch (e) {
      // Stable error code in data (round-55): a flat "-32603 Tool failed: ..."
      // string hides whether the device is offline / the session is gone / a
      // timeout / the extension is offline — the model needs the distinction
      // to retry smartly.
      return mcpError(-32603, `Tool ${name} failed: ${e.message}`, id, e.code);
    }
  }
  return mcpError(-32601, `Method not found: ${method}`, id);
}

export async function callTool(tool, env, device, args) {
  if (tool.name.startsWith("terminal_")) {
    return callTerminalTool(tool.name, env, device, args);
  }
  // Browser tools route via PluginHubDO → WS → extension (chrome.debugger) on
  // the device's browser. The DO resolves with the extension's response frame
  // {id, type:"response", ok, result|error}; unwrap to the inner result so
  // formatResult turns {image:...} into an MCP image block.
  const id = env.PLUGIN_HUB.idFromName(device.name);
  const hub = env.PLUGIN_HUB.get(id);
  const headers = { "content-type": "application/json" };
  // DO_AUTH gate: the DO 401s any request without x-do-auth when configured —
  // WITHOUT this header the call failed silently (empty success result, no
  // error) and browser tools appeared to do nothing.
  if (env.DO_AUTH) headers["x-do-auth"] = env.DO_AUTH;
  const res = await hub.fetch("https://hub/call", {
    method: "POST",
    headers,
    body: JSON.stringify({ tool: tool.name, params: args, requestId: crypto.randomUUID() }),
  });
  // Never let an auth failure masquerade as success.
  if (res.status === 401) throw new Error("hub auth misconfigured (x-do-auth)");
  const j = await res.json().catch(() => ({}));
  if (res.status === 503) throw ToolErr(EXTENSION_OFFLINE, "extension_offline — is the Vale extension running on the device browser?");
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
function ToolErr(code, message) {
  return Object.assign(new Error(message), { code });
}

async function callTerminalTool(name, env, device, args) {
  // Every terminal tool on the device is reachable here (round-54: only 5 of
  // 16 were mapped — write/read/resize/select/history/list_ports/diag/secret
  // were invisible to MCP clients through the console). Keep in sync with
  // TERMINAL_TOOLS in mcp-tools.js.
  const toolPath = {
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
  }[name];
  if (!toolPath) throw new Error(`Unknown terminal tool: ${name}`);
  const body = { ...args };
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
  const data = await resp.json().catch(() => ({}));
  // round-58: deviceFetch's `ok` is the HTTP status — the agent returns
  // tool errors as HTTP 200 + {"ok":false,"error":...} (web.rs api_call_tool),
  // so the old `if (!ok)` never fired and the error-code mapping below was
  // DEAD CODE: "Session not found" sailed back to the model as a successful
  // tool result. Check the agent's own ok flag.
  if (!ok || data.ok === false) {
    // The agent's DeviceError variants surface in the error message
    // ("Session not found: x", "Session busy ...", "SSH ... timed out") —
    // map them to stable codes so the model can decide reopen-vs-retry
    // (round-57; the agent's structured error channel lands next).
    const msg = data?.error || `Device returned ${resp.status}`;
    const code = /Session not found/i.test(msg) ? SESSION_NOT_FOUND
      : /Session busy/i.test(msg) ? SESSION_BUSY
      : /timed out/i.test(msg) ? TIMEOUT
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
function formatResult(result) {
  if (result && typeof result === "object" && result.image) {
    return [{ type: "image", data: result.image.data, mimeType: result.image.mimeType || "image/png" }];
  }
  return [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }];
}

function mcpJson(result, id) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", result, id }), { headers: { "content-type": "application/json" } });
}
function mcpError(code, message, id, data) {
  const error = { code, message };
  if (data) error.data = { code: data };
  return new Response(JSON.stringify({ jsonrpc: "2.0", error, id }), { headers: { "content-type": "application/json" } });
}

function mcpSseStream() {
  const encoder = new TextEncoder();
  let timer = null;
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
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
