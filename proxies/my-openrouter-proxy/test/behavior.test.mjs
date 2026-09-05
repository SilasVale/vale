// my-openrouter-proxy behavior tests (first unit coverage — previously only
// the wrangler dry-run gate). Pins the BYOK contract from the file header:
// default-closed (no caller Authorization → 401), a strict safe-header
// forward list (client cookies / keys never ride through), the
// anthropic-version default injection, POST-only bodies, method whitelist,
// and response passthrough with CORS stamped.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const CONSOLE = "https://ai.saisi.online";
const UPSTREAM = "https://openrouter.ai/api/v1/messages";

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

const req = (method, path, { bearer = "caller-or-key", body, headers = {}, origin } = {}) => {
  const h = { ...headers };
  if (bearer !== undefined) h.authorization = `Bearer ${bearer}`;
  if (origin) h.origin = origin;
  return new Request(`https://or.local${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
};

test("OPTIONS preflight reflects allowlisted + loopback origins, closed otherwise", async () => {
  const ok = await worker.fetch(new Request("https://or.local/v1/messages", { method: "OPTIONS", headers: { origin: CONSOLE } }), {});
  assert.equal(ok.headers.get("access-control-allow-origin"), CONSOLE);
  const loop = await worker.fetch(new Request("http://localhost:7777/x", { method: "OPTIONS", headers: { origin: "http://localhost:7777" } }), {});
  assert.equal(loop.headers.get("access-control-allow-origin"), "http://localhost:7777");
  const denied = await worker.fetch(new Request("https://or.local/x", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), {});
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("method whitelist: PUT/DELETE get 405, GET and POST pass", async () => {
  const put = await worker.fetch(req("PUT", "/v1/messages"), {});
  assert.equal(put.status, 405);
  const del = await worker.fetch(new Request("https://or.local/v1/messages", { method: "DELETE", headers: { authorization: "Bearer k" } }), {});
  assert.equal(del.status, 405);
  const s = stubFetch();
  try {
    s.respond(200, {});
    const get = await worker.fetch(req("GET", "/v1/messages"), {});
    assert.equal(get.status, 200);
    const post = await worker.fetch(req("POST", "/v1/messages", { body: {} }), {});
    assert.equal(post.status, 200);
  } finally {
    s.restore();
  }
});

test("BYOK: missing Authorization 401s (default-closed, no built-in secret exists)", async () => {
  const noAuth = await worker.fetch(
    new Request("https://or.local/v1/messages", { method: "POST", body: "{}" }),
    {},
  );
  assert.equal(noAuth.status, 401);
  assert.match(await noAuth.text(), /caller Authorization required/);
});

test("safe-header forwarding: caller key + anthropic-version ride; cookies and client keys do not", async () => {
  const { calls, restore } = stubFetch();
  try {
    await worker.fetch(
      req("POST", "/v1/messages", {
        bearer: "caller-or-key",
        body: { model: "x" },
        headers: {
          cookie: "session=stolen",
          "x-api-key": "also-stolen",
          "anthropic-version": "2023-01-01",
          "user-agent": "claude-code/1",
          "accept-language": "en",
        },
      }),
      {},
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, UPSTREAM);
    const h = calls[0].init.headers;
    assert.equal(h.get("authorization"), "Bearer caller-or-key");
    assert.equal(h.get("anthropic-version"), "2023-01-01", "caller's version forwarded");
    assert.equal(h.get("content-type"), "application/json");
    assert.equal(h.get("user-agent"), "claude-code/1");
    assert.equal(h.get("cookie"), null, "cookies must never reach OpenRouter");
    assert.equal(h.get("x-api-key"), null);
  } finally {
    restore();
  }
});

test("anthropic-version defaults when the caller omits it", async () => {
  const { calls, restore } = stubFetch();
  try {
    await worker.fetch(req("POST", "/v1/messages", { body: {} }), {});
    assert.equal(calls[0].init.headers.get("anthropic-version"), "2023-06-01");
  } finally {
    restore();
  }
});

test("POST forwards the body; GET does not (some runtimes throw on GET bodies)", async () => {
  const s = stubFetch();
  try {
    s.respond(200, {});
    await worker.fetch(req("POST", "/v1/messages", { body: { model: "x" } }), {});
    assert.equal(await new Response(s.calls[0].init.body).text(), JSON.stringify({ model: "x" }));
    await worker.fetch(req("GET", "/v1/messages"), {});
    assert.equal(s.calls[1].init.body, undefined);
  } finally {
    s.restore();
  }
});

test("response passthrough: upstream status + body + CORS stamped on top", async () => {
  const s = stubFetch();
  try {
    s.respond(429, { error: "rate limited" });
    const r = await worker.fetch(
      req("POST", "/v1/messages", { body: {}, origin: CONSOLE }),
      {},
    );
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("access-control-allow-origin"), CONSOLE);
    assert.match(await r.text(), /rate limited/);
  } finally {
    s.restore();
  }
});
