// auth.ts primitive unit tests — pure Web Crypto, no KV/env needed.
// The handler-level suites (auth-gates/panel-grant/devices) exercise these
// through HTTP; this file pins the primitives directly: PBKDF2 roundtrip,
// safeEq, the CSRF matrix, HMAC session issue/verify (incl. expiry vs
// tamper), cookie helpers.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  randomHex,
  hashPassword,
  verifyPassword,
  safeEq,
  csrfCookieViolation,
  issueSessionToken,
  verifySessionToken,
  parseCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
  b64urlDecodeStr,
  PASSWORD_ITERATIONS,
  SESSION_TTL_MS,
} from "../src/auth.ts";
import { readFileSync } from "node:fs";

// ── randomHex ──────────────────────────────────────────────

test("randomHex: 2×hex chars, unique per call", () => {
  const a = randomHex(16);
  const b = randomHex(16);
  assert.equal(a.length, 32);
  assert.match(a, /^[0-9a-f]+$/);
  assert.notEqual(a, b);
  assert.equal(randomHex(0), "");
});

// ── PBKDF2 ─────────────────────────────────────────────────

test("hashPassword is deterministic; verifyPassword accepts/rejects", async () => {
  const h1 = await hashPassword("s3cret", "salty");
  const h2 = await hashPassword("s3cret", "salty");
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
  assert.equal(await verifyPassword("s3cret", "salty", h1), true);
  assert.equal(await verifyPassword("wrong", "salty", h1), false);
  assert.equal(await verifyPassword("s3cret", "other-salt", h1), false);
  assert.equal(await verifyPassword("s3cret", "salty", "0".repeat(64)), false);
});

// ── safeEq ─────────────────────────────────────────────────

test("safeEq: equal/length-mismatch/content-mismatch", () => {
  assert.equal(safeEq("abc", "abc"), true);
  assert.equal(safeEq("abc", "abd"), false);
  assert.equal(safeEq("abc", "abcd"), false);
  assert.equal(safeEq("", "x"), false);
});

// ── CSRF gate ──────────────────────────────────────────────

const req = (method, headers = {}) =>
  new Request("https://console.test/api/x", { method, headers });

test("csrf: safe methods never violate, even with a session cookie", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(
      csrfCookieViolation(req(method, { cookie: "ag_session=abc", "sec-fetch-site": "cross-site" })),
      false,
      method,
    );
  }
});

test("csrf: mutations without any credential cookie are the bearer path", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      csrfCookieViolation(req(method, { cookie: "other=1", "sec-fetch-site": "cross-site" })),
      false,
      method,
    );
  }
});

test("csrf: cookie-carrying mutations pass same-origin/none/missing, fail same-site/cross-site", () => {
  const cookie = { cookie: "ag_session=abc" };
  assert.equal(csrfCookieViolation(req("POST", { ...cookie, "sec-fetch-site": "same-origin" })), false);
  assert.equal(csrfCookieViolation(req("POST", { ...cookie, "sec-fetch-site": "none" })), false);
  assert.equal(csrfCookieViolation(req("POST", { ...cookie, "sec-fetch-site": "Same-Origin" })), false);
  assert.equal(csrfCookieViolation(req("POST", cookie)), false, "non-browser clients omit the header");
  assert.equal(csrfCookieViolation(req("POST", { ...cookie, "sec-fetch-site": "same-site" })), true);
  assert.equal(csrfCookieViolation(req("POST", { ...cookie, "sec-fetch-site": "cross-site" })), true);
});

test("csrf: per-device proxy cookies count as credential cookies too", () => {
  const cookie = { cookie: "vale_pt_d1=tok" };
  assert.equal(csrfCookieViolation(req("POST", { ...cookie, "sec-fetch-site": "cross-site" })), true);
  assert.equal(csrfCookieViolation(req("POST", { ...cookie, "sec-fetch-site": "same-origin" })), false);
});

// ── HMAC sessions ──────────────────────────────────────────

test("session issue/verify roundtrip carries uid+role", async () => {
  const tok = await issueSessionToken("sekret", "u1", "admin");
  assert.match(tok, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const got = await verifySessionToken("sekret", tok);
  assert.deepEqual(got, { uid: "u1", role: "admin" });
});

test("session verify rejects wrong secret, tampering, and malformed tokens", async () => {
  const tok = await issueSessionToken("sekret", "u1", "admin");
  assert.equal(await verifySessionToken("other", tok), null);
  const [payload, sig] = tok.split(".");
  assert.equal(await verifySessionToken("sekret", `${payload}x.${sig}`), null, "tampered payload");
  assert.equal(await verifySessionToken("sekret", `${payload}.${sig}x`), null, "tampered sig");
  assert.equal(await verifySessionToken("sekret", "no-dot-here"), null);
  assert.equal(await verifySessionToken("", tok), null);
  assert.equal(await verifySessionToken("sekret", ""), null);
});

test("session verify rejects expired payloads (distinct from sig failure)", async () => {
  // Craft a VALIDLY-SIGNED but expired token with node:crypto (issueSessionToken
  // always mints a fresh exp, so expiry is unreachable through it).
  const payload = Buffer.from(JSON.stringify({ uid: "u1", role: "user", exp: 1 }))
    .toString("base64url");
  const sig = createHmac("sha256", "sekret").update(payload).digest("base64url");
  assert.equal(await verifySessionToken("sekret", `${payload}.${sig}`), null);
});

test("b64urlDecodeStr restores stripped padding", () => {
  // Lengths needing 0, 1, and 2 pad chars.
  assert.equal(b64urlDecodeStr(Buffer.from("abcd").toString("base64url")), "abcd");
  assert.equal(b64urlDecodeStr(Buffer.from("abcde").toString("base64url")), "abcde");
  assert.equal(b64urlDecodeStr(Buffer.from("abcdef").toString("base64url")), "abcdef");
});

// ── cookies ────────────────────────────────────────────────

test("parseCookie splits pairs, skips junk", () => {
  assert.deepEqual(parseCookie("a=1; b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseCookie("  ag_session=tok ; stray ; x= y "), {
    ag_session: "tok",
    x: "y",
  });
  assert.deepEqual(parseCookie(""), {});
});

test("session cookie headers carry flags; clear zeroes Max-Age", () => {
  assert.equal(
    sessionCookieHeader("tok", 3600, false),
    "ag_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
  );
  assert.match(sessionCookieHeader("tok", 3600, true), /; Secure$/);
  assert.equal(
    clearSessionCookieHeader(false),
    "ag_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  );
  assert.match(clearSessionCookieHeader(true), /; Secure$/);
});

// ── security parameters: which ones are safe to change? ────
//
// A "fixed" parameter that is read at VERIFY time is a different animal from
// one that is written INTO the artifact it protects. The two constants below
// look alike and behave oppositely, so the difference is pinned rather than
// left to whoever next decides to "harden" the hashing.

test("PASSWORD_ITERATIONS is pinned: raising it locks out every existing user", async () => {
  // MEASURED, not asserted: hashing the same password+salt at 100000 and at
  // 600000 produces different digests, and verifyPassword compares
  // timingSafeEqual(hashPassword(input), storedHash) with the CURRENT
  // constant. So a changed constant cannot match a hash written under the old
  // one — every user, forever, with no error that distinguishes it from a
  // wrong password.
  assert.equal(
    PASSWORD_ITERATIONS,
    100000,
    "PASSWORD_ITERATIONS changed. This is a BREAKING change, not a tuning " +
      "knob: user records store only {salt, passwordHash}, so every existing " +
      "hash was derived at the old count and will no longer verify. Raising " +
      "it safely needs a migration (store the count per user, verify against " +
      "the stored value, re-hash on next successful login). See the ledger's " +
      "Open threads, then update this pin.",
  );

  // Demonstrate the mechanism the comment describes, so the claim is evidence
  // rather than prose: two counts, same inputs, different digests.
  const enc = new TextEncoder();
  const derive = async (iterations) => {
    const key = await crypto.subtle.importKey("raw", enc.encode("hunter2"), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: enc.encode("saltsalt"), iterations, hash: "SHA-256" },
      key,
      256,
    );
    return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, "0")).join("");
  };
  assert.notEqual(
    await derive(100000),
    await derive(600000),
    "PBKDF2 at two iteration counts must differ — if this ever passes, the " +
      "lockout claim above is wrong and this pin should be revisited",
  );

  // ...and the stored record really has nowhere to record the count.
  const users = readFileSync(new URL("../src/store/users.ts", import.meta.url), "utf8");
  const record = users.slice(users.indexOf("  id: string;"), users.indexOf("export const ADMIN_USERNAME"));
  for (const field of ["salt", "passwordHash"]) {
    assert.ok(record.includes(field), `the user record still carries ${field}`);
  }
  assert.ok(
    !/iterations/i.test(record),
    "FIXED? The user record now carries an iteration count — that is the " +
      "migration this pin asks for. Re-hash on login, then update this test " +
      "and the ledger Open-threads entry.",
  );
});

test("SESSION_TTL_MS is NOT baked in — the expiry rides in the signed payload", async () => {
  // The contrast that makes the pin above meaningful. `issueSessionToken`
  // writes `exp: Date.now() + SESSION_TTL_MS` INTO the payload;
  // `verifySessionToken` trusts that embedded value and never reads the
  // constant. So changing SESSION_TTL_MS affects only tokens minted after the
  // change — old ones keep their own expiry.
  //
  // Proven by minting a token under a DIFFERENT ttl and verifying it: if
  // verification consulted the constant, this would fail.
  const secret = "s3cret";
  const shortTtl = 60_000;
  const payload = Buffer.from(
    JSON.stringify({ uid: "u1", role: "user", exp: Date.now() + shortTtl }),
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  const token = `${payload}.${sig}`;

  const ok = await verifySessionToken(secret, token);
  assert.ok(ok, "a token whose exp was computed with a different TTL must still verify");
  assert.equal(ok.uid, "u1");
  assert.notEqual(
    shortTtl,
    SESSION_TTL_MS,
    "the fixture's TTL must differ from the constant for this to prove anything",
  );
});
