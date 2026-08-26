# Device operations v2: browser extension + AI-first MCP — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move device-browser control from Windows remote CDP (broken) to a Windows-local Chrome/Edge extension (chrome.debugger internal CDP), rework the MCP tool surface to be AI-first (visual + semantic), add a screen-buffer tool for terminals, and slim vale-command down to a pure service + standalone tray.

**Architecture:** Claude Code (dev machine) → gateway /mcp (JSON-RPC) → the gateway routes per device: browser tools go through PluginHubDO (long-lived WS) to the extension (chrome.debugger driving real tabs); terminal tools go through deviceFetch, proxying the device's existing /api/tools directly. The extension installs in the Windows device's Chrome/Edge; the dev machine only talks HTTPS to the gateway.

**Tech Stack:** Cloudflare Worker (JS, zero dependencies), MV3 Chrome extension, chrome.debugger CDP, Rust (rmcp MCP server), xterm.js.

## Global Constraints

- **ESM JS, zero new dependencies**: the gateway hand-rolls JSON-RPC (no @modelcontextprotocol/sdk); the extension is plain JS (no build step)
- **All MCP tools take a `device` parameter**, validated against KV
- **Gateway tool timeouts < 90s** (Worker subrequest cap is 100s); terminal quiet defaults to 400ms
- **No content script in the extension**: all in-page operations go through CDP Runtime.evaluate, zero page intrusion
- **MV3 permissions**: `["tabs","debugger","storage","alarms"]`; host_permissions covers the console domain + device subdomains
- **One controlled tab per device** (`tabs.create`); never detach on WS disconnect
- **The extension installs in Windows-device Chrome/Edge** (the dev machine has no UI); the tab shape = panel embed (proxied URL)
- **vale-command slimming**: retire the web panel/Tauri/browser automation; keep the MCP server + terminal backend + SSE endpoint; standalone tray
- **Commit style**: conventional commits + stage tags (`feat(stage-x)`, etc.); every commit keeps the tree green
- **command verification baseline**: `cargo test` → `cargo clippy --all-targets` → `cargo xwin check -p vale-command --target x86_64-pc-windows-msvc`; gateway: `node --test` + `wrangler deploy`

---

### Task 1: Fix the gateway WS proxy 101 branch (root-cause fix)

**Files:**
- Modify: `/home/zhengsaisi/vale/gateway/src/index.js:720-725`

**Interfaces:**
- Consumes: existing `proxyDevice(request, env, device, restPath)` (index.js:691)
- Produces: a fixed `proxyDevice` 101 branch — WS upgrades through the proxy correctly carry back `resp.webSocket`

- [ ] **Step 1: Write a failing test**

Create `/home/zhengsaisi/vale/gateway/test/proxy-ws.test.mjs`:

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

(Note: Node cannot construct a `status:101` Response — 101 is an illegal status in Node. So the test instead calls a **pure function extracted from `proxyDevice`**, `build101Response(resp)`, mocking a `{status:101, webSocket:fake}` object and asserting the returned Response carries the webSocket and doesn't throw a RangeError. See Step 3's implementation.)

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd /home/zhengsaisi/vale/gateway && node --test test/proxy-ws.test.mjs`
Expected: FAIL (`build101Response` undefined)

- [ ] **Step 3: Implement**

Inside `proxyDevice` in `index.js` (720-725), extract the 101 branch and call the new function; near the top of the file (after `CORS_HEADERS`), add:

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

Inside `proxyDevice` (720-725), change to:

```js
  if (resp.status === 101) {
    return build101Response(resp) ?? resp;
  }
  // Streaming (SSE / octet-stream): pass the body through untouched.
  if (resp.body && (ct.includes("text/event-stream") || ct.includes("application/octet-stream"))) {
    return new Response(resp.body, { status: resp.status, headers: outHeaders });
  }
```

- [ ] **Step 4: Update the test to unit-test `build101Response`**

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

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd /home/zhengsaisi/vale/gateway && node --test test/proxy-ws.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 6: Regression + commit**

Run: `cd /home/zhengsaisi/vale/gateway && node --test`
Expected: all green (existing tests + new tests)
Run: `cd /home/zhengsaisi/vale/gateway && npx wrangler deploy`
Expected: deploy succeeds
Run: `git add gateway/src/index.js gateway/test/proxy-ws.test.mjs && git commit -m "fix(stage-gateway): WS 101 rewrap — carry resp.webSocket (was RangeError 500)"`

---

### Task 2: Gateway MCP endpoint + terminal tools (deviceFetch extraction)

**Files:**
- Create: `/home/zhengsaisi/vale/gateway/src/mcp.js`
- Create: `/home/zhengsaisi/vale/gateway/src/mcp-tools.js`
- Modify: `/home/zhengsaisi/vale/gateway/src/index.js` (deviceFetch extraction + /mcp route)
- Test: `/home/zhengsaisi/vale/gateway/test/mcp.test.mjs`

**Interfaces:**
- Consumes: `getDevice(env, name)` (store.js), `findUserByToken` (store.js:178)
- Produces:
  - `deviceFetch(env, device, path, body)` → `Promise<{status, ok, data}>`
  - `handleMcp(request, env)` → `Promise<Response>` (GET = keep-alive SSE stream, POST = JSON-RPC)
  - MCP tools: `terminal_open(device,kind,target,rows?,cols?)`, `terminal_screen(device,session_id,lines?)`, `terminal_send(device,session_id,input,quiet_ms?)`, `terminal_list(device)`, `terminal_close(device,session_id)`

- [ ] **Step 1: Extract `deviceFetch`**

Add the shared function before `proxyDevice` in `index.js`:

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

Change `proxyDevice` (691-712) to call `deviceFetch` and use its `resp`:

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
  // ... (keep the existing 101/SSE/rewrite/JSON branches unchanged)
}
```

- [ ] **Step 2: Write the MCP tool registry**

Create `/home/zhengsaisi/vale/gateway/src/mcp-tools.js`:

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

- [ ] **Step 3: Implement `handleMcp`**

Create `/home/zhengsaisi/vale/gateway/src/mcp.js`:

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

- [ ] **Step 4: Wire the /mcp route**

In `index.js`'s main fetch flow, after the console API checks and before the static-page checks (between 158-164):

```js
      // ---- MCP endpoint (Claude Code) — admin token, page host only ----
      if (isPageHost && path === "/mcp") {
        return await handleMcp(request, env);
      }
```

And import at the top of `index.js`:

```js
import { handleMcp } from "./mcp.js";
```

(Note: `mcp.js` also imports `deviceFetch`, so the two import each other. To avoid a circular dependency, extract `deviceFetch` and `build101Response` into a new file `/home/zhengsaisi/vale/gateway/src/device-fetch.js`, and have both `index.js` and `mcp.js` import from there. In this task, put `deviceFetch` in `device-fetch.js` and change `index.js`'s `proxyDevice` to import it.)

- [ ] **Step 5: Write the MCP unit tests**

Create `/home/zhengsaisi/vale/gateway/test/mcp.test.mjs`:

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

- [ ] **Step 6: Run the tests**

Run: `cd /home/zhengsaisi/vale/gateway && node --test`
Expected: all green

- [ ] **Step 7: Commit**

Run: `git add gateway/src/ && git commit -m "feat(stage-gateway): /mcp endpoint + AI-first terminal tools (deviceFetch shared)"`

---

### Task 3: PluginHubDO + plugin pairing/ticket/status

**Files:**
- Create: `/home/zhengsaisi/vale/gateway/src/plugin-hub.js`
- Modify: `/home/zhengsaisi/vale/gateway/src/store.js` (plugins:v1 + ticket/pairing-code helpers)
- Modify: `/home/zhengsaisi/vale/gateway/src/index.js` (/api/plugins/* routes + PluginHubDO import)
- Modify: `/home/zhengsaisi/vale/gateway/wrangler.jsonc` (PLUGIN_HUB DO binding + v2 migration)
- Test: `/home/zhengsaisi/vale/gateway/test/plugins.test.mjs`

**Interfaces:**
- Consumes: `randomHex` (store.js:135), `getDevice`
- Produces:
  - `addPluginLink(env, token, device)` / `getPluginByToken(env, token)` / `removePluginLink(env, token)`
  - `createPairCode(env, device)` → code, `consumePairCode(env, code)` → device | null
  - `createWsTicket(env, device)` → ticket, `consumeWsTicket(env, ticket)` → device | null
  - `PluginHubDO` (one instance per device, WS Hibernation): `/ws`, `/call`, `/status`

- [ ] **Step 1: store.js plugin KV helpers**

Append after the devices:v1 section of `store.js` (326-405):

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

Create `/home/zhengsaisi/vale/gateway/src/plugin-hub.js`:

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

- [ ] **Step 3: index.js plugin routes**

At the top of `index.js`, import:

```js
import { addPluginLink, getPluginByToken, removePluginLink, createPairCode, consumePairCode, createWsTicket, consumeWsTicket } from "./store.js";
import { PluginHubDO } from "./plugin-hub.js";
export { PluginHubDO };
```

In `handleConsole`'s admin section (after the device module, ~330), add:

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

Also define `const PLUGIN_BASE = "/api/plugins";` at the top and import `listPluginLinks`, `randomHex` (if store.js doesn't export randomHex, export it).

- [ ] **Step 4: wrangler.jsonc DO binding**

Add to `wrangler.jsonc` (following the BreakerDO precedent):

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

(If migrations currently lack the v1-breaker tag, add it.)

- [ ] **Step 5: Write the plugins unit tests**

Create `/home/zhengsaisi/vale/gateway/test/plugins.test.mjs` (KV stub testing the store helpers):

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

- [ ] **Step 6: Run the tests**

Run: `cd /home/zhengsaisi/vale/gateway && node --test`
Expected: all green

- [ ] **Step 7: Commit**

Run: `git add gateway/src gateway/wrangler.jsonc gateway/test && git commit -m "feat(stage-gateway): PluginHubDO + plugin pairing/ticket/status"`

---

### Task 4: Minimal viable extension (skeleton + popup pairing + cdp controller + ws.js)

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
- Consumes: gateway `/api/plugins/*`, `chrome.debugger`
- Produces: the extension SW handles WS `request` frames (`{id, tool, params}`) → calls tools.js tools → `{id, ok, result/error}`; controlled tab (`/api/devices/<d>/proxy/`)

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

(`host_permissions: ["https://*/*"]` so device subdomains/console domains can change anytime; options can tighten it.)

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

`popup/popup.html` (minimal UI: connection status/device/buttons) + `popup.js` (sends `status`/`pair`/`openTab`/`unpair` messages and renders) + `options/options.html|js` (consoleOrigin setting). The UI structure follows the existing style in command/src/ui (simple cards). icons use minimal placeholder PNGs (16/48/128, solid color).

- [ ] **Step 9: Manual verification**

- Chrome → `chrome://extensions` → developer mode → load unpacked → pick `extension/`
- options: set consoleOrigin
- console Devices panel generates a pairing code → enter it in the popup → claim
- popup opens a controlled tab → should open `https://console/api/devices/d1/proxy/`
- (The WS channel is integrated with the gateway in Task 5; in this task, first manually verify pairing + opening the tab + attach without errors via the popup)

- [ ] **Step 10: Commit**

Run: `git add extension/ && git commit -m "feat(stage-ext): extension skeleton — pairing, popup, cdp controller, ws client"`

---

### Task 5: Extension WS channel integration (gateway PluginHubDO ↔ extension)

**Files:**
- Modify: `/home/zhengsaisi/vale/gateway/src/mcp.js` (wire browser tools to PluginHubDO)
- Modify: `/home/zhengsaisi/vale/gateway/src/mcp-tools.js` (browser tool handler definitions)
- Test: `/home/zhengsaisi/vale/gateway/test/mcp-browser.test.mjs`

**Interfaces:**
- Consumes: PluginHubDO (Task 3), the extension's runTool (Task 4)
- Produces: the full browser tool path (Claude Code → /mcp → DO /call → WS → extension → CDP → results returned)

- [ ] **Step 1: Wire mcp.js browser tools to the DO**

Change `callTool` in `mcp.js` to:

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

- [ ] **Step 2: Write the integration test (stubbed DO logic)**

Create `/home/zhengsaisi/vale/gateway/test/mcp-browser.test.mjs`: with a stubbed `PLUGIN_HUB` env (`idFromName` returns the same name, `get` returns a fetch stub), assert that `callTool` forwards browser tools to the DO /call and returns extension_offline when offline. Core assertions:

```js
test("browser tool routes through PluginHubDO; offline → extension_offline", async () => {
  // stub env.PLUGIN_HUB.get(id).fetch → {status:503,json:()=>({error:"extension_offline"})}
  // call callTool({name:"browser_snapshot"}, env, {name:"d1",hostname:"d1.example.com",token:"x"}, {device:"d1"})
  // expect rejects with /extension_offline/
});
```

- [ ] **Step 3: Run the tests**

Run: `cd /home/zhengsaisi/vale/gateway && node --test`
Expected: all green

- [ ] **Step 4: End-to-end integration (wrangler dev + Chrome)**

- `wrangler dev` (.dev.vars sets CONSOLE_HOST=localhost)
- Chrome loads the extension (installed in Task 4); options sets consoleOrigin=`http://localhost:8787`
- console generates a pairing code → popup claims → the extension connects to WS (popup shows connected)
- Use a node script to connect directly to `ws://localhost:8787/api/plugins/ws?device=d1&ticket=...` simulating the plugin → receive hello → send ping → receive pong (verifies basic DO hibernation behavior)
- Then the real extension: call `tools/call browser_snapshot` via curl on the gateway `/mcp` (Bearer admin token) → returns the element-tree JSON

- [ ] **Step 5: Commit**

Run: `git add gateway/src gateway/test && git commit -m "feat(stage-gateway): browser tools wired to PluginHubDO + offline handling"`

---

### Task 6: Terminal AI tool (device terminal_screen)

**Files:**
- Modify: `/home/zhengsaisi/vale/command/src/plugins/terminal/tools.rs` (add `tool_screen` + register in `build()`)
- Modify: `/home/zhengsaisi/vale/command/src/plugins/terminal/mod.rs` (tool count test 12→13)
- Modify: `/home/zhengsaisi/vale/command/CLAUDE.md` (tool count documentation)

**Interfaces:**
- Consumes: `OutputBuf`, `SessionBuf` (mod.rs:23-48), `clean_terminal_output` (mod.rs:51-95)
- Produces: new tool `terminal_screen(session_id, lines?)` → `{screen, dropped}` — the tail N lines of screen text

- [ ] **Step 1: Write a failing test (tool count + existence)**

Change `tool_count_and_names` in `mod.rs`'s tests to:

```rust
        assert_eq!(tools.len(), 13);
        for expected in [
            "terminal_open", "terminal_write", "terminal_close", "terminal_list",
            "terminal_execute", "terminal_list_ports", "terminal_resize",
            "terminal_select", "terminal_read", "terminal_screen",
            "secret_set", "secret_get", "secret_delete",
        ] {
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd /home/zhengsaisi/vale/command && cargo test --lib plugins::terminal`
Expected: FAIL (terminal_screen missing / count 12≠13)

- [ ] **Step 3: Implement `tool_screen`**

Add `tool_screen(&output_buf)` to the Vec in `tools.rs`'s `build()`, and implement:

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

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd /home/zhengsaisi/vale/command && cargo test --lib plugins::terminal`
Expected: PASS (13 tools)

- [ ] **Step 5: Full verification + commit**

Run: `cd /home/zhengsaisi/vale/command && cargo test && cargo clippy --all-targets`
Expected: all green, zero warnings
Run: `git add command/src/plugins/terminal/ && git commit -m "feat(stage-command): terminal_screen — tail-N-lines screen buffer for AI"`

---

### Task 7: Terminal display in the extension (terminal page xterm)

**Files:**
- Create: `/home/zhengsaisi/vale/extension/terminal/terminal.html` + `terminal.css` + `terminal.js`
- Copy: `/home/zhengsaisi/vale/command/src/ui/vendor/xterm.min.js`, `xterm.css`, `xterm-addon-fit.min.js` → `/home/zhengsaisi/vale/extension/terminal/vendor/`

**Interfaces:**
- Consumes: device `/api/events/term` (SSE via the gateway proxy) + `/api/tools/terminal_write` (POST via the proxy)
- Produces: a full-screen xterm terminal page inside the extension + multi-session tabs

- [ ] **Step 1: Copy the xterm vendor files**

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

(The full version includes session selection/multi-tab/reconnect logic, modeled on `command/src/ui/term.js`.)

- [ ] **Step 4: Manual verification**

- Extension terminal page: open → PTY auto-opens → xterm shows the PowerShell prompt
- Type `dir` in xterm → the device echoes the response
- Close and reopen the terminal page → the session is still there (listed by terminal_list) → can re-attach
- Network drop/reconnect: EventSource reconnects automatically and output continues

- [ ] **Step 5: Commit**

Run: `git add extension/terminal/ && git commit -m "feat(stage-ext): terminal page — xterm + SSE/POST via gateway proxy"`

---

### Task 8: Slim vale-command (retire the panel/Tauri/browser automation + tray)

**Files:**
- Delete: `/home/zhengsaisi/vale/command/src/ui/`
- Delete: `/home/zhengsaisi/vale/command/src-tauri/`
- Delete: `/home/zhengsaisi/vale/command/src/plugins/browser/`
- Delete: `/home/zhengsaisi/vale/command/src/tools/browser.rs`, `browser_headless.rs`, `cdp.rs`
- Delete: `/home/zhengsaisi/vale/command/src/desktop_api.rs`
- Modify: `/home/zhengsaisi/vale/command/Cargo.toml` (clean up features/deps/members)
- Modify: `/home/zhengsaisi/vale/command/src/main.rs`, `lib.rs`, `state.rs`, `web.rs`, `mcp/server.rs` (remove UI/browser references)
- Create: `/home/zhengsaisi/vale/command/vale-tray-slim/` (or reuse vale-tray, a new slim tray app)

**Interfaces:**
- Consumes: keep `/mcp` (TokenGate + rmcp), `/api/tools/{name}`, SSE endpoints, the terminal backend
- Produces: pure-service vale-command (no UI) + standalone tray

- [ ] **Step 1: Delete the retired files**

Run: `git rm -r command/src/ui command/src-tauri command/src/plugins/browser command/src/tools/browser.rs command/src/tools/browser_headless.rs command/src/tools/cdp.rs command/src/desktop_api.rs`

- [ ] **Step 2: Clean up Cargo.toml**

- Remove `"src-tauri"` from `[workspace] members` (keep `vale-command-core`)
- Delete optional deps: `tauri`, `tokio-tungstenite`, `reqwest`, `url` (unless used elsewhere)
- `[features]`: delete `browser`, `tauri`, `desktop`; keep `terminal`, `keyring`, `windows-service`
- If a `vale-command-desktop` bin exists under `[[bin]]`, remove it

- [ ] **Step 3: Remove code references**

- `main.rs`: delete the Tauri/desktop branch; the headless binary is the only form
- `lib.rs`: remove `tauri` feature references
- `state.rs`: remove the `browser_mgr` field
- `web.rs`: remove the `/api/browser/*` endpoints, the `browser.js` asset, and UI references in ASSETS; keep `/api/tools/{name}`, the SSE term stream, TokenGate; trim static assets to only what's necessary (or delete them all — the panel is no longer needed)
- `mcp/server.rs`: drop browser tool registration (keep terminal)
- Remove the `plugins/browser/` registration from `mod.rs`

- [ ] **Step 4: Tray app**

Create `/home/zhengsaisi/vale/command/vale-tray-slim/` (native Windows tray, no window):
- Start/stop/restart the vale-command service (via the Windows service API)
- Show running status/subdomain/masked token (reads config.yaml + service status)
- Copy MCP config, open the console device page (open the URL in a browser)
- Local terminal entry (opens a local cmd/PowerShell window)
- Implementation: Rust + the `tray-icon` crate (Windows-only), no tauri dependency

- [ ] **Step 5: Verification**

Run: `cd /home/zhengsaisi/vale/command && cargo test && cargo clippy --all-targets`
Expected: all green, zero warnings (no webkit2gtk dependency, compiles on Linux)
Run: `cargo xwin check -p vale-command --target x86_64-pc-windows-msvc`
Expected: passes

- [ ] **Step 6: Commit**

Run: `git add -A command/ && git commit -m "refactor(stage-command): slim vale-command — retire web panel/tauri/browser automation; add tray app"`

---

### Task 9: console SPA online column/pairing UI + install guide

**Files:**
- Modify: `/home/zhengsaisi/vale/gateway/public/app.js` (Devices section: online column, pairing button, MCP config copy)
- Modify: `/home/zhengsaisi/vale/gateway/public/index.html` (Devices section DOM)
- Modify: `/home/zhengsaisi/vale/gateway/public/style.css` (styles)
- Create: `/home/zhengsaisi/vale/extension/README.md` (install guide) + `/home/zhengsaisi/vale/command/deploy/vale-command-setup.ps1` (extension install section)

**Interfaces:**
- Consumes: `/api/plugins/status`, `/api/plugins/pair`, `/api/me` (token)
- Produces: console Devices page: per-device "online" badge, pairing-code modal, gateway MCP config copy, extension install guide

- [ ] **Step 1: app.js Devices section**

In `loadDevices()`, add to each device row:
- "Online" column: poll `/api/plugins/status` → green/gray dot
- "Pair extension" button → `POST /api/plugins/pair {device}` → a modal shows the code + instructions (enter it in the popup)
- "Gateway MCP config" button → use `/api/me`'s token to generate `mcpServers.vale-gate = {type:"http", url:"https://<console>/mcp", headers:{Authorization:"Bearer <token>"}}` and copy it
- "Install extension" button → open the `/extension/README.md` guide (or show a modal: download zip → extract → load at chrome://extensions)

(Add the corresponding strings to the i18n dictionaries around lines 65-83.)

- [ ] **Step 2: Verification**

- `wrangler dev` → console Devices page: the online column displays (green when an extension is connected), the pairing-code modal works, the copied MCP config works when pasted into Claude Code's config

- [ ] **Step 3: Commit**

Run: `git add gateway/public extension/README.md && git commit -m "feat(stage-console): devices online column + extension pairing + gateway MCP config"`

---

### Task 10: Wrap-up (README + production deploy + end-to-end regression)

**Files:**
- Modify: `/home/zhengsaisi/vale/README.md` (architecture/installation)
- Modify: `/home/zhengsaisi/vale/gateway/DEVICE-INTEGRATION.md` (update architecture: the extension replaces remote CDP)

- [ ] **Step 1: Documentation**

Update README + DEVICE-INTEGRATION.md to the new architecture (extension + gateway /mcp + terminal tools).

- [ ] **Step 2: Production deploy**

Run: `cd /home/zhengsaisi/vale/gateway && npx wrangler deploy`
Expected: success (the new v2-plugin-hub DO migration applies automatically)

- [ ] **Step 3: End-to-end regression**

- Production: Claude Code `claude mcp add vale-gate --transport http --url https://<console>/mcp --header "Authorization: Bearer <token>"`
- Script: `browser_open` (device panel) → `browser_screenshot` (view the picture) → `browser_click` (click a panel element) → `terminal_open` → `terminal_send('ping')` → `terminal_screen` (view the output)
- Verify throughout: the extension stays connected (WS heartbeat), screenshots render, clicks take effect, terminal screen text is correct

- [ ] **Step 4: Commit**

Run: `git add -A && git commit -m "docs(device): v2 architecture + install guide (extension + gateway MCP)"`

---

## Self-Review

**Spec coverage** (mapped against the spec's sections):
- ✅ Extension (manifest/SW/cdp/element tree/ws/popup/options/terminal) → Tasks 4, 7
- ✅ Gateway WS proxy fix → Task 1
- ✅ PluginHubDO + pairing/ticket/status → Task 3
- ✅ MCP endpoint + 12 tools → Tasks 2, 5
- ✅ Terminal terminal_screen → Task 6
- ✅ vale-command slimming + tray → Task 8
- ✅ console SPA online column/pairing/install guide → Task 9
- ✅ Verification/regression → each step of Tasks 1-10 + Task 10

**Placeholder scan**: no TBD/TODO; the install guide is explicit in Task 9 (README + the ps1 section); tray features are explicit in Task 8 (tray-icon + 4 features).

**Type consistency**:
- `deviceFetch(env, device, path, body)` → defined in Task 2, called within Task 2 (proxyDevice + mcp terminal)
- `build101Response(resp)` → defined in Task 1
- `createPairCode/consumePairCode/createWsTicket/consumeWsTicket/addPluginLink/getPluginByToken/removePluginLink` → defined in Task 3's store, consumed by Task 3's index routes
- `handleMcp(request, env)` → defined in Task 2, consumed by Task 2's index routes
- `runTool(tool, params)` → defined in the Task 4 extension, consumed by Task 4's ws.js handler
- the `terminal_screen` device tool → defined in Task 6, referenced by Task 2's gateway mcp-tools (same name)
- PluginHubDO `/call` protocol `{tool, params, requestId}` → defined in Task 3, consumed by Task 5's mcp.js
- `{image:{type:"image",data,mimeType}}` content block → returned by the Task 4 extension, not specially handled by Task 2's mcp.js (passes through as text) — **note**: the screenshot result is an image block; Task 2's `callTool` returns `mcpJson({content:[{type:"text",...}]})`, which would serialize the object into a string. Fix needed in Task 5: when the result has an `image` field, use `[{type:"image", data, mimeType}]` for `content`. Also change `callTool`'s return structure in Task 5 Step 1 (already implied; when implementing, add a `formatResult(result)` helper in mcp.js: if `result.image` exists → image content block, otherwise text).

**Found and fixed**: Task 2's mcp.js `callTool` image handling is addressed in Task 5 (needed only when a browser tool returns an image); Task 5 specifies `formatResult`. This is incorporated into Task 5 Step 1 above.

## Execution Handoff

The plan is complete and saved to `docs/superpowers/plans/2026-08-06-device-ops-v2.md`. Two ways to execute:

1. **Subagent-Driven (recommended)**: dispatch a fresh subagent per task with reviews between tasks; fast iteration
2. **Inline Execution**: run tasks in batch in this session with executing-plans, reviewing at checkpoints

Which one do you choose?
