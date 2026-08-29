// MCP gateway behavior tests — the round-160 fixes that came out of a week
// of real DSH usage (428 failed tool calls, 10% of all traffic):
//   1. device arg is OPTIONAL — a missing or misguessed name resolves to the
//      single registered device instead of erroring ("Unknown device: og").
//   2. terminal_* stale-session self-heal — after an agent restart wipes the
//      PTY registry, a session_not_found result retargets to the one live
//      session instead of bouncing the error back to the model.
//   3. secret_* routes to the DEVICE agent (keyring/file), not the browser
//      extension (extension_offline made secret_get fail 9/9).
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { __clearCaches } from "../src/store.ts";

const ADMIN_PW = "test-admin-password";
const ADMIN_TOKEN = "test-admin-mcp-token";

function makeEnv(devices, links = {}) {
  __clearCaches();
  const kv = new Map([
    ["devices:v1", JSON.stringify(devices)],
    ["plugins:v1", JSON.stringify(links)],
    ["auth:admin_password", ADMIN_PW],
    ["user:admin", JSON.stringify({ id: "admin", username: "admin", role: "admin", enabled: true, token: "" })],
    ["token:" + ADMIN_TOKEN, "admin"],
    ["_admin_seeded", "1"],
  ]);
  return {
    CONSOLE_HOST: "x",
    KEYS: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
      async list({ prefix } = {}) {
        return { keys: [...kv.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((k) => ({ name: k })) };
      },
    },
  };
}

function mcpReq(method, params) {
  return new Request("https://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function callTool(env, name, args) {
  const res = await worker.fetch(mcpReq("tools/call", { name, arguments: args }), env);
  return res.json();
}

test("tools/call without a device arg resolves the single registered device", async () => {
  const env = makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: "devtok" }]);
  // terminal_list hits the device — stub the probe/list fetches.
  const real = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (url) => {
    paths.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: [{ id: "term-1", kind: "pty" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const j = await callTool(env, "terminal_list", {});
    assert.equal(j.error, undefined, JSON.stringify(j));
    assert.ok(j.result?.content?.length >= 1);
    assert.ok(paths.some((u) => u.includes("d1.agent.saisi.online/api/tools/terminal_list")), "must proxy to the resolved device");
  } finally { globalThis.fetch = real; }
});

test("a misguessed device name with multiple devices lists them in the error", async () => {
  const env = makeEnv([
    { name: "d1", hostname: "d1.agent.saisi.online", token: "t1" },
    { name: "d2", hostname: "d2.agent.saisi.online", token: "t2" },
  ]);
  const j = await callTool(env, "terminal_list", { device: "og" });
  assert.equal(j.error?.code, -32602);
  assert.match(j.error.message, /Unknown device: og/);
  assert.match(j.error.message, /Registered devices: d1, d2/);
});

test("terminal_execute on a stale session retargets to the single live session", async () => {
  const env = makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: "devtok" }]);
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ u, body: init?.body ? JSON.parse(init.body) : null });
    if (u.includes("/api/tools/terminal_execute")) {
      const sid = JSON.parse(init.body).session_id;
      if (sid === "term-old") {
        // The agent's typed post-restart error (round-59 code).
        return new Response(JSON.stringify({ ok: false, code: "session_not_found", error: "Session not found: term-old. This session existed before the last agent restart - PTYs cannot survive restarts." }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, result: { state: "done", output: "ok" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/api/tools/terminal_list")) {
      return new Response(JSON.stringify({ ok: true, result: [{ id: "term-new", kind: "pty" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const j = await callTool(env, "terminal_execute", { session_id: "term-old", input: "ls" });
    assert.equal(j.error, undefined, JSON.stringify(j).slice(0, 300));
    const text = j.result?.content?.[0]?.text || "";
    assert.match(text, /term-new/, "result must mention the retargeted session");
    const execCalls = calls.filter((c) => c.u.includes("terminal_execute"));
    assert.equal(execCalls.length, 2, "exactly one retry after the list");
    assert.equal(execCalls[1].body.session_id, "term-new", "retry must use the live session id");
  } finally { globalThis.fetch = real; }
});

test("terminal_close on an already-dead session succeeds (no retarget, nothing closed)", async () => {
  const env = makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: "devtok" }]);
  const real = globalThis.fetch;
  const closes = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/api/tools/terminal_close")) {
      closes.push(JSON.parse(init.body).session_id);
      return new Response(JSON.stringify({ ok: false, code: "session_not_found", error: "Session not found: term-old" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/api/tools/terminal_list")) {
      return new Response(JSON.stringify({ ok: true, result: [{ id: "term-other" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const j = await callTool(env, "terminal_close", { session_id: "term-old" });
    assert.equal(j.error, undefined, JSON.stringify(j).slice(0, 300));
    const text = j.result?.content?.[0]?.text || "";
    assert.match(text, /already gone/);
    assert.deepEqual(closes, ["term-old"], "must NOT close a different session");
  } finally { globalThis.fetch = real; }
});

test("secret_get routes to the DEVICE agent, not the browser extension", async () => {
  const env = makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: "devtok" }]);
  const real = globalThis.fetch;
  const hits = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    hits.push(u);
    if (u.includes("/api/tools/secret_get")) {
      return new Response(JSON.stringify({ ok: true, result: { value: "the-password" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const j = await callTool(env, "secret_get", { target: "root@box:22" });
    assert.equal(j.error, undefined, JSON.stringify(j).slice(0, 300));
    const text = j.result?.content?.[0]?.text || "";
    assert.match(text, /the-password/);
    assert.ok(hits.some((u) => u.includes("d1.agent.saisi.online/api/tools/secret_get")), "must fetch from the device agent");
    // No PluginHubDO in env — an extension route would have thrown instead of succeeding.
  } finally { globalThis.fetch = real; }
});
