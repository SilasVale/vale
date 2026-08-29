// mcp.js handler behavior tests — pure local (mock KV + stubbed fetch), no Cloudflare calls.
//
// store.js reads via env.KEYS (`token:<t>` → userId, `user:<id>` → JSON, `devices:v1` →
// JSON array), so a Map-backed KV stub stands in. Note store.js keeps a module-level
// 24h cache: distinct tokens per distinct user and one consistent devices payload keep
// tests from stepping on each other's cached entries.
//
// terminal_execute is asserted through the real deviceFetch path by stubbing globalThis.fetch
// (ESM namespace exports are frozen, so monkey-patching deviceFetch itself is not possible;
// stubbing fetch exercises the full handleMcp → callTool → deviceFetch pipeline unchanged).
import test from "node:test";
import assert from "node:assert/strict";
import { handleMcp } from "../src/mcp.ts";
import { __clearCaches } from "../src/store.ts";

const DEVICE = { name: "d1", hostname: "d1.agent.saisi.online", token: "devtok" };

// admin: token:admintoken → admin (role admin); bob: token:usertoken → bob (role user)
function makeEnv() {
  const kv = new Map([
    ["token:admintoken", "admin"],
    ["user:admin", JSON.stringify({ id: "admin", username: "admin", role: "admin", enabled: true, token: "admintoken" })],
    ["token:usertoken", "bob"],
    ["user:bob", JSON.stringify({ id: "bob", username: "bob", role: "user", enabled: true, token: "usertoken" })],
    ["devices:v1", JSON.stringify([DEVICE])],
  ]);
  return {
    KEYS: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put() {}, async delete() {}, async list() { return { keys: [] }; },
    },
  };
}

const post = (body, auth = "Bearer admintoken") =>
  new Request("https://x/mcp", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });

// ── Auth gate ─────────────────────────────────────────────────

test("mcp: bad token → 401 JSON-RPC error", async () => {
  const res = await handleMcp(post({ jsonrpc: "2.0", method: "ping", id: 1 }, "Bearer bad"), makeEnv());
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.jsonrpc, "2.0");
  assert.equal(data.error.code, -32001);
  assert.equal(data.id, null);
});

test("mcp: missing authorization header → 401", async () => {
  const res = await handleMcp(new Request("https://x/mcp", { method: "POST", body: "{}" }), makeEnv());
  assert.equal(res.status, 401);
});

test("mcp: valid token but non-admin role → 401", async () => {
  const res = await handleMcp(post({ jsonrpc: "2.0", method: "ping", id: 1 }, "Bearer usertoken"), makeEnv());
  assert.equal(res.status, 401);
});

// ── initialize ─────────────────────────────────────────────────

test("mcp: initialize echoes protocolVersion + vale-gate serverInfo", async () => {
  const res = await handleMcp(post({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} }, id: 1 }), makeEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  const data = await res.json();
  assert.equal(data.jsonrpc, "2.0");
  assert.equal(data.id, 1);
  assert.equal(data.result.protocolVersion, "2025-06-18");
  assert.equal(data.result.serverInfo.name, "vale-gate");
  assert.deepEqual(data.result.capabilities, { tools: { listChanged: false } });
});

// ── notifications → 202 (JSON-RPC notifications are not answered) ──

test("mcp: notifications/initialized + notifications/cancelled → 202 empty body", async () => {
  for (const method of ["notifications/initialized", "notifications/cancelled"]) {
    const res = await handleMcp(post({ jsonrpc: "2.0", method }), makeEnv());
    assert.equal(res.status, 202, `${method} must be 202`);
    assert.equal(res.body, null, `${method} must have an empty body`);
  }
});

// ── tools/call body mapping (through the real deviceFetch) ─────

test("mcp: tools/call terminal_execute → device /api/tools/terminal_execute with mapped body", async () => {
  const env = makeEnv();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const cmd = JSON.parse(init.body).command; // echo the command like a real device terminal
    return new Response(JSON.stringify({ ok: true, output: `ran: ${cmd}` }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    // explicit quiet_ms
    let res = await handleMcp(post({ jsonrpc: "2.0", method: "tools/call", params: { name: "terminal_execute", arguments: { device: "d1", session_id: "s-1", input: "ls -la", quiet_ms: 400 } }, id: 2 }), env);
    assert.equal(res.status, 200);
    let data = await res.json();
    assert.equal(data.result.content[0].type, "text");
    // quiet_ms defaults to 400 when omitted
    res = await handleMcp(post({ jsonrpc: "2.0", method: "tools/call", params: { name: "terminal_execute", arguments: { device: "d1", session_id: "s-1", input: "pwd" } }, id: 3 }), env);
    assert.equal(res.status, 200);
    data = await res.json();
    assert.ok(data.result.content[0].text.includes("pwd"));

    // No gateway heartbeat since round-54: the agent's execute wait-loop
    // pings the session itself, so each execute is exactly ONE device fetch.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://d1.agent.saisi.online/api/tools/terminal_execute");
    assert.deepEqual(JSON.parse(calls[0].init.body), { command: "ls -la", session_id: "s-1", quiet_ms: 400 }); // device + input stripped, input→command, explicit quiet_ms passed through
    assert.deepEqual(JSON.parse(calls[1].init.body), { command: "pwd", session_id: "s-1", quiet_ms: 200 });   // default quiet_ms matches the agent
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer devtok"); // device token injected server-side
    assert.equal(calls[0].init.headers.get("host"), null);   // host/cookie stripped
    assert.equal(calls[0].init.headers.get("cookie"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("mcp: tools/call unknown device → -32602 listing registered devices (round-160)", async () => {
  // round-160: a SINGLE registered device absorbs any missing/misguessed
  // name (the dominant real-world failure — 43 "Unknown device" calls/week);
  // the listing error only fires when several devices exist.
  __clearCaches();
  const kv = new Map([
    ["token:admintoken", "admin"],
    ["user:admin", JSON.stringify({ id: "admin", username: "admin", role: "admin", enabled: true, token: "admintoken" })],
    ["devices:v1", JSON.stringify([
      { name: "d1", hostname: "d1.agent.saisi.online", token: "t1" },
      { name: "d2", hostname: "d2.agent.saisi.online", token: "t2" },
    ])],
  ]);
  const env = { CONSOLE_HOST: "x", KEYS: { async get(k) { return kv.get(k) ?? null; }, async put() {}, async delete() {}, async list() { return { keys: [] }; } } };
  const res = await handleMcp(post({ jsonrpc: "2.0", method: "tools/call", params: { name: "terminal_list", arguments: { device: "nope" } }, id: 4 }), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.error.code, -32602);
  assert.match(data.error.message, /Unknown device: nope/);
  assert.match(data.error.message, /Registered devices: d1, d2/);
});

// ── SSE GET ────────────────────────────────────────────────────

test("mcp: GET → 200 text/event-stream keepalive stream; cancel() clears the timer", async () => {
  const res = await handleMcp(new Request("https://x/mcp", { headers: { authorization: "Bearer admintoken" } }), makeEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.ok(res.body instanceof ReadableStream);
  await res.body.cancel(); // must not throw; underlying source cancel() clears the keepalive interval
});

// ── Contract: gateway tool list vs agent /api/spec (round-54) ──
// The gateway's TERMINAL_TOOLS mirror the agent's /api/spec (the single
// source of truth). When the agent gains/loses a tool, refresh THIS snapshot
// AND the toolPath map in mcp.js — the test fails loudly on drift instead of
// silently hiding tools from console MCP clients (11 tools were missing
// before round-54).

test("contract: every agent terminal tool is registered in the gateway list", async () => {
  const { allMcpTools } = await import("../src/mcp-tools.ts");
  const names = allMcpTools().map((t) => t.name);
  // Snapshot of agent /api/spec tool names (agent/src/plugins/terminal/tools.rs).
  const AGENT_SPEC_TOOLS = [
    "terminal_open", "terminal_write", "terminal_close", "terminal_list",
    "terminal_execute", "terminal_list_ports", "terminal_resize",
    "terminal_select", "terminal_read", "terminal_screen",
    "terminal_history", "terminal_diag_write", "terminal_diag_read",
    "secret_set", "secret_get", "secret_delete",
    "terminal_saved_connections", "terminal_connect_saved",
    "terminal_env", "browser_pw_info", "browser_run_script",
  ];
  for (const t of AGENT_SPEC_TOOLS) {
    assert.ok(names.includes(t), `gateway MCP list missing agent tool: ${t}`);
  }
  // No extras that the device cannot serve.
  const ALLOWED_EXTRA = ["browser_open", "browser_snapshot", "browser_screenshot", "browser_click", "browser_type", "browser_wait", "browser_close"];
  for (const n of names) {
    assert.ok(AGENT_SPEC_TOOLS.includes(n) || ALLOWED_EXTRA.includes(n), `unexpected gateway tool: ${n}`);
  }
});

test("contract: terminal_execute schema/quiet default match the agent", async () => {
  const { allMcpTools } = await import("../src/mcp-tools.ts");
  const t = allMcpTools().find((t) => t.name === "terminal_execute");
  assert.ok(t, "terminal_execute registered");
  // The gateway exposes `input` (mapped to the agent's `command` in mcp.js);
  // quiet_ms default must be the agent's 200ms, not a gateway invention.
  assert.equal(t.inputSchema.properties.quiet_ms.description.includes("200"), true);
  // round-160: device is OPTIONAL (single-device default resolution).
  assert.equal(t.inputSchema.required.join(","), "session_id,input");
});

// round-58: agent tool errors are HTTP 200 + {"ok":false,"error":...} — the
// gateway must map them to stable codes instead of returning them as success.
test("mcp: agent error (200 + ok:false) → SESSION_NOT_FOUND code", async () => {
  const env = makeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    return new Response(JSON.stringify({ ok: false, error: "Session not found: s-1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = await handleMcp(post({ jsonrpc: "2.0", method: "tools/call", params: { name: "terminal_execute", arguments: { device: "d1", session_id: "s-1", input: "ls" } }, id: 9 }), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.error.code, -32603);
    assert.equal(data.error.data.code, "SESSION_NOT_FOUND");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("mcp: agent error (200 + ok:false) → SESSION_BUSY code", async () => {
  const env = makeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    return new Response(JSON.stringify({ ok: false, error: "Session busy (another execute in progress): s-1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = await handleMcp(post({ jsonrpc: "2.0", method: "tools/call", params: { name: "terminal_execute", arguments: { device: "d1", session_id: "s-1", input: "ls" } }, id: 10 }), env);
    const data = await res.json();
    assert.equal(data.error.data.code, "SESSION_BUSY");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("mcp: agent typed error (200 + ok:false + code) → TOOL_ERROR not DEVICE_UNREACHABLE (round-64)", async () => {
  const env = makeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ ok: false, error: "Serial port not found: COM9", code: "serial_port_not_found" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = await handleMcp(post({ jsonrpc: "2.0", method: "tools/call", params: { name: "terminal_open", arguments: { device: "d1", kind: "serial", target: "COM9" } }, id: 11 }), env);
    const data = await res.json();
    assert.equal(data.error.data.code, "TOOL_ERROR");
    assert.notEqual(data.error.data.code, "DEVICE_UNREACHABLE");
  } finally {
    globalThis.fetch = realFetch;
  }
});
