// F3 scoped relay token (ADR-0007 step 1) — relay-allowed/denied matrix.
//
// The relay token resolves to its owner with role "relay": translate/models
// dual-accept it, /mcp (admin-only) + the adminKey recovery gates reject it,
// and revocation/rotation behave independently of the admin token. Step 3
// (admin cutover off relay paths) ships as a default-off KV switch below.
//
// store.ts keeps a module-level cache: every test uses distinct token
// strings so entries seeded by an earlier test are never re-read.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { handleMcp } from "../src/mcp.ts";
import { handleGateway } from "../src/index.ts";
import { __clearCaches } from "../src/store.ts";
import {
  findUserByToken,
  getUser,
  rotateRelayToken,
  revokeRelayToken,
  regenerateToken,
} from "../src/store/users.ts";
import { safeEq, issueSessionToken } from "../src/auth.ts";
import { makeEnv as makeBaseEnv } from "./helpers.mjs";

function relayEnv(adminToken = "relay-adm-1") {
  return makeBaseEnv({
    users: {
      admin: { id: "admin", username: "admin", role: "admin", enabled: true, token: adminToken },
    },
    kv: { _admin_seeded: "1", "auth:admin_password": "pw", [`token:${adminToken}`]: "admin" },
  });
}

const meReq = (env, cookie, path, method, body) =>
  worker.fetch(
    new Request(`https://x${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie: `ag_session=${cookie}` } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );

// ── store: issuance + resolution ────────────────────────────

test("relay: rotate mints a token resolving to the owner with role relay", async () => {
  __clearCaches();
  const env = relayEnv();
  const relay = await rotateRelayToken(env, "admin");
  assert.ok(relay && relay !== "relay-adm-1", "fresh relay token issued");
  const u = await findUserByToken(env, relay);
  assert.equal(u.id, "admin");
  assert.equal(u.role, "relay");
  assert.equal(u.enabled, true);
});

test("relay: admin token still resolves role admin (dual-accept)", async () => {
  __clearCaches();
  const env = relayEnv("relay-adm-2");
  await rotateRelayToken(env, "admin");
  const u = await findUserByToken(env, "relay-adm-2");
  assert.equal(u.id, "admin");
  assert.equal(u.role, "admin");
});

test("relay: rotate replaces the old relay mapping", async () => {
  __clearCaches();
  const env = relayEnv("relay-adm-3");
  const r1 = await rotateRelayToken(env, "admin");
  const r2 = await rotateRelayToken(env, "admin");
  assert.notEqual(r1, r2);
  assert.equal(await findUserByToken(env, r1), null, "old relay mapping revoked");
  assert.equal((await findUserByToken(env, r2)).role, "relay");
});

test("relay: revoke kills the relay token, admin unaffected; second revoke is false", async () => {
  __clearCaches();
  const env = relayEnv("relay-adm-4");
  const r = await rotateRelayToken(env, "admin");
  assert.equal(await revokeRelayToken(env, "admin"), true);
  assert.equal(await findUserByToken(env, r), null);
  assert.equal((await findUserByToken(env, "relay-adm-4")).role, "admin");
  assert.equal(await revokeRelayToken(env, "admin"), false);
});

test("relay: admin-token rotation does not sweep the relay mapping", async () => {
  __clearCaches();
  const env = relayEnv("relay-adm-5");
  const r = await rotateRelayToken(env, "admin");
  await regenerateToken(env, "admin");
  assert.equal((await findUserByToken(env, r))?.role, "relay", "relay survives admin rotation");
});

test("relay: relay token never safeEq-matches the admin token (recovery gates exclude it)", async () => {
  __clearCaches();
  const env = relayEnv("relay-adm-6");
  const r = await rotateRelayToken(env, "admin");
  const admin = await getUser(env, "admin");
  assert.equal(safeEq(r, admin.token), false);
});

// ── /api/me issuance routes ─────────────────────────────────

test("relay route: 401 unauth; authed issues a working relay token", async () => {
  __clearCaches();
  const env = relayEnv("relay-adm-7");
  assert.equal((await meReq(env, null, "/api/me/token/relay", "POST", {})).status, 401);
  const cookie = await issueSessionToken("pw", "admin", "admin");
  const res = await meReq(env, cookie, "/api/me/token/relay", "POST", {});
  assert.equal(res.status, 200);
  const { token } = await res.json();
  assert.ok(token && token !== "relay-adm-7", "fresh relay token issued");
  const u = await findUserByToken(env, token);
  assert.equal(u.id, "admin");
  assert.equal(u.role, "relay");
});

test("relay route: DELETE revokes; meGet reports presence only", async () => {
  __clearCaches();
  const env = relayEnv("relay-adm-8");
  const cookie = await issueSessionToken("pw", "admin", "admin");
  const issued = await (await meReq(env, cookie, "/api/me/token/relay", "POST", {})).json();
  const me1 = await (await meReq(env, cookie, "/api/me", "GET")).json();
  assert.equal(me1.relayTokenSet, true);
  assert.ok(!("relayToken" in me1), "relay value never surfaces, only presence");
  const del = await meReq(env, cookie, "/api/me/token/relay", "DELETE");
  assert.deepEqual(await del.json(), { ok: true, revoked: true });
  assert.equal(await findUserByToken(env, issued.token), null);
  const me2 = await (await meReq(env, cookie, "/api/me", "GET")).json();
  assert.equal(me2.relayTokenSet, false);
  const del2 = await meReq(env, cookie, "/api/me/token/relay", "DELETE");
  assert.deepEqual(await del2.json(), { ok: true, revoked: false });
});

// ── gate matrix ─────────────────────────────────────────────

test("relay: /mcp Bearer relay → 401 (admin-only)", async () => {
  __clearCaches();
  const env = relayEnv("relay-adm-9");
  const r = await rotateRelayToken(env, "admin");
  const res = await handleMcp(
    new Request("https://x/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${r}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("relay: x-api-key relay drives /v1/messages (dual-accept), billed to the owner", async () => {
  __clearCaches();
  const uid = "relayowner";
  const env = makeBaseEnv({
    users: {
      [uid]: { id: uid, username: uid, role: "user", enabled: true, token: "relay-tr-adm" },
    },
    kv: {
      "token:relay-tr-adm": uid,
      [`ukeys:${uid}`]: JSON.stringify({ OPENCODE_GO_API_KEY: "sk-og" }),
    },
    extra: {
      BREAKER: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("0") }) },
    },
  });
  const relay = await rotateRelayToken(env, uid);
  const real = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const res = await handleGateway(
      new Request("https://g/v1/messages", {
        method: "POST",
        headers: { "x-api-key": relay, "content-type": "application/json" },
        body: JSON.stringify({
          model: "og/deepseek-v4-flash",
          max_tokens: 10,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      env,
      new URL("https://g/v1/messages"),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "message");
    assert.equal(body.content[0].text, "ok");
  } finally {
    globalThis.fetch = real;
  }
});

// ── step-3 cutover switch (default off) ─────────────────────
// Helper: translate env with optional cutover flag, pre-seeded owner keys.
function cutEnv(uid, adminToken, cutover) {
  return makeBaseEnv({
    users: {
      [uid]: { id: uid, username: uid, role: "admin", enabled: true, token: adminToken },
    },
    kv: {
      [`token:${adminToken}`]: uid,
      [`ukeys:${uid}`]: JSON.stringify({ OPENCODE_GO_API_KEY: "sk-og" }),
      ...(cutover ? { "settings:RELAY_ADMIN_CUTOVER": "1" } : {}),
    },
    extra: {
      BREAKER: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("0") }) },
    },
  });
}

const okUpstream = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const postMessages = (env, token) =>
  handleGateway(
    new Request("https://g/v1/messages", {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({
        model: "og/deepseek-v4-flash",
        max_tokens: 10,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
    env,
    new URL("https://g/v1/messages"),
  );

test("cutover off (default): admin token still drives relay paths", async () => {
  __clearCaches();
  const env = cutEnv("cutowner1", "relay-cut-adm-1", false);
  const real = globalThis.fetch;
  globalThis.fetch = async () => okUpstream();
  try {
    const res = await postMessages(env, "relay-cut-adm-1");
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = real;
  }
});

test("cutover on: admin 401s on relay paths, relay still passes", async () => {
  __clearCaches();
  const env = cutEnv("cutowner2", "relay-cut-adm-2", true);
  const relay = await rotateRelayToken(env, "cutowner2");
  const real = globalThis.fetch;
  globalThis.fetch = async () => okUpstream();
  try {
    const denied = await postMessages(env, "relay-cut-adm-2");
    assert.equal(denied.status, 401);
    const dj = await denied.json();
    assert.match(dj.error?.message || "", /relay token/);
    assert.equal((await postMessages(env, relay)).status, 200);
  } finally {
    globalThis.fetch = real;
  }
});

test("cutover on: /mcp admin still works (cutover touches relay paths only)", async () => {
  __clearCaches();
  const env = cutEnv("cutowner3", "relay-cut-adm-3", true);
  const res = await handleMcp(
    new Request("https://x/mcp", {
      method: "POST",
      headers: { authorization: "Bearer relay-cut-adm-3", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    }),
    env,
  );
  assert.equal(res.status, 200);
});

test("relay reveal: 401 unauth; 404 when unset; value when set", async () => {
  __clearCaches();
  const env = relayEnv("relay-adm-10");
  assert.equal((await meReq(env, null, "/api/me/token/relay/reveal", "POST", {})).status, 401);
  const cookie = await issueSessionToken("pw", "admin", "admin");
  assert.equal((await meReq(env, cookie, "/api/me/token/relay/reveal", "POST", {})).status, 404);
  const issued = await (await meReq(env, cookie, "/api/me/token/relay", "POST", {})).json();
  const shown = await meReq(env, cookie, "/api/me/token/relay/reveal", "POST", {});
  assert.equal(shown.status, 200);
  assert.deepEqual(await shown.json(), { ok: true, value: issued.token });
});
