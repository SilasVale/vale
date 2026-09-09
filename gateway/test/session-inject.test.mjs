// session.ts dependency-inversion seam tests (SOLID Round-5: DIP).
//
// The resolution flow depends on the narrow SessionUserStore interface, not
// on the KV-backed store. These pins prove, with zero KV involved:
//   - an injected fake resolves/tamper-rejects/disables exactly like prod;
//   - the default parameter IS the live store (explicit == omitted);
//   - all pre-existing 2-arg call sites keep their behavior (the full
//     contract matrix lives in session.test.mjs; this file only pins the
//     seam, it never duplicates that matrix).
// User ids are distinct from every other test file: store.ts keeps a
// module-level cache.
import test from "node:test";
import assert from "node:assert/strict";
import {
  requireSession,
  requireAdmin,
  liveSessionStore,
} from "../src/session.ts";
import { issueSessionToken } from "../src/auth.ts";
import { makeEnv } from "./helpers.mjs";

const SECRET = "di-test-secret";
const PW = "salt:hash";

const DIADMIN = { id: "diadmin", username: "diadmin", role: "admin", enabled: true };
const DIOFF = { id: "dioff", username: "dioff", role: "admin", enabled: false };
const DIUSER = { id: "diuser", username: "diuser", role: "user", enabled: true };

// Pure in-memory fake: no KEYS binding (revocation check skipped, same as a
// KV-less env), no module cache, fully deterministic.
const fakeStore = (users, adminPassword = "present") => ({
  getAdminPassword: async () => adminPassword,
  getUser: async (_env, uid) => users[uid] || null,
});

const plainEnv = { SESSION_SECRET: SECRET };
const cookieReq = (cookie) =>
  new Request("https://console.test/api/x", {
    headers: cookie ? { cookie: `ag_session=${cookie}` } : {},
  });

test("injected store resolves a SESSION_SECRET-signed cookie with no KV", async () => {
  const tok = await issueSessionToken(SECRET, "diadmin", "admin");
  const user = await requireSession(cookieReq(tok), plainEnv, fakeStore({ diadmin: DIADMIN }));
  assert.equal(user?.id, "diadmin");
});

test("injected store rejects tampered / unknown / disabled / passwordless", async () => {
  const store = fakeStore({ diadmin: DIADMIN, dioff: DIOFF });
  const tok = await issueSessionToken(SECRET, "diadmin", "admin");
  assert.equal(await requireSession(cookieReq(`${tok}x`), plainEnv, store), null, "tampered → null");
  const ghost = await issueSessionToken(SECRET, "nobody", "admin");
  assert.equal(await requireSession(cookieReq(ghost), plainEnv, store), null, "unknown uid → null");
  const off = await issueSessionToken(SECRET, "dioff", "admin");
  assert.equal(await requireSession(cookieReq(off), plainEnv, store), null, "disabled → null");
  const nopw = await requireSession(cookieReq(tok), plainEnv, fakeStore({ diadmin: DIADMIN }, ""));
  assert.equal(nopw, null, "no admin password → null even with a valid cookie");
});

test("default parameter is the live store (explicit == omitted)", async () => {
  const env = makeEnv({
    users: { diadmin: DIADMIN },
    kv: { "auth:admin_password": PW },
  });
  const tok = await issueSessionToken(PW, "diadmin", "admin");
  const omitted = await requireSession(cookieReq(tok), env);
  const explicit = await requireSession(cookieReq(tok), env, liveSessionStore);
  assert.equal(omitted?.id, "diadmin");
  assert.equal(explicit?.id, "diadmin");
});

test("requireAdmin triple through the injected store", async () => {
  const adminTok = await issueSessionToken(SECRET, "diadmin", "admin");
  const admin = await requireAdmin(
    cookieReq(adminTok),
    plainEnv,
    fakeStore({ diadmin: DIADMIN }),
  );
  assert.equal(admin.id, "diadmin");

  const userTok = await issueSessionToken(SECRET, "diuser", "user");
  const denied = await requireAdmin(
    cookieReq(userTok),
    plainEnv,
    fakeStore({ diuser: DIUSER }),
  );
  assert.ok(denied instanceof Response);
  assert.equal(denied.status, 403);

  const missing = await requireAdmin(
    cookieReq(null),
    plainEnv,
    fakeStore({ diadmin: DIADMIN }),
  );
  assert.ok(missing instanceof Response);
  assert.equal(missing.status, 401);
});
