// /api/zen gate pins (SOLID Round-19 — the handler half of the relay's
// first tests; routing was Round-18). Everything here runs WITHOUT network:
// the BYOK/target/path gates reject before fetch, OPTIONS short-circuits,
// and upstream-reaching cases run against a stubbed global fetch that
// captures the outgoing request. What must never regress: anonymous relay
// stays refused, unknown targets never fall back, traversal never reaches
// an upstream, exactly ONE credential rides per og path, and the zen
// session header forwards under zen's name only for og targets.
import test from "node:test";
import assert from "node:assert/strict";
import handler, { normalizeUpstreamPath } from "../zen.js";

const KEY = { "x-api-key": "sk-test-caller" };

async function withStubFetch(handlerFn, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handlerFn;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// Capture stub: records the outgoing upstream request, answers 200.
function capture(seen) {
  return async (url, init) => {
    seen.url = String(url);
    seen.init = init;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
}

const post = (url, headers = {}) =>
  new Request(url, { method: "POST", headers, body: "{}" });

// ── normalizeUpstreamPath table ──────────────────────────────

test("path guard: plain absolute paths pass, everything hostile is null", () => {
  assert.equal(normalizeUpstreamPath("/v1/messages"), "/v1/messages");
  assert.equal(normalizeUpstreamPath("/v1/chat/completions"), "/v1/chat/completions");
  assert.equal(normalizeUpstreamPath("/a%20b"), "/a b", "encoded space decodes");
  for (const evil of [
    "/../evil",
    "/a/../../b",
    "..",
    "v1/messages",
    "",
    "https://evil.example/x",
    "/\\evil.example/x",
    "\\\\evil\\x",
    "%zz",
    "/a%00b",
    "/a\r\nb",
    "javascript:alert(1)",
  ]) {
    assert.equal(normalizeUpstreamPath(evil), null, `rejected: ${JSON.stringify(evil)}`);
  }
});

// ── pre-fetch gates (no network touched) ─────────────────────

test("OPTIONS short-circuits with CORS, never gates, never dials", async () => {
  const r = await withStubFetch(
    async () => {
      throw new Error("must not be called");
    },
    () =>
      handler(
        new Request("https://r.example/api/zen?target=og", {
          method: "OPTIONS",
          headers: { origin: "https://ai.saisi.online" },
        }),
      ),
  );
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "https://ai.saisi.online");
});

test("CORS: allowlist yes, evil no, loopback only at loopback hosts", async () => {
  const opt = (origin, host) =>
    handler(
      new Request(`https://${host}/api/zen`, { method: "OPTIONS", headers: { origin } }),
    );
  const noFetch = async () => {
    throw new Error("must not be called");
  };
  assert.equal(
    (await withStubFetch(noFetch, () => opt("https://api.saisi.online", "r.example"))).headers.get(
      "access-control-allow-origin",
    ),
    "https://api.saisi.online",
  );
  assert.equal(
    (await withStubFetch(noFetch, () => opt("https://evil.example", "r.example"))).headers.get(
      "access-control-allow-origin",
    ),
    null,
  );
  assert.equal(
    (
      await withStubFetch(noFetch, () => opt("http://localhost:8787", "127.0.0.1:8787"))
    ).headers.get("access-control-allow-origin"),
    "http://localhost:8787",
    "dev loopback reflected",
  );
  assert.equal(
    (await withStubFetch(noFetch, () => opt("http://localhost:8787", "r.example"))).headers.get(
      "access-control-allow-origin",
    ),
    null,
    "loopback Origin at the deployed host gets nothing (audit P2)",
  );
});

test("anonymous relay refused (401) before any target/path work", async () => {
  const r = await withStubFetch(
    async () => {
      throw new Error("must not be called");
    },
    () => handler(post("https://r.example/api/zen?target=og")),
  );
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /caller key required/);
});

test("unknown target rejected without fallback (400)", async () => {
  const r = await withStubFetch(
    async () => {
      throw new Error("must not be called");
    },
    () => handler(post("https://r.example/api/zen?target=evil", KEY)),
  );
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /unknown target/);
});

test("traversal path rejected without dialing (400)", async () => {
  const r = await withStubFetch(
    async () => {
      throw new Error("must not be called");
    },
    () => handler(post(`https://r.example/api/zen?target=og&path=${encodeURIComponent("/../evil")}`, KEY)),
  );
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /invalid path/);
});

// ── upstream-reaching contract (stubbed fetch) ───────────────

test("og auth split: exactly one credential scheme per path", async () => {
  const seen = {};
  const h = (p) => new Headers(p);
  await withStubFetch(capture(seen), () =>
    handler(post("https://r.example/api/zen?target=og&path=/v1/messages", KEY)),
  );
  assert.match(seen.url, /^https:\/\/opencode\.ai\/zen\/go\/v1\/messages$/);
  assert.equal(h(seen.init.headers).get("x-api-key"), "sk-test-caller");
  assert.equal(h(seen.init.headers).get("authorization"), null, "single-key: no Bearer alongside");

  await withStubFetch(capture(seen), () =>
    handler(post("https://r.example/api/zen?target=og&path=/v1/chat/completions", KEY)),
  );
  assert.equal(h(seen.init.headers).get("authorization"), "Bearer sk-test-caller");
  assert.equal(h(seen.init.headers).get("x-api-key"), null, "single-key: no x-api-key alongside");

  await withStubFetch(capture(seen), () =>
    handler(post("https://r.example/api/zen?target=og&path=/v1/responses", KEY)),
  );
  assert.equal(h(seen.init.headers).get("authorization"), "Bearer sk-test-caller", "responses takes Bearer");
});

test("Bearer prefix stripped once; x-api-key wins over Authorization", async () => {
  const seen = {};
  const h = (p) => new Headers(p);
  await withStubFetch(capture(seen), () =>
    handler(post("https://r.example/api/zen?target=ds&path=/v1/chat/completions", { authorization: "Bearer sk-1" })),
  );
  assert.match(seen.url, /^https:\/\/api\.deepseek\.com\/v1\/chat\/completions$/);
  assert.equal(h(seen.init.headers).get("authorization"), "Bearer sk-1", "no double Bearer");

  await withStubFetch(capture(seen), () =>
    handler(
      post("https://r.example/api/zen?target=ds&path=/x", {
        "x-api-key": "sk-key",
        authorization: "Bearer sk-auth",
      }),
    ),
  );
  assert.equal(h(seen.init.headers).get("authorization"), "Bearer sk-key", "x-api-key takes precedence");
});

test("non-og targets always Bearer; session header is og-only", async () => {
  const seen = {};
  const h = (p) => new Headers(p);
  await withStubFetch(capture(seen), () =>
    handler(
      post("https://r.example/api/zen?target=or&path=/v1/chat/completions", {
        ...KEY,
        "x-client-request-id": "conv-9",
      }),
    ),
  );
  assert.equal(h(seen.init.headers).get("authorization"), "Bearer sk-test-caller");
  assert.equal(h(seen.init.headers).get("x-opencode-session"), null, "foreign upstreams never get zen session");

  await withStubFetch(capture(seen), () =>
    handler(
      post("https://r.example/api/zen?target=og&path=/v1/messages", {
        ...KEY,
        "x-client-request-id": "conv-9",
      }),
    ),
  );
  assert.equal(h(seen.init.headers).get("x-opencode-session"), "conv-9", "caller spelling mapped to zen's name");
});

test("header hygiene: allowlist only, JSON forced, version defaulted", async () => {
  const seen = {};
  const h = (p) => new Headers(p);
  await withStubFetch(capture(seen), () =>
    handler(
      post("https://r.example/api/zen?target=og&path=/v1/messages", {
        ...KEY,
        cookie: "sess=1",
        "x-evil": "nope",
        "content-type": "text/plain",
      }),
    ),
  );
  const hh = h(seen.init.headers);
  assert.equal(hh.get("cookie"), null);
  assert.equal(hh.get("x-evil"), null, "non-allowlisted headers dropped");
  assert.equal(hh.get("content-type"), "application/json", "forced JSON");
  assert.equal(hh.get("anthropic-version"), "2023-06-01", "version defaulted");
});
