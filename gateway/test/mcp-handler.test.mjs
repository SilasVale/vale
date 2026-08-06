// mcp.js handler behavior tests — pure local (mock KV + stubbed fetch), no Cloudflare calls.
//
// store.js reads via env.KEYS (`token:<t>` → userId, `user:<id>` → JSON, `devices:v1` →
// JSON array), so a Map-backed KV stub stands in. Note store.js keeps a module-level
// 24h cache: distinct tokens per distinct user and one consistent devices payload keep
// tests from stepping on each other's cached entries.
//
// terminal_send is asserted through the real deviceFetch path by stubbing globalThis.fetch
// (ESM namespace exports are frozen, so monkey-patching deviceFetch itself is not possible;
// stubbing fetch exercises the full handleMcp → callTool → deviceFetch pipeline unchanged).
import test from "node:test";
import assert from "node:assert/strict";
import { handleMcp } from "../src/mcp.js";

const DEVICE = { name: "d1", hostname: "d1.command.saisi.online", token: "devtok" };

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

test("mcp: tools/call terminal_send → device /api/tools/terminal_execute with mapped body", async () => {
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
    let res = await handleMcp(post({ jsonrpc: "2.0", method: "tools/call", params: { name: "terminal_send", arguments: { device: "d1", session_id: "s-1", input: "ls -la", quiet_ms: 400 } }, id: 2 }), env);
    assert.equal(res.status, 200);
    let data = await res.json();
    assert.equal(data.result.content[0].type, "text");
    // quiet_ms defaults to 400 when omitted
    res = await handleMcp(post({ jsonrpc: "2.0", method: "tools/call", params: { name: "terminal_send", arguments: { device: "d1", session_id: "s-1", input: "pwd" } }, id: 3 }), env);
    assert.equal(res.status, 200);
    data = await res.json();
    assert.ok(data.result.content[0].text.includes("pwd"));

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://d1.command.saisi.online/api/tools/terminal_execute");
    assert.deepEqual(JSON.parse(calls[0].init.body), { command: "ls -la", session_id: "s-1", quiet_ms: 400 }); // device + input stripped, input→command
    assert.deepEqual(JSON.parse(calls[1].init.body), { command: "pwd", session_id: "s-1", quiet_ms: 400 });   // default quiet_ms
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer devtok"); // device token injected server-side
    assert.equal(calls[0].init.headers.get("host"), null);   // host/cookie stripped
    assert.equal(calls[0].init.headers.get("cookie"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("mcp: tools/call unknown device → -32602", async () => {
  const res = await handleMcp(post({ jsonrpc: "2.0", method: "tools/call", params: { name: "terminal_list", arguments: { device: "nope" } }, id: 4 }), makeEnv());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.error.code, -32602);
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
