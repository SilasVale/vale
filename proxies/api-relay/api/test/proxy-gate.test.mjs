// /api/proxy gate pins (SOLID Round-20 — test completion on the
// OpenRouter relay). No src changes: every gate is reachable through the
// default export with a stubbed fetch. What must never regress: anonymous
// callers refused (BYOK-only, no env key to spend), x-api-key does NOT
// authenticate here (unlike /api/zen — Authorization only), the upstream
// is fixed regardless of path, the caller key forwards verbatim, and the
// autonomous CORS copy keeps the loopback-at-prod trap closed.
import test from "node:test";
import assert from "node:assert/strict";
import handler from "../proxy.js";

async function withStubFetch(handlerFn, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handlerFn;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

function capture(seen) {
  return async (url, init) => {
    seen.url = String(url);
    seen.init = init;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
}

const AUTH = { authorization: "Bearer sk-or-test" };
const post = (url, headers = {}) => new Request(url, { method: "POST", headers, body: "{}" });
const never = async () => {
  throw new Error("must not be called");
};

test("OPTIONS short-circuits with CORS, never gates, never dials", async () => {
  const r = await withStubFetch(never, () =>
    handler(
      new Request("https://r.example/api/proxy", {
        method: "OPTIONS",
        headers: { origin: "https://dsh.saisi.online" },
      }),
    ),
  );
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "https://dsh.saisi.online");
});

test("CORS matrix on the autonomous copy (drift guard vs gateway http.ts)", async () => {
  const opt = (origin, host) =>
    handler(new Request(`https://${host}/api/proxy`, { method: "OPTIONS", headers: { origin } }));
  assert.equal(
    (await withStubFetch(never, () => opt("https://ai.saisi.online", "r.example"))).headers.get(
      "access-control-allow-origin",
    ),
    "https://ai.saisi.online",
  );
  assert.equal(
    (await withStubFetch(never, () => opt("https://evil.example", "r.example"))).headers.get(
      "access-control-allow-origin",
    ),
    null,
  );
  assert.equal(
    (await withStubFetch(never, () => opt("http://localhost:3000", "127.0.0.1:3000"))).headers.get(
      "access-control-allow-origin",
    ),
    "http://localhost:3000",
  );
  assert.equal(
    (await withStubFetch(never, () => opt("http://localhost:3000", "r.example"))).headers.get(
      "access-control-allow-origin",
    ),
    null,
    "loopback Origin at the deployed host gets nothing (audit P2)",
  );
});

test("anonymous refused (401); x-api-key alone does NOT authenticate", async () => {
  const bare = await withStubFetch(never, () => handler(post("https://r.example/api/proxy", {})));
  assert.equal(bare.status, 401);
  assert.match((await bare.json()).error, /BYOK/);
  const keyOnly = await withStubFetch(never, () =>
    handler(post("https://r.example/api/proxy", { "x-api-key": "sk-test" })),
  );
  assert.equal(keyOnly.status, 401, "Authorization only here — unlike /api/zen");
});

test("upstream fixed to OpenRouter regardless of path/query", async () => {
  const seen = {};
  await withStubFetch(capture(seen), () =>
    handler(post("https://r.example/api/proxy/anything?x=1", AUTH)),
  );
  assert.equal(seen.url, "https://openrouter.ai/api/v1/messages");
  assert.equal(seen.init.method, "POST");
});

test("caller key forwarded verbatim (no strip, no double)", async () => {
  const seen = {};
  const h = (p) => new Headers(p);
  await withStubFetch(capture(seen), () => handler(post("https://r.example/api/proxy", AUTH)));
  assert.equal(h(seen.init.headers).get("authorization"), "Bearer sk-or-test");
});

test("header hygiene: allowlist only, JSON forced, version defaulted", async () => {
  const seen = {};
  const h = (p) => new Headers(p);
  await withStubFetch(capture(seen), () =>
    handler(
      post("https://r.example/api/proxy", {
        ...AUTH,
        cookie: "sess=1",
        "x-evil": "nope",
        "accept-language": "zh-CN",
      }),
    ),
  );
  const hh = h(seen.init.headers);
  assert.equal(hh.get("cookie"), null);
  assert.equal(hh.get("x-evil"), null);
  assert.equal(hh.get("accept-language"), "zh-CN", "SAFE headers pass");
  assert.equal(hh.get("content-type"), "application/json");
  assert.equal(hh.get("anthropic-version"), "2023-06-01");
});
