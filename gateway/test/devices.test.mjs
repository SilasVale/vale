// Device management endpoint tests — the round-159 additions that had ZERO
// coverage before (rename, register-keys list/revoke, install-cmd, and the
// ?fresh=1 probe-cache bypass on /api/plugins/status).
//
// Same harness as proxy-auth.test.mjs: full worker fetch against the default
// export with a Map-backed KV stub; admin/non-admin sessions minted directly
// via issueSessionToken (no ACCESS_* env needed). store.ts's module-level
// 24h cache MUST be cleared per test — these tests MUTATE devices:v1, unlike
// proxy-auth's read-only seeding, so a stale cache would leak across tests.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { issueSessionToken, SESSION_COOKIE } from "../src/auth.ts";
import { __clearCaches, maskKey } from "../src/store.ts";

const ADMIN_PW = "test-admin-password";

function makeEnv(devices, links = {}) {
  __clearCaches();
  const kv = new Map([
    ["devices:v1", JSON.stringify(devices)],
    ["plugins:v1", JSON.stringify(links)],
    ["auth:admin_password", ADMIN_PW],
    ["user:admin", JSON.stringify({ id: "admin", username: "admin", role: "admin", enabled: true, token: "" })],
    ["user:bob", JSON.stringify({ id: "bob", username: "bob", role: "user", enabled: true, token: "" })],
    ["_admin_seeded", "1"],
  ]);
  const expiry = new Map(); // key → expiration (epoch SECONDS, like real KV)
  return {
    CONSOLE_HOST: "x",
    KEYS: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v, opts) {
        kv.set(k, v);
        if (opts && opts.expirationTtl) expiry.set(k, Math.floor(Date.now() / 1000) + opts.expirationTtl);
      },
      async delete(k) { kv.delete(k); expiry.delete(k); },
      async list({ prefix } = {}) {
        const keys = [];
        for (const k of kv.keys()) {
          if (prefix && !k.startsWith(prefix)) continue;
          keys.push({ name: k, expiration: expiry.get(k) || 0 });
        }
        return { keys };
      },
    },
    // Test hook: real KV list() keeps returning expired-but-unreaped key
    // names; tests backdate entries here to reproduce that state.
    _expiry: expiry,
  };
}

async function adminCookie() { return issueSessionToken(ADMIN_PW, "admin", "admin"); }
async function userCookie() { return issueSessionToken(ADMIN_PW, "bob", "user"); }

function req(method, path, { body, cookie, auth } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Install a global fetch stub; returns { calls, restore }. */
function stubFetch(matcher, response) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes(matcher)) {
      return response instanceof Response ? response : new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const D1 = { name: "d1", hostname: "d1.agent.saisi.online", token: "devtok-1234567890", registeredAt: 1000, lastVersion: "1.0.105" };
const D2 = { name: "d2", hostname: "d2.agent.saisi.online", token: "devtok-9876543210" };

/* ---------------- rename ---------------- */

test("rename: happy path preserves token + metadata, migrates plugin links", async () => {
  const env = makeEnv([D1, D2], { "tok-d1": { device: "d1", createdAt: 1, expiresAt: Date.now() + 86400000 } });
  const res = await worker.fetch(
    req("POST", "/api/devices/d1/rename", { body: { name: "renamed", hostname: "renamed.agent.saisi.online" }, cookie: await adminCookie() }),
    env,
  );
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.device.name, "renamed");
  assert.equal(j.device.hostname, "renamed.agent.saisi.online");
  assert.equal(j.device.token, maskKey("devtok-1234567890"), "token must be returned masked");

  // Store: name/hostname updated, credential + metadata untouched.
  const devs = JSON.parse(await env.KEYS.get("devices:v1"));
  const renamed = devs.find((d) => d.name === "renamed");
  assert.ok(renamed, "d1 must be gone, renamed present");
  assert.equal(renamed.token, "devtok-1234567890", "credential must survive a rename");
  assert.equal(renamed.registeredAt, 1000);
  assert.equal(renamed.lastVersion, "1.0.105");
  assert.ok(!devs.some((d) => d.name === "d1"));

  // Plugin links migrated to the new name (same token, new device).
  const links = JSON.parse(await env.KEYS.get("plugins:v1"));
  assert.equal(links["tok-d1"].device, "renamed");
});

test("rename: same-name rename is allowed (no-op host refresh)", async () => {
  const env = makeEnv([D1]);
  const res = await worker.fetch(
    req("POST", "/api/devices/d1/rename", { body: { name: "d1" }, cookie: await adminCookie() }),
    env,
  );
  assert.equal(res.status, 200);
});

test("rename: error branches — 401 unauth / 403 non-admin / 400 bad name / 404 missing / 409 taken", async () => {
  const env = makeEnv([D1, D2]);
  const noAuth = await worker.fetch(req("POST", "/api/devices/d1/rename", { body: { name: "x1" } }), env);
  assert.equal(noAuth.status, 401);

  const bob = await worker.fetch(
    req("POST", "/api/devices/d1/rename", { body: { name: "x1" }, cookie: await userCookie() }),
    env,
  );
  assert.equal(bob.status, 403);

  const admin = await adminCookie();
  const bad = await worker.fetch(req("POST", "/api/devices/d1/rename", { body: { name: "bad name!" }, cookie: admin }), env);
  assert.equal(bad.status, 400);

  const missing = await worker.fetch(req("POST", "/api/devices/ghost/rename", { body: { name: "x1" }, cookie: admin }), env);
  assert.equal(missing.status, 404);

  const taken = await worker.fetch(req("POST", "/api/devices/d1/rename", { body: { name: "d2" }, cookie: admin }), env);
  assert.equal(taken.status, 409);
});

/* ---------------- register-keys ---------------- */

test("register-keys: generate → list with TTL → revoke → empty; 401 unauth", async () => {
  const env = makeEnv([D1]);
  const gen = await worker.fetch(req("POST", "/api/devices/register-key", { cookie: await adminCookie() }), env);
  assert.equal(gen.status, 200);
  const { key } = await gen.json();
  assert.match(key, /^[0-9a-f]{16}$/);

  const listRes = await worker.fetch(req("GET", "/api/devices/register-keys", { cookie: await adminCookie() }), env);
  assert.equal(listRes.status, 200);
  const listed = (await listRes.json()).keys;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].code, key);
  assert.ok(listed[0].expiresAt > Date.now(), "KV TTL must surface as a future expiry");

  const revoke = await worker.fetch(req("DELETE", `/api/devices/register-keys/${key}`, { cookie: await adminCookie() }), env);
  assert.equal(revoke.status, 200);
  const after = (await (await worker.fetch(req("GET", "/api/devices/register-keys", { cookie: await adminCookie() }), env)).json()).keys;
  assert.equal(after.length, 0);

  const unauth = await worker.fetch(req("GET", "/api/devices/register-keys"), env);
  assert.equal(unauth.status, 401);
});

test("register-keys: expired-but-unreaped KV entries are filtered from the list", async () => {
  const env = makeEnv([D1]);
  const gen = await worker.fetch(req("POST", "/api/devices/register-key", { cookie: await adminCookie() }), env);
  const { key } = await gen.json();

  // Simulate real KV: the name lingers in list() after the TTL passed.
  env._expiry.set(`regkey:${key}`, Math.floor(Date.now() / 1000) - 5);

  const listRes = await worker.fetch(req("GET", "/api/devices/register-keys", { cookie: await adminCookie() }), env);
  const listed = (await listRes.json()).keys;
  assert.equal(listed.length, 0, "expired keys must not surface as unused reg keys");
});

/* ---------------- install-cmd ---------------- */

// installCmdCache is module-level with a 5-min TTL — every test travels the
// clock past it (store.cache.test.mjs's Date.now pattern) so tests stay
// order-independent about what the previous test cached.
function travelMs(ms) {
  const real = Date.now;
  Date.now = () => real() + ms;
  return () => { Date.now = real; };
}

test("install-cmd: upstream version flows through", async () => {
  const env = makeEnv([D1]);
  const undo = travelMs(0);
  const { restore } = stubFetch("agent.saisi.online/api/version", {
    version: "9.9.9", download: "https://x/dl/vale-agent-9.9.9.tgz", sha256: "a".repeat(64),
  });
  try {
    const res = await worker.fetch(req("GET", "/api/devices/install-cmd", { cookie: await adminCookie() }), env);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.version, "9.9.9");
    assert.equal(j.download, "https://x/dl/vale-agent-9.9.9.tgz");
  } finally { restore(); undo(); }
});

test("install-cmd: 5-min in-isolate cache (second call hits, clock travel re-fetches)", async () => {
  // installCmdCache is module-level and the previous test seeded it — every
  // travel offset here is strictly beyond all earlier ones (0 < 10m < 20m)
  // so each phase's cache age is deterministic (5-min TTL).
  const env = makeEnv([D1]);
  let undo = travelMs(10 * 60 * 1000);
  const { calls, restore } = stubFetch("agent.saisi.online/api/version", { version: "9.9.9", download: "https://x/dl/v.tgz" });
  try {
    const auth = { cookie: await adminCookie() };
    await worker.fetch(req("GET", "/api/devices/install-cmd", auth), env);
    await worker.fetch(req("GET", "/api/devices/install-cmd", auth), env);
    assert.equal(calls.length, 1, "second call within the TTL must hit the cache");
    undo();
    undo = travelMs(20 * 60 * 1000);
    await worker.fetch(req("GET", "/api/devices/install-cmd", auth), env);
    assert.equal(calls.length, 2, "cache must expire after 5 min");
  } finally { restore(); undo(); }
});

test("install-cmd: upstream failure → null version fallback (UI falls back to its constant)", async () => {
  const env = makeEnv([D1]);
  // 30 min: strictly beyond the previous test's cache stamp (20 min) + TTL.
  const undo = travelMs(30 * 60 * 1000);
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("boom", { status: 503 });
  try {
    const res = await worker.fetch(req("GET", "/api/devices/install-cmd", { cookie: await adminCookie() }), env);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.deepEqual([j.ok, j.version, j.download], [true, null, null]);
  } finally { globalThis.fetch = real; undo(); }
});

test("install-cmd: 401 unauth", async () => {
  const env = makeEnv([D1]);
  const res = await worker.fetch(req("GET", "/api/devices/install-cmd"), env);
  assert.equal(res.status, 401);
});

/* ---------------- /api/plugins/status?fresh=1 ---------------- */

test("plugins/status: ?fresh=1 bypasses the 30s probe cache; cached call does not re-probe", async () => {
  // Unique device name — DEVICE_PROBE_CACHE is a module-level Map shared
  // across tests, so probe counting must use a name no other test touches.
  // The stub matcher is LOWERCASE: the WHATWG URL parser lowercases
  // hostnames (deviceFetch round-121), so "dFresh" arrives as "dfresh".
  const env = makeEnv([{ name: "dFresh", hostname: "dFresh.agent.saisi.online", token: "tok-fresh" }]);
  const { calls, restore } = stubFetch("dfresh.agent.saisi.online/api/status", {
    ok: true, version: "9.8.7", serial_ports: [],
  });
  try {
    const auth = { cookie: await adminCookie() };
    const first = await worker.fetch(req("GET", "/api/plugins/status", auth), env);
    assert.equal(first.status, 200);
    const j1 = (await first.json()).devices.dFresh;
    assert.equal(j1.agent_up, true);
    assert.equal(j1.tunnel_up, true);
    assert.equal(j1.version, "9.8.7");
    assert.equal(typeof j1.checked_at, "number");
    const probesAfterFirst = calls.filter((u) => u.includes("/api/status")).length;
    assert.equal(probesAfterFirst, 1);

    // Cached call: no new probe.
    await worker.fetch(req("GET", "/api/plugins/status", auth), env);
    assert.equal(calls.filter((u) => u.includes("/api/status")).length, probesAfterFirst);

    // fresh=1: cache bypassed, exactly one more probe.
    const fresh = await worker.fetch(req("GET", "/api/plugins/status?fresh=1", auth), env);
    assert.equal(fresh.status, 200);
    assert.equal(calls.filter((u) => u.includes("/api/status")).length, probesAfterFirst + 1);
  } finally { restore(); }
});

test("upload proxy: 401 unauth / 401 bad device token (no network on reject)", async () => {
  const env = makeEnv({ d1: { name: "d1", hostname: "d1.agent.saisi.online", token: "a".repeat(64), proxySecret: "s" } });
  const noAuth = await worker.fetch(req("POST", "/api/upload"), env);
  assert.equal(noAuth.status, 401);
  const bad = await worker.fetch(
    req("POST", "/api/upload", { auth: `Bearer ${"b".repeat(64)}` }), env);
  assert.equal(bad.status, 401);
});

test("upload proxy: device config token accepted (no network on reject paths only)", async () => {
  const { __clearCaches } = await import("../src/store.ts");
  __clearCaches();
  const env = makeEnv({ d1: { name: "d1", hostname: "d1.agent.saisi.online", token: "c".repeat(64), proxySecret: "s" } });
  // Bad token still 401 without touching the network.
  const bad = await worker.fetch(req("POST", "/api/upload", { auth: `Bearer ${"d".repeat(64)}` }), env);
  assert.equal(bad.status, 401);
});

test("upload proxy: forwards a MINIMAL header set — UPLOAD_KEY + multipart framing, never client cookies", async () => {
  const { __clearCaches } = await import("../src/store.ts");
  __clearCaches();
  const env = {
    // ARRAY seed: the accept path iterates listDevices() (Device[]) — the
    // object-shaped seeds above only exercise reject paths.
    ...makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: "c".repeat(64), proxySecret: "s" }]),
    UPLOAD_KEY: "test-upload-key",
    INDEX_WORKER_URL: "https://idx.example",
  };
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    // Device-token accept path (safeEq compare) carrying ambient headers a
    // browser or extension page might have attached.
    const upstreamReq = new Request("https://x/api/upload", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"c".repeat(64)}`,
        "content-type": "multipart/form-data; boundary=----valeboundary",
        cookie: "ag_session=stolen; theme=dark; vale_pt_d1=also-stolen",
        "user-agent": "evil-client/1.0",
        "x-custom-leak": "nope",
      },
      body: "pretend-file-bytes",
    });
    const upstream = await worker.fetch(upstreamReq, env);
    assert.equal(upstream.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://idx.example/api/upload");
    const h = seen[0].headers;
    // The injected credential + the multipart framing survive verbatim…
    assert.equal(h.get("authorization"), "Bearer test-upload-key");
    assert.equal(h.get("content-type"), "multipart/form-data; boundary=----valeboundary");
    // …content-length is mirrored when the inbound request exposes it
    // (workerd does for real uploads; undici-built Requests don't).
    assert.equal(h.get("content-length"), upstreamReq.headers.get("content-length"));
    // …and NOTHING else does: the index worker is a separate origin and must
    // never see console cookies or ambient client headers.
    assert.equal(h.get("cookie"), null);
    assert.equal(h.get("user-agent"), null);
    assert.equal(h.get("x-custom-leak"), null);
  } finally {
    globalThis.fetch = real;
  }
});
