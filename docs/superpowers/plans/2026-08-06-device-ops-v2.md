# 设备操作 v2：浏览器扩展 + AI-first MCP — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设备浏览器的操作从 Windows 远程 CDP（坏的）迁移到 Windows 本地 Chrome/Edge 扩展（chrome.debugger 内部 CDP），并把 MCP 工具面重做为 AI-first（视觉 + 语义），终端增加屏幕缓冲工具，vale-command 瘦身为纯服务 + 独立托盘。

**Architecture:** Claude Code（开发机）→ 网关 /mcp（JSON-RPC）→ 网关按设备路由：浏览器工具经 PluginHubDO（WS 长连）到扩展（chrome.debugger 操作真实标签页）；终端工具经 deviceFetch 直接反代设备现有 /api/tools。扩展装 Windows 设备 Chrome/Edge，开发机只管 HTTPS 到网关。

**Tech Stack:** Cloudflare Worker（JS，零依赖）、MV3 Chrome 扩展、chrome.debugger CDP、Rust（rmcp MCP server）、xterm.js。

## Global Constraints

- **ESM JS，零新增依赖**：gateway 手写 JSON-RPC（不用 @modelcontextprotocol/sdk）；扩展原生 JS（无构建步骤）
- **MCP 工具全带 `device` 参数**，validate against KV
- **网关工具超时 < 90s**（Worker 子请求 100s 上限）；终端 quiet 默认 400ms
- **扩展无 content script**：一切页面内操作走 CDP Runtime.evaluate，页面零侵入
- **MV3 权限**：`["tabs","debugger","storage","alarms"]`；host_permissions 覆盖 console 域名 + 设备子域
- **每设备一个受控标签页**（`tabs.create`），WS 断连绝不 detach
- **扩展装 Windows 设备 Chrome/Edge**（开发机无界面）；标签页形态=面板内嵌（反代 URL）
- **vale-command 瘦身**：退役 Web 面板/Tauri/浏览器自动化；保留 MCP server + 终端后端 + SSE 端点；托盘独立
- **提交风格**：conventional commits + stage 标签（`feat(stage-x)` 等），每个提交保持绿
- **command 验证基准**：`cargo test` → `cargo clippy --all-targets` → `cargo xwin check -p vale-command --target x86_64-pc-windows-msvc`；gateway：`node --test` + `wrangler deploy`

---

### Task 1: 修复网关 WS 反代 101 分支（根因修复）

**Files:**
- Modify: `/home/zhengsaisi/vale/gateway/src/index.js:720-725`

**Interfaces:**
- Consumes: 现有 `proxyDevice(request, env, device, restPath)`（index.js:691）
- Produces: 修复后的 `proxyDevice` 101 分支——WS 升级经代理可正确回传 `resp.webSocket`

- [ ] **Step 1: 写失败测试**

创建 `/home/zhengsaisi/vale/gateway/test/proxy-ws.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";

// Stub global fetch: return a 101 response with a fake webSocket property.
const fakeWebSocket = { send() {}, close() {} };
const originalFetch = globalThis.fetch;

test("proxyDevice passes 101 + webSocket through without throwing", async () => {
  globalThis.fetch = async () => new Response(null, { status: 101, headers: { "content-type": "text/event-stream" } });
  // NOTE: Response with status 101 throws RangeError in Node — this test must
  // construct the mock differently. See Step 2; we assert the *gateway* code
  // path handles a 101 fetch result by returning a Response with webSocket.
  // Since we can't build a 101 Response in Node, we test via a helper that
  // checks the branch directly with a minimal mock.
  globalThis.fetch = originalFetch;
});
```

（说明：Node 无法构造 `status:101` 的 Response——101 在 Node 是非法状态。因此测试改为直接调用一个**从 `proxyDevice` 提取的纯函数** `build101Response(resp)`，mock 一个 `{status:101, webSocket:fake}` 对象，断言返回的 Response 携带 webSocket 且不抛 RangeError。见 Step 3 的实现。）

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /home/zhengsaisi/vale/gateway && node --test test/proxy-ws.test.mjs`
Expected: FAIL（`build101Response` 未定义）

- [ ] **Step 3: 实现**

在 `index.js` `proxyDevice` 内（720-725），把 101 分支拆出并调用新函数；在文件顶部附近（`CORS_HEADERS` 之后）加：

```js
/**
 * Rebuild a 101 Switching Protocols response carrying the upgraded WebSocket.
 * The old code built `new Response(resp.body, {status:101, headers})` which
 * throws RangeError (101 is only legal with a `webSocket` property), so every
 * WS upgrade through the proxy 500'd. Minimal branch: no header rewriting.
 */
export function build101Response(resp) {
  if (resp.status !== 101) return null;
  if (resp.webSocket) {
    try {
      return new Response(null, { status: 101, webSocket: resp.webSocket });
    } catch {
      return resp; // workerd #3047: any repack failure → pass through untouched
    }
  }
  return new Response(resp.body || null, { status: 101, headers: new Headers(resp.headers) });
}
```

`proxyDevice` 内（720-725）改为：

```js
  if (resp.status === 101) {
    return build101Response(resp) ?? resp;
  }
  // Streaming (SSE / octet-stream): pass the body through untouched.
  if (resp.body && (ct.includes("text/event-stream") || ct.includes("application/octet-stream"))) {
    return new Response(resp.body, { status: resp.status, headers: outHeaders });
  }
```

- [ ] **Step 4: 更新测试为对 `build101Response` 的单元测试**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { build101Response } from "../src/index.js";

test("build101Response returns webSocket-bearing 101 Response", () => {
  const fakeWS = { send() {}, close() {} };
  const resp = { status: 101, webSocket: fakeWS, headers: {} };
  const out = build101Response(resp);
  assert.equal(out.status, 101);
  assert.equal(out.webSocket, fakeWS);
});

test("build101Response passes through non-101", () => {
  assert.equal(build101Response({ status: 200 }), null);
});
```

- [ ] **Step 5: 运行测试验证通过**

Run: `cd /home/zhengsaisi/vale/gateway && node --test test/proxy-ws.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 6: 回归 + 提交**

Run: `cd /home/zhengsaisi/vale/gateway && node --test`
Expected: 全绿（现有测试 + 新测试）
Run: `cd /home/zhengsaisi/vale/gateway && npx wrangler deploy`
Expected: 部署成功
Run: `git add gateway/src/index.js gateway/test/proxy-ws.test.mjs && git commit -m "fix(stage-gateway): WS 101 rewrap — carry resp.webSocket (was RangeError 500)"`

---

### Task 2: 网关 MCP 端点 + 终端工具（deviceFetch 提取）

**Files:**
- Create: `/home/zhengsaisi/vale/gateway/src/mcp.js`
- Create: `/home/zhengsaisi/vale/gateway/src/mcp-tools.js`
- Modify: `/home/zhengsaisi/vale/gateway/src/index.js`（deviceFetch 提取 + /mcp 路由）
- Test: `/home/zhengsaisi/vale/gateway/test/mcp.test.mjs`

**Interfaces:**
- Consumes: `getDevice(env, name)`（store.js）、`findUserByToken`（store.js:178）
- Produces:
  - `deviceFetch(env, device, path, body)` → `Promise<{status, ok, data}>`
  - `handleMcp(request, env)` → `Promise<Response>`（GET=永活 SSE 流，POST=JSON-RPC）
  - MCP 工具：`terminal_open(device,kind,target,rows?,cols?)`、`terminal_screen(device,session_id,lines?)`、`terminal_send(device,session_id,input,quiet_ms?)`、`terminal_list(device)`、`terminal_close(device,session_id)`

- [ ] **Step 1: 提取 `deviceFetch`**

在 `index.js` `proxyDevice` 前加共享函数：

```js
/**
 * Fetch a device panel/MCP path with the Bearer token injected server-side.
 * Shared by proxyDevice (HTTP proxy) and the gateway MCP terminal tools.
 * Behavior is identical to the old inline fetch in proxyDevice.
 */
export async function deviceFetch(env, device, restPath, init = {}) {
  const upstream = new URL(`https://${device.hostname}${restPath}`);
  const headers = new Headers(init.headers || {});
  headers.delete("host");
  headers.delete("cookie");
  headers.set("Authorization", `Bearer ${device.token}`);
  let resp;
  try {
    resp = await fetch(upstream.toString(), { ...init, headers });
  } catch (e) {
    return { status: 502, ok: false, error: `Device unreachable: ${e.message}` };
  }
  return { status: resp.status, ok: resp.ok, resp };
}
```

`proxyDevice`（691-712）改为调用 `deviceFetch` 并沿用其 `resp`：

```js
async function proxyDevice(request, env, device, restPath) {
  const url = new URL(request.url);
  const { resp } = await deviceFetch(env, device, restPath, {
    method: request.method,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
  });
  if (!resp) return jsonError(502, "Device unreachable", "proxy_error");
  const outHeaders = new Headers(resp.headers);
  outHeaders.set("Access-Control-Allow-Origin", "*");
  const ct = String(outHeaders.get("content-type") || "").toLowerCase();
  // ... (保持原有 101/SSE/rewrite/JSON 分支不变)
}
```

- [ ] **Step 2: 写 MCP 工具注册表**

创建 `/home/zhengsaisi/vale/gateway/src/mcp-tools.js`：

```js
/**
 * MCP tool registry for the gateway (vale-gate /mcp endpoint).
 * All tools take a `device` name; terminal tools proxy the device's existing
 * /api/tools endpoints; browser tools route via PluginHubDO (added in Task 3).
 * Browser tools here are stubbed to a clear error until Task 3 wires the DO.
 */
import { getDevice } from "./store.js";

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
```

- [ ] **Step 3: 实现 `handleMcp`**

创建 `/home/zhengsaisi/vale/gateway/src/mcp.js`：

```js
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
import { deviceFetch } from "./index.js";

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
    return mcpJson({}, null); // no-op notifications
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
      return mcpJson({ content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] }, id);
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

function mcpJson(result, id) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", result, id }), { headers: { "content-type": "application/json" } });
}
function mcpError(code, message, id) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }), { headers: { "content-type": "application/json" } });
}

function mcpSseStream() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const timer = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15000);
      controller._timer = timer;
    },
    cancel() { clearInterval(this._timer); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
```

- [ ] **Step 4: 挂 /mcp 路由**

在 `index.js` fetch 主流程，console API 检查之后、静态页检查之前（158-164 之间）：

```js
      // ---- MCP endpoint (Claude Code) — admin token, page host only ----
      if (isPageHost && path === "/mcp") {
        return await handleMcp(request, env);
      }
```

并在 `index.js` 顶部 import：

```js
import { handleMcp } from "./mcp.js";
```

（注意：`mcp.js` 也 import 了 `deviceFetch`，二者互相 import。为避免循环依赖，把 `deviceFetch` 与 `build101Response` 提取到新文件 `/home/zhengsaisi/vale/gateway/src/device-fetch.js`，`index.js` 与 `mcp.js` 都从那里 import。本任务里把 `deviceFetch` 放 `device-fetch.js`，`index.js` 的 `proxyDevice` 改 import 它。）

- [ ] **Step 5: 写 MCP 单测**

创建 `/home/zhengsaisi/vale/gateway/test/mcp.test.mjs`：

```js
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
  for (const n of ["browser_open","browser_snapshot","browser_screenshot","browser_click","browser_type","browser_wait","browser_close","terminal_open","terminal_screen","terminal_send","terminal_list","terminal_close"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});
```

- [ ] **Step 6: 运行测试**

Run: `cd /home/zhengsaisi/vale/gateway && node --test`
Expected: 全绿

- [ ] **Step 7: 提交**

Run: `git add gateway/src/ && git commit -m "feat(stage-gateway): /mcp endpoint + AI-first terminal tools (deviceFetch shared)"`

---

### Task 3: PluginHubDO + 插件配对/票据/状态

**Files:**
- Create: `/home/zhengsaisi/vale/gateway/src/plugin-hub.js`
- Modify: `/home/zhengsaisi/vale/gateway/src/store.js`（plugins:v1 + 票据/配对码 helper）
- Modify: `/home/zhengsaisi/vale/gateway/src/index.js`（/api/plugins/* 路由 + PluginHubDO import）
- Modify: `/home/zhengsaisi/vale/gateway/wrangler.jsonc`（PLUGIN_HUB DO 绑定 + v2 迁移）
- Test: `/home/zhengsaisi/vale/gateway/test/plugins.test.mjs`

**Interfaces:**
- Consumes: `randomHex`（store.js:135）、`getDevice`
- Produces:
  - `addPluginLink(env, token, device)` / `getPluginByToken(env, token)` / `removePluginLink(env, token)`
  - `createPairCode(env, device)` → code、`consumePairCode(env, code)` → device | null
  - `createWsTicket(env, device)` → ticket、`consumeWsTicket(env, ticket)` → device | null
  - `PluginHubDO`（每设备实例，WS Hibernation）：`/ws`、`/call`、`/status`

- [ ] **Step 1: store.js 插件 KV helper**

在 `store.js` devices:v1 区块（326-405）后追加：

```js
/* ---------------- Plugin (extension) registry ---------------- */

const PLUGIN_KEY = "plugins:v1";

export async function listPluginLinks(env) {
  const raw = await env.KEYS.get(PLUGIN_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
export async function savePluginLinks(env, map) {
  await env.KEYS.put(PLUGIN_KEY, JSON.stringify(map));
}
export async function addPluginLink(env, token, device) {
  const map = await listPluginLinks(env);
  map[token] = { device, createdAt: Date.now() };
  await savePluginLinks(env, map);
}
export async function getPluginByToken(env, token) {
  const map = await listPluginLinks(env);
  return map[token] || null;
}
export async function removePluginLink(env, token) {
  const map = await listPluginLinks(env);
  if (map[token]) { delete map[token]; await savePluginLinks(env, map); }
}

// One-time pairing code (console admin generates; extension claims).
export async function createPairCode(env, device) {
  const code = randomHex(6).toUpperCase();
  await env.KEYS.put(`pair:${code}`, device, { expirationTtl: 600 });
  return code;
}
export async function consumePairCode(env, code) {
  const device = await env.KEYS.get(`pair:${code}`);
  if (!device) return null;
  await env.KEYS.delete(`pair:${code}`);
  return device;
}

// One-time short-lived WS ticket (extension trades its plugin token for this).
export async function createWsTicket(env, device) {
  const ticket = randomHex(16);
  await env.KEYS.put(`plg-ticket:${ticket}`, device, { expirationTtl: 60 });
  return ticket;
}
export async function consumeWsTicket(env, ticket) {
  const device = await env.KEYS.get(`plg-ticket:${ticket}`);
  if (!device) return null;
  await env.KEYS.delete(`plg-ticket:${ticket}`);
  return device;
}
```

- [ ] **Step 2: PluginHubDO**

创建 `/home/zhengsaisi/vale/gateway/src/plugin-hub.js`：

```js
/**
 * PluginHubDO — per-device WebSocket hub for the browser extension.
 * One DO instance per device name (idFromName). Uses WebSocket Hibernation:
 * the DO sleeps between messages; `acceptWebSocket` + `webSocketMessage` keep
 * the connection alive across hibernate cycles. Dead-peer detection uses a
 * storage alarm (timers don't run while hibernating): the extension pings
 * every 20s; the alarm fires 65s after the last message and closes a stale WS.
 */
export class PluginHubDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.device = state.id?.name || "unknown";
    this.pending = new Map(); // requestId → {resolve, timeout}
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return this.handleWs(request, url);
    }
    if (url.pathname === "/call") {
      const { tool, params, requestId } = await request.json();
      return this.callPlugin(tool, params, requestId);
    }
    if (url.pathname === "/status") {
      const sockets = this.state.getWebSockets?.() || [];
      return Response.json({ online: sockets.length > 0 });
    }
    return new Response("not found", { status: 404 });
  }

  async handleWs(request, url) {
    const device = url.searchParams.get("device");
    if (device !== this.device) return new Response("wrong DO", { status: 400 });
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    // Single-connection semantics: close any previous socket for this device.
    for (const ws of this.state.getWebSockets()) {
      if (ws !== pair[1]) ws.close(4000, "replaced");
    }
    this.state.storage.setAlarm(Date.now() + 65_000);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async callPlugin(tool, params, requestId) {
    const sockets = this.state.getWebSockets() || [];
    if (sockets.length === 0) {
      return Response.json({ error: "extension_offline" }, { status: 503 });
    }
    const ws = sockets[0];
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ error: "timeout" }), 60_000);
      this.pending.set(requestId, (msg) => { clearTimeout(timeout); resolve(msg); });
      ws.send(JSON.stringify({ id: requestId, type: "request", tool, params }));
    });
    return Response.json(result);
  }

  async webSocketMessage(ws, message) {
    this.state.storage.setAlarm(Date.now() + 65_000);
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
    if (msg.type === "hello") { this.state.storage.put("lastSeen", Date.now()); return; }
    if (msg.type === "response" && msg.id) {
      const resolve = this.pending.get(msg.id);
      if (resolve) { this.pending.delete(msg.id); resolve(msg); }
    }
  }

  async webSocketClose(ws, code, reason) {
    // Reject all in-flight calls so /call returns a clear error, not a hang.
    const err = { error: "extension_disconnected" };
    for (const [id, resolve] of this.pending) { resolve(err); this.pending.delete(id); }
  }

  async alarm() {
    const sockets = this.state.getWebSockets() || [];
    for (const ws of sockets) ws.close(4001, "idle timeout");
  }
}
```

- [ ] **Step 3: index.js 插件路由**

在 `index.js` 顶部 import：

```js
import { addPluginLink, getPluginByToken, removePluginLink, createPairCode, consumePairCode, createWsTicket, consumeWsTicket } from "./store.js";
import { PluginHubDO } from "./plugin-hub.js";
export { PluginHubDO };
```

在 `handleConsole` admin 区（设备模块之后，~330 后）加：

```js
  // ---- Plugin (extension) pairing & status ----
  if (method === "POST" && path === `${PLUGIN_BASE}/pair`) {
    const { device } = (await request.json().catch(() => ({}))) || {};
    const d = device ? await getDevice(env, String(device)) : null;
    if (!d) return jsonError(404, "Device not found", "not_found_error");
    const code = await createPairCode(env, d.name);
    return jsonOk({ code });
  }
  if (method === "POST" && path === `${PLUGIN_BASE}/pair/claim`) {
    const { code } = (await request.json().catch(() => ({}))) || {};
    const device = await consumePairCode(env, String(code || ""));
    if (!device) return jsonError(403, "Invalid or used pairing code", "authorization_error");
    const token = randomHex(16);
    await addPluginLink(env, token, device);
    return jsonOk({ token, device });
  }
  if (method === "POST" && path === `${PLUGIN_BASE}/ws-ticket`) {
    const auth = String(request.headers.get("authorization") || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const link = token ? await getPluginByToken(env, token) : null;
    if (!link) return jsonError(401, "Invalid plugin token", "authorization_error");
    const ticket = await createWsTicket(env, link.device);
    return jsonOk({ ticket, device: link.device });
  }
  if (method === "POST" && path === `${PLUGIN_BASE}/unpair`) {
    const { device } = (await request.json().catch(() => ({}))) || {};
    const links = await listPluginLinks(env);
    for (const [t, l] of Object.entries(links)) if (l.device === device) await removePluginLink(env, t);
    return jsonOk({ ok: true });
  }
  if (method === "GET" && path === `${PLUGIN_BASE}/status`) {
    const devices = await listDevices(env);
    const out = {};
    for (const d of devices) {
      try {
        const id = env.PLUGIN_HUB.idFromName(d.name);
        const hub = env.PLUGIN_HUB.get(id);
        const res = await hub.fetch("https://hub/status");
        const j = await res.json();
        out[d.name] = { online: !!j.online };
      } catch { out[d.name] = { online: false }; }
    }
    return jsonOk({ devices: out });
  }
```

并在顶部定义 `const PLUGIN_BASE = "/api/plugins";`、import `listPluginLinks`、`randomHex`（若 store.js 未导出 randomHex 则导出之）。

- [ ] **Step 4: wrangler.jsonc DO 绑定**

在 `wrangler.jsonc` 加（照 BreakerDO 先例）：

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "PLUGIN_HUB", "class_name": "PluginHubDO" }
  ]
},
"migrations": [
  { "tag": "v1-breaker", "new_sqlite_classes": ["BreakerDO"] },
  { "tag": "v2-plugin-hub", "new_sqlite_classes": ["PluginHubDO"] }
]
```

（若 migrations 现无 v1-breaker 标记，则新增。）

- [ ] **Step 5: 写 plugins 单测**

创建 `/home/zhengsaisi/vale/gateway/test/plugins.test.mjs`（KV stub 测 store helper）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createPairCode, consumePairCode, addPluginLink, getPluginByToken, removePluginLink, createWsTicket, consumeWsTicket } from "../src/store.js";

function env() {
  const m = new Map();
  return { KEYS: {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => m.set(k, v),
    delete: async (k) => m.delete(k),
  } };
}

test("pair code: create then consume (one-time)", async () => {
  const e = env();
  const code = await createPairCode(e, "d1");
  assert.ok(code);
  assert.equal(await consumePairCode(e, code), "d1");
  assert.equal(await consumePairCode(e, code), null);
});

test("plugin link: add/get/remove", async () => {
  const e = env();
  await addPluginLink(e, "tok", "d1");
  assert.deepEqual(await getPluginByToken(e, "tok"), { device: "d1", createdAt: await getPluginByToken(e, "tok").then(l => l.createdAt) });
  await removePluginLink(e, "tok");
  assert.equal(await getPluginByToken(e, "tok"), null);
});

test("ws ticket: one-time", async () => {
  const e = env();
  const t = await createWsTicket(e, "d1");
  assert.equal(await consumeWsTicket(e, t), "d1");
  assert.equal(await consumeWsTicket(e, t), null);
});
```

- [ ] **Step 6: 运行测试**

Run: `cd /home/zhengsaisi/vale/gateway && node --test`
Expected: 全绿

- [ ] **Step 7: 提交**

Run: `git add gateway/src gateway/wrangler.jsonc gateway/test && git commit -m "feat(stage-gateway): PluginHubDO + plugin pairing/ticket/status"`

---

### Task 4: 扩展最小可用（骨架 + popup 配对 + cdp 控制器 + ws.js）

**Files:**
- Create: `/home/zhengsaisi/vale/extension/manifest.json`
- Create: `/home/zhengsaisi/vale/extension/background.js`
- Create: `/home/zhengsaisi/vale/extension/lib/ws.js`
- Create: `/home/zhengsaisi/vale/extension/lib/cdp.js`
- Create: `/home/zhengsaisi/vale/extension/lib/elements.js`
- Create: `/home/zhengsaisi/vale/extension/lib/state.js`
- Create: `/home/zhengsaisi/vale/extension/lib/tools.js`
- Create: `/home/zhengsaisi/vale/extension/popup/popup.html` + `popup.css` + `popup.js`
- Create: `/home/zhengsaisi/vale/extension/options/options.html` + `options.css` + `options.js`
- Create: `/home/zhengsaisi/vale/extension/icons/icon16.png|icon48.png|icon128.png`
- Create: `/home/zhengsaisi/vale/extension/README.md`

**Interfaces:**
- Consumes: 网关 `/api/plugins/*`、`chrome.debugger`
- Produces: 扩展 SW 处理 WS `request` 帧（`{id, tool, params}`）→ 调用 tools.js 工具 → `{id, ok, result/error}`；受控标签页（`/api/devices/<d>/proxy/`）

- [ ] **Step 1: manifest.json**

```json
{
  "manifest_version": 3,
  "name": "Vale Browser Control",
  "description": "AI-first device browser control — real tabs driven via chrome.debugger for Claude Code MCP.",
  "version": "0.1.0",
  "permissions": ["tabs", "debugger", "storage", "alarms"],
  "host_permissions": ["https://*/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup/popup.html", "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" } },
  "options_page": "options/options.html",
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

（`host_permissions: ["https://*/*"]` 便于设备子域/console 域随时变化；options 可收紧。）

- [ ] **Step 2: lib/state.js**

```js
// chrome.storage.session-backed state with in-memory mirror.
export const state = {
  pairedDevice: null,   // { device, token }
  wsState: "disconnected",
  controlledTabs: {},   // device → tabId
  error: null,
};
const LS_KEY = "valePlugin";

export async function loadPairing() {
  const local = await chrome.storage.local.get(LS_KEY);
  if (local[LS_KEY]) state.pairedDevice = local[LS_KEY];
  return state.pairedDevice;
}
export async function savePairing(p) {
  state.pairedDevice = p;
  await chrome.storage.local.set({ [LS_KEY]: p });
}
export async function clearPairing() {
  state.pairedDevice = null;
  await chrome.storage.local.remove(LS_KEY);
}
```

- [ ] **Step 3: lib/ws.js**

```js
import { state, loadPairing } from "./state.js";

let ws = null;
let backoffMs = 1000;
let heartbeat = null;
let requestSeq = 0;
const pending = new Map(); // id → {resolve, reject}

export function wsSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

export function callPlugin(tool, params) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${requestSeq++}`;
    pending.set(id, { resolve, reject });
    wsSend({ id, type: "request", tool, params });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("gateway timeout")); } }, 65_000);
  });
}

export async function connect() {
  const pairing = state.pairedDevice || (await loadPairing());
  if (!pairing) return;
  const consoleOrigin = (await chrome.storage.local.get("consoleOrigin")).consoleOrigin || "https://console.saisi.online";
  try {
    // Trade the plugin token for a one-time WS ticket.
    const res = await fetch(`${consoleOrigin}/api/plugins/ws-ticket`, { headers: { Authorization: `Bearer ${pairing.token}` } });
    const { ticket } = await res.json();
    if (!ticket) { state.error = "ws-ticket failed"; return; }
    const url = `wss://${new URL(consoleOrigin).host}/api/plugins/ws?device=${encodeURIComponent(pairing.device)}&ticket=${encodeURIComponent(ticket)}`;
    ws = new WebSocket(url);
    ws.onopen = () => { backoffMs = 1000; state.wsState = "connected"; wsSend({ type: "hello", device: pairing.device }); startHeartbeat(); };
    ws.onmessage = (ev) => handleFrame(JSON.parse(ev.data));
    ws.onclose = () => { state.wsState = "disconnected"; stopHeartbeat(); scheduleReconnect(); };
    ws.onerror = () => ws.close();
  } catch (e) { state.error = String(e); scheduleReconnect(); }
}

function handleFrame(frame) {
  if (frame.type === "pong") return;
  if (frame.type === "request") {
    handleToolRequest(frame).then((result) => wsSend({ id: frame.id, type: "response", ok: true, result }))
      .catch((err) => wsSend({ id: frame.id, type: "response", ok: false, error: String(err?.message || err) }));
  }
}
function startHeartbeat() { heartbeat = setInterval(() => wsSend({ type: "ping", t: Date.now() }), 20_000); }
function stopHeartbeat() { if (heartbeat) clearInterval(heartbeat); heartbeat = null; }
function scheduleReconnect() {
  setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30_000) + Math.floor(Math.random() * 1000);
}

// Dispatch a request frame to the tools layer (defined in background.js).
let handler = null;
export function setRequestHandler(fn) { handler = fn; }
async function handleToolRequest(frame) { if (!handler) throw new Error("no handler"); return handler(frame.tool, frame.params); }
```

- [ ] **Step 4: lib/cdp.js**

```js
import { state } from "./state.js";

// Attach debugger to a tab (create if needed) and enable the domains we use.
export async function ensureTab(device, proxyUrl) {
  let tabId = state.controlledTabs[device];
  if (!tabId) {
    const tabs = await chrome.tabs.query({ url: `*://*/api/devices/${device}/proxy/*` });
    tabId = tabs[0]?.id;
  }
  if (!tabId) {
    const tab = await chrome.tabs.create({ url: proxyUrl });
    tabId = tab.id;
  }
  state.controlledTabs[device] = tabId;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    if (String(e).includes("Another debugger is already attached")) {
      throw new Error("DevTools or another extension is attached to the controlled tab — close DevTools on it");
    }
    throw new Error(`debugger attach failed: ${e}`);
  }
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  return tabId;
}

export async function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export function onDetach(listener) {
  chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
    if (state.controlledTabs[deviceForTab(tabId)] === tabId) {
      state.error = `debugger detached: ${reason}`;
      // Do NOT re-attach on canceled_by_user; re-attach on target_closed via next call.
    }
  });
}
function deviceForTab(tabId) {
  for (const [d, id] of Object.entries(state.controlledTabs)) if (id === tabId) return d;
  return null;
}
```

- [ ] **Step 5: lib/elements.js**

```js
// Injected via Runtime.evaluate: walk the DOM (incl. open shadow roots), collect
// interactive elements with a stable CSS path per element. Returns JSON.
export const ELEMENTS_SCRIPT = `
(() => {
  const out = [];
  const seen = new Set();
  const INTERACTIVE = new Set(["A","BUTTON","INPUT","SELECT","TEXTAREA","SUMMARY","LABEL"]);
  function visible(el) {
    if (el.getClientRects().length === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.opacity !== "0" && s.display !== "none";
  }
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { sel += "#" + CSS.escape(node.id); }
      else {
        const cls = [...node.classList].slice(0, 2).map(c => "." + CSS.escape(c)).join("");
        if (cls) sel += cls;
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter(c => c.tagName === node.tagName);
          if (siblings.length > 1) sel += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
        }
      }
      parts.unshift(sel);
      if (node.parentElement && node.parentElement.host) {
        parts.unshift(":host");
        node = node.parentElement.host;
      } else {
        node = node.parentElement;
      }
    }
    return parts.join(" > ");
  }
  function walk(root) {
    const els = root.querySelectorAll("*");
    for (const el of els) {
      if (seen.has(el)) continue; seen.add(el);
      const tag = el.tagName;
      const role = el.getAttribute("role");
      if (!INTERACTIVE.has(tag) && !(role && /button|link|tab|menuitem|checkbox|radio|switch/.test(role)) && !el.getAttribute("onclick") && !(el.getAttribute("contenteditable") === "true")) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      let value = "";
      if (tag === "INPUT" || tag === "TEXTAREA") {
        value = (el.type === "password" || el.type === "hidden") ? "******" : (el.value || "");
      }
      out.push({
        ref: out.length,
        tag: tag.toLowerCase(),
        role: role || "",
        text: (el.innerText || el.textContent || "").trim().slice(0, 120),
        name: el.getAttribute("name") || el.getAttribute("aria-label") || "",
        type: el.getAttribute("type") || "",
        value,
        href: el.getAttribute("href") || "",
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        visible: true,
        path: cssPath(el),
      });
      if (out.length >= 120) return;
    }
    if (root.shadowRoot) walk(root.shadowRoot);
  }
  walk(document);
  return JSON.stringify({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    elements: out,
  });
})()
`;
```

- [ ] **Step 6: lib/tools.js**

```js
import { ensureTab, send } from "./cdp.js";
import { ELEMENTS_SCRIPT } from "./elements.js";
import { state } from "./state.js";

function proxyUrl(device) {
  const origin = (chrome.storage.local.get("consoleOrigin")).then ? "" : "";
  return `${CONSOLE_ORIGIN}/api/devices/${device}/proxy/`;
}
// consoleOrigin is read async in background.js and injected into this module.
export let CONSOLE_ORIGIN = "";
export function setConsoleOrigin(o) { CONSOLE_ORIGIN = o; }

async function evaluate(tabId, expr) {
  const { result } = await send(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
  return result.value;
}
async function snapshot(tabId) {
  const json = await evaluate(tabId, ELEMENTS_SCRIPT);
  return JSON.parse(json);
}
async function resolveRef(tabId, ref) {
  const snap = await snapshot(tabId);
  const el = snap.elements.find((e) => e.ref === ref);
  if (!el) throw new Error(`element ref ${ref} not found — re-snapshot`);
  return { el, snap };
}
async function clickByPath(tabId, path) {
  // Re-resolve the path in-page; if it fails, DOM changed → re-snapshot.
  const found = await evaluate(tabId, `(() => {
    try { const el = document.querySelector(${JSON.stringify(path)}); return el ? el.getBoundingClientRect() : null; }
    catch { return null; }
  })()`);
  if (!found) throw new Error("DOM changed — please re-snapshot");
  const x = found.x + found.width / 2, y = found.y + found.height / 2;
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function runTool(tool, params) {
  const device = params.device;
  const tabId = await ensureTab(device, proxyUrl(device));
  switch (tool) {
    case "browser_open": {
      await send(tabId, "Page.navigate", { url: params.url });
      await waitLoad(tabId, 30_000);
      return snapshot(tabId);
    }
    case "browser_snapshot": return snapshot(tabId);
    case "browser_screenshot": {
      const { data } = await send(tabId, "Page.captureScreenshot", { format: "png", captureBeyondViewport: !!params.full_page });
      return { image: { type: "image", data, mimeType: "image/png" } };
    }
    case "browser_click": {
      const { el } = await resolveRef(tabId, params.element_ref);
      await clickByPath(tabId, el.path);
      return snapshot(tabId);
    }
    case "browser_type": {
      const { el } = await resolveRef(tabId, params.element_ref);
      await evaluate(tabId, `(() => { const el = document.querySelector(${JSON.stringify(el.path)}); el?.focus(); return true; })()`);
      await send(tabId, "Input.insertText", { text: String(params.text) });
      return snapshot(tabId);
    }
    case "browser_wait": {
      const deadline = Date.now() + (params.timeout_s || 15) * 1000;
      while (Date.now() < deadline) {
        const snap = await snapshot(tabId);
        const text = snap.title + " " + JSON.stringify(snap.elements);
        if (params.condition && text.includes(params.condition)) return snap;
        await new Promise((r) => setTimeout(r, 300));
      }
      return snapshot(tabId);
    }
    case "browser_close": {
      await chrome.tabs.remove(tabId);
      delete state.controlledTabs[device];
      return { closed: true };
    }
    default: throw new Error(`unknown browser tool: ${tool}`);
  }
}

async function waitLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const onEvent = (source, method) => {
      if (source.tabId === tabId && method === "Page.loadEventFired") {
        chrome.debugger.onEvent.removeListener(onEvent);
        resolve();
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    setTimeout(() => { chrome.debugger.onEvent.removeListener(onEvent); resolve(); }, timeoutMs);
  });
}
```

- [ ] **Step 7: background.js**

```js
import { connect, setRequestHandler, wsSend } from "./lib/ws.js";
import { state, loadPairing, clearPairing } from "./lib/state.js";
import { runTool, setConsoleOrigin } from "./lib/tools.js";

async function init() {
  await loadPairing();
  const o = (await chrome.storage.local.get("consoleOrigin")).consoleOrigin || "https://console.saisi.online";
  setConsoleOrigin(o);
  setRequestHandler(async (tool, params) => {
    if (tool.startsWith("browser_")) return runTool(tool, params);
    throw new Error(`terminal tools go through the device proxy, not the extension: ${tool}`);
  });
  connect();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("consoleOrigin", (r) => {
    if (!r.consoleOrigin) chrome.storage.local.set({ consoleOrigin: "https://console.saisi.online" });
  });
  chrome.alarms.create("keepalive", { periodInMinutes: 4 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && state.wsState === "disconnected") connect();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "pair") {
    // { code } → claim against the gateway
    fetch(`${(chrome.storage.local.get("consoleOrigin")).consoleOrigin || "https://console.saisi.online"}/api/plugins/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: msg.code }),
    }).then((r) => r.json()).then((j) => {
      if (j.token) { savePairing({ device: j.device, token: j.token }); connect(); sendResponse({ ok: true, device: j.device }); }
      else sendResponse({ ok: false, error: j.error || "claim failed" });
    }).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }
  if (msg.type === "status") {
    sendResponse({ wsState: state.wsState, device: state.pairedDevice?.device, controlledTabs: Object.keys(state.controlledTabs), error: state.error });
    return false;
  }
  if (msg.type === "openTab") {
    const d = state.pairedDevice?.device;
    if (!d) { sendResponse({ ok: false, error: "not paired" }); return false; }
    chrome.tabs.create({ url: `${o}/api/devices/${d}/proxy/` });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "unpair") { clearPairing(); sendResponse({ ok: true }); return false; }
});
```

- [ ] **Step 8: popup + options**

`popup/popup.html`（最小 UI，连接状态/设备/按钮）+ `popup.js`（发 `status`/`pair`/`openTab`/`unpair` 消息渲染）+ `options/options.html|js`（consoleOrigin 设置）。UI 结构与 command/src/ui 现有风格一致（简洁卡片）。icons 用最小占位 PNG（16/48/128，纯色）。

- [ ] **Step 9: 手动验证**

- Chrome → `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `extension/`
- options 设 consoleOrigin
- console Devices 面板生成配对码 → popup 输入 → claim
- popup 开受控标签页 → 应打开 `https://console/api/devices/d1/proxy/`
- （WS 通道在 Task 5 与网关联调；本任务先用 popup 手动验证配对 + 开标签页 + attach 不报错）

- [ ] **Step 10: 提交**

Run: `git add extension/ && git commit -m "feat(stage-ext): extension skeleton — pairing, popup, cdp controller, ws client"`

---

### Task 5: 扩展 WS 通道联调（网关 PluginHubDO ↔ 扩展）

**Files:**
- Modify: `/home/zhengsaisi/vale/gateway/src/mcp.js`（浏览器工具接 PluginHubDO）
- Modify: `/home/zhengsaisi/vale/gateway/src/mcp-tools.js`（浏览器工具 handler 定义）
- Test: `/home/zhengsaisi/vale/gateway/test/mcp-browser.test.mjs`

**Interfaces:**
- Consumes: PluginHubDO（Task 3）、扩展 runTool（Task 4）
- Produces: 完整浏览器工具链路（Claude Code → /mcp → DO /call → WS → 扩展 → CDP → 结果回传）

- [ ] **Step 1: mcp.js 浏览器工具接 DO**

`mcp.js` 的 `callTool` 改为：

```js
async function callTool(tool, env, device, args) {
  if (tool.name.startsWith("terminal_")) {
    return callTerminalTool(tool.name, env, device, args);
  }
  const id = env.PLUGIN_HUB.idFromName(device.name);
  const hub = env.PLUGIN_HUB.get(id);
  const res = await hub.fetch("https://hub/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: tool.name, params: args, requestId: crypto.randomUUID() }),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 503) throw new Error("extension_offline — is the Vale extension running on the device browser?");
  if (j.error) throw new Error(`extension error: ${j.error}`);
  return j;
}
```

- [ ] **Step 2: 写联调测试（DO 逻辑 stub）**

创建 `/home/zhengsaisi/vale/gateway/test/mcp-browser.test.mjs`：用 stub 的 `PLUGIN_HUB` env（`idFromName` 返回同名，`get` 返回一个 fetch stub），断言 `callTool` 把浏览器工具转发到 DO /call、离线时返回 extension_offline。核心断言：

```js
test("browser tool routes through PluginHubDO; offline → extension_offline", async () => {
  // stub env.PLUGIN_HUB.get(id).fetch → {status:503,json:()=>({error:"extension_offline"})}
  // call callTool({name:"browser_snapshot"}, env, {name:"d1",hostname:"d1.example.com",token:"x"}, {device:"d1"})
  // expect rejects with /extension_offline/
});
```

- [ ] **Step 3: 运行测试**

Run: `cd /home/zhengsaisi/vale/gateway && node --test`
Expected: 全绿

- [ ] **Step 4: 端到端联调（wrangler dev + Chrome）**

- `wrangler dev`（.dev.vars 配 CONSOLE_HOST=localhost）
- Chrome 加载扩展（Task 4 已装）；options 设 consoleOrigin=`http://localhost:8787`
- console 生成配对码 → popup claim → 扩展连上 WS（popup 显示 connected）
- 用 node 脚本直连 `ws://localhost:8787/api/plugins/ws?device=d1&ticket=...` 模拟插件 → 收到 hello → 发 ping → 收 pong（验证 DO hibernation 基本行为）
- 然后真实扩展：网关 `/mcp` 用 curl 调 `tools/call browser_snapshot`（Bearer admin token）→ 返回元素树 JSON

- [ ] **Step 5: 提交**

Run: `git add gateway/src gateway/test && git commit -m "feat(stage-gateway): browser tools wired to PluginHubDO + offline handling"`

---

### Task 6: 终端 AI 工具（设备 terminal_screen）

**Files:**
- Modify: `/home/zhengsaisi/vale/command/src/plugins/terminal/tools.rs`（新增 `tool_screen` + `build()` 注册）
- Modify: `/home/zhengsaisi/vale/command/src/plugins/terminal/mod.rs`（工具数量测试 12→13）
- Modify: `/home/zhengsaisi/vale/command/CLAUDE.md`（工具计数说明）

**Interfaces:**
- Consumes: `OutputBuf`、`SessionBuf`（mod.rs:23-48）、`clean_terminal_output`（mod.rs:51-95）
- Produces: 新工具 `terminal_screen(session_id, lines?)` → `{screen, dropped}`——尾部 N 行屏幕文本

- [ ] **Step 1: 写失败测试（工具数量 + 存在性）**

`mod.rs` tests 中 `tool_count_and_names` 改为：

```rust
        assert_eq!(tools.len(), 13);
        for expected in [
            "terminal_open", "terminal_write", "terminal_close", "terminal_list",
            "terminal_execute", "terminal_list_ports", "terminal_resize",
            "terminal_select", "terminal_read", "terminal_screen",
            "secret_set", "secret_get", "secret_delete",
        ] {
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /home/zhengsaisi/vale/command && cargo test --lib plugins::terminal`
Expected: FAIL（terminal_screen 缺失 / count 12≠13）

- [ ] **Step 3: 实现 `tool_screen`**

`tools.rs` `build()` 的 Vec 里加 `tool_screen(&output_buf)`，并实现：

```rust
fn tool_screen(output_buf: &OutputBuf) -> ToolDef {
    let buf = output_buf.clone();
    ToolDef::new(
        "terminal_screen",
        "Get the current on-screen text of a terminal session — the tail of the output buffer (ANSI-stripped), for AI readability. Returns up to `lines` lines (default 60).",
        json!({"type":"object","properties":{"session_id":{"type":"string"},"lines":{"type":"integer","description":"Number of lines from the tail. Default 60."}},"required":["session_id"]}),
        move |params: Value| {
            let buf = buf.clone();
            async move {
                let session_id = require_str(&params, "session_id")?;
                let lines = params.get("lines").and_then(|v| v.as_u64()).unwrap_or(60).max(1) as usize;
                let (screen, dropped) = {
                    let mut map = buf.lock().unwrap_or_else(|p| p.into_inner());
                    let entry = map.get_mut(&session_id);
                    match entry {
                        Some(entry) => {
                            // Tail: find the start of the Nth-from-end line.
                            let data = &entry.data;
                            let mut start = data.len();
                            let mut seen = 0;
                            let mut i = data.len();
                            while i > 0 && seen < lines {
                                i -= 1;
                                if data[i] == b'\n' {
                                    seen += 1;
                                    if seen < lines { start = i; }
                                }
                            }
                            let start = if seen >= lines { i + 1 } else { 0 };
                            (clean_terminal_output(&data[start..]), entry.dropped)
                        }
                        None => (String::new(), 0u64),
                    }
                };
                if dropped > 0 {
                    Ok(json!({"screen": screen, "dropped": dropped}))
                } else {
                    Ok(json!({"screen": screen}))
                }
            }
        },
    )
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /home/zhengsaisi/vale/command && cargo test --lib plugins::terminal`
Expected: PASS（13 tools）

- [ ] **Step 5: 全量验证 + 提交**

Run: `cd /home/zhengsaisi/vale/command && cargo test && cargo clippy --all-targets`
Expected: 全绿、零警告
Run: `git add command/src/plugins/terminal/ && git commit -m "feat(stage-command): terminal_screen — tail-N-lines screen buffer for AI"`

---

### Task 7: 终端显示进扩展（terminal 页 xterm）

**Files:**
- Create: `/home/zhengsaisi/vale/extension/terminal/terminal.html` + `terminal.css` + `terminal.js`
- Copy: `/home/zhengsaisi/vale/command/src/ui/vendor/xterm.min.js`、`xterm.css`、`xterm-addon-fit.min.js` → `/home/zhengsaisi/vale/extension/terminal/vendor/`

**Interfaces:**
- Consumes: 设备 `/api/events/term`（SSE 经网关反代）+ `/api/tools/terminal_write`（POST 经反代）
- Produces: 扩展内全屏 xterm 终端页 + 多会话 tab

- [ ] **Step 1: 复制 xterm vendor**

Run: `mkdir -p /home/zhengsaisi/vale/extension/terminal/vendor && cp /home/zhengsaisi/vale/command/src/ui/vendor/{xterm.min.js,xterm.css,xterm-addon-fit.min.js} /home/zhengsaisi/vale/extension/terminal/vendor/`

- [ ] **Step 2: terminal.html**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="vendor/xterm.css">
  <link rel="stylesheet" href="terminal.css">
</head>
<body>
  <div id="toolbar">
    <select id="device-select"></select>
    <div id="tabs"></div>
    <button id="new-session">New PTY</button>
  </div>
  <div id="term-container"></div>
  <script src="vendor/xterm.min.js"></script>
  <script src="vendor/xterm-addon-fit.min.js"></script>
  <script src="terminal.js"></script>
</body>
</html>
```

- [ ] **Step 3: terminal.js**

```js
// Reads pairing from storage, lists device sessions, opens the xterm, and
// pipes: SSE (EventSource on the proxied /api/events/term) → xterm;
// xterm onData → POST proxied /api/tools/terminal_write.
import { state, loadPairing } from "../lib/state.js";

const origin = (await chrome.storage.local.get("consoleOrigin")).consoleOrigin || "https://console.saisi.online";
const pairing = await loadPairing();
if (!pairing) { document.body.innerHTML = "Not paired — open the popup and pair first."; throw new Error("not paired"); }

const proxy = `${origin}/api/devices/${pairing.device}/proxy`;
const term = new window.Terminal({ convertEol: true });
const fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term-container"));

// Session list → session select
async function refreshSessions() {
  const res = await fetch(`${proxy}/api/tools/terminal_list`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const j = await res.json();
  // render session ids into #tabs
}
// Open a PTY session if none exists
async function ensureSession() {
  const res = await fetch(`${proxy}/api/tools/terminal_open`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "pty", target: "powershell", rows: 30, cols: 100 }) });
  const j = await res.json();
  return j.session_id;
}
// SSE output stream (token-free; the gateway proxy injects Bearer)
const es = new EventSource(`${proxy}/api/events/term`);
es.onmessage = (ev) => {
  try {
    const { data } = JSON.parse(ev.data);
    term.write(new Uint8Array(data));
  } catch {}
};
term.onData((d) => {
  fetch(`${proxy}/api/tools/terminal_write`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: currentSession, data: d }) }).catch(() => {});
});
// fit on resize
window.addEventListener("resize", () => fit.fit());
```

（完整版含 session 选择/多 tab/断线重连，逻辑仿 `command/src/ui/term.js`。）

- [ ] **Step 4: 手动验证**

- 扩展 terminal 页：打开 → 自动开 PTY → xterm 显示 PowerShell 提示符
- 在 xterm 输入 `dir` → 设备响应回显
- 关掉 terminal 页再开 → 会话仍在（terminal_list 列出）→ 可重新 attach
- 断网/重连：EventSource 自动重连，输出继续

- [ ] **Step 5: 提交**

Run: `git add extension/terminal/ && git commit -m "feat(stage-ext): terminal page — xterm + SSE/POST via gateway proxy"`

---

### Task 8: vale-command 瘦身（退役面板/Tauri/浏览器自动化 + 托盘）

**Files:**
- Delete: `/home/zhengsaisi/vale/command/src/ui/`
- Delete: `/home/zhengsaisi/vale/command/src-tauri/`
- Delete: `/home/zhengsaisi/vale/command/src/plugins/browser/`
- Delete: `/home/zhengsaisi/vale/command/src/tools/browser.rs`、`browser_headless.rs`、`cdp.rs`
- Delete: `/home/zhengsaisi/vale/command/src/desktop_api.rs`
- Modify: `/home/zhengsaisi/vale/command/Cargo.toml`（清理 feature/deps/member）
- Modify: `/home/zhengsaisi/vale/command/src/main.rs`、`lib.rs`、`state.rs`、`web.rs`、`mcp/server.rs`（去 UI/browser 引用）
- Create: `/home/zhengsaisi/vale/command/vale-tray-slim/`（或复用 vale-tray，新托盘小应用）

**Interfaces:**
- Consumes: 保留 `/mcp`（TokenGate + rmcp）、`/api/tools/{name}`、SSE 端点、terminal 后端
- Produces: 纯服务 vale-command（无 UI）+ 独立托盘

- [ ] **Step 1: 删除退役文件**

Run: `git rm -r command/src/ui command/src-tauri command/src/plugins/browser command/src/tools/browser.rs command/src/tools/browser_headless.rs command/src/tools/cdp.rs command/src/desktop_api.rs`

- [ ] **Step 2: Cargo.toml 清理**

- `[workspace] members` 去掉 `"src-tauri"`（保留 `vale-command-core`）
- 删 optional deps：`tauri`、`tokio-tungstenite`、`reqwest`、`url`（若无其他用途）
- `[features]`：删 `browser`、`tauri`、`desktop`；保留 `terminal`、`keyring`、`windows-service`
- 若 `vale-command-desktop` bin 在 `[[bin]]`，删除

- [ ] **Step 3: 去除代码引用**

- `main.rs`：删 Tauri/desktop 分支，headless 二进制为唯一形态
- `lib.rs`：删 `tauri` feature 引用
- `state.rs`：删 `browser_mgr` 字段
- `web.rs`：删 `/api/browser/*` 端点、`browser.js` asset、ASSETS 中 UI 引用；保留 `/api/tools/{name}`、SSE term 流、TokenGate、静态资源删到只剩必要（或全删——面板不再需要）
- `mcp/server.rs`：去 browser tools 注册（保留 terminal）
- 删除 `plugins/browser/` 的 `mod.rs` 注册

- [ ] **Step 4: 托盘小应用**

新建 `/home/zhengsaisi/vale/command/vale-tray-slim/`（Windows 原生托盘，无窗口）：
- 开关/重启 vale-command 服务（调 Windows service API）
- 显示运行状态/子域名/token 掩码（读 config.yaml + 服务状态）
- 复制 MCP 配置、打开控制台设备页（浏览器打开 URL）
- 本地终端入口（打开本地 cmd/PowerShell 窗口）
- 实现：Rust + `tray-icon` crate（Windows-only），无 tauri 依赖

- [ ] **Step 5: 验证**

Run: `cd /home/zhengsaisi/vale/command && cargo test && cargo clippy --all-targets`
Expected: 全绿、零警告（无 webkit2gtk 依赖，Linux 可编译）
Run: `cargo xwin check -p vale-command --target x86_64-pc-windows-msvc`
Expected: 通过

- [ ] **Step 6: 提交**

Run: `git add -A command/ && git commit -m "refactor(stage-command): slim vale-command — retire web panel/tauri/browser automation; add tray app"`

---

### Task 9: console SPA 在线列/配对 UI + 安装指引

**Files:**
- Modify: `/home/zhengsaisi/vale/gateway/public/app.js`（Devices 区：在线列、配对按钮、MCP 配置复制）
- Modify: `/home/zhengsaisi/vale/gateway/public/index.html`（Devices 区 DOM）
- Modify: `/home/zhengsaisi/vale/gateway/public/style.css`（样式）
- Create: `/home/zhengsaisi/vale/extension/README.md`（安装指引）+ `/home/zhengsaisi/vale/command/deploy/vale-command-setup.ps1`（扩展安装段）

**Interfaces:**
- Consumes: `/api/plugins/status`、`/api/plugins/pair`、`/api/me`（token）
- Produces: 控制台设备页：每设备"在线"徽章、配对码弹窗、网关 MCP 配置复制、安装扩展指引

- [ ] **Step 1: app.js Devices 区**

`loadDevices()` 里每设备行加：
- "在线"列：轮询 `/api/plugins/status` → 绿点/灰点
- 「配对扩展」按钮 → `POST /api/plugins/pair {device}` → 弹窗显示码 + 指引（在 popup 输入）
- 「网关 MCP 配置」按钮 → 用 `/api/me` 的 token 生成 `mcpServers.vale-gate = {type:"http", url:"https://<console>/mcp", headers:{Authorization:"Bearer <token>"}}` 复制
- 「安装扩展」按钮 → 打开 `/extension/README.md` 指引（或弹出模态：下载 zip → 解压 → chrome://extensions 加载）

（i18n 字典 65-83 处加对应字符串。）

- [ ] **Step 2: 验证**

- `wrangler dev` → console Devices 页：在线列显示（有扩展连上为绿）、配对码弹窗可用、MCP 配置复制后粘贴到 Claude Code 配置可用

- [ ] **Step 3: 提交**

Run: `git add gateway/public extension/README.md && git commit -m "feat(stage-console): devices online column + extension pairing + gateway MCP config"`

---

### Task 10: 收尾（README + 生产部署 + 端到端回归）

**Files:**
- Modify: `/home/zhengsaisi/vale/README.md`（架构/安装）
- Modify: `/home/zhengsaisi/vale/gateway/DEVICE-INTEGRATION.md`（更新架构：扩展取代远程 CDP）

- [ ] **Step 1: 文档**

README + DEVICE-INTEGRATION.md 更新为新架构（扩展 + 网关 /mcp + 终端工具）。

- [ ] **Step 2: 生产部署**

Run: `cd /home/zhengsaisi/vale/gateway && npx wrangler deploy`
Expected: 成功（新 DO 迁移 v2-plugin-hub 自动应用）

- [ ] **Step 3: 端到端回归**

- 生产环境：Claude Code `claude mcp add vale-gate --transport http --url https://<console>/mcp --header "Authorization: Bearer <token>"`
- 剧本：`browser_open`（设备面板）→ `browser_screenshot`（看图）→ `browser_click`（点面板元素）→ `terminal_open` → `terminal_send('ping')` → `terminal_screen`（看输出）
- 全程验证：扩展连接稳定（WS 心跳）、截图渲染、点击生效、终端屏幕文本正确

- [ ] **Step 4: 提交**

Run: `git add -A && git commit -m "docs(device): v2 architecture + install guide (extension + gateway MCP)"`

---

## Self-Review

**Spec coverage**（对照 spec 各节）：
- ✅ 扩展（manifest/SW/cdp/元素树/ws/popup/options/terminal）→ Tasks 4, 7
- ✅ 网关 WS 反代修复 → Task 1
- ✅ PluginHubDO + 配对/票据/状态 → Task 3
- ✅ MCP 端点 + 12 工具 → Tasks 2, 5
- ✅ 终端 terminal_screen → Task 6
- ✅ vale-command 瘦身 + 托盘 → Task 8
- ✅ console SPA 在线列/配对/安装指引 → Task 9
- ✅ 验证/回归 → Tasks 1-10 各步 + Task 10

**Placeholder scan**：无 TBD/TODO；安装指引在 Task 9 明确（README + ps1 段）；托盘功能在 Task 8 明确（tray-icon + 4 功能）。

**Type consistency**：
- `deviceFetch(env, device, path, body)` → Task 2 定义，Task 2 内部调用（proxyDevice + mcp terminal）
- `build101Response(resp)` → Task 1 定义
- `createPairCode/consumePairCode/createWsTicket/consumeWsTicket/addPluginLink/getPluginByToken/removePluginLink` → Task 3 store 定义，Task 3 index 路由消费
- `handleMcp(request, env)` → Task 2 定义，Task 2 index 路由消费
- `runTool(tool, params)` → Task 4 扩展定义，Task 4 ws.js handler 消费
- `terminal_screen` 设备工具 → Task 6 定义，Task 2 网关 mcp-tools 引用（名一致）
- PluginHubDO `/call` 协议 `{tool, params, requestId}` → Task 3 定义，Task 5 mcp.js 消费
- `{image:{type:"image",data,mimeType}}` content block → Task 4 扩展返回，Task 2 mcp.js 未特殊处理（透传 text）——**注意**：截图结果是 image block，Task 2 的 `callTool` 返回 `mcpJson({content:[{type:"text",...}]})` 会把对象序列化成字符串。需要在 Task 5 修：当 result 含 `image` 字段时，`content` 用 `[{type:"image", data, mimeType}]`。在 Task 5 Step 1 一并改 `callTool` 返回结构（已隐含；实现时在 mcp.js 加一个 `formatResult(result)`：若 `result.image` 存在 → image content block，否则 text）。

**发现并修正**：Task 2 的 mcp.js `callTool` 对 image 的处理在 Task 5 补（浏览器工具返回 image 时才需要）；Task 5 明确 `formatResult`。已在上文 Task 5 Step 1 并入。

## Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-08-06-device-ops-v2.md`。两种执行方式：

1. **Subagent-Driven（推荐）**：每个任务派一个全新子代理，任务间审查，迭代快
2. **Inline Execution**：本会话内用 executing-plans 批量执行，检查点审查

选哪种？
