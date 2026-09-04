// CORS allowlist pinning (zen-go-proxy precedent —
// proxies/zen-go-proxy/src/index.js): the gateway reflects the Origin
// if allowlisted (console origins + loopback) with Vary: Origin, and sends
// NO Access-Control-Allow-Origin otherwise. Genuinely-public installer
// payloads keep the ACAO:* wildcard.
//
// Surfaces pinned: jsonOk/jsonError shared helpers (via /api/health),
// the global OPTIONS preflight, proxyDevice()'s stamp on device-proxied
// responses, and the installer exception.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import {
  CORS_HEADERS,
  corsHeadersFor,
  isAllowedOrigin,
  isLoopbackOrigin,
  stampCors,
  withCors,
} from "../src/http.ts";
import { issueSessionToken, SESSION_COOKIE } from "../src/auth.ts";

const ADMIN_PW = "test-admin-password";
const AI = "https://ai.saisi.online";
const API = "https://api.saisi.online";
const DSH = "https://dsh.saisi.online";
const EVIL = "https://evil.example";
const LOOPBACK = "http://localhost:8787";

function corsEnv(extra = {}) {
  const kv = new Map([
    ["devices:v1", JSON.stringify([{ name: "d1", hostname: "d1.agent.saisi.online", token: "devtok" }])],
    ["plugins:v1", JSON.stringify({})],
    ["auth:admin_password", ADMIN_PW],
    ["user:admin", JSON.stringify({ id: "admin", username: "admin", role: "admin", enabled: true, token: "" })],
    ["_admin_seeded", "1"],
  ]);
  return {
    CONSOLE_HOST: "ai.saisi.online,api.saisi.online",
    KEYS: {
      async get(k) {
        return kv.has(k) ? kv.get(k) : null;
      },
      async put(k, v) {
        kv.set(k, v);
      },
      async delete(k) {
        kv.delete(k);
      },
    },
    // Installer payloads are served from Workers Assets (/vale).
    ASSETS: {
      async fetch() {
        return new Response("#!/bin/sh\necho vale\n", { status: 200 });
      },
    },
    ...extra,
  };
}

const get = (path, origin, host = "https://ai.saisi.online") =>
  new Request(host + path, origin ? { headers: { origin } } : {});

/* ---- unit: shared helper surface ---- */

test("CORS_HEADERS carries no wildcard (origin reflected per request)", () => {
  assert.ok(!("Access-Control-Allow-Origin" in CORS_HEADERS));
});

test("isAllowedOrigin: console origins + loopback pass, others fail", () => {
  assert.equal(isAllowedOrigin(AI), true);
  assert.equal(isAllowedOrigin(API), true);
  assert.equal(isAllowedOrigin(DSH), true);
  assert.equal(isAllowedOrigin(EVIL), false);
  assert.equal(isAllowedOrigin(""), false);
  assert.equal(isAllowedOrigin("https://ai.saisi.online.evil.example"), false);
  assert.equal(isLoopbackOrigin(LOOPBACK), true);
  assert.equal(isLoopbackOrigin("https://127.0.0.1:8787"), true);
  assert.equal(isLoopbackOrigin("ftp://localhost/x"), false);
  assert.equal(isAllowedOrigin(LOOPBACK), true);
});

test("corsHeadersFor: reflect + Vary when allowed, no ACAO otherwise", () => {
  const mk = (origin) => new Request("https://ai.saisi.online/api/health", origin ? { headers: { origin } } : {});
  const ok = corsHeadersFor(mk(AI));
  assert.equal(ok["Access-Control-Allow-Origin"], AI);
  assert.equal(ok["Vary"], "Origin");
  const loop = corsHeadersFor(mk(LOOPBACK));
  assert.equal(loop["Access-Control-Allow-Origin"], LOOPBACK);
  assert.equal(corsHeadersFor(mk(EVIL))["Access-Control-Allow-Origin"], undefined);
  assert.equal(corsHeadersFor(mk(null))["Access-Control-Allow-Origin"], undefined);
  assert.equal(corsHeadersFor()["Access-Control-Allow-Origin"], undefined);
});

test("stampCors/withCors: set-or-strip on live headers, upgrades untouched", async () => {
  const h = new Headers({ "Access-Control-Allow-Origin": "*" });
  stampCors(get("/api/health", AI), h);
  assert.equal(h.get("Access-Control-Allow-Origin"), AI);
  assert.equal(h.get("Vary"), "Origin");
  stampCors(get("/api/health", EVIL), h);
  assert.equal(h.get("Access-Control-Allow-Origin"), null);
  // withCors rebuilds the response; a 101 upgrade (or webSocket) passes
  // through as-is. (Node's undici cannot construct a 101 Response, so the
  // guard is exercised with the shape workerd hands back from upgrades.)
  const upgraded = { status: 101, headers: new Headers(), body: null };
  assert.equal(withCors(get("/x", EVIL), upgraded), upgraded);
  const socketed = { status: 200, webSocket: {}, headers: new Headers(), body: null };
  assert.equal(withCors(get("/x", AI), socketed), socketed);
  const rebuilt = withCors(get("/x", AI), new Response("{}", { headers: { "content-type": "application/json" } }));
  assert.equal(rebuilt.headers.get("Access-Control-Allow-Origin"), AI);
  assert.equal(await rebuilt.text(), "{}");
});

/* ---- integration: global OPTIONS preflight ---- */

test("OPTIONS preflight: allowed origin reflected, disallowed gets no ACAO", async () => {
  const env = corsEnv();
  const preflight = (origin) =>
    worker.fetch(
      new Request("https://ai.saisi.online/api/me", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      }),
      env,
    );
  const ok = await preflight(AI);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), AI);
  assert.equal(ok.headers.get("Vary"), "Origin");
  const loop = await preflight(LOOPBACK);
  assert.equal(loop.headers.get("Access-Control-Allow-Origin"), LOOPBACK);
  const denied = await preflight(EVIL);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
});

/* ---- integration: jsonOk/jsonError helpers via /api/health ---- */

test("/api/health: ACAO reflected for console origin + loopback, absent otherwise", async () => {
  const env = corsEnv();
  const ok = await worker.fetch(get("/api/health", AI), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), AI);
  assert.equal(ok.headers.get("Vary"), "Origin");
  const loop = await worker.fetch(get("/api/health", LOOPBACK), env);
  assert.equal(loop.headers.get("Access-Control-Allow-Origin"), LOOPBACK);
  const denied = await worker.fetch(get("/api/health", EVIL), env);
  assert.equal(denied.status, 200); // narrowing never breaks the payload
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  const none = await worker.fetch(get("/api/health", null), env);
  assert.equal(none.headers.get("Access-Control-Allow-Origin"), null);
});

/* ---- integration: installer payloads keep the wildcard ---- */

test("installer endpoints keep ACAO:* even for a disallowed origin", async () => {
  const env = corsEnv();
  for (const p of ["/api/vale-cli", "/api/vale-install", "/api/vale-install.ps1"]) {
    const res = await worker.fetch(get(p, EVIL), env);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*", p);
  }
});

/* ---- integration: proxyDevice stamp on device-proxied responses ---- */

async function withDeviceFetch(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("device proxy: ACAO reflected for console origin, absent for disallowed", async () => {
  const env = corsEnv();
  const admin = await issueSessionToken(ADMIN_PW, "admin", "admin");
  const proxy = (origin) =>
    worker.fetch(
      new Request("https://ai.saisi.online/api/devices/d1/proxy/api/tools/terminal_list", {
        headers: { cookie: `${SESSION_COOKIE}=${admin}`, ...(origin ? { origin } : {}) },
      }),
      env,
    );
  await withDeviceFetch(async () => {
    const ok = await proxy(AI);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("Access-Control-Allow-Origin"), AI);
    assert.equal(ok.headers.get("Vary"), "Origin");
    const denied = await proxy(EVIL);
    assert.equal(denied.status, 200);
    assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  });
});
