// Browser-tool routing tests: callTool forwards browser tools to the
// PluginHubDO (/call) instead of the device's HTTP API, maps the DO's response
// (the extension's {id, type:"response", ok, result|error} frame) to call
// results, and the offline case surfaces a clear error. Pure local — PLUGIN_HUB
// is stubbed, no Cloudflare calls. The handleMcp-level case verifies a
// screenshot result ({image:...}) becomes an MCP image content block.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMcp, callTool } from "../src/mcp.js";

const DEVICE = { name: "d1", hostname: "d1.agent.saisi.online", token: "devtok" };

// PLUGIN_HUB stub: idFromName maps every name to itself, get() returns a
// fetch stub that records calls — the real DO binding behaves the same way.
function makeHub(fetchImpl) {
  return {
    idFromName: (name) => name,
    get: () => ({ fetch: fetchImpl }),
  };
}

// Full env for handleMcp-level tests (KV stub + PLUGIN_HUB stub).
function makeEnv(hub) {
  const kv = new Map([
    ["token:admintoken", "admin"],
    ["user:admin", JSON.stringify({ id: "admin", username: "admin", role: "admin", enabled: true, token: "admintoken" })],
    ["devices:v1", JSON.stringify([DEVICE])],
  ]);
  return {
    PLUGIN_HUB: hub,
    KEYS: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put() {}, async delete() {}, async list() { return { keys: [] }; },
    },
  };
}

test("browser tool routes through PluginHubDO /call; offline → extension_offline", async () => {
  const calls = [];
  const hub = makeHub(async (url, init) => {
    calls.push({ url: String(url), init });
    return { status: 503, json: async () => ({ error: "extension_offline" }) };
  });
  await assert.rejects(
    callTool({ name: "browser_snapshot" }, { PLUGIN_HUB: hub }, { name: "d1", hostname: "d1.example.com", token: "x" }, { device: "d1" }),
    /extension_offline/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hub/call");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.tool, "browser_snapshot");
  assert.deepEqual(body.params, { device: "d1" }); // device passes through — the extension needs it
  assert.ok(body.requestId, "requestId must be set");
});

test("browser tool: DO returns ok:true frame → callTool returns the inner result", async () => {
  const hub = makeHub(async () => ({
    status: 200,
    json: async () => ({ id: "r-1", type: "response", ok: true, result: { title: "Vale", url: "https://example.com", elements: [{ ref: 1, tag: "A", text: "x" }] } }),
  }));
  const result = await callTool({ name: "browser_snapshot" }, { PLUGIN_HUB: hub }, { name: "d1", hostname: "d1.example.com", token: "x" }, { device: "d1" });
  assert.deepEqual(result, { title: "Vale", url: "https://example.com", elements: [{ ref: 1, tag: "A", text: "x" }] });
});

test("browser tool: DO returns ok:false frame → rejects with the extension's error", async () => {
  const hub = makeHub(async () => ({
    status: 200,
    json: async () => ({ id: "r-2", type: "response", ok: false, error: "DOM changed — please re-snapshot" }),
  }));
  await assert.rejects(
    callTool({ name: "browser_click" }, { PLUGIN_HUB: hub }, { name: "d1", hostname: "d1.example.com", token: "x" }, { device: "d1", element_ref: 3 }),
    /extension error: DOM changed — please re-snapshot/,
  );
});

test("mcp: browser_screenshot through handleMcp → MCP image content block", async () => {
  const img = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const hub = makeHub(async () => ({ status: 200, json: async () => ({ id: "r-3", type: "response", ok: true, result: { image: img } }) }));
  const res = await handleMcp(
    new Request("https://x/mcp", {
      method: "POST",
      headers: { authorization: "Bearer admintoken", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "browser_screenshot", arguments: { device: "d1", full_page: true } }, id: 5 }),
    }),
    makeEnv(hub),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.result.content, [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
});
