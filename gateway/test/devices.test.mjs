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
import { makeEnv as makeBaseEnv } from "./helpers.mjs";

const ADMIN_PW = "test-admin-password";

// Shared Map-KV stub (helpers.mjs, richest variant: list() + expiry tracking)
// seeded with this file's console base; keeps the makeEnv(devices, links)
// call shape the tests use. The expiry map is exposed as env._expiry (tests
// backdate entries to reproduce real KV's expired-but-unreaped list names).
function makeEnv(devices, links = {}) {
  return makeBaseEnv({
    devices,
    links,
    users: {
      admin: { id: "admin", username: "admin", role: "admin", enabled: true, token: "" },
      bob: { id: "bob", username: "bob", role: "user", enabled: true, token: "" },
    },
    kv: { "auth:admin_password": ADMIN_PW, _admin_seeded: "1" },
  });
}

async function adminCookie() { return issueSessionToken(ADMIN_PW, "admin", "admin"); }
async function userCookie() { return issueSessionToken(ADMIN_PW, "bob", "user"); }

function req(method, path, { body, cookie, auth, ip } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (ip) headers["cf-connecting-ip"] = ip;
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

/* ---------------- admin gate matrix (round-364) ---------------- */
// Every admin-gated devices route must answer 401 with no session and 403
// for a non-admin session — BEFORE touching devices (reject-only calls, so
// no mutations happen and one shared env suffices). Rename/install-cmd
// already pin theirs per-route; the rest are pinned here so a future
// handler that forgets requireSession fails loudly.
test("admin gate matrix: no session → 401, non-admin → 403 on every admin devices route", async () => {
  const env = makeEnv([D1]);
  const bob = await userCookie();
  const routes = [
    ["GET", "/api/devices"],
    ["POST", "/api/devices"],
    ["GET", "/api/devices/d1/mcp"],
    ["DELETE", "/api/devices/d1"],
    ["POST", "/api/devices/d1/panel-grant"],
    ["GET", "/api/devices/register-keys"],
    ["DELETE", "/api/devices/register-keys/abc"],
    ["GET", "/api/devices/install-cmd"],
    ["POST", "/api/devices/register-key"],
  ];
  for (const [method, path] of routes) {
    // GET/HEAD must not carry a body (undici throws) — gates run before
    // body parsing anyway, so omitting it changes nothing under test.
    const opts = method === "GET" || method === "HEAD" ? {} : { body: {} };
    const anon = await worker.fetch(req(method, path, opts), env);
    assert.equal(anon.status, 401, `${method} ${path} without session must be 401`);
    const nonAdmin = await worker.fetch(req(method, path, { ...opts, cookie: bob }), env);
    assert.equal(nonAdmin.status, 403, `${method} ${path} for non-admin must be 403`);
  }
  // Nothing was mutated by the rejected calls.
  const devs = JSON.parse(await env.KEYS.get("devices:v1"));
  assert.deepEqual(
    devs.map((d) => d.name),
    ["d1"],
    "reject-only matrix must not mutate the device list",
  );
});

/* ---------------- self-register (round-158 anti-hijack endpoint) -------- */
// round-440 (coverage-driven): handleSelfRegister had ZERO route pins.
const T64 = (c) => c.repeat(64);
// round-441: the public device routes share one 10/min/IP gate — each test
// below uses its own cf-connecting-ip so the tests never trip each other.
let nextIp = 41;
const testIp = () => `10.44.1.${nextIp++}`;
const selfReg = (env, body, ip) => worker.fetch(
  req("POST", "/api/devices/self-register", { body, ip: ip || testIp() }),
  env,
);

test("self-register: malformed body 400, non-64-hex token 403, off-suffix host 400", async () => {
  __clearCaches();
  const env = makeEnv([]);
  assert.equal((await selfReg(env, { name: "bad name!", hostname: "d9.agent.saisi.online", token: T64("a") })).status, 400);
  assert.equal((await selfReg(env, { name: "d9", hostname: "d9.agent.saisi.online", token: "shorttok" })).status, 403);
  assert.equal((await selfReg(env, { name: "d9", hostname: "evil.example.com", token: T64("a") })).status, 400);
  assert.deepEqual(JSON.parse(await env.KEYS.get("devices:v1")), [], "rejects mutate nothing");
});

test("self-register: new device inserts; same-token re-post refreshes idempotently", async () => {
  __clearCaches();
  const env = makeEnv([]);
  const { restore } = stubFetch("d9.agent.saisi.online", {});
  try {
    const body = { name: "d9", hostname: "d9.agent.saisi.online", token: T64("b") };
    const res = await selfReg(env, body);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).device, { name: "d9", hostname: "d9.agent.saisi.online" });
    const again = await selfReg(env, body);
    assert.equal(again.status, 200, "same token re-registers idempotently");
    const devs = JSON.parse(await env.KEYS.get("devices:v1"));
    assert.equal(devs.filter((d) => d.name === "d9").length, 1);
  } finally {
    restore();
  }
});

test("self-register: existing device rejects hostname moves + unproven rotations", async () => {
  __clearCaches();
  const OLD = T64("c"), NEW = T64("d");
  const env = makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: OLD, proxySecret: "ps-stored", registeredAt: 7 }]);
  const { restore } = stubFetch("d1.agent.saisi.online", {});
  try {
    const moved = await selfReg(env, { name: "d1", hostname: "moved.agent.saisi.online", token: OLD });
    assert.equal(moved.status, 409);
    const rotated = await selfReg(env, { name: "d1", hostname: "d1.agent.saisi.online", token: NEW });
    assert.equal(rotated.status, 409, "different token without stored-tunnel proof refuses");
    const devs = JSON.parse(await env.KEYS.get("devices:v1"));
    assert.equal(devs.find((d) => d.name === "d1").token, OLD);
  } finally {
    restore();
  }
});

// round-460 (coverage-driven): the PROVED rotation arm + the new-device
// proxySecret capture arm had ZERO pins.
test("self-register: tunnel-proved rotation accepted, new device captures the secret", async () => {
  __clearCaches();
  const OLD = T64("e"), NEW = T64("f");
  const SECRET = "s".repeat(40);
  const env = makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: OLD, proxySecret: SECRET, registeredAt: 7 }]);
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const secret = u.includes("d1.agent.saisi.online") ? SECRET : "n".repeat(40);
    return new Response(JSON.stringify(u.includes("/api/status") ? { proxy_secret: secret } : {}), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const rotated = await selfReg(env, { name: "d1", hostname: "d1.agent.saisi.online", token: NEW });
    assert.equal(rotated.status, 200, "tunnel proof (secret match) accepts the rotation");
    const devs = JSON.parse(await env.KEYS.get("devices:v1"));
    const d1 = devs.find((d) => d.name === "d1");
    assert.equal(d1.token, NEW);
    assert.equal(d1.proxySecret, SECRET, "stored secret preserved across rotation");
    assert.equal(d1.registeredAt, 7, "idempotent refresh keeps the original date");
    const fresh = await selfReg(env, { name: "d9", hostname: "d9.agent.saisi.online", token: T64("a") });
    assert.equal(fresh.status, 200);
    const d9 = JSON.parse(await env.KEYS.get("devices:v1")).find((d) => d.name === "d9");
    assert.equal(d9.proxySecret, "n".repeat(40), "new device captures the served secret");
  } finally {
    globalThis.fetch = real;
  }
});

test("self-register: stored-tunnel proof rotates the token", async () => {
  __clearCaches();
  const OLD = T64("e"), NEW = T64("f");
  const env = makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: OLD, proxySecret: "ps-stored", registeredAt: 7 }]);
  const { restore } = stubFetch("d1.agent.saisi.online", { proxy_secret: "ps-stored" });
  try {
    const res = await selfReg(env, { name: "d1", hostname: "d1.agent.saisi.online", token: NEW });
    assert.equal(res.status, 200);
    const devs = JSON.parse(await env.KEYS.get("devices:v1"));
    const d1 = devs.find((d) => d.name === "d1");
    assert.equal(d1.token, NEW);
    assert.equal(d1.registeredAt, 7, "rotation keeps the original registration date");
  } finally {
    restore();
  }
});

/* ---------------- register + tunnel-token (one-time-key chain) ---------- */
// round-441 (coverage-driven): both public one-time-key handlers had ZERO
// route pins — the spend/claim/grant chain and the round-68 anti-takeover.
const regPost = (env, path, body) => worker.fetch(
  req("POST", path, { body, ip: testIp() }),
  env,
);

test("register: garbage key 403s with zero KV writes; happy path spends the key", async () => {
  __clearCaches();
  const env = makeEnv([]);
  const garbage = await regPost(env, "/api/register", { key: "nope", name: "d9", hostname: "d9.agent.saisi.online", token: T64("a") });
  assert.equal(garbage.status, 403);
  assert.ok([...env._kv.keys()].every((k) => !k.startsWith("regclaim")), "round-115: invalid keys are zero-write");
  await env.KEYS.put("regkey:kk11", "1");
  const body = { key: "kk11", name: "d9", hostname: "d9.agent.saisi.online", token: T64("a") };
  const { restore } = stubFetch("d9.agent.saisi.online", {});
  let res;
  try {
    res = await regPost(env, "/api/register", body);
  } finally {
    restore();
  }
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(await regPost(env, "/api/register", body).then((r) => r.status), 403, "spent key refuses reuse");
  const devs = JSON.parse(await env.KEYS.get("devices:v1"));
  assert.ok(devs.some((d) => d.name === "d9"));
});

test("register: existing device name refuses with 409 (round-68 anti-takeover)", async () => {
  __clearCaches();
  const env = makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: T64("c") }]);
  await env.KEYS.put("regkey:kk22", "1");
  const res = await regPost(env, "/api/register", { key: "kk22", name: "d1", hostname: "d1.agent.saisi.online", token: T64("d") });
  assert.equal(res.status, 409);
  const devs = JSON.parse(await env.KEYS.get("devices:v1"));
  assert.equal(devs.find((d) => d.name === "d1").token, T64("c"), "production record untouched");
});

// round-461 (coverage-driven): register-with-key 400, rename bad-hostname
// 400, tunnel-token claim 403 + vanishing-key cleanup had ZERO pins.
test("register: valid key with bad body 400s; rename rejects a bad hostname", async () => {
  __clearCaches();
  const env = makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: T64("c") }]);
  await env.KEYS.put("regkey:kk44", "1");
  const bad = await regPost(env, "/api/register", { key: "kk44", name: "bad name!", hostname: "d9.agent.saisi.online", token: T64("a") });
  assert.equal(bad.status, 400);
  const admin = await adminCookie();
  const ren = await worker.fetch(req("POST", "/api/devices/d1/rename", {
    body: { name: "d1", hostname: "not a host!!" }, cookie: admin,
  }), env);
  assert.equal(ren.status, 400);
});

test("tunnel-token: claimed key 403s; vanishing key releases the claim", async () => {
  __clearCaches();
  const env = makeEnv([]);
  await env.KEYS.put("regkey:kk55", "1");
  await env.KEYS.put("cf:api_token", "CFTOKEN");
  await env.KEYS.put("regclaim:kk55", "1");
  assert.equal((await regPost(env, "/api/install/tunnel-token", { key: "kk55" })).status, 403);
  await env.KEYS.delete("regclaim:kk55");
  // Vanishing key: present at the gate, gone at the re-check — the claim
  // must be released (else the key is bricked for 60s).
  let regkeyGets = 0;
  const innerGet = env.KEYS.get.bind(env.KEYS);
  env.KEYS.get = async (k) => {
    if (k === "regkey:kk55") return ++regkeyGets === 1 ? "1" : null;
    return innerGet(k);
  };
  assert.equal((await regPost(env, "/api/install/tunnel-token", { key: "kk55" })).status, 403);
  assert.equal(await innerGet("regclaim:kk55"), null, "claim released on re-check failure");
});

// round-462 (coverage-driven): the insert-race 409 arm (round-122: pre-check
// passes, locked insert loses) + the admin-session upload arm had ZERO pins.
test("register: lost insert race 409s (pre-check passed, lock lost)", async () => {
  __clearCaches();
  const env = makeEnv([]);
  await env.KEYS.put("regkey:kk66", "1");
  const raced = JSON.stringify([{ name: "d1", hostname: "d1.agent.saisi.online", token: T64("q") }]);
  let devGets = 0;
  const innerGet = env.KEYS.get.bind(env.KEYS);
  env.KEYS.get = async (k) => {
    if (k === "devices:v1") return ++devGets === 1 ? "[]" : raced;
    return innerGet(k);
  };
  const { restore } = stubFetch("d1.agent.saisi.online", {});
  try {
    const res = await regPost(env, "/api/register", { key: "kk66", name: "d1", hostname: "d1.agent.saisi.online", token: T64("w") });
    assert.equal(res.status, 409);
  } finally {
    restore();
  }
});

test("upload proxy: admin session is proxied with the upload key", async () => {
  __clearCaches();
  const env = {
    ...makeEnv([]),
    UPLOAD_KEY: "test-upload-key",
    INDEX_WORKER_URL: "https://idx.example",
  };
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = await worker.fetch(req("POST", "/api/upload", {
      cookie: await adminCookie(),
      body: "pretend-file-bytes",
    }), env);
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["https://idx.example/api/upload"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("tunnel-token: valid key returns the CF token once, then feeds register via grant", async () => {
  __clearCaches();
  const env = makeEnv([]);
  await env.KEYS.put("regkey:kk33", "1");
  await env.KEYS.put("cf:api_token", "CFTOKEN");
  const bad = await regPost(env, "/api/install/tunnel-token", { key: "nope" });
  assert.equal(bad.status, 403);
  const res = await regPost(env, "/api/install/tunnel-token", { key: "kk33" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).apiToken, "CFTOKEN");
  const again = await regPost(env, "/api/install/tunnel-token", { key: "kk33" });
  assert.equal(again.status, 403, "spent key cannot harvest the token twice");
  // Same install completes registration with the spent key via the grant.
  const reg = await regPost(env, "/api/register", { key: "kk33", name: "d9", hostname: "d9.agent.saisi.online", token: T64("e") });
  assert.equal(reg.status, 200);
});

// round-458 (coverage-driven): the list/add/mcp SUCCESS paths had ZERO
// pins (only the 401/403 gate matrix). Covers the list mapping (masked
// token + mcp snippet), add validation + registeredAt keep, mcp 404/200.
test("devices list/add/mcp: admin success paths", async () => {
  __clearCaches();
  const env = makeEnv([]);
  const admin = await adminCookie();
  const call = (method, path, body) =>
    worker.fetch(req(method, path, { cookie: admin, body }), env);
  const empty = await (await call("GET", "/api/devices")).json();
  assert.deepEqual(empty.devices, []);
  const bad = await call("POST", "/api/devices", { name: "!!", hostname: "d1.agent.saisi.online", token: "tok12345" });
  assert.equal(bad.status, 400);
  const add = await call("POST", "/api/devices", { name: "d1", hostname: "d1.agent.saisi.online", token: "tok12345" });
  assert.equal(add.status, 200);
  const added = await add.json();
  assert.equal(added.ok, true);
  assert.equal(added.device.name, "d1");
  assert.ok(!added.device.token.includes("tok12345"), "list/add surfaces never leak the raw token");
  const list = await (await call("GET", "/api/devices")).json();
  assert.equal(list.devices.length, 1);
  assert.equal(list.devices[0].name, "d1");
  assert.ok(list.devices[0].mcp.url.includes("d1.agent.saisi.online/mcp"));
  assert.ok(list.devices[0].mcp.json.includes("tok12345"), "mcp snippet is the one place with the raw token");
  assert.equal((await call("GET", "/api/devices/nope/mcp")).status, 404);
  const mcp = await call("GET", "/api/devices/d1/mcp");
  assert.equal(mcp.status, 200);
  assert.equal((await mcp.json()).name, "d1");
});

// round-459 (coverage-driven): DELETE success (with link revocation) and
// the grant-redeem matrix had ZERO pins.
test("devices delete: removes the record and revokes its plugin links", async () => {
  __clearCaches();
  const env = makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: T64("a") }]);
  await env.KEYS.put("plugins:v1", JSON.stringify({ "tok-x": { device: "d1", createdAt: 1, expiresAt: Date.now() + 86400000 } }));
  __clearCaches();
  const admin = await adminCookie();
  const del = await worker.fetch(req("DELETE", "/api/devices/d1", { cookie: admin }), env);
  assert.equal(del.status, 200);
  const list = await (await worker.fetch(req("GET", "/api/devices", { cookie: admin }), env)).json();
  assert.deepEqual(list.devices, []);
  assert.deepEqual(JSON.parse(await env.KEYS.get("plugins:v1")), {}, "device links revoked on delete");
});

test("panel-grant redeem: no-token/unknown-token 401, mismatch 403, unknown grant 404, ok + single-use", async () => {
  __clearCaches();
  const env = makeEnv([
    { name: "d1", hostname: "d1.agent.saisi.online", token: T64("a") },
    { name: "d2", hostname: "d2.agent.saisi.online", token: T64("b") },
  ]);
  const admin = await adminCookie();
  const mint = (n) => worker.fetch(req("POST", `/api/devices/${n}/panel-grant`, { cookie: admin }), env);
  const code = (await (await mint("d1")).json()).url.split("grant=")[1];
  assert.ok(code, "mint returns a grant code");
  const redeem = (token, grant) => worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    ...(token ? { auth: token } : {}),
    body: { grant },
  }), env);
  assert.equal((await redeem(null, code)).status, 401);
  assert.equal((await redeem(T64("z"), code)).status, 401);
  assert.equal((await redeem(T64("b"), code)).status, 403, "grant bound to another device");
  assert.equal((await redeem(T64("a"), "nope")).status, 404);
  assert.equal((await redeem(T64("a"), code)).status, 200);
  assert.equal((await redeem(T64("a"), code)).status, 404, "single-use: consumed on first redeem");
});

test("panel-grant redeem: KV read failure fails closed 401", async () => {
  __clearCaches();
  const env = makeEnv([{ name: "d1", hostname: "d1.agent.saisi.online", token: T64("a") }]);
  const inner = env.KEYS.get.bind(env.KEYS);
  await inner("devices:v1"); // warm any boot reads before breaking the stub
  env.KEYS.get = async () => { throw new Error("kv down"); };
  const res = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    auth: T64("a"),
    body: { grant: "whatever" },
  }), env);
  assert.equal(res.status, 401, "listDevices throw → caller null → 401, never 500");
});
