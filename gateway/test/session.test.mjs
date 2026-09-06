// session.ts resolution-flow tests — cookie → user contract directly
// (handler suites cover the HTTP layer; this pins the middle layer):
// secret preference/fail-closed issuance, cookie accept/revoke/tamper/
// disabled/rotation paths, and the requireAdmin 401/403/user triple.
// Distinct user ids per file: store.ts keeps a module-level cache.
import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionSecret,
  issueSessionSecret,
  requireSession,
  requireAdmin,
} from "../src/session.ts";
import { issueSessionToken } from "../src/auth.ts";
import { makeEnv } from "./helpers.mjs";

const ADMIN = {
  id: "sessadmin",
  username: "sessadmin",
  role: "admin",
  enabled: true,
};
const USER = {
  id: "sessuser",
  username: "sessuser",
  role: "user",
  enabled: true,
};
const OFF = {
  id: "sessoff",
  username: "sessoff",
  role: "admin",
  enabled: false,
};

// Admin-password presence: requireCookieSession only checks truthiness.
const PW = "salt:hash";
const envWith = (users, kv = {}, extra = {}) =>
  makeEnv({ users, kv: { "auth:admin_password": PW, ...kv }, extra });

const cookieReq = (cookie) =>
  new Request("https://console.test/api/x", {
    headers: cookie ? { cookie: `ag_session=${cookie}` } : {},
  });

// ── secret selection ─────────────────────────────────────────

test("sessionSecret prefers SESSION_SECRET, falls back to the password", () => {
  assert.equal(sessionSecret({ SESSION_SECRET: "S" }, "pw"), "S");
  assert.equal(sessionSecret({}, "pw"), "pw");
  assert.equal(sessionSecret({ SESSION_SECRET: "" }, "pw"), "pw");
});

test("issueSessionSecret fails closed without SESSION_SECRET", () => {
  assert.equal(issueSessionSecret({ SESSION_SECRET: "S" }), "S");
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal(issueSessionSecret({}), null);
  } finally {
    console.error = orig;
  }
});

// ── requireSession ───────────────────────────────────────────

test("no cookie → null (no Access fallback configured)", async () => {
  const env = envWith({ sessadmin: ADMIN });
  assert.equal(await requireSession(cookieReq(null), env), null);
});

test("no admin password at all → null even with a cookie", async () => {
  const env = makeEnv({ users: { sessadmin: ADMIN } });
  const tok = await issueSessionToken("whatever", "sessadmin", "admin");
  assert.equal(await requireSession(cookieReq(tok), env), null);
});

test("valid cookie resolves the user", async () => {
  const env = envWith({ sessadmin: ADMIN });
  const tok = await issueSessionToken(PW, "sessadmin", "admin");
  const user = await requireSession(cookieReq(tok), env);
  assert.equal(user?.id, "sessadmin");
});

test("revoked cookie (logout blacklist) dies even with a valid sig", async () => {
  const env = envWith({ sessadmin: ADMIN });
  const tok = await issueSessionToken(PW, "sessadmin", "admin");
  env._kv.set(`sess-revoked:${tok}`, "1");
  assert.equal(await requireSession(cookieReq(tok), env), null);
});

test("tampered cookie → null", async () => {
  const env = envWith({ sessadmin: ADMIN });
  const tok = await issueSessionToken(PW, "sessadmin", "admin");
  assert.equal(await requireSession(cookieReq(`${tok}x`), env), null);
});

test("disabled user → null despite a valid cookie", async () => {
  const env = envWith({ sessoff: OFF });
  const tok = await issueSessionToken(PW, "sessoff", "admin");
  assert.equal(await requireSession(cookieReq(tok), env), null);
});

test("rotation compat: password-signed cookie accepted under SESSION_SECRET", async () => {
  const env = envWith({ sessadmin: ADMIN }, {}, { SESSION_SECRET: "S" });
  const tok = await issueSessionToken(PW, "sessadmin", "admin");
  const user = await requireSession(cookieReq(tok), env);
  assert.equal(user?.id, "sessadmin");
});

test("SESSION_SECRET-signed cookie accepted when set", async () => {
  const env = envWith({ sessadmin: ADMIN }, {}, { SESSION_SECRET: "S" });
  const tok = await issueSessionToken("S", "sessadmin", "admin");
  const user = await requireSession(cookieReq(tok), env);
  assert.equal(user?.id, "sessadmin");
});

// ── requireAdmin triple ──────────────────────────────────────

test("requireAdmin: admin → user, non-admin → 403, absent → 401", async () => {
  const envA = envWith({ sessadmin: ADMIN });
  const tokA = await issueSessionToken(PW, "sessadmin", "admin");
  const admin = await requireAdmin(cookieReq(tokA), envA);
  assert.equal(admin.id, "sessadmin");

  const envU = envWith({ sessuser: USER });
  const tokU = await issueSessionToken(PW, "sessuser", "user");
  const denied = await requireAdmin(cookieReq(tokU), envU);
  assert.ok(denied instanceof Response);
  assert.equal(denied.status, 403);

  const missing = await requireAdmin(cookieReq(null), envA);
  assert.ok(missing instanceof Response);
  assert.equal(missing.status, 401);
});
