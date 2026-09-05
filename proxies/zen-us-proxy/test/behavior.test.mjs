// zen-us-proxy behavior tests (first unit coverage — previously only the
// wrangler dry-run gate). The worker is exercised end to end with a stubbed
// global fetch. Pins the file's documented contracts:
//  - CORS reflect-if-allowlisted (console origins + loopback), closed otherwise
//  - /v1/models and /v1/messages gate on CLIENT_KEY, default-CLOSED (the
//    endpoint spends the worker's own paid OPENCODE_GO_API_KEY)
//  - /v1/responses is BYOK: the CALLER's Bearer key is forwarded, the worker
//    never substitutes its own, blank key 401s
//  - upstream 5xx → generic client text (detail server-side); 4xx → message
//    passthrough; the SSE body streams through with CORS stamped
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const CONSOLE = "https://ai.saisi.online";
const NATIVE = "https://opencode.ai/zen/go/v1/messages";
const RESPONSES = "https://opencode.ai/zen/go/v1/responses";
const MODELS = "https://opencode.ai/zen/go/v1/models";

function stubFetch() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ __stub: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    respond(status, body, headers = {}) {
      globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        });
      };
    },
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const env = { CLIENT_KEY: "ck-secret", OPENCODE_GO_API_KEY: "up-key" };
const req = (method, path, { key = "ck-secret", bearer, body, headers = {}, origin } = {}) => {
  const h = { ...headers };
  if (key !== undefined) h["x-api-key"] = key;
  if (bearer !== undefined) h.authorization = bearer ? `Bearer ${bearer}` : "";
  if (origin) h.origin = origin;
  return new Request(`https://zen-us.local${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
};

test("OPTIONS preflight reflects allowlisted + loopback origins, closed otherwise", async () => {
  const ok = await worker.fetch(new Request("https://zen-us.local/x", { method: "OPTIONS", headers: { origin: CONSOLE } }), env);
  assert.equal(ok.headers.get("access-control-allow-origin"), CONSOLE);
  const loop = await worker.fetch(new Request("http://localhost:9999/x", { method: "OPTIONS", headers: { origin: "http://localhost:9999" } }), env);
  assert.equal(loop.headers.get("access-control-allow-origin"), "http://localhost:9999");
  const denied = await worker.fetch(new Request("https://zen-us.local/x", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), env);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("/v1/models is CLIENT_KEY-gated and forwards the worker's upstream key", async () => {
  const noGate = await worker.fetch(req("GET", "/v1/models", { key: "nope" }), env);
  assert.equal(noGate.status, 401);
  const noSecret = await worker.fetch(req("GET", "/v1/models"), {}); // CLIENT_KEY unset → default-closed
  assert.equal(noSecret.status, 401);
  const { calls, restore } = stubFetch();
  try {
    await worker.fetch(req("GET", "/v1/models"), env);
    assert.equal(calls[0].url, MODELS);
    assert.equal(calls[0].init.headers["x-api-key"], "up-key");
  } finally {
    restore();
  }
});

test("/v1/messages: default-CLOSED gate, native Anthropic passthrough with anthropic-version", async () => {
  const noGate = await worker.fetch(req("POST", "/v1/messages", { key: "", body: "{}" }), env);
  assert.equal(noGate.status, 401, "missing gate key must not reach the paid upstream");
  const unset = await worker.fetch(req("POST", "/v1/messages", { key: "x" }), {}); // CLIENT_KEY unset
  assert.equal(unset.status, 401);

  const { calls, respond, restore } = stubFetch();
  try {
    const raw = JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 5, messages: [] });
    respond(200, raw, { "content-type": "text/event-stream" });
    const r = await worker.fetch(req("POST", "/v1/messages", { body: raw }), env);
    assert.equal(r.status, 200);
    assert.equal(calls[0].url, NATIVE);
    assert.equal(calls[0].init.headers["x-api-key"], "up-key");
    assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
    // request.body is a stream — the passthrough forwards it untouched.
    assert.equal(await new Response(calls[0].init.body).text(), raw, "native passthrough forwards the body verbatim");
    assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  } finally {
    restore();
  }
});

test("/v1/messages upstream 5xx: generic client text; 4xx passes the upstream message through", async () => {
  const s = stubFetch();
  try {
    s.respond(502, { error: { message: "INTERNAL detail" } });
    const r5 = await worker.fetch(req("POST", "/v1/messages", { body: "{}" }), env);
    assert.equal(r5.status, 502);
    assert.equal((await r5.json()).error.message, "Upstream unavailable");
    s.respond(400, { error: { message: "bad anthropic request" } });
    const r4 = await worker.fetch(req("POST", "/v1/messages", { body: "{}" }), env);
    assert.equal(r4.status, 400);
    assert.equal((await r4.json()).error.message, "bad anthropic request");
  } finally {
    s.restore();
  }
});

test("/v1/responses is BYOK: forwards the CALLER's key, never the worker's; blank key 401s", async () => {
  const noKey = await worker.fetch(req("POST", "/v1/responses", { bearer: "", body: {} }), env);
  assert.equal(noKey.status, 401);
  const missing = await worker.fetch(req("POST", "/v1/responses", { body: {} }), env);
  assert.equal(missing.status, 401);

  const { calls, respond, restore } = stubFetch();
  try {
    respond(200, "data: {\"resp\":true}\n\n", { "content-type": "text/event-stream" });
    const r = await worker.fetch(
      req("POST", "/v1/responses", { bearer: "caller-zen-key", body: { model: "og/muse-spark" } }),
      env,
    );
    assert.equal(r.status, 200);
    assert.equal(calls[0].url, RESPONSES);
    assert.equal(calls[0].init.headers.Authorization, "Bearer caller-zen-key");
    assert.match(await r.text(), /"resp":true/, "SSE body passes through");
    assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  } finally {
    restore();
  }
});

test("/v1/responses upstream errors pass through with upstream message", async () => {
  const s = stubFetch();
  try {
    s.respond(402, { message: "insufficient credits" });
    const r = await worker.fetch(
      req("POST", "/v1/responses", { bearer: "caller-key", body: {} }),
      env,
    );
    assert.equal(r.status, 402);
    assert.equal((await r.json()).error.message, "insufficient credits");
  } finally {
    s.restore();
  }
});

test("unknown path 404s (gated paths first, then the envelope)", async () => {
  const { respond, restore } = stubFetch();
  try {
    respond(200, {});
    const r = await worker.fetch(req("GET", "/nope"), env);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.type, "not_found_error");
  } finally {
    restore();
  }
});
