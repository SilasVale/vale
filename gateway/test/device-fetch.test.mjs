// deviceHostError precision (SSRF guard shared by deviceFetch + the MCP
// browser bridge): 172.16/12 is second-octet 16-31 only (not all of 172/8),
// and the fc/fd/fe80 v6 prefixes must be actual address forms (contain ':'
// — hostnames never do), so 'fc.example.com' stays reachable.
import test from "node:test";
import assert from "node:assert/strict";
import { deviceFetch, deviceHostError } from "../src/device-fetch.ts";

test("172.16/12 blocked: 172.16.x through 172.31.x", () => {
  for (const h of ["172.16.0.1", "172.20.5.4", "172.31.255.255"]) {
    assert.match(deviceHostError(h) || "", /private\/internal/, `${h} blocked`);
  }
});

test("172/8 outside 16/12 allowed: 172.15.x and 172.32.x", () => {
  for (const h of ["172.15.0.1", "172.32.0.1", "172.0.0.1", "172.33.1.2"]) {
    assert.equal(deviceHostError(h), null, `${h} allowed`);
  }
});

test("hostname strings with v6-like prefixes allowed: fc.example.com", () => {
  for (const h of ["fc.example.com", "fd.example.com", "fe80.example.com"]) {
    assert.equal(deviceHostError(h), null, `${h} allowed`);
  }
});

test("actual v6 private forms still blocked", () => {
  for (const h of ["fc00::1", "fd00::1234", "fe80::1"]) {
    assert.match(deviceHostError(h) || "", /private\/internal/, `${h} blocked`);
  }
});

test("classic guards unchanged: loopback, mapped, metadata, public", () => {
  for (const h of ["127.0.0.1", "::ffff:127.0.0.1", "localhost", "10.0.0.5", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1"]) {
    assert.match(deviceHostError(h) || "", /private\/internal/, `${h} blocked`);
  }
  for (const h of ["d1.agent.saisi.online", "example.com", "8.8.8.8"]) {
    assert.equal(deviceHostError(h), null, `${h} allowed`);
  }
});

// ── deviceFetch path sanitization (round-120/121 SSRF fixes, round-361) ──
// The authority-prefix gate + hostname-equality gate had NO direct tests
// (only indirect exercise via mcp-handler). Stub globalThis.fetch: the
// module calls it through fetchWithTimeout, which uses the global.
const DEV = { hostname: "d1.agent.saisi.online", token: "tok-device-1" };

async function withStubFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const okUpstream = (seen) => async (url, init) => {
  seen.url = String(url);
  seen.init = init;
  return new Response("ok", { status: 200 });
};

test("deviceFetch: userinfo smuggling (@evil) → 400, upstream never called (round-120)", async () => {
  const r = await withStubFetch(
    async () => {
      throw new Error("must not be called");
    },
    () => deviceFetch({}, DEV, "@evil.example/x"),
  );
  assert.equal(r.status, 400);
  assert.equal(r.error, "invalid proxy path");
  assert.equal(r.resp, undefined);
});

test("deviceFetch: leading scheme in path → 400 (round-120)", async () => {
  for (const p of ["https://evil.example/x", "http://evil.example/"]) {
    const r = await withStubFetch(
      async () => {
        throw new Error("must not be called");
      },
      () => deviceFetch({}, DEV, p),
    );
    assert.equal(r.status, 400, p);
  }
});

test("deviceFetch: @ in a query string is legitimate → passes through (round-121 narrowing)", async () => {
  const seen = {};
  const r = await withStubFetch(okUpstream(seen), () =>
    deviceFetch({}, DEV, "/api/x?user=a@b.com"),
  );
  assert.equal(r.status, 200);
  assert.match(seen.url, /\/api\/x\?user=a@b\.com/, "query preserved verbatim");
  assert.match(seen.url, /^https:\/\/d1\.agent\.saisi\.online\//, "host is the device's own");
});

test("deviceFetch: header hygiene — host/cookie stripped, device Bearer injected", async () => {
  const seen = {};
  await withStubFetch(okUpstream(seen), () =>
    deviceFetch(
      {},
      DEV,
      "/api/tools/x",
      { headers: { host: "attacker.example", cookie: "sess=1", "x-keep": "yes" } },
    ),
  );
  const h = new Headers(seen.init.headers);
  assert.equal(h.get("host"), null, "client Host must not ride upstream");
  assert.equal(h.get("cookie"), null, "client cookies must not ride upstream");
  assert.equal(h.get("authorization"), "Bearer tok-device-1");
  assert.equal(h.get("x-keep"), "yes", "unrelated headers pass through");
});

test("deviceFetch: uppercase registration hostname still dials (round-121 case-insensitive)", async () => {
  const seen = {};
  const upper = { hostname: "D1.Agent.Saisi.Online", token: "tok-device-1" };
  const r = await withStubFetch(okUpstream(seen), () => deviceFetch({}, upper, "/api/status"));
  assert.equal(r.status, 200);
  assert.match(seen.url, /^https:\/\/d1\.agent\.saisi\.online\//i);
});

test("deviceFetch: private device hostname → 400 via deviceHostError, never dialed", async () => {
  const r = await withStubFetch(
    async () => {
      throw new Error("must not be called");
    },
    () => deviceFetch({}, { hostname: "169.254.169.254", token: "tok-x" }, "/api/status"),
  );
  assert.equal(r.status, 400);
  assert.match(r.error || "", /private\/internal/);
});

test("deviceFetch: unreachable device → 502 with reason, no throw", async () => {
  const r = await withStubFetch(
    async () => {
      throw new TypeError("fetch failed");
    },
    () => deviceFetch({}, DEV, "/api/status"),
  );
  assert.equal(r.status, 502);
  assert.equal(r.ok, false);
  assert.match(r.error || "", /Device unreachable: fetch failed/);
});
