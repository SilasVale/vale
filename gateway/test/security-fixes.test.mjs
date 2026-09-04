// Regression tests for the gateway security-fix round (audit findings):
//  1. POST /api/register enforces the device-host suffix allowlist
//     (same gate as self-register — a one-time-key holder must not be able
//     to register hostname=evil.com and have the proxy dial it with creds).
//  2. The MCP browser bridge (mcp.ts callMcpClientBridge) applies the shared
//     deviceFetch hostname guards before its long-timeout raw fetches — a
//     private/internal device hostname is refused with zero upstream calls.
//  3. Session tokens round-trip for every payload-length residue (the issued
//     payload is unpadded b64url; decode must restore padding like access.ts).
//     NOTE: Node's atob tolerates missing padding, so this passes pre-fix
//     locally — it pins the contract the strict workerd decoder requires.
//  4. Fresh-deploy seed (no CLIENT_KEY anywhere) mints an admin gateway
//     token, so the initial-password bootstrap is passable (previously the
//     empty token 403'd both key-gated paths while register/login 500'd:
//     no path to a first session).
//
// ORDER MATTERS: the fresh-seed test runs FIRST — store.ts's module-level
// `seeded` flag makes seedAdmin a process-once no-op, so every later test
// uses a pre-seeded env.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { issueSessionToken, verifySessionToken, SESSION_COOKIE } from "../src/auth.ts";
import { callTool, DEVICE_UNREACHABLE } from "../src/mcp.ts";
import { __clearCaches } from "../src/store.ts";

const ADMIN_PW = "test-admin-password";

/* ---- 4. fresh-deploy seed + bootstrap (runs first, see note above) ---- */

function freshEnv() {
  __clearCaches();
  const kv = new Map();
  return {
    CONSOLE_HOST: "x",
    KEYS: {
      async get(k) {
        return kv.has(k) ? kv.get(k) : null;
      },
      async put(k, v) {
        kv.set(k, v);
      },
      async delete(k) {
        kv.delete(k);
      },
    },
    _kv: kv,
  };
}

test("fresh deploy (no CLIENT_KEY): seed mints admin token; bootstrap + login work", async () => {
  const env = freshEnv();
  const put = (body) =>
    worker.fetch(
      new Request("https://x/api/admin/password", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  // Wrong key is still rejected (the gate isn't opened, just passable).
  const bad = await put({ password: "newpass123", adminKey: "WRONG" });
  assert.equal(bad.status, 403);
  // The seed minted a usable gateway token (readable by the deployer from KV).
  const admin = JSON.parse(env._kv.get("user:admin"));
  assert.ok(/^[0-9a-f]{48}$/.test(admin.token), "admin token is a minted 48-hex key");
  assert.equal(env._kv.get(`token:${admin.token}`), "admin");
  // Bootstrap with the minted key sets the first password session-less.
  const ok = await put({ password: "newpass123", adminKey: admin.token });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).initial, true);
  // And the new password logs in.
  const login = await worker.fetch(
    new Request("https://x/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "newpass123" }),
    }),
    env,
  );
  assert.equal(login.status, 200);
  assert.ok(String(login.headers.get("set-cookie") || "").includes(`${SESSION_COOKIE}=`));
});

/* ---- 1. /api/register suffix allowlist ---- */

function regEnv() {
  __clearCaches();
  const kv = new Map([
    ["regkey:testkey123", "1"],
    ["regkey:testkey456", "1"],
    ["devices:v1", JSON.stringify([])],
    ["plugins:v1", JSON.stringify({})],
    ["auth:admin_password", ADMIN_PW],
    [
      "user:admin",
      JSON.stringify({ id: "admin", username: "admin", role: "admin", enabled: true, token: "" }),
    ],
    ["_admin_seeded", "1"],
  ]);
  return {
    CONSOLE_HOST: "x",
    KEYS: {
      async get(k) {
        return kv.has(k) ? kv.get(k) : null;
      },
      async put(k, v) {
        kv.set(k, v);
      },
      async delete(k) {
        kv.delete(k);
      },
    },
    _kv: kv,
  };
}

async function withDeviceStub(fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true, proxy_secret: "s".repeat(32) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return { out: await fn(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

const register = (env, body) =>
  worker.fetch(
    new Request("https://x/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );

test("register: hostname outside the agent-host suffix → 400, no dial, key unspent", async () => {
  const env = regEnv();
  const { out: res, calls } = await withDeviceStub(() =>
    register(env, { key: "testkey123", name: "d9", hostname: "evil.com", token: "sometoken123" }),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message || "", /agent\.saisi\.online/);
  assert.equal(calls.length, 0, "rejected before the /api/status probe dials the hostname");
  assert.deepEqual(JSON.parse(env._kv.get("devices:v1")), [], "device not created");
  assert.equal(env._kv.get("regkey:testkey123"), "1", "one-time key not burned by a rejection");
});

test("register: agent-host hostname still registers", async () => {
  const env = regEnv();
  const { out: res } = await withDeviceStub(() =>
    register(env, {
      key: "testkey456",
      name: "d1",
      hostname: "d1.agent.saisi.online",
      token: "sometoken123",
    }),
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(JSON.parse(env._kv.get("devices:v1"))[0].hostname, "d1.agent.saisi.online");
});

/* ---- 2. MCP browser bridge hostname guard ---- */

async function withCountingFetch(fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return { status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  try {
    return { out: await fn().catch((e) => e), calls };
  } finally {
    globalThis.fetch = real;
  }
}

test("mcp bridge: private/internal device hostname → DEVICE_UNREACHABLE, zero fetches", async () => {
  for (const hostname of ["169.254.169.254", "127.0.0.1", "10.0.0.5", "localhost"]) {
    const { out: err, calls } = await withCountingFetch(() =>
      callTool(
        { name: "browser_open" },
        {},
        { name: "d1", hostname, token: "t" },
        { device: "d1", url: "https://example.com" },
      ),
    );
    assert.ok(err instanceof Error, `${hostname}: bridge threw`);
    assert.equal(err.code, DEVICE_UNREACHABLE, `${hostname}: stable error code`);
    assert.match(err.message, /private\/internal/, `${hostname}: guard message`);
    assert.equal(calls.length, 0, `${hostname}: no upstream dial (incl. self-heal)`);
  }
});

test("mcp bridge: public hostname still dials the device API", async () => {
  const { out, calls } = await withCountingFetch(() =>
    callTool(
      { name: "browser_open" },
      {},
      { name: "d1", hostname: "d1.agent.saisi.online", token: "t" },
      { device: "d1", url: "https://example.com" },
    ),
  );
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith("https://d1.agent.saisi.online/api/tools/mcp_client_call"));
});

/* ---- 3. session token padding round-trip ---- */

test("session token verifies for every payload-length residue", async () => {
  for (let n = 1; n <= 24; n++) {
    const uid = "u".repeat(n);
    const tok = await issueSessionToken("secret-for-test", uid, "admin");
    assert.ok(!tok.split(".")[0].includes("="), "issued payload is unpadded b64url");
    const v = await verifySessionToken("secret-for-test", tok);
    assert.deepEqual(v, { uid, role: "admin" }, `uid length ${n}`);
  }
});

test("logout writes the server-side sess-revoked blacklist (payload segment, not sig)", async () => {
  const env = freshEnv();
  const payload = Buffer.from(JSON.stringify({ uid: "u1", role: "admin", exp: Date.now() + 3600_000 }))
    .toString("base64url");
  const cookie = `${payload}.fakesig`;
  const r = await worker.fetch(
    new Request("https://x/api/auth/logout", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    }),
    env,
  );
  assert.equal(r.status, 200);
  const keys = [...env._kv.keys()].filter((k) => k.startsWith("sess-revoked:"));
  assert.equal(keys.length, 1, "exactly one blacklist entry written");
});
