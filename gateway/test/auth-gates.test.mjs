// Auth-gate regression tests (coverage audit rows 1+2): the CSRF cookie gate
// and the DO fail-closed denies shipped in the auth-core audit with ZERO
// test references. Pure local, no Cloudflare runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { csrfCookieViolation } from "../src/auth.ts";
import { BreakerDO } from "../src/reliability.ts";
import { RouteDO } from "../src/route-do.ts";

const req = (method, headers) => new Request("https://x/api/anything", { method, headers });

test("csrfCookieViolation: drive-by matrix (cookie + mutating method)", () => {
  const CK = { cookie: "ag_session=abc123" };
  // FOREIGN browser origins are denied — the whole point of the gate.
  assert.equal(csrfCookieViolation(req("POST", { ...CK, "sec-fetch-site": "cross-site" })), true);
  assert.equal(csrfCookieViolation(req("POST", { ...CK, "sec-fetch-site": "same-site" })), true);
  // Legit same-origin panel + non-browser (header absent) pass.
  assert.equal(csrfCookieViolation(req("POST", { ...CK, "sec-fetch-site": "same-origin" })), false);
  assert.equal(csrfCookieViolation(req("POST", { ...CK, "sec-fetch-site": "none" })), false);
  assert.equal(csrfCookieViolation(req("POST", { ...CK })), false); // CLI/test clients
  // Non-mutating methods never trip it.
  assert.equal(csrfCookieViolation(req("GET", { ...CK, "sec-fetch-site": "cross-site" })), false);
  // Bearer-only callers (no session cookie) ride free even cross-site —
  // a cross-site page cannot attach the Authorization header by itself.
  assert.equal(csrfCookieViolation(req("POST", { "sec-fetch-site": "cross-site" })), false);
  // Every mutating verb is covered.
  for (const m of ["PUT", "PATCH", "DELETE"]) {
    assert.equal(csrfCookieViolation(req(m, { ...CK, "sec-fetch-site": "cross-site" })), true, m);
  }
});

test("csrfCookieViolation: per-device vale_pt_* cookies are gated too (audit P1)", () => {
  // The device proxy mints vale_pt_<device> cookies that authenticate
  // mutations on /api/devices/<name>/proxy/* — every cookie-carrying
  // mutation means BOTH credential families, so the gate must fire on them
  // exactly as it does on ag_session.
  const PT = { cookie: "vale_pt_d1=tok123" };
  assert.equal(csrfCookieViolation(req("POST", { ...PT, "sec-fetch-site": "cross-site" })), true);
  assert.equal(csrfCookieViolation(req("POST", { ...PT, "sec-fetch-site": "same-site" })), true);
  // The proxied panel's own same-origin fetches pass; non-browser clients
  // (no Sec-Fetch-Site) ride free, as with sessions.
  assert.equal(csrfCookieViolation(req("POST", { ...PT, "sec-fetch-site": "same-origin" })), false);
  assert.equal(csrfCookieViolation(req("POST", { ...PT, "sec-fetch-site": "none" })), false);
  assert.equal(csrfCookieViolation(req("POST", { ...PT })), false);
  // Non-mutating subresource loads with the pair cookie are never blocked.
  assert.equal(csrfCookieViolation(req("GET", { ...PT, "sec-fetch-site": "same-site" })), false);
  // A device cookie next to an unrelated session-less cookie set still trips
  // the gate on a cross-site mutation…
  const MIXED = { cookie: "theme=dark; vale_pt_d1=tok123" };
  assert.equal(csrfCookieViolation(req("POST", { ...MIXED, "sec-fetch-site": "same-site" })), true);
  // …and the gate still keys on cookie PRESENCE: no cookie of either family
  // (bearer path) is untouched even cross-site.
  assert.equal(
    csrfCookieViolation(req("POST", { cookie: "theme=dark", "sec-fetch-site": "same-site" })),
    false,
  );
});

// ── DO fail-closed denies (BreakerDO / RouteDO) ───────────────────────────
const storage = { get: async () => null, put: async () => {}, delete: async () => {} };

for (const [name, Cls] of [
  ["BreakerDO", BreakerDO],
  ["RouteDO", RouteDO],
]) {
  test(`${name}: DO_AUTH UNSET fails CLOSED (even with a header)`, async () => {
    const do_ = new Cls({ storage }, {});
    const r1 = await do_.fetch(new Request("https://d/check"));
    assert.equal(r1.status, 401, "no header must not pass an unconfigured DO");
    const r2 = await do_.fetch(new Request("https://d/check", { headers: { "x-do-auth": "anything" } }));
    assert.equal(r2.status, 401, "a header cannot substitute for an unconfigured secret");
  });
  test(`${name}: wrong/missing x-do-auth denied, correct secret allowed`, async () => {
    const do_ = new Cls({ storage }, { DO_AUTH: "sekret" });
    assert.equal((await do_.fetch(new Request("https://d/check"))).status, 401);
    assert.equal(
      (await do_.fetch(new Request("https://d/check", { headers: { "x-do-auth": "wrong" } }))).status,
      401,
    );
    // same-length wrong secret (exercises the constant-time diff, not just length)
    assert.equal(
      (await do_.fetch(new Request("https://d/check", { headers: { "x-do-auth": "xxxxxxx" } }))).status,
      401,
    );
    const ok = await do_.fetch(new Request("https://d/check", { headers: { "x-do-auth": "sekret" } }));
    assert.notEqual(ok.status, 401, "correct secret must not be denied");
  });
}
