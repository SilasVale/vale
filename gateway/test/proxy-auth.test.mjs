// Device proxy auth tests — the proxy route accepts an admin session cookie
// OR a plugin token bound to that device.
//
// The browser extension's terminal page is cross-site to the console (a
// SameSite=Lax session cookie never attaches), so it authenticates to the
// gateway with `Authorization: Bearer <pluginToken>` — the same credential as
// /api/plugins/ws. The token must grant access ONLY to the device it's paired
// to; no other device, no admin APIs.
//
// Full worker fetch (default export) with a Map-backed KV stub; a stubbed
// global fetch stands in for the device panel (mirrors mcp-handler.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { issueSessionToken, SESSION_COOKIE } from "../src/auth.ts";

const ADMIN_PW = "test-admin-password";
const DEVICE = { name: "d1", hostname: "d1.agent.saisi.online", token: "devtok" };

// KV stub: device registry, plugin links (plugins:v1 token → {device}),
// admin password + users for the session path. `_admin_seeded` keeps
// seedAdmin from rewriting anything (content is consistent across tests so
// store.js's module-level cache can't go stale).
function makeEnv() {
  const kv = new Map([
    ["devices:v1", JSON.stringify([DEVICE])],
    ["plugins:v1", JSON.stringify({
      "tok-d1": { device: "d1", createdAt: 1, expiresAt: Date.now() + 86400000 * 30 },
      "tok-d2": { device: "d2", createdAt: 2 },
    })],
    ["auth:admin_password", ADMIN_PW],
    ["user:admin", JSON.stringify({ id: "admin", username: "admin", role: "admin", enabled: true, token: "" })],
    ["user:bob", JSON.stringify({ id: "bob", username: "bob", role: "user", enabled: true, token: "" })],
    ["_admin_seeded", "1"],
  ]);
  return {
    CONSOLE_HOST: "x",
    KEYS: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
    },
  };
}

/**
 * Stand in for the device panel; captures upstream calls, returns a JSON tool
 * envelope. MUST be async and `await` fn: the stub has to stay installed for
 * the whole worker.fetch pipeline (a sync helper restoring fetch in a `finally`
 * would reinstall the real fetch before the proxied device call happens).
 */
async function withDeviceFetch(fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, result: [{ id: "term-1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const PROXY_URL = "https://x/api/devices/d1/proxy/api/tools/terminal_list";

// ── Plugin token path (no session cookie at all) ──────────────

test("proxy: paired plugin token → proxied; device Bearer injected server-side", async () => {
  await withDeviceFetch(async (calls) => {
    const res = await worker.fetch(new Request(PROXY_URL, { headers: { authorization: "Bearer tok-d1" } }), makeEnv());
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://d1.agent.saisi.online/api/tools/terminal_list");
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer devtok"); // device token, not the plugin token
    assert.equal(calls[0].init.headers.get("cookie"), null); // console session never forwarded
    assert.equal(calls[0].init.method, "GET");
  });
});

test("proxy: token bound to a different device → 401, no upstream call", async () => {
  await withDeviceFetch(async (calls) => {
    const res = await worker.fetch(new Request(PROXY_URL, { headers: { authorization: "Bearer tok-d2" } }), makeEnv());
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

test("proxy: no auth at all → 401", async () => {
  await withDeviceFetch(async (calls) => {
    const res = await worker.fetch(new Request(PROXY_URL), makeEnv());
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

test("proxy: garbage token → 401", async () => {
  await withDeviceFetch(async (calls) => {
    const res = await worker.fetch(new Request(PROXY_URL, { headers: { authorization: "Bearer nope" } }), makeEnv());
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

// ── Session path (unchanged admin behavior) ───────────────────

test("proxy: admin session cookie still works", async () => {
  const token = await issueSessionToken(ADMIN_PW, "admin", "admin");
  await withDeviceFetch(async (calls) => {
    const res = await worker.fetch(new Request(PROXY_URL, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), makeEnv());
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer devtok");
  });
});

test("proxy: non-admin session without plugin token → 401", async () => {
  const token = await issueSessionToken(ADMIN_PW, "bob", "user");
  await withDeviceFetch(async (calls) => {
    const res = await worker.fetch(new Request(PROXY_URL, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), makeEnv());
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

// ── Route errors ──────────────────────────────────────────────

test("proxy: unknown device → 401 for the unauthenticated caller (device-name oracle closed)", async () => {
  await withDeviceFetch(async (calls) => {
    const res = await worker.fetch(new Request("https://x/api/devices/nope/proxy/api/tools/terminal_list"), makeEnv());
    // Gateway CRITICAL round: existence of a device name is no longer
    // disclosed to anonymous callers — 404 only surfaces to admin sessions.
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

// ── SSE passthrough (the extension's terminal stream) ─────────

test("proxy: SSE response passes through with the plugin token", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("data: {\"ok\":true}\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  try {
    const res = await worker.fetch(new Request("https://x/api/devices/d1/proxy/api/events/term", { headers: { authorization: "Bearer tok-d1" } }), makeEnv());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(await res.text(), "data: {\"ok\":true}\n\n");
  } finally {
    globalThis.fetch = real;
  }
});

// ── Login brute-force throttle ────────────────────────────────

test("login: 5 wrong passwords lock the username for 30s", async () => {
  const env = makeEnv();
  const post = (pw) => worker.fetch(new Request("https://x/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: pw }),
  }), env);
  for (let i = 0; i < 4; i++) {
    const res = await post(`wrong-${i}`);
    assert.equal(res.status, 401);
  }
  // 5th wrong password arms the lock.
  const fifth = await post("wrong-5");
  assert.equal(fifth.status, 401);
  // Even the correct password is now refused.
  const locked = await post(ADMIN_PW);
  assert.equal(locked.status, 429);
});

// ── Device status (agent + tunnel probe) ───────────────────────

test("plugins/status: agent_up reflects the device /api/status probe", async () => {
  const env = makeEnv();
  const adminCookie = await issueSessionToken(ADMIN_PW, "admin", "admin");
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/status")) return new Response(JSON.stringify({ ok: true, version: "1.0.6" }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  try {
    const res = await worker.fetch(new Request("https://x/api/plugins/status", { headers: { cookie: `${SESSION_COOKIE}=${adminCookie}` } }), env);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.devices.d1.agent_up, true);
    assert.equal(j.devices.d1.tunnel_up, true);
    assert.equal("online" in j.devices.d1, false); // extension WS state removed (round-341)
  } finally {
    globalThis.fetch = real;
  }
});
