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
      return mcpError(-32603, `Tool ${name} failed: ${e.message}`, id);
    }
  }
  return mcpError(-32601, `Method not found: ${method}`, id);
}

async function callTool(tool, env, device, args) {
  if (tool.name.startsWith("terminal_")) {
    return callTerminalTool(tool.name, env, device, args);
  }
  // Browser tools are wired via PluginHubDO in Task 3; until then, a clear error.
  throw new Error("browser tools require the extension channel (task 3)");
}

async function callTerminalTool(name, env, device, args) {
  const toolPath = {
    terminal_open: "/api/tools/terminal_open",
    terminal_screen: "/api/tools/terminal_screen",
    terminal_send: "/api/tools/terminal_execute",
    terminal_list: "/api/tools/terminal_list",
    terminal_close: "/api/tools/terminal_close",
  }[name];
  if (!toolPath) throw new Error(`Unknown terminal tool: ${name}`);
  const body = { ...args };
  delete body.device;
  if (name === "terminal_send") {
    body.command = body.input;
    delete body.input;
    body.quiet_ms = body.quiet_ms ?? 400;
  }
  const { ok, resp } = await deviceFetch(env, device, toolPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp) throw new Error("Device unreachable");
  const data = await resp.json().catch(() => ({}));
  if (!ok) throw new Error(data?.error || `Device returned ${resp.status}`);
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
function mcpError(code, message, id) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }), { headers: { "content-type": "application/json" } });
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
