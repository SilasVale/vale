// zen-go-proxy behavior tests (first unit coverage for the satellite proxies;
// previously only the wrangler dry-run gate existed). The worker default
// export is exercised end to end with a stubbed global fetch — no wrangler,
// no network, no secrets. Covers the behaviors the file's comments promise:
// CORS reflect-if-allowlisted, the default-closed CLIENT_KEY gate, the
// deepseek-v4-flash native Anthropic passthrough vs the OpenAI translation
// path (request conversion + response conversion + SSE), upstream error
// shaping (5xx generic vs 4xx passthrough), and the 413/404/500 envelopes.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const CONSOLE = "https://ai.saisi.online";
const EVIL = "https://evil.example";
const UPSTREAM_CHAT = "https://opencode.ai/zen/go/v1/chat/completions";
const UPSTREAM_NATIVE = "https://opencode.ai/zen/go/v1/messages";

/** Install a global fetch stub; returns { calls, respond, restore }. */
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
const req = (method, path, { key = "ck-secret", body, headers = {}, origin } = {}) => {
  const h = { ...headers };
  if (key !== undefined) h["x-api-key"] = key;
  if (origin) h.origin = origin;
  return new Request(`https://zen-go.local${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
};

/* ---- CORS ---- */

test("OPTIONS preflight reflects allowlisted + loopback origins, closed otherwise", async () => {
  const ok = await worker.fetch(new Request("https://zen-go.local/v1/messages", { method: "OPTIONS", headers: { origin: CONSOLE } }), env);
  assert.equal(ok.headers.get("access-control-allow-origin"), CONSOLE);
  assert.equal(ok.headers.get("vary"), "Origin");
  const loop = await worker.fetch(new Request("http://localhost:8787/x", { method: "OPTIONS", headers: { origin: "http://localhost:8787" } }), env);
  assert.equal(loop.headers.get("access-control-allow-origin"), "http://localhost:8787");
  const denied = await worker.fetch(new Request("https://zen-go.local/x", { method: "OPTIONS", headers: { origin: EVIL } }), env);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

/* ---- CLIENT_KEY gate (default-closed) ---- */

test("CLIENT_KEY unset refuses EVERY caller — a missing gate secret never reaches the paid key", async () => {
  const r = await worker.fetch(req("POST", "/v1/messages", { key: "anything", body: { model: "x" } }), {});
  assert.equal(r.status, 401);
});

test("wrong/missing x-api-key 401s; correct key proceeds to routing", async () => {
  const bad = await worker.fetch(req("POST", "/v1/messages", { key: "wrong", body: { model: "x" } }), env);
  assert.equal(bad.status, 401);
  const { respond, restore } = stubFetch();
  try {
    respond(200, { choices: [] });
    const ok = await worker.fetch(req("POST", "/v1/messages", { key: "ck-secret", body: { model: "m" } }), env);
    assert.equal(ok.status, 200);
  } finally {
    restore();
  }
});

/* ---- routing + native passthrough ---- */

test("Flash-line slugs pass through RAW to /v1/messages (Anthropic-native), no translation", async () => {
  // deepseek-flash is the live V4.1 lane slug; deepseek-v4-flash is the
  // retired V4 slug zen still aliases. Both take the native path.
  for (const slug of ["deepseek-flash", "deepseek-v4-flash"]) {
    const { calls, respond, restore } = stubFetch();
    try {
      const raw = JSON.stringify({ model: slug, messages: [{ role: "user", content: "hi" }], max_tokens: 8 });
      respond(200, raw, { "content-type": "text/event-stream" });
      const r = await worker.fetch(req("POST", "/v1/messages", { body: raw }), env);
      assert.equal(r.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, UPSTREAM_NATIVE);
      assert.equal(calls[0].init.headers["x-api-key"], "up-key");
      assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
      assert.equal(calls[0].init.body, raw, "native path must forward the request verbatim");
      assert.equal(await r.text(), raw, "body streams through untouched");
    } finally {
      restore();
    }
  }
});

test("non-native models translate to the OpenAI chat/completions upstream with a Bearer key", async () => {
  const { calls, respond, restore } = stubFetch();
  try {
    respond(200, {
      id: "up1",
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const r = await worker.fetch(
      req("POST", "/v1/messages", {
        body: {
          model: "glm-4.7",
          system: "be nice",
          max_tokens: 16,
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        },
      }),
      env,
    );
    assert.equal(r.status, 200);
    assert.equal(calls[0].url, UPSTREAM_CHAT);
    assert.equal(calls[0].init.headers.Authorization, "Bearer up-key");
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.model, "glm-4.7");
    assert.deepEqual(sent.messages[0], { role: "system", content: "be nice" });
    assert.deepEqual(sent.messages[1], { role: "user", content: "hi" });
    assert.equal(sent.max_tokens, 16);
    // Anthropic response shape restored from the OpenAI one
    const out = await r.json();
    assert.equal(out.type, "message");
    assert.deepEqual(out.content, [{ type: "text", text: "hello" }]);
    assert.equal(out.stop_reason, "end_turn");
    assert.equal(out.usage.input_tokens, 5);
    assert.equal(out.usage.output_tokens, 2);
  } finally {
    restore();
  }
});

test("assistant thinking + tool_use blocks convert to reasoning_content + tool_calls; tool_use stop maps", async () => {
  const { respond, restore } = stubFetch();
  try {
    respond(200, {
      id: "up2",
      choices: [{
        message: {
          role: "assistant",
          reasoning_content: "pondering",
          content: "",
          tool_calls: [{ id: "call9", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: {},
    });
    const r = await worker.fetch(
      req("POST", "/v1/messages", {
        body: { model: "glm-4.7", messages: [{ role: "user", content: "go" }] },
      }),
      env,
    );
    const out = await r.json();
    assert.deepEqual(
      out.content.map((b) => b.type),
      ["thinking", "tool_use"],
      "empty text block must be omitted; thinking first",
    );
    assert.equal(out.content[0].thinking, "pondering");
    assert.deepEqual(out.content[1].input, { path: "a.txt" });
    assert.equal(out.stop_reason, "tool_use");
  } finally {
    restore();
  }
});

test("tool_result user blocks become OpenAI tool messages; tools + tool_choice convert", async () => {
  const { calls, respond, restore } = stubFetch();
  try {
    respond(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
    await worker.fetch(
      req("POST", "/v1/messages", {
        body: {
          model: "glm-4.7",
          messages: [
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result text" }] },
          ],
          tools: [{ name: "read", description: "read a file", input_schema: { type: "object" } }],
          tool_choice: { type: "tool", name: "read" },
        },
      }),
      env,
    );
    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(sent.messages[0], { role: "tool", tool_call_id: "t1", content: "result text" });
    assert.deepEqual(sent.tools, [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object" } } }]);
    assert.deepEqual(sent.tool_choice, { type: "function", function: { name: "read" } });
  } finally {
    restore();
  }
});

test("stream:true on the translate path emits Anthropic SSE framing", async () => {
  const { respond, restore } = stubFetch();
  try {
    respond(200, {
      id: "up3",
      choices: [{ message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    const r = await worker.fetch(
      req("POST", "/v1/messages", {
        body: { model: "glm-4.7", stream: true, messages: [{ role: "user", content: "yo" }] },
      }),
      env,
    );
    assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
    const sse = await r.text();
    assert.match(sse, /^event: message_start\n/);
    assert.match(sse, /event: content_block_start\n/);
    assert.match(sse, /"type":"text_delta","text":"hi there"/);
    assert.match(sse, /event: message_stop/);
  } finally {
    restore();
  }
});

/* ---- upstream error shaping ---- */

test("upstream 5xx: generic client text, upstream detail stays server-side", async () => {
  const { respond, restore } = stubFetch();
  try {
    respond(503, { error: { message: "SECRET detail" } });
    const r = await worker.fetch(req("POST", "/v1/messages", { body: { model: "glm-4.7" } }), env);
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.error.message, "Upstream unavailable");
    assert.equal(JSON.stringify(j).includes("SECRET"), false);
  } finally {
    restore();
  }
});

test("upstream 4xx passes the upstream message through to the caller", async () => {
  const { respond, restore } = stubFetch();
  try {
    respond(429, { error: { message: "rate limited by upstream" } });
    const r = await worker.fetch(req("POST", "/v1/messages", { body: { model: "glm-4.7" } }), env);
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error.message, "rate limited by upstream");
  } finally {
    restore();
  }
});

/* ---- bodies + misc envelopes ---- */

test("oversized declared body 413s before buffering; unknown path 404s; bad JSON 500s", async () => {
  // The guard screens the DECLARED content-length header (undici does not set
  // one for string bodies, so the test declares it explicitly — exactly what
  // a client streaming an oversized payload presents).
  const big = await worker.fetch(
    req("POST", "/v1/messages", { body: "x", headers: { "content-length": String(10 * 1024 * 1024 + 1) } }),
    env,
  );
  assert.equal(big.status, 413);

  const nf = await worker.fetch(req("GET", "/nope"), env);
  assert.equal(nf.status, 404);

  const bad = await worker.fetch(req("POST", "/v1/messages", { body: "{not json" }), env);
  assert.equal(bad.status, 500);
  assert.equal((await bad.json()).error.message, "Internal error");
});

test("count_tokens estimates from the serialized message array and never dials upstream", async () => {
  const { calls, restore } = stubFetch();
  try {
    const r = await worker.fetch(
      req("POST", "/v1/messages/count_tokens", { body: { messages: [{ role: "user", content: "12345678" }] } }),
      env,
    );
    const j = await r.json();
    // JSON.stringify of that array is 44 chars -> ceil(44/4) = 11
    assert.equal(j.input_tokens, Math.ceil(JSON.stringify([{ role: "user", content: "12345678" }]).length / 4));
    assert.equal(calls.length, 0, "count_tokens never dials upstream");
  } finally {
    restore();
  }
});
