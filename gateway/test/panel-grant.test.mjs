// One-time device-panel grants — the end-to-end fix for the panel token
// riding in URLs. The console's openPanel used to open
// https://<device-host>/panel/?token=<permanent 64-hex token> directly at the
// device origin; now it mints a 120s single-use grant bound to one device and
// the AGENT redeems it with its own Bearer token.
//
// Same harness as devices.test.mjs: full worker fetch against the default
// export with a Map-backed KV stub (helpers.mjs — list() + expiry tracking,
// so the KV TTL on panelgrant:<code> is assertable); admin/non-admin sessions
// minted directly via issueSessionToken. Device-token auth for the redeem
// route mirrors /api/upload's device path (registry scan + safeEq).
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { issueSessionToken, SESSION_COOKIE } from "../src/auth.ts";
import { makeEnv as makeBaseEnv } from "./helpers.mjs";

const ADMIN_PW = "test-admin-password";

const D1 = { name: "d1", hostname: "d1.agent.saisi.online", token: "a".repeat(64), proxySecret: "s" };
const D2 = { name: "d2", hostname: "d2.agent.saisi.online", token: "b".repeat(64), proxySecret: "s" };

function makeEnv(devices) {
  return makeBaseEnv({
    devices,
    users: {
      admin: { id: "admin", username: "admin", role: "admin", enabled: true, token: "" },
      bob: { id: "bob", username: "bob", role: "user", enabled: true, token: "" },
    },
    kv: { "auth:admin_password": ADMIN_PW, _admin_seeded: "1" },
  });
}

async function adminCookie() {
  return issueSessionToken(ADMIN_PW, "admin", "admin");
}
async function userCookie() {
  return issueSessionToken(ADMIN_PW, "bob", "user");
}

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

/** Mint a grant for `name` as the admin; returns the parsed { ok, url }. */
async function mint(env, name) {
  const res = await worker.fetch(
    req("POST", `/api/devices/${name}/panel-grant`, { cookie: await adminCookie() }),
    env,
  );
  assert.equal(res.status, 200, "mint must succeed for an existing device");
  return res.json();
}

/** The panelgrant:<code> KV key for the code embedded in a mint URL. */
function kvKey(url) {
  return `panelgrant:${new URL(url).searchParams.get("grant")}`;
}

/* ---------------- mint ---------------- */

test("panel-grant mint: 401 without session / 403 non-admin / 404 unknown device", async () => {
  const env = makeEnv([D1]);
  const noAuth = await worker.fetch(req("POST", "/api/devices/d1/panel-grant"), env);
  assert.equal(noAuth.status, 401);

  const bob = await worker.fetch(
    req("POST", "/api/devices/d1/panel-grant", { cookie: await userCookie() }),
    env,
  );
  assert.equal(bob.status, 403);

  const ghost = await worker.fetch(
    req("POST", "/api/devices/ghost/panel-grant", { cookie: await adminCookie() }),
    env,
  );
  assert.equal(ghost.status, 404);
});

test("panel-grant mint: 200 with admin session + url shape + KV record with ~120s TTL", async () => {
  const env = makeEnv([D1]);
  const j = await mint(env, "d1");

  assert.equal(j.ok, true);
  // Same hostname source as the MCP-config endpoint (https://<hostname>/…).
  assert.match(j.url, /^https:\/\/d1\.agent\.saisi\.online\/panel\/\?grant=[0-9a-f]{32}$/);
  assert.ok(!j.url.includes(D1.token), "the permanent token must NEVER appear in the minted url");

  const key = kvKey(j.url);
  assert.ok(env._kv.has(key), "grant must be stored in KV");
  const rec = JSON.parse(env._kv.get(key));
  assert.equal(rec.device, "d1", "grant must be bound to the device");
  assert.ok(typeof rec.mintedAt === "number");
  assert.ok(!JSON.stringify(rec).includes(D1.token), "grant record must not embed the device token");
  // TTL: 120s per store/grants.ts (KV minimum is 60; a short ceiling bounds
  // the lifetime of a URL sitting in history/address bar).
  const ttl = env._expiry.get(key) - Math.floor(Date.now() / 1000);
  assert.ok(ttl > 100 && ttl <= 120, `TTL must be ~120s, got ${ttl}`);
});

test("panel-grant mint: each mint is a distinct single-use code", async () => {
  const env = makeEnv([D1]);
  const a = await mint(env, "d1");
  const b = await mint(env, "d1");
  assert.notEqual(new URL(a.url).searchParams.get("grant"), new URL(b.url).searchParams.get("grant"));
});

/* ---------------- redeem ---------------- */

test("panel-grant redeem: device Bearer happy path → ok:true + grant deleted (single use)", async () => {
  const env = makeEnv([D1]);
  const { url } = await mint(env, "d1");
  const code = new URL(url).searchParams.get("grant");

  const res = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    auth: D1.token,
    body: { grant: code },
  }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.ok(!env._kv.has(kvKey(url)), "grant must be consumed (deleted) by the redeem");

  // Replay after consume → 404 (the grant is one-time).
  const replay = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    auth: D1.token,
    body: { grant: code },
  }), env);
  assert.equal(replay.status, 404);
});

test("panel-grant redeem: wrong-device grant → 403 and the grant stays alive", async () => {
  const env = makeEnv([D1, D2]);
  const { url } = await mint(env, "d1");
  const code = new URL(url).searchParams.get("grant");

  const res = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    auth: D2.token, // d2 redeeming d1's grant
    body: { grant: code },
  }), env);
  assert.equal(res.status, 403);
  assert.ok(env._kv.has(kvKey(url)), "a wrong-device redeem must not consume the grant");

  // The rightful device can still redeem afterwards.
  const ok = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    auth: D1.token,
    body: { grant: code },
  }), env);
  assert.equal(ok.status, 200);
});

test("panel-grant redeem: unknown / malformed / missing grant → 404 (no existence or shape leak)", async () => {
  const env = makeEnv([D1]);
  const unknown = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    auth: D1.token,
    body: { grant: "0123456789abcdef0123456789abcdef" }, // right shape, never minted
  }), env);
  assert.equal(unknown.status, 404);

  const malformed = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    auth: D1.token,
    body: { grant: "garbage!!" },
  }), env);
  assert.equal(malformed.status, 404, "malformed codes behave like unknown grants");

  const missing = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    auth: D1.token,
    body: {},
  }), env);
  assert.equal(missing.status, 404);
});

test("panel-grant redeem: 401 without / with an unknown device token", async () => {
  const env = makeEnv([D1]);
  const { url } = await mint(env, "d1");
  const code = new URL(url).searchParams.get("grant");

  const noAuth = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    body: { grant: code },
  }), env);
  assert.equal(noAuth.status, 401);

  const stranger = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    auth: "f".repeat(64),
    body: { grant: code },
  }), env);
  assert.equal(stranger.status, 401);
  assert.ok(env._kv.has(kvKey(url)), "failed auth must not consume the grant");
});

/* ---------------- end-to-end shape ---------------- */

test("panel-grant end-to-end: minted url never carries the device token; grant is device-bound", async () => {
  const env = makeEnv([D1, D2]);
  const j = await mint(env, "d1");
  assert.ok(!j.url.includes(D1.token));

  // d2's token must not redeem d1's grant (checked above too, but assert the
  // full loop here: the only credential that unlocks this url is d1's).
  const wrong = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    auth: D2.token,
    body: { grant: new URL(j.url).searchParams.get("grant") },
  }), env);
  assert.equal(wrong.status, 403);
  const right = await worker.fetch(req("POST", "/api/devices/panel-grant/redeem", {
    auth: D1.token,
    body: { grant: new URL(j.url).searchParams.get("grant") },
  }), env);
  assert.equal(right.status, 200);
});
