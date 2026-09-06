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
  jsonError,
  jsonOk,
  readJson,
  stampCors,
  withCors,
} from "../src/http.ts";
import { issueSessionToken, SESSION_COOKIE } from "../src/auth.ts";
import { makeEnv as makeBaseEnv } from "./helpers.mjs";
import { createPluginContext, registerPlugins, dispatch } from "../src/plugins/registry.ts";
import mcpPlugin from "../src/plugins/mcp.ts";

const ADMIN_PW = "test-admin-password";
const AI = "https://ai.saisi.online";
const API = "https://api.saisi.online";
const DSH = "https://dsh.saisi.online";
const EVIL = "https://evil.example";
const LOOPBACK = "http://localhost:8787";

// Shared Map-KV stub (helpers.mjs) seeded with the console base + the two
// corsEnv-specific extras: the multi-origin CONSOLE_HOST and the ASSETS stub
// (installer payloads are served from Workers Assets (/vale)).
function corsEnv(extra = {}) {
  return makeBaseEnv({
    devices: [{ name: "d1", hostname: "d1.agent.saisi.online", token: "devtok" }],
    links: {},
    users: { admin: { id: "admin", username: "admin", role: "admin", enabled: true, token: "" } },
    kv: { "auth:admin_password": ADMIN_PW, _admin_seeded: "1" },
    extra: {
      CONSOLE_HOST: "ai.saisi.online,api.saisi.online",
      ASSETS: {
        async fetch() {
          return new Response("#!/bin/sh\necho vale\n", { status: 200 });
        },
      },
      ...extra,
    },
  });
}

const get = (path, origin, host = "https://ai.saisi.online") =>
  new Request(host + path, origin ? { headers: { origin } } : {});

/* ---- unit: shared helper surface ---- */

test("CORS_HEADERS carries no wildcard (origin reflected per request)", () => {
  assert.ok(!("Access-Control-Allow-Origin" in CORS_HEADERS));
});

test("isAllowedOrigin: console origins pass; loopback only with a loopback request host", () => {
  assert.equal(isAllowedOrigin(AI), true);
  assert.equal(isAllowedOrigin(API), true);
  assert.equal(isAllowedOrigin(DSH), true);
  assert.equal(isAllowedOrigin(EVIL), false);
  assert.equal(isAllowedOrigin(""), false);
  assert.equal(isAllowedOrigin("https://ai.saisi.online.evil.example"), false);
  assert.equal(isLoopbackOrigin(LOOPBACK), true);
  assert.equal(isLoopbackOrigin("https://127.0.0.1:8787"), true);
  assert.equal(isLoopbackOrigin("ftp://localhost/x"), false);
  // Loopback origins are a wrangler-dev affordance: allowed only when the
  // request itself targets a loopback host (audit P2 — production used to
  // reflect ANY localhost origin).
  assert.equal(isAllowedOrigin(LOOPBACK), false, "no request host → production default: closed");
  assert.equal(isAllowedOrigin(LOOPBACK, "ai.saisi.online"), false);
  assert.equal(isAllowedOrigin(LOOPBACK, "localhost"), true);
  assert.equal(isAllowedOrigin(LOOPBACK, "127.0.0.1"), true);
});

test("corsHeadersFor: reflect + Vary when allowed, no ACAO otherwise", () => {
  const mk = (origin, host = "https://ai.saisi.online") =>
    new Request(host + "/api/health", origin ? { headers: { origin } } : {});
  const ok = corsHeadersFor(mk(AI));
  assert.equal(ok["Access-Control-Allow-Origin"], AI);
  assert.equal(ok["Vary"], "Origin");
  // A loopback Origin at the deployed console host is a foreign local page:
  // no reflection.
  assert.equal(corsHeadersFor(mk(LOOPBACK))["Access-Control-Allow-Origin"], undefined);
  // The same loopback Origin at a loopback host is local wrangler dev:
  // reflected.
  const dev = corsHeadersFor(mk(LOOPBACK, "http://localhost:8787"));
  assert.equal(dev["Access-Control-Allow-Origin"], LOOPBACK);
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
  const preflight = (origin, host = "https://ai.saisi.online") =>
    worker.fetch(
      new Request(host + "/api/me", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      }),
      env,
    );
  const ok = await preflight(AI);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), AI);
  assert.equal(ok.headers.get("Vary"), "Origin");
  // Loopback Origin at the console host: NOT reflected (production gate).
  const deniedLoop = await preflight(LOOPBACK);
  assert.equal(deniedLoop.headers.get("Access-Control-Allow-Origin"), null);
  // The same Origin at a loopback host (wrangler dev): reflected.
  const devLoop = await preflight(LOOPBACK, "http://localhost:8787");
  assert.equal(devLoop.headers.get("Access-Control-Allow-Origin"), LOOPBACK);
  const denied = await preflight(EVIL);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
});

/* ---- integration: jsonOk/jsonError helpers via /api/health ---- */

test("/api/health: ACAO reflected for console origin + loopback dev host, absent otherwise", async () => {
  const env = corsEnv();
  const ok = await worker.fetch(get("/api/health", AI), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), AI);
  assert.equal(ok.headers.get("Vary"), "Origin");
  // Loopback Origin at the console host: no ACAO (production gate)…
  const consoleLoop = await worker.fetch(get("/api/health", LOOPBACK), env);
  assert.equal(consoleLoop.status, 200); // narrowing never breaks the payload
  assert.equal(consoleLoop.headers.get("Access-Control-Allow-Origin"), null);
  // …but a loopback request URL (wrangler dev) reflects it.
  const devReq = new Request("http://localhost:8787/api/health", {
    headers: { origin: LOOPBACK },
  });
  const devLoop = await worker.fetch(devReq, env);
  assert.equal(devLoop.headers.get("Access-Control-Allow-Origin"), LOOPBACK);
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

/* ---- /mcp plugin exit: internal 401 carries CORS without the front door ---- */
// handleMcp builds its 401/405/parse-error responses bare; the plugin exit
// wraps them with withCors (the front-door re-stamp is idempotent). Drive
// the plugin dispatch directly — no outer withCors — so the stamp here is
// what the test pins.

function mcpPluginCtx() {
  const ctx = createPluginContext(null, { jsonOk, jsonError, readJson, CORS_HEADERS });
  registerPlugins(ctx, [mcpPlugin]);
  return ctx;
}

test("/mcp plugin: bare 401 (bad token) is stamped with CORS for console origin", async () => {
  const ctx = mcpPluginCtx();
  const env = corsEnv();
  const req = new Request("https://ai.saisi.online/mcp", {
    method: "POST",
    headers: { origin: AI, authorization: "Bearer bad", "content-type": "application/json" },
    body: "{}",
  });
  const res = await dispatch(ctx, "POST", "/mcp", req, env, new URL(req.url));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), AI);
  assert.equal(res.headers.get("Vary"), "Origin");
});

test("/mcp plugin: disallowed origin gets no ACAO (default-closed)", async () => {
  const ctx = mcpPluginCtx();
  const env = corsEnv();
  const req = new Request("https://ai.saisi.online/mcp", {
    method: "POST",
    headers: { origin: EVIL, authorization: "Bearer bad", "content-type": "application/json" },
    body: "{}",
  });
  const res = await dispatch(ctx, "POST", "/mcp", req, env, new URL(req.url));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

// ── http.ts response/body helpers (round-428: zero direct pins — every
// plugin builds on these, so their shape is foundation) ──

test("jsonOk: 200 + JSON content type; extraHeaders merge", async () => {
  const res = jsonOk({ ok: true }, { "X-Test": "1" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.equal(res.headers.get("X-Test"), "1");
  assert.deepEqual(await res.json(), { ok: true });
});

test("jsonError: status + {type:error,{type,message}} envelope", async () => {
  const res = jsonError(403, "nope", "authentication_error");
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { type: "error", error: { type: "authentication_error", message: "nope" } });
});

test("readJson: valid parses, empty/invalid degrade to {}", async () => {
  const good = new Request("https://x/", { method: "POST", body: JSON.stringify({ a: 1 }) });
  assert.deepEqual(await readJson(good), { a: 1 });
  const empty = new Request("https://x/", { method: "POST" });
  assert.deepEqual(await readJson(empty), {});
  const bad = new Request("https://x/", { method: "POST", body: "{oops" });
  assert.deepEqual(await readJson(bad), {});
});
