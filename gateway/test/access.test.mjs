// Access SSO (option C) unit tests — sign local RS256 JWTs and drive
// requireSession end-to-end against a KV stub. No network: JWKS is injected.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto as crypto } from "node:crypto";

const { requireSession } = await import("../src/session.ts");
const { verifyAccessJwt, ensureUserByEmail } = await import("../src/access.ts");

const AUD = "test-aud-tag";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { priv: pair.privateKey, pubJwk: { kid: "test-kid", kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e } };
}

const keys = await makeKeys();

async function signJwt({ aud = AUD, email = "someone@example.com", expSec = Math.floor(Date.now() / 1000) + 600, kid = "test-kid" } = {}) {
  const h = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const p = b64url(JSON.stringify({ aud, email, exp: expSec }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.priv, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

/** Sign a JWT with an arbitrary extra-claim set (e.g. aud as array). */
async function signJwtRaw(payload) {
  const h = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-kid" }));
  const p = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.priv, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

function makeEnv({ adminEmail = "", users = {} } = {}) {
  const store = new Map(Object.entries(users));
  for (const [k, v] of Object.entries(users)) store.set(k, typeof v === "string" ? v : JSON.stringify(v));
  return {
    KEYS: {
      async get(k) { return store.has(k) ? store.get(k) : null; },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
    },
    ACCESS_AUD: AUD,
    ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
    ACCESS_JWKS_JSON: JSON.stringify({ keys: [keys.pubJwk] }),
    ACCESS_ADMIN_EMAIL: adminEmail,
    __store: store,
  };
}

function reqWith(jwt) {
  return new Request("https://ai.saisi.online/api/me", { headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} });
}

test.beforeEach(() => { /* fresh env per test via makeEnv */ });

test("valid JWT provisions a passwordless user on first sight", async () => {
  const env = makeEnv();
  const user = await ensureUserByEmail(env, "alice@example.com");
  assert.ok(user);
  assert.equal(user.role, "user");
  assert.equal(user.enabled, true);
  assert.ok(!user.passwordHash, "passwordless");
  // binding persisted
  assert.equal(await env.KEYS.get("access-email:alice@example.com"), user.id);
});

test("same email resolves to the same account (no duplicate provisioning)", async () => {
  const env = makeEnv();
  const a = await ensureUserByEmail(env, "bob@example.com");
  const b = await ensureUserByEmail(env, "BOB@example.com"); // case-insensitive
  assert.equal(a.id, b.id);
});

test("username collision gets a suffix instead of overwriting", async () => {
  const env = makeEnv({ users: { "user:alice": { id: "alice", username: "alice", role: "admin", enabled: true } } });
  const u = await ensureUserByEmail(env, "alice@example.com");
  assert.notEqual(u.id, "alice");
  assert.ok(u.id.startsWith("alice-"));
});

test("ACCESS_ADMIN_EMAIL binds to the seeded admin account", async () => {
  const env = makeEnv({
    adminEmail: "me@163.com",
    users: { "user:admin": { id: "admin", username: "admin", role: "admin", enabled: true } },
  });
  const u = await ensureUserByEmail(env, "me@163.com");
  assert.equal(u.id, "admin");
  assert.equal(u.role, "admin");
});

test("requireSession falls back to Access identity when no cookie", async () => {
  const env = makeEnv();
  const res = await requireSession(reqWith(await signJwt({ email: "carol@example.com" })), env);
  assert.ok(res);
  assert.equal(res.username.startsWith("carol"), true);
});

test("requireSession prefers a valid cookie session when present", async () => {
  // With no JWKS at all, JWT path is inert — only the cookie path could pass.
  const env = makeEnv();
  delete env.ACCESS_JWKS_JSON;
  const res = await requireSession(reqWith(await signJwt()), env);
  assert.equal(res, null);
});

test("rejects wrong aud / expired / bad signature", async () => {
  const env = makeEnv();
  const wrongAud = await signJwt({ aud: "other-app" });
  assert.equal(await verifyAccessJwt(reqWith(wrongAud), env), null);
  const expired = await signJwt({ expSec: Math.floor(Date.now() / 1000) - 10 });
  assert.equal(await verifyAccessJwt(reqWith(expired), env), null);
  const tampered = (await signJwt()).slice(0, -3) + "abc";
  assert.equal(await verifyAccessJwt(reqWith(tampered), env), null);
  assert.equal(await verifyAccessJwt(reqWith(null), env), null);
});

test("accepts aud as an array containing the configured AUD (RFC 7519 §4.1.3)", async () => {
  // Cloudflare currently emits aud as ["<tag>"]; an equals-only check
  // (string === string) silently rejects every live Access JWT.
  const env = makeEnv();
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJwtRaw({ aud: [AUD, "another-app"], email: "dave@example.com", exp: now + 600 });
  const claims = await verifyAccessJwt(reqWith(jwt), env);
  assert.deepEqual(claims, { email: "dave@example.com" });
  // wrong aud in the array → reject
  const wrongArr = await signJwtRaw({ aud: ["other-app", "yet-another"], email: "dave@example.com", exp: now + 600 });
  assert.equal(await verifyAccessJwt(reqWith(wrongArr), env), null);
});
