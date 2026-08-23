// Browser-tool routing tests: callTool forwards browser tools to the device's
// own HTTP API (/api/tools/mcp_client_call → playwright-mcp via the agent's
// mcp_client plugin), maps gateway tool names to playwright names, and
// self-heals the "rebooted device" case: nothing starts playwright-mcp nor
// opens the client session after boot, so the first browser_* call hits
// "not connected" — the bridge then start → connect → retries once.
// Pure local — global fetch is stubbed, no network calls. The handleMcp-level
// case verifies a screenshot data-URL becomes an MCP image content block.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMcp, callTool } from "../src/mcp.ts";

const DEVICE = { name: "d1", hostname: "d1.example.com", token: "devtok" };

// fetch stub: records every call, replies from a handler per URL.
function makeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, impl };
}

async function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

const okJson = (result) => ({
  status: 200,
  json: async () => ({ ok: true, result }),
});

test("browser tool routes to the device mcp_client_call API with mapped name + bearer", async () => {
  const { calls, impl } = makeFetch((url) => {
    assert.equal(url, "https://d1.example.com/api/tools/mcp_client_call");
    return okJson({ title: "Vale" });
  });
  await withFetch(impl, () =>
    callTool(
      { name: "browser_open" },
      {},
      DEVICE,
      { device: "d1", url: "https://example.com" },
    ),
  );
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  // gateway 名 browser_open 映射为 playwright 的 browser_navigate
  assert.equal(body.tool, "browser_navigate");
  assert.deepEqual(body.arguments, { device: "d1", url: "https://example.com" });
  assert.equal(calls[0].init.headers.Authorization, "Bearer devtok");
});

test("self-heal: not connected → playwright/start + mcp_client_connect → retry succeeds", async () => {
  let n = 0;
  const { calls, impl } = makeFetch((url, init) => {
    if (String(url).endsWith("/api/tools/mcp_client_call")) {
      n += 1;
      if (n === 1) {
        return {
          status: 200,
          json: async () => ({
            ok: false,
            error: "not connected — call mcp_client_connect first",
            code: "invalid_params",
          }),
        };
      }
      return okJson({ elements: [] });
    }
    // heal endpoints
    assert.ok(
      String(url).endsWith("/api/plugins/playwright/start") ||
        String(url).endsWith("/api/tools/mcp_client_connect"),
      `unexpected heal URL ${url}`,
    );
    return okJson({ status: "started" });
  });
  const result = await withFetch(impl, () =>
    callTool({ name: "browser_snapshot" }, {}, DEVICE, { device: "d1" }),
  );
  assert.deepEqual(result, { ok: true, result: { elements: [] } });
  // order: call → start → connect → retry(call)
  const urls = calls.map((c) => c.url.split("/").pop());
  assert.deepEqual(urls, [
    "mcp_client_call",
    "start",
    "mcp_client_connect",
    "mcp_client_call",
  ]);
});

test("persistent failure after heal → rejects with the device error", async () => {
  const { impl } = makeFetch(() => ({
    status: 200,
    json: async () => ({ ok: false, error: "MCP connect failed: refused" }),
  }));
  await withFetch(impl, () =>
    assert.rejects(
      callTool({ name: "browser_click" }, {}, DEVICE, { device: "d1" }),
      /MCP connect failed: refused/,
    ),
  );
});

test("mcp: browser_screenshot data-URL → MCP image content block", async () => {
  const { impl } = makeFetch(() =>
    okJson("data:image/png;base64,aGVsbG8="),
  );
  const res = await withFetch(impl, () =>
    handleMcp(
      new Request("https://x/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer admintoken",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "browser_screenshot",
            arguments: { device: "d1", full_page: true },
          },
          id: 5,
        }),
      }),
      makeEnv(),
    ),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.result.content, [
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ]);
});

// KV stub for handleMcp-level tests.
function makeEnv() {
  const kv = new Map([
    ["token:admintoken", "admin"],
    [
      "user:admin",
      JSON.stringify({
        id: "admin",
        username: "admin",
        role: "admin",
        enabled: true,
        token: "admintoken",
      }),
    ],
    ["devices:v1", JSON.stringify([DEVICE])],
  ]);
  return {
    KEYS: {
      async get(k) {
        return kv.has(k) ? kv.get(k) : null;
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [] };
      },
    },
  };
}
