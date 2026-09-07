// Full-path /v1/messages gateway tests — mock KV + stubbed fetch, no Cloudflare calls.
//
// Exercises handleGateway's routing for the og/ channel. deepseek-v4-flash is
// Anthropic-native on zen/go/v1/messages (x-api-key auth) and bypasses the OpenAI
// translation; other og models (minimax-m3, mimo-v2.5) keep the translate path.
//
// store.js keeps a module-level 24h cache, so every test uses a distinct token/user.
import test from "node:test";
import assert from "node:assert/strict";
import { handleGateway } from "../src/index.ts";
import { scanTopLevelModel, rawWithModel, estimateTokens, rawWithTopLevelField, rawWithDeepSeekProvider, rawWithOxAlphaReasoningDefault } from "../src/body-scan.ts";
import { __clearCaches } from "../src/store.ts";

let uidSeq = 0;
function gwEnv({ keys = {}, breakerOpen = false, trips = null, timeout = 30, usProxy = false, usProxyBase } = {}) {
  const uid = `u${++uidSeq}`;
  const token = `tok-${uid}`;
  const kv = new Map([
    [`token:${token}`, uid],
    [`user:${uid}`, JSON.stringify({ id: uid, username: uid, role: "user", enabled: true, token })],
    [`ukeys:${uid}`, JSON.stringify({
      DEEPSEEK_API_KEY: "sk-ds", OPENCODE_GO_API_KEY: "sk-og",
      OPENROUTER_API_KEY: "sk-or", QWEN_API_KEY: "sk-qw", ...keys,
    })],
  ]);
  // US_PROXY: KV setting wins (the console toggle writes settings:US_PROXY).
  if (usProxy) kv.set("settings:US_PROXY", "1");
  const breaker = {
    idFromName: () => ({}),
    get: () => ({
      // isChannelDegraded / recordChannelFailure call the stub with a plain URL
      // string, not a Request — handle both.
      fetch: async (req) => {
        const u = typeof req === "string" ? req : String(req?.url || "");
        if (u.endsWith("/trip")) trips?.push(u);
        return new Response(breakerOpen ? "1" : "0");
      },
    }),
  };
  // Mock RouteDO: in-memory storage keyed by uid
  const routeStore = new Map();
  const routeDo = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async (req, init) => {
        const method = init?.method || "GET";
        const url = new URL(typeof req === "string" ? req : req.url);
        const uid = url.searchParams.get("uid");
        if (method === "GET") {
          const model = routeStore.get(uid) || null;
          return new Response(JSON.stringify({ model }));
        }
        if (method === "PUT") {
          const body = JSON.parse(init.body || "{}");
          routeStore.set(body.uid, body.model);
          return new Response(JSON.stringify({ ok: true }));
        }
        if (method === "DELETE") {
          routeStore.delete(uid);
          return new Response(JSON.stringify({ ok: true }));
        }
        return new Response("not found", { status: 404 });
      },
    }),
  };
  return {
    env: {
      KEYS: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async () => {}, delete: async () => {} },
      BREAKER: breaker,
      ROUTE: routeDo,
      UPSTREAM_TIMEOUT_MS: timeout,
      OG_TIMEOUT_MS: timeout, // og translate reads this (60s default)
      ...(usProxyBase ? { US_PROXY_BASE: usProxyBase } : {}),
    },
    token,
  };
}

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const post = (env, token, body, path = "/v1/messages") =>
  handleGateway(
    new Request(`https://g${path}`, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    new URL(`https://g${path}`),
  );

// ── og models: ALL route via zen chat/completions (OpenAI translate path) ──
// (2026-08: OG_NATIVE_ANTHROPIC emptied — zen natively speaks OpenAI format
// for every model, so the /v1/messages native passthrough is gone.)

test("og/deepseek-v4-flash goes to zen chat/completions with Bearer (translate path)", async () => {
  const { env, token } = gwEnv();
  let seen;
  const res = await withFetch(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); }, () =>
    post(env, token, { model: "og/deepseek-v4-flash", max_tokens: 10, stream: false, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/chat/completions");
  // Translate path authenticates with Bearer; no x-api-key on this route.
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-og");
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "deepseek-v4-flash"); // og/ prefix stripped
  assert.equal(sent.stream, false);
  const body = await res.json(); // translated back to Anthropic shape
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "ok");
});

// round-478 (coverage-driven): the stream-ignored upstream arms (JSON
// instead of SSE → one-shot SSE / 502 error envelope) had ZERO pins.
test("og stream:true with a JSON upstream → one-shot Anthropic SSE, not an empty message", async () => {
  const { env, token } = gwEnv();
  const res = await withFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "streamed-ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }), () =>
    post(env, token, { model: "og/deepseek-v4-flash", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  assert.match(await res.text(), /streamed-ok/);
});

test("og stream:true with a 200-wrapped upstream error → 502, never an empty message", async () => {
  const { env, token } = gwEnv();
  const res = await withFetch(async () => new Response(JSON.stringify({ error: { message: "upstream boom" } }), { status: 200, headers: { "content-type": "application/json" } }), () =>
    post(env, token, { model: "og/deepseek-v4-flash", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /upstream boom/);
});

test("og/minimax-m3 also goes to chat/completions (translate path)", async () => {
  const { env, token } = gwEnv();
  let seen;
  const res = await withFetch(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); }, () =>
    post(env, token, { model: "og/minimax-m3", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(JSON.parse(seen.init.body).model, "minimax-m3");
  assert.equal(res.status, 200);
});

// ── og/muse-spark-*: /v1/responses (OpenAI Responses API) ──
// Muse Spark Contributor is responses-only on zen/go (chat/completions 500s)
// and is forced through the US exit (Meta Geographic Use Policy). The
// /v1/responses entry forwards the OpenAI Responses body verbatim with the
// model prefix stripped, via the US exit. The default exit is the Vercel
// relay (v.saisi.online/api/zen — the only exit verified to clear the Meta
// RegionError); MUSE_RESPONSES_EXIT=zen-us (or an https URL) selects
// another BYOK /v1/responses exit.

test("og/muse-spark-1.3-contributor on /v1/responses forces the US exit", async () => {
  const { env, token } = gwEnv();
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({
      id: "resp_1", object: "response", created_at: 1, status: "completed",
      model: "muse-spark-1.3-contributor", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () =>
    post(env, token, { model: "og/muse-spark-1.3-contributor", input: "hi", max_output_tokens: 10 }, "/v1/responses"),
  );
  // US exit forced even with the global switch OFF (Meta region policy) —
  // default exit is the Vercel relay (v.saisi.online/api/zen).
  assert.ok(seen.url.startsWith("https://v.saisi.online/api/zen?target=og&path="));
  assert.ok(decodeURIComponent(seen.url).includes("/v1/responses"));
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-og");
  // No anthropic-version header on the OpenAI-native responses wire.
  const av = seen.init.headers.get ? seen.init.headers.get("anthropic-version") : seen.init.headers["anthropic-version"];
  assert.equal(av, null);
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "muse-spark-1.3-contributor"); // og/ prefix stripped
  assert.equal(sent.input, "hi");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "response"); // passthrough, not translated
});

test("og/muse-spark-1.2-contributor on /v1/responses works (US exit, Bearer)", async () => {
  __clearCaches();
  const { env, token } = gwEnv();
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ object: "response", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }, () =>
    post(env, token, { model: "og/muse-spark-1.2-contributor", input: "hi" }, "/v1/responses"),
  );
  assert.ok(seen.url.startsWith("https://v.saisi.online/api/zen?target=og&path="));
  assert.equal(JSON.parse(seen.init.body).model, "muse-spark-1.2-contributor");
  assert.equal(res.status, 200);
});

// round-495 (coverage-driven): the /v1/responses model guard had ZERO pins
// (only the happy path was covered). NOTE: the route.kind!=="opencode" arm
// is defensive-only — og/ always resolves kind "opencode" — so both cases
// land on the model guard.
test("/v1/responses rejects non-muse-spark and non-og models with 400", async () => {
  const { env, token } = gwEnv();
  await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    async () => {
      for (const model of ["og/deepseek-v4-flash", "ds/deepseek-v4-flash"]) {
        const res = await post(env, token, { model, input: "hi" }, "/v1/responses");
        assert.equal(res.status, 400, model);
        assert.match((await res.json()).error.message, /only og\/muse-spark-\* Contributor models/, model);
      }
    },
  );
});

test("og/muse-spark-1.3-contributor rides the zen-us CF exit when MUSE_RESPONSES_EXIT=zen-us", async () => {
  __clearCaches();
  const { env, token } = gwEnv();
  env.MUSE_RESPONSES_EXIT = "zen-us";
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ object: "response", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }, () =>
    post(env, token, { model: "og/muse-spark-1.3-contributor", input: "hi" }, "/v1/responses"),
  );
  assert.equal(seen.url, "https://zen-us.saisi.online/v1/responses");
  assert.equal(res.status, 200);
});

test("og/muse-spark-1.3-contributor rides a custom exit when MUSE_RESPONSES_EXIT is an https URL", async () => {
  __clearCaches();
  const { env, token } = gwEnv();
  env.MUSE_RESPONSES_EXIT = "https://alt.example.com/v1/responses";
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ object: "response", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }, () =>
    post(env, token, { model: "og/muse-spark-1.3-contributor", input: "hi" }, "/v1/responses"),
  );
  assert.equal(seen.url, "https://alt.example.com/v1/responses");
  assert.equal(res.status, 200);
});

test("/v1/responses rejects non-muse og models", async () => {
  const { env, token } = gwEnv();
  const res = await post(env, token, { model: "og/deepseek-v4-flash", input: "hi" }, "/v1/responses");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /muse-spark/);
});

test("/v1/responses rejects unknown models (not in MODELS whitelist)", async () => {
  const { env, token } = gwEnv();
  const res = await post(env, token, { model: "og/muse-spark-9.9-contributor", input: "hi" }, "/v1/responses");
  assert.equal(res.status, 400);
});

test("gmi/MiniMaxAI/MiniMax-M3 uses GMI BYOK passthrough on chat/completions", async () => {
  __clearCaches();
  const { env, token } = gwEnv({
    keys: {
      OPENCODE_GO_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      DEEPSEEK_API_KEY: "sk-ds",
      GMI_API_KEY: "sk-gmi",
    },
  });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "gmi/MiniMaxAI/MiniMax-M3",
    max_tokens: 8,
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  }, "/v1/chat/completions"));
  assert.equal(seen.url, "https://api.gmi-serving.com/v1/chat/completions");
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-gmi");
  // gmi/ prefix stripped; upstream model id preserved verbatim.
  assert.equal(JSON.parse(seen.init.body).model, "MiniMaxAI/MiniMax-M3");
  assert.equal(res.status, 200);
});

test("gmi without GMI_API_KEY → 502 config error on chat/completions", async () => {
  __clearCaches();
  const { env, token } = gwEnv({
    keys: {
      OPENCODE_GO_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      GMI_API_KEY: undefined,
    },
  });
  let calls = 0;
  const res = await withFetch(async () => { calls++; return new Response("{}", { status: 200 }); }, () =>
    post(env, token, {
      model: "gmi/MiniMaxAI/MiniMax-M3",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }, "/v1/chat/completions"),
  );
  assert.equal(calls, 0);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error?.message || body.message || "", /GMI_API_KEY not configured/);
});

test("gmi Anthropic-format request (/v1/messages) is translated to OpenAI chat/completions", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { GMI_API_KEY: "sk-gmi" } });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () =>
    post(env, token, {
      model: "gmi/MiniMaxAI/MiniMax-M3",
      max_tokens: 8,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(seen.url, "https://api.gmi-serving.com/v1/chat/completions");
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-gmi");
  // Outbound body is OpenAI format (gmi/ prefix stripped, system role intact).
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "MiniMaxAI/MiniMax-M3");
  assert.equal(sent.stream, false);
  assert.equal(sent.messages[0].role, "user");
  // Translated back to Anthropic shape for the client.
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "ok");
});

test("gmi /v1/messages stream:true → OpenAI SSE translated to Anthropic SSE", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { GMI_API_KEY: "sk-gmi" } });
  const openaiSse =
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n' +
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const res = await withFetch(async () =>
    new Response(openaiSse, { status: 200, headers: { "content-type": "text/event-stream" } }), () =>
    post(env, token, {
      model: "gmi/MiniMaxAI/MiniMax-M3",
      max_tokens: 8,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /"type":"text_delta","text":"Hel"/);
  assert.match(text, /"type":"text_delta","text":"lo"/);
  assert.match(text, /"stop_reason":"end_turn"/);
  assert.match(text, /event: message_stop/);
});

test("gmi /v1/messages without GMI_API_KEY → 502 config error", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { GMI_API_KEY: undefined } });
  let calls = 0;
  const res = await withFetch(async () => { calls++; return new Response("{}", { status: 200 }); }, () =>
    post(env, token, {
      model: "gmi/MiniMaxAI/MiniMax-M3",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(calls, 0);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error?.message || body.message || "", /GMI_API_KEY not configured/);
});

// ── qw/ (Qwen MaaS / Aliyun Token Plan) — Anthropic /v1/messages rides the
// /apps/anthropic endpoint; OpenAI-format /v1/chat/completions (DSH & co.)
// must ride the compatible-mode endpoint (the Anthropic endpoint rejects
// OpenAI bodies with 400 "Request body format invalid").

test("qw/qwen3.8-flash /v1/chat/completions → Qwen compatible-mode endpoint with QWEN_API_KEY", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { QWEN_API_KEY: "sk-qw" } });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      id: "chatcmpl-1", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "qw/qwen3.8-flash",
    max_tokens: 8,
    stream: false,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "bash", description: "x", parameters: { type: "object" } } }],
  }, "/v1/chat/completions"));
  assert.equal(seen.url, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-qw");
  // qw/ prefix stripped; OpenAI body forwarded verbatim (tools format intact).
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "qwen3.8-flash");
  assert.ok(sent.tools[0].type === "function");
  assert.equal(res.status, 200);
});

test("qw/qwen3.8-flash /v1/messages → Anthropic /apps/anthropic endpoint (passthrough)", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { QWEN_API_KEY: "sk-qw" } });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "qwen3.8-flash",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "qw/qwen3.8-flash",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.equal(seen.url, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages");
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-qw");
  assert.equal(JSON.parse(seen.init.body).model, "qwen3.8-flash");
  assert.equal(res.status, 200);
});

test("qw /v1/chat/completions with US_PROXY → egress path targets compatible-mode", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { QWEN_API_KEY: "sk-qw" }, usProxy: true, usProxyBase: "https://v.example.com" });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      id: "chatcmpl-1", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "qw/qwen3.8-flash",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  }, "/v1/chat/completions"));
  assert.equal(
    seen.url,
    "https://v.example.com/api/zen?target=qw&path=%2Fcompatible-mode%2Fv1%2Fchat%2Fcompletions",
  );
  assert.equal(res.status, 200);
});

// ── cm/ (Command Code GOAT) — Anthropic /v1/messages is translated to the
// OpenAI chat/completions endpoint (the Command Code Anthropic endpoint only
// serves claude-* models); /v1/chat/completions passes through directly.

test("cm/deepseek/deepseek-v4-flash /v1/messages → translated to Command Code chat/completions with reasoning", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { CMD_API_KEY: "sk-cm" } });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      id: "gen_cm1", object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", reasoning: "思考中", content: "ok", reasoning_details: [{ type: "reasoning.text", text: "思考中", format: "unknown", index: 0 }] },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "cm/deepseek/deepseek-v4-flash",
    max_tokens: 8,
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.equal(seen.url, "https://api.commandcode.ai/provider/v1/chat/completions");
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-cm");
  // Outbound body is OpenAI format, cm/ prefix stripped.
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "deepseek/deepseek-v4-flash");
  assert.equal(sent.stream, false);
  assert.equal(sent.messages[0].role, "user");
  // Translated back to Anthropic shape; Command Code's `reasoning` field
  // becomes a thinking block.
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, "message");
  assert.equal(body.content[0].type, "thinking");
  assert.equal(body.content[0].thinking, "思考中");
  assert.equal(body.content[1].type, "text");
  assert.equal(body.content[1].text, "ok");
});

test("cm /v1/chat/completions is a direct OpenAI passthrough with CMD_API_KEY", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { CMD_API_KEY: "sk-cm" } });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      id: "gen_cm2", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "cm/deepseek/deepseek-v4-flash",
    max_tokens: 8,
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  }, "/v1/chat/completions"));
  assert.equal(seen.url, "https://api.commandcode.ai/provider/v1/chat/completions");
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-cm");
  assert.equal(JSON.parse(seen.init.body).model, "deepseek/deepseek-v4-flash");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "ok");
});

// cm/ free catalog models (2026-09-03): Meituan LongCat-2.0:free and Poolside
// Laguna S 2.1 -free are OpenAI passthroughs like deepseek — prefix stripped,
// CMD_API_KEY bearer, any model id accepted.

for (const freeModel of ["meituan/LongCat-2.0:free", "poolside/laguna-s-2.1-free"]) {
  test(`cm/${freeModel} /v1/chat/completions is a direct OpenAI passthrough with CMD_API_KEY`, async () => {
    __clearCaches();
    const { env, token } = gwEnv({ keys: { CMD_API_KEY: "sk-cm" } });
    let seen;
    const res = await withFetch(async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({
        id: "gen_cm_free", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }, () => post(env, token, {
      model: `cm/${freeModel}`,
      max_tokens: 8,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }, "/v1/chat/completions"));
    assert.equal(seen.url, "https://api.commandcode.ai/provider/v1/chat/completions");
    const auth = seen.init.headers.get
      ? seen.init.headers.get("authorization")
      : seen.init.headers.Authorization;
    assert.equal(auth, "Bearer sk-cm");
    assert.equal(JSON.parse(seen.init.body).model, freeModel);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "ok");
  });
}

test("cm /v1/messages without CMD_API_KEY → 502 config error", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { CMD_API_KEY: undefined } });
  let calls = 0;
  const res = await withFetch(async () => { calls++; return new Response("{}", { status: 200 }); }, () =>
    post(env, token, {
      model: "cm/deepseek/deepseek-v4-flash",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(calls, 0);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error?.message || body.message || "", /CMD_API_KEY not configured/);
});

test("cm /v1/messages stream:true → Command Code reasoning delta becomes thinking_delta", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { CMD_API_KEY: "sk-cm" } });
  const openaiSse =
    'data: {"id":"chatcmpl-cm","choices":[{"index":0,"delta":{"reasoning":"思考"},"finish_reason":null}]}\n\n' +
    'data: {"id":"chatcmpl-cm","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const res = await withFetch(async () =>
    new Response(openaiSse, { status: 200, headers: { "content-type": "text/event-stream" } }), () =>
    post(env, token, {
      model: "cm/deepseek/deepseek-v4-flash",
      max_tokens: 8,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /"type":"thinking_delta","thinking":"思考"/);
  assert.match(text, /"type":"text_delta","text":"好"/);
  assert.match(text, /event: message_stop/);
});

// ── amd/ (AMD Radeon Cloud, developer.amd.com.cn/radeon) — BOTH formats are
// native upstream: Anthropic /v1/messages (thinking + tool_use verified live
// 2026-09-02, x-api-key auth) and OpenAI /v1/chat/completions (Bearer). No
// translation on either path, and the route always stays off the US exit.

test("amd/DeepSeek-V4-Flash /v1/messages → native Anthropic passthrough with x-api-key", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { AMD_API_KEY: "rc-amd" } });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      id: "msg_amd1", type: "message", role: "assistant",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "tool_use", id: "call_1", name: "get_time", input: { tz: "Asia/Tokyo" } },
      ],
      stop_reason: "tool_use",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "amd/DeepSeek-V4-Flash",
    max_tokens: 8,
    messages: [{ role: "user", content: "what time in Tokyo?" }],
    tools: [{ name: "get_time", description: "x", input_schema: { type: "object" } }],
  }));
  assert.equal(seen.url, "https://developer.amd.com.cn/radeon/api/v1/messages");
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  const apiKey = seen.init.headers.get
    ? seen.init.headers.get("x-api-key")
    : seen.init.headers["x-api-key"];
  // x-api-key (the header the Radeon docs show), never Bearer, never the
  // client's own gateway token.
  assert.equal(apiKey, "rc-amd");
  assert.equal(auth, null);
  // amd/ prefix stripped, Anthropic body forwarded un-translated (a chat
  // reshaping would turn tools[].input_schema into function.parameters).
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "DeepSeek-V4-Flash");
  assert.equal(sent.tools[0].input_schema.type, "object");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.content[1].type, "tool_use");
});

test("amd/Qwen3.8-Flash-Next /v1/chat/completions → OpenAI passthrough with Bearer", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { AMD_API_KEY: "rc-amd" } });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      id: "chatcmpl-amd", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "amd/Qwen3.8-Flash-Next",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "bash", description: "x", parameters: { type: "object" } } }],
  }, "/v1/chat/completions"));
  assert.equal(seen.url, "https://developer.amd.com.cn/radeon/api/v1/chat/completions");
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer rc-amd");
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "Qwen3.8-Flash-Next");
  assert.equal(sent.tools[0].type, "function");
  assert.equal(res.status, 200);
});

test("amd/ ignores the US exit (no amd target in the proxy; CN-served host)", async () => {
  __clearCaches();
  const { env, token } = gwEnv({
    keys: { AMD_API_KEY: "rc-amd" },
    usProxy: true,
    usProxyBase: "https://v.example.com",
  });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [], stop_reason: "end_turn" }), { status: 200 });
  }, () => post(env, token, {
    model: "amd/GLM-5.3-Flash",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.ok(!seen.url.startsWith("https://v.example.com"), `proxied: ${seen.url}`);
  assert.equal(seen.url, "https://developer.amd.com.cn/radeon/api/v1/messages");
  assert.equal(res.status, 200);
});

test("amd /v1/messages without AMD_API_KEY → 502 config error, no upstream call", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { AMD_API_KEY: undefined } });
  let calls = 0;
  const res = await withFetch(async () => { calls++; return new Response("{}", { status: 200 }); }, () =>
    post(env, token, {
      model: "amd/DeepSeek-V4-Flash",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(calls, 0);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error?.message || body.message || "", /AMD_API_KEY not configured/);
});

test("amd 429 concurrency limit: {detail:{error}} envelope unwrapped, status + rate_limit_error kept", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { AMD_API_KEY: "rc-amd" }, timeout: 1000 });
  let calls = 0;
  const res = await withFetch(async () => {
    calls++;
    return new Response(JSON.stringify({
      detail: {
        error: {
          message: "Model 'DeepSeek-V4-Flash' is at its concurrency limit (64); please retry later or use another model",
          type: "rate_limit_error",
          code: "model_concurrency_rate_limit_exceeded",
        },
      },
    }), { status: 429, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "amd/DeepSeek-V4-Flash",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.ok(calls >= 2, `a 429 on a free shared pool should be retried, got ${calls}`);
  assert.equal(res.status, 429);
  const body = await res.json();
  // Without the detail-unwrap this came back as a stringified blob with a
  // non-retryable api_error type, so clients stopped backing off.
  assert.match(body.error.message, /concurrency limit/);
  assert.equal(body.error.type, "rate_limit_error");
});

test("nv Anthropic-format request (/v1/messages) is translated with NVAPI_KEY", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { NVAPI_KEY: "sk-nv" } });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () =>
    post(env, token, {
      model: "nv/minimaxai/minimax-m3",
      max_tokens: 8,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(seen.url, "https://integrate.api.nvidia.com/v1/chat/completions");
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-nv");
  assert.equal(JSON.parse(seen.init.body).model, "minimaxai/minimax-m3");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "ok");
});

// round-498 (coverage-driven): the nv/gmi translate failure mapping had
// ZERO pins (only the happy path was covered).
test("nv translate failure maps status/message and carries retry-after", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { NVAPI_KEY: "sk-nv" } });
  const res = await withFetch(async () => new Response(JSON.stringify({
    error: { message: "nim shed", type: "overloaded_error" },
  }), { status: 503, headers: { "content-type": "application/json", "retry-after": "1" } }), () =>
    post(env, token, {
      model: "nv/minimaxai/minimax-m3",
      max_tokens: 8,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "1");
  const body = await res.json();
  assert.equal(body.error.message, "nim shed");
  // This branch maps status/message/pacing only — no upstream-type adoption.
  assert.equal(body.error.type, "api_error");
});

test("or/z-ai/glm-5.2:free uses OpenRouter BYOK passthrough", async () => {  __clearCaches();
  const { env, token } = gwEnv({
    keys: {
      OPENCODE_GO_API_KEY: undefined,
      OPENROUTER_API_KEY: "sk-openrouter-glm",
    },
  });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "glm" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "or/z-ai/glm-5.2:free",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.match(String(seen.url), /(?:openrouter|v\.saisi\.online\/api\/proxy)/);
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-openrouter-glm");
  assert.equal(JSON.parse(seen.init.body).model, "z-ai/glm-5.2:free");
  assert.equal(res.status, 200);
});

test("or/nvidia/nemotron-3-ultra-550b-a55b:free uses OpenRouter BYOK passthrough", async () => {
  __clearCaches();
  const { env, token } = gwEnv({
    keys: {
      OPENCODE_GO_API_KEY: undefined,
      OPENROUTER_API_KEY: "sk-openrouter-nemotron",
    },
  });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "nemotron" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "or/nvidia/nemotron-3-ultra-550b-a55b:free",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.match(String(seen.url), /(?:openrouter|v\.saisi\.online\/api\/proxy)/);
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-openrouter-nemotron");
  assert.equal(JSON.parse(seen.init.body).model, "nvidia/nemotron-3-ultra-550b-a55b:free");
  assert.equal(res.status, 200);
});

test("nv/nvidia/nemotron via NIM official API (dedicated key, model swap)", async () => {
  __clearCaches();
  const { env, token } = gwEnv({
    keys: {
      OPENCODE_GO_API_KEY: undefined,
      NVAPI_KEY: "nvapi-test-123",
    },
  });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "nv/nvidia/nemotron-3-ultra-550b-a55b",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
  }, "/v1/chat/completions"));
  assert.equal(seen.url, "https://integrate.api.nvidia.com/v1/chat/completions");
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer nvapi-test-123");
  assert.equal(JSON.parse(seen.init.body).model, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(res.status, 200);
});

test("nv/ on /v1/messages without NVAPI_KEY → 502 config error", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { NVAPI_KEY: undefined } });
  let calls = 0;
  const res = await withFetch(async () => { calls++; return new Response("{}", { status: 200 }); }, () =>
    post(env, token, {
      model: "nv/nvidia/nemotron-3-ultra-550b-a55b",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    }),
  ); // default path = /v1/messages; the translate branch rejects before fetch
  assert.equal(calls, 0);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error?.message || "", /NVAPI_KEY not configured/);
});

test("or/stealth/ox-alpha uses OpenRouter BYOK passthrough", async () => {
  __clearCaches();
  const { env, token } = gwEnv({
    keys: {
      OPENCODE_GO_API_KEY: undefined,
      OPENROUTER_API_KEY: "sk-openrouter-ox",
    },
  });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "ox" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "or/stealth/ox-alpha",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.match(String(seen.url), /(?:openrouter|v\.saisi\.online\/api\/proxy)/);
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-openrouter-ox");
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "stealth/ox-alpha");
  // reasoning.effort=max is pinned on every ox-alpha request (overrides client).
  assert.deepEqual(sent.reasoning, { effort: "max" });
  assert.equal(res.status, 200);
});

test("or/stealth/ox-alpha chat/completions also pins reasoning.effort=max", async () => {
  __clearCaches();
  const { env, token } = gwEnv({
    keys: {
      OPENCODE_GO_API_KEY: undefined,
      OPENROUTER_API_KEY: "sk-openrouter-ox",
    },
  });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "or/stealth/ox-alpha",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  }, "/v1/chat/completions"));
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "stealth/ox-alpha");
  assert.deepEqual(sent.reasoning, { effort: "max" });
  assert.equal(res.status, 200);
});

test("or/deepseek/deepseek-v4-flash-0731 uses direct OpenRouter with fixed DeepSeek provider", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ usProxy: true });
  let seen;
  await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ content: [{ type: "text", text: "deepseek" }] }), { status: 200 });
  }, () => post(env, token, {
    model: "or/deepseek/deepseek-v4-flash-0731",
    provider: { order: ["other"], allow_fallbacks: true },
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  }));
  // 2026-08-22: or/ walks the US exit like every channel (openrouter-proxy
  // retired from the chain); the DeepSeek provider pin rides in the body.
  assert.equal(seen.url, "https://v.saisi.online/api/zen?target=or&path=%2Fv1%2Fmessages");
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "deepseek/deepseek-v4-flash-0731");
  assert.deepEqual(sent.provider, { order: ["deepseek"], allow_fallbacks: false });
});

test("og/gpt-5.6-luna uses OpenCode Go through the Vercel US exit", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { OPENROUTER_API_KEY: undefined } });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: "luna" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "og/gpt-5.6-luna", max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.equal(seen.url, "https://v.saisi.online/api/zen?target=og&path=%2Fv1%2Fchat%2Fcompletions");
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-og");
  assert.equal(JSON.parse(seen.init.body).model, "gpt-5.6-luna");
  assert.equal(res.status, 200);
});


// ── US_PROXY switch: on = every channel via the Vercel US exit ──

test("US_PROXY on: og/deepseek-v4-flash walks translate via the proxy (not native)", async () => {
  __clearCaches(); // 24h settings cache would poison the switch test
  const { env, token } = gwEnv({ usProxy: true });
  let seen;
  const res = await withFetch(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); }, () =>
    post(env, token, { model: "og/deepseek-v4-flash", max_tokens: 10, stream: false, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(seen.url, "https://v.saisi.online/api/zen?target=og&path=%2Fv1%2Fchat%2Fcompletions");
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-og");
  assert.equal(res.status, 200);
});

test("US_PROXY honors a configurable proxy base", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ usProxy: true, usProxyBase: "https://proxy.example.test" });
  let seen;
  await withFetch(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 }); }, () =>
    post(env, token, { model: "og/minimax-m3", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(seen.url, "https://proxy.example.test/api/zen?target=og&path=%2Fv1%2Fchat%2Fcompletions");
});

test("US_PROXY on: ds/ goes through the proxy passthrough", async () => {
  __clearCaches(); // 24h settings cache would poison the switch test
  const { env, token } = gwEnv({ usProxy: true });
  let seen;
  const res = await withFetch(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); }, () =>
    post(env, token, { model: "ds/deepseek-v4-flash", max_tokens: 10, stream: false, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(seen.url, "https://v.saisi.online/api/zen?target=ds&path=%2Fanthropic%2Fv1%2Fmessages");
  assert.equal(res.status, 200);
});

test("US_PROXY off (default): flash goes direct via chat/completions", async () => {
  __clearCaches(); // 24h settings cache would poison the switch test
  const { env, token } = gwEnv(); // no settings:US_PROXY key
  let seen;
  await withFetch(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); }, () =>
    post(env, token, { model: "og/deepseek-v4-flash", max_tokens: 10, stream: false, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/chat/completions");
});

test("og/mimo-v2.5 keeps the translate path (chat/completions, Anthropic JSON out)", async () => {
  const { env, token } = gwEnv();
  let seen;
  const res = await withFetch(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); }, () =>
    post(env, token, { model: "og/mimo-v2.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/chat/completions");
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-og");
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "mimo-v2.5");
  assert.equal(sent.stream, false);
  const body = await res.json();
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "ok");
});

test("og image request forwards the preprocessed body (described, no raw image)", async () => {
  const { env, token } = gwEnv();
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    if (calls.length === 1) {
      // describeImage → og/mimo-v2.5 vision model (translate)
      return new Response(JSON.stringify({ choices: [{ message: { content: "a screenshot" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }, () =>
    post(env, token, {
      model: "og/deepseek-v4-flash", max_tokens: 10, stream: false,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }] }],
    }),
  );
  assert.equal(calls.length, 2); // describe + main
  const main = calls[1];
  assert.equal(main.url, "https://opencode.ai/zen/go/v1/chat/completions");
  const auth = main.headers.get ? main.headers.get("authorization") : main.headers.Authorization;
  assert.equal(auth, "Bearer sk-og");
  const content = main.body.messages[0].content;
  assert.ok(content.every((b) => b.type !== "image"), "image must be described before native passthrough");
  assert.ok(content.some((b) => b.type === "text" && b.text.includes("a screenshot")), "described text present");
  assert.equal(main.body.model, "deepseek-v4-flash");
});

// ── count_tokens for og (translate route estimates, never hits upstream) ──

test("og count_tokens estimates without any upstream call", async () => {
  const { env, token } = gwEnv();
  let calls = 0;
  const res = await withFetch(async () => { calls++; return new Response("{}", { status: 200 }); }, () =>
    post(env, token, { model: "og/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }, "/v1/messages/count_tokens"),
  );
  assert.equal(calls, 0); // translate route never hits upstream for count_tokens
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Number.isInteger(body.input_tokens) && body.input_tokens > 0);
});

test("ds count_tokens also estimates locally (no per-turn upstream round-trip)", async () => {
  const { env, token } = gwEnv();
  let calls = 0;
  const res = await withFetch(async () => { calls++; return new Response("{}", { status: 200 }); }, () =>
    post(env, token, { model: "ds/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }, "/v1/messages/count_tokens"),
  );
  assert.equal(calls, 0); // all channels estimate locally since 2026-08-12
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Number.isInteger(body.input_tokens) && body.input_tokens > 0);
});

// round-502 (coverage-driven): the count_tokens keyless guards had ZERO
// pins (only the keyed happy paths were covered).
test("count_tokens without the user's own key → 502, no estimate leaks", async () => {
  const { env, a } = isoEnv({ aKeys: { DEEPSEEK_API_KEY: undefined, QWEN_API_KEY: undefined } });
  const cases = [
    ["ds/deepseek-v4-flash", /DEEPSEEK_API_KEY not configured/],
    ["qw/qwen3.8-max-preview", /QWEN_API_KEY not configured/],
    ["amd/DeepSeek-V4-Flash", /AMD_API_KEY not configured/],
  ];
  await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    async () => {
      for (const [model, re] of cases) {
        const res = await post(env, a.token, { model, messages: [{ role: "user", content: "hi" }] }, "/v1/messages/count_tokens");
        assert.equal(res.status, 502, model);
        assert.match((await res.json()).error.message, re, model);
      }
    },
  );
});

// ── reliability on the translate path ──────────────────────────

// A fetch that hangs until the caller's AbortController fires — like a real
// fetch would (a bare `new Promise(() => {})` never settles and would leave the
// event loop idle).
const never = (url, init) => new Promise((_, reject) => {
  init?.signal?.addEventListener("abort", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    reject(e);
  });
});

test("og translate timeout: 502, counts 1 failure but does NOT trip (needs 3 within window)", async () => {
  const trips = [];
  const { env, token } = gwEnv({ trips });
  const res = await withFetch(never, () =>
    post(env, token, { model: "og/mimo-v2.5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /timeout/);
  // A timeout is recorded (blackholed channels hang instead of erroring) but
  // a single one never trips — the BreakerDO needs 3 within 10 minutes.
  assert.equal(trips.length, 1);
});

test("og translate network error: 502 and counts a breaker failure (1 of 3)", async () => {
  const trips = [];
  const { env, token } = gwEnv({ trips });
  const res = await withFetch(async () => { throw new TypeError("fetch failed"); }, () =>
    post(env, token, { model: "og/mimo-v2.5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /network error/);
  assert.equal(trips.length, 1); // one failure recorded — the DO opens only at 3
});

test("og translate success resets the breaker failure count", async () => {
  const trips = [];
  const resets = [];
  const { env, token } = gwEnv({ trips });
  // Track /reset calls on the breaker stub.
  env.BREAKER.get = () => ({
    fetch: async (req) => {
      const u = typeof req === "string" ? req : String(req?.url || "");
      if (u.endsWith("/trip")) trips?.push(u);
      if (u.endsWith("/reset")) resets.push(u);
      return new Response("0");
    },
  });
  let n = 0;
  const res = await withFetch(async () => (++n, new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } })), () =>
    post(env, token, { model: "og/mimo-v2.5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 200);
  assert.equal(trips.length, 0);
  assert.equal(resets.length, 1); // success → count reset
});

test("og translate fast 500: NOT retried (billable POST), 500 passthrough, breaker NOT tripped", async () => {
  const trips = [];
  const { env, token } = gwEnv({ trips, timeout: 1000 });
  let n = 0;
  const res = await withFetch(async () => (++n, new Response("boom", { status: 500 })), () =>
    post(env, token, { model: "og/mimo-v2.5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(n, 1); // single attempt — re-sending would double-bill
  assert.equal(trips.length, 0);
  // round-116: the status is now preserved (was hardcoded 502) so the client
  // can distinguish 5xx/429 and back off properly.
  assert.equal(res.status, 500);
});

// ── ds passthrough retries (absorb fast 5xx/429, never slow failures) ──

test("ds passthrough: 500 → NOT retried (billable POST), single attempt", async () => {
  const { env, token } = gwEnv({ timeout: 1000 });
  let n = 0;
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return ++n, new Response("boom", { status: 500 });
  }, () =>
    post(env, token, { model: "ds/deepseek-v4-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(n, 1); // single attempt — re-sending would double-bill
  assert.equal(res.status, 500);
  assert.equal(seen.url, "https://api.deepseek.com/anthropic/v1/messages");
});

test("ds passthrough: 500 → upstream status passed through, single attempt", async () => {
  const { env, token } = gwEnv({ timeout: 1000 });
  let n = 0;
  const res = await withFetch(async () => (++n, new Response(JSON.stringify({ error: { message: "upstream busy" } }), { status: 500, headers: { "content-type": "application/json" } })), () =>
    post(env, token, { model: "ds/deepseek-v4-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(n, 1);
  assert.equal(res.status, 500); // ds passthrough surfaces the upstream status
});

// ── Error paths: bad token / missing key / og translate retry exhaustion ──

test("bad gateway token → 401", async () => {
  const { env } = gwEnv();
  const res = await post(env, "tok-bogus", { model: "ds/deepseek-v4-flash", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 401);
});

test("og translate: missing OPENCODE_GO_API_KEY → 502 config_error", async () => {
  const { env, token } = gwEnv({ keys: { OPENCODE_GO_API_KEY: undefined } });
  const res = await withFetch(async () => { throw new Error("must not be called"); }, () =>
    post(env, token, { model: "og/mimo-v2.5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error.message, /OPENCODE_GO_API_KEY not configured/);
});

test("og-native passthrough: missing OPENCODE_GO_API_KEY → 502 config_error (not bare Upstream 401)", async () => {
  const { env, token } = gwEnv({ keys: { OPENCODE_GO_API_KEY: undefined } });
  const res = await withFetch(async () => { throw new Error("must not be called"); }, () =>
    post(env, token, { model: "og/deepseek-v4-flash", max_tokens: 1, stream: false, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error.message, /OPENCODE_GO_API_KEY not configured/);
});

test("og translate: 500 → 500 single attempt (billable POST not retried)", async () => {
  const trips = [];
  const { env, token } = gwEnv({ trips, timeout: 1000 });
  let n = 0;
  const res = await withFetch(async () => (++n, new Response(JSON.stringify({ error: { message: "upstream busy" } }), { status: 500, headers: { "content-type": "application/json" } })), () =>
    post(env, token, { model: "og/mimo-v2.5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(n, 1); // single attempt — re-sending would double-bill
  // round-116: status preserved (was 502).
  assert.equal(res.status, 500);
  assert.equal(trips.length, 0); // fast 5xx must not trip the breaker
});

test("ds passthrough: timeout → 502 single attempt, no retry (slow ≠ flaky)", async () => {
  const trips = [];
  const { env, token } = gwEnv({ trips, timeout: 50 });
  const res = await withFetch(never, () =>
    post(env, token, { model: "ds/deepseek-v4-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /timeout/);
  assert.equal(trips.length, 0);
});

// ── web_search on an og model ──────────────────────────────────

test("og web_search: forced to deepseek-v4-flash native (translate models can't search)", async () => {
  const { env, token } = gwEnv();
  const calls = [];
  const res = await withFetch(async (url, init) => {
    calls.push(String(url));
    // A web_search request on ANY og model is forced to the native
    // /v1/messages passthrough with model=deepseek-v4-flash — the only model
    // zen implements web_search for (verified 2026-08-13).
    assert.equal(String(url), "https://opencode.ai/zen/go/v1/messages");
    const sent = JSON.parse(String(init.body));
    assert.equal(sent.model, "deepseek-v4-flash");
    return new Response(JSON.stringify({
      type: "message",
      content: [{ type: "server_tool_use", name: "web_search", input: { query: "what's new" } },
                { type: "text", text: "search answer" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () =>
    post(env, token, {
      model: "og/mimo-v2.5", max_tokens: 100, stream: false,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "tool", name: "web_search" },
      messages: [{ role: "user", content: "query: what's new" }],
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(res.status, 200);
  const body = await res.json();
  const text = body.content.find((b) => b.type === "text");
  assert.equal(text.text, "search answer");
});

// round-490 (coverage-driven): the single-web_search auto-tool_choice arm
// had ZERO pins (the explicit-choice path was covered above).
test("og web_search: lone search tool without tool_choice gets it injected", async () => {
  const { env, token } = gwEnv();
  let sent;
  await withFetch(async (url, init) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "search answer" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () =>
    post(env, token, {
      model: "og/mimo-v2.5", max_tokens: 100, stream: false,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: "query: what's new" }],
    }),
  );
  assert.deepEqual(sent.tool_choice, { type: "tool", name: "web_search" });
});

// round-507 (coverage-driven): the tool_choice:"any" web_search variant had
// ZERO pins (only type:"tool" + the lone-tool auto-inject were covered).
test("og web_search: explicit any-choice with a search tool forces the search model", async () => {
  const { env, token } = gwEnv();
  let sent;
  await withFetch(async (url, init) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "search answer" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () =>
    post(env, token, {
      model: "og/mimo-v2.5", max_tokens: 100, stream: false,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "any", tools: [{ name: "web_search" }] },
      messages: [{ role: "user", content: "query: what's new" }],
    }),
  );
  assert.equal(sent.model, "deepseek-v4-flash");
});

// ── scanTopLevelModel / rawWithModel (CPU-safe model extraction) ──

test("scanTopLevelModel: extracts top-level model", () => {
  const raw = JSON.stringify({ model: "og/deepseek-v4-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  const { model } = scanTopLevelModel(raw);
  assert.equal(model, "og/deepseek-v4-flash");
});

test("scanTopLevelModel: ignores model inside messages content", () => {
  const raw = JSON.stringify({ max_tokens: 5, messages: [{ role: "user", content: "hi", model: "inside" }] });
  assert.equal(scanTopLevelModel(raw).model, null);
});

test("scanTopLevelModel: ignores model in nested tool_use input", () => {
  const raw = JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "tool_use", input: { model: "x" } }] }] });
  assert.equal(scanTopLevelModel(raw).model, null);
});

test("scanTopLevelModel: model-like string inside escaped content", () => {
  const raw = '{"model":"auto","messages":[{"content":"\\"model\\":\\"x\\""}]}';
  const { model } = scanTopLevelModel(raw);
  assert.equal(model, "auto");
});

test("scanTopLevelModel: no model field → null", () => {
  assert.equal(scanTopLevelModel("{}").model, null);
});

test("rawWithModel: swaps only the top-level model value", () => {
  const raw = JSON.stringify({ model: "ds/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });
  const out = rawWithModel(raw, "qw/qwen3.8-max-preview");
  const parsed = JSON.parse(out);
  assert.equal(parsed.model, "qw/qwen3.8-max-preview");
  assert.equal(parsed.messages.length, 1);
});

test("rawWithModel: missing model returns body unchanged", () => {
  const raw = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(rawWithModel(raw, "qw/qwen"), raw);
});

test("estimateTokens: large body approximates instead of walking", () => {
  // A 2M-char body must not be char-walked (Free plan CPU budget) — the
  // approximation path returns a positive estimate quickly.
  const big = "x".repeat(2_000_000);
  assert.ok(estimateTokens(big) > 0);
});

test("estimateTokens: base64 images counted per-image, not as text (round-57)", () => {
  // A 1.3MB base64 screenshot: the old code charged it as ~440k text tokens
  // (~280x). It must be ~1600 (real vision cost) + small text overhead.
  const img = "A".repeat(1_300_000); // ~1.3MB base64
  const body = JSON.stringify({ model: "ds", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: img } }] }] });
  const est = estimateTokens(body);
  assert.ok(est < 10_000, `image body estimated too high: ${est}`);
  assert.ok(est >= 1600, `image body underestimated: ${est}`);
});

test("estimateTokens: large body with images outside the 2MB window", () => {
  // Windowed body: 2MB of text + a 1.3MB image beyond the sampled window.
  // The image must still be charged per-image (~1600), not as text.
  const text = "t".repeat(2_000_000);
  const img = "B".repeat(1_300_000);
  const body = JSON.stringify({ model: "ds", messages: [{ role: "user", content: text }, { role: "user", content: [{ type: "image", source: { type: "base64", data: img } }] }] });
  const est = estimateTokens(body);
  // 2M chars text ≈ 500k tokens + 1600 per image (allow generous margin).
  assert.ok(est < 700_000, `windowed image body estimated too high: ${est}`);
  assert.ok(est > 400_000, `windowed text underestimated: ${est}`);
});

test("scanTopLevelModel: model after system/tools (Claude Code field order)", () => {
  // Claude Code sends system + tools BEFORE model — the scanner must not let
  // earlier fields break top-level key detection (regression: model → null,
  // request silently routed to the default ds channel).
  const raw = JSON.stringify({
    system: [{ type: "text", text: "You are a coding agent." }],
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    model: "og/deepseek-v4-flash",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(scanTopLevelModel(raw).model, "og/deepseek-v4-flash");
  const out = rawWithModel(raw, "ds/deepseek-v4-flash");
  assert.equal(JSON.parse(out).model, "ds/deepseek-v4-flash");
});

// ── rawWithTopLevelField (round-396: string-surgery injectors had zero
// direct tests — only indirect translate-handler exercise) ──

test("rawWithTopLevelField: replaces an existing string value, keeps the rest", () => {
  const raw = JSON.stringify({ model: "a", stream: false, messages: [] });
  const out = JSON.parse(rawWithTopLevelField(raw, "model", "b"));
  assert.equal(out.model, "b");
  assert.equal(out.stream, false);
  assert.deepEqual(out.messages, []);
});

test("rawWithTopLevelField: replaces an object value wholesale", () => {
  const raw = JSON.stringify({ reasoning: { effort: "low" }, model: "a" });
  const out = JSON.parse(rawWithTopLevelField(raw, "reasoning", { effort: "max" }));
  assert.deepEqual(out.reasoning, { effort: "max" });
  assert.equal(out.model, "a");
});

test("rawWithTopLevelField: appends with comma / bare-brace separator", () => {
  assert.deepEqual(JSON.parse(rawWithTopLevelField("{}", "a", 1)), { a: 1 });
  assert.deepEqual(JSON.parse(rawWithTopLevelField('{"x":1}', "a", 1)), { x: 1, a: 1 });
  assert.deepEqual(JSON.parse(rawWithTopLevelField('{ "x" : 1 } ', "a", 1)), { x: 1, a: 1 });
});

test("rawWithTopLevelField: nested same-name fields untouched", () => {
  const raw = JSON.stringify({ model: "top", messages: [{ model: "nested" }] });
  const out = JSON.parse(rawWithTopLevelField(raw, "model", "new"));
  assert.equal(out.model, "new");
  assert.equal(out.messages[0].model, "nested");
});

test("rawWithTopLevelField: field name inside a string value is not a match", () => {
  const raw = JSON.stringify({ messages: [{ content: '"reasoning":{}' }] });
  const out = JSON.parse(rawWithTopLevelField(raw, "reasoning", { effort: "max" }));
  assert.deepEqual(out.reasoning, { effort: "max" });
  assert.equal(out.messages[0].content, '"reasoning":{}');
});

test("rawWithTopLevelField: non-object body returns unchanged", () => {
  assert.equal(rawWithTopLevelField("not json", "a", 1), "not json");
  assert.equal(rawWithTopLevelField("[1,2]", "a", 1), "[1,2]");
});

test("rawWithDeepSeekProvider / rawWithOxAlphaReasoningDefault shapes", () => {
  const p = JSON.parse(rawWithDeepSeekProvider(JSON.stringify({ model: "ds" })));
  assert.deepEqual(p.provider, { order: ["deepseek"], allow_fallbacks: false });
  const r = JSON.parse(rawWithOxAlphaReasoningDefault(JSON.stringify({ model: "ox" })));
  assert.deepEqual(r.reasoning, { effort: "max" });
  // client-sent reasoning respected as-is (not overridden to max)
  const keep = JSON.stringify({ reasoning: { effort: "low" } });
  assert.equal(rawWithOxAlphaReasoningDefault(keep), keep);
});

// ── F1 coverage: /v1/chat/completions per-token limiter ─────────────────
// The limiter shipped with ZERO test coverage. Drive 49 calls with one
// token; the 49th must 429. Module-level Maps persist across tests, so
// each test uses a unique token (gwEnv's uid) for a clean bucket.
test("chat/completions: per-token limiter trips at ~60/min (F1 coverage)", async () => {
  const now = 1785000000000;
  const realDateNow = Date.now;
  Date.now = () => now;
  const { env, token } = gwEnv();
  try {
    await withFetch(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      async () => {
        for (let i = 0; i < 48; i++) {
          const r = await post(env, token, { model: "og/deepseek-v4-flash", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, "/v1/chat/completions");
          assert.equal(r.status, 200, `call ${i + 1} should pass`);
        }
        const limited = await post(env, token, { model: "og/deepseek-v4-flash", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, "/v1/chat/completions");
        assert.equal(limited.status, 429, "49th call within the minute must be rate-limited");
      },
    );
  } finally {
    Date.now = realDateNow;
  }
});

// ── Per-user key isolation (multi-user BYOK core property, round-360) ──
// translate.ts resolves the caller by x-api-key and spends THAT user's
// ukeys. These tests pin the property with two live users: a regression
// that mixed the key lookup up would let alice spend bob's quota (and bill
// side-effects to the wrong account). Distinct tokens per test: store.ts
// keeps a module-level cache AND the F1 limiter holds per-token buckets,
// so token reuse across tests would cross-contaminate.
let isoSeq = 0;
function isoEnv({ aKeys = {}, bKeys = {}, aEnabled = true } = {}) {
  const mk = (tag, ogKey, enabled) => {
    const uid = `iso-${tag}-${++isoSeq}`;
    const token = `tok-${uid}`;
    return {
      uid,
      token,
      userRec: { id: uid, username: uid, role: "user", enabled, token },
      ukeys: {
        DEEPSEEK_API_KEY: "sk-ds",
        OPENCODE_GO_API_KEY: ogKey,
        OPENROUTER_API_KEY: "sk-or",
        QWEN_API_KEY: "sk-qw",
      },
    };
  };
  const a = mk("a", "sk-og-ALICE", aEnabled);
  const b = mk("b", "sk-og-BOB", true);
  Object.assign(a.ukeys, aKeys);
  Object.assign(b.ukeys, bKeys);
  const kv = new Map();
  for (const u of [a, b]) {
    kv.set(`token:${u.token}`, u.uid);
    kv.set(`user:${u.uid}`, JSON.stringify(u.userRec));
    kv.set(`ukeys:${u.uid}`, JSON.stringify(u.ukeys));
  }
  const breaker = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () => new Response("0"),
    }),
  };
  const routeStore = new Map();
  const routeDo = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async (req, init) => {
        const method = init?.method || "GET";
        const url = new URL(typeof req === "string" ? req : req.url);
        if (method === "GET") {
          return new Response(
            JSON.stringify({ model: routeStore.get(url.searchParams.get("uid")) || null }),
          );
        }
        return new Response(JSON.stringify({ ok: true }));
      },
    }),
  };
  return {
    env: {
      KEYS: {
        get: async (k) => (kv.has(k) ? kv.get(k) : null),
        put: async () => {},
        delete: async () => {},
      },
      BREAKER: breaker,
      ROUTE: routeDo,
    },
    a,
    b,
  };
}

const ogBody = () => ({
  model: "og/deepseek-v4-flash",
  max_tokens: 10,
  stream: false,
  messages: [{ role: "user", content: "hi" }],
});
const okChoices = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const upstreamAuth = (seen) =>
  seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;

test("per-user isolation: alice's og call carries alice's key", async () => {
  const { env, a } = isoEnv();
  let seen;
  const res = await withFetch(
    async (url, init) => {
      seen = { url, init };
      return okChoices();
    },
    () => post(env, a.token, ogBody()),
  );
  assert.equal(res.status, 200);
  assert.equal(upstreamAuth(seen), "Bearer sk-og-ALICE", "must spend the CALLER's key");
});

test("per-user isolation: bob's og call carries bob's key (same model, same minute)", async () => {
  const { env, b } = isoEnv();
  let seen;
  const res = await withFetch(
    async (url, init) => {
      seen = { url, init };
      return okChoices();
    },
    () => post(env, b.token, ogBody()),
  );
  assert.equal(res.status, 200);
  assert.equal(upstreamAuth(seen), "Bearer sk-og-BOB", "must spend the CALLER's key");
});

test("per-user isolation: alice without a key gets 502 even though bob has one (no borrowing)", async () => {
  // JSON.stringify drops undefined values — alice genuinely has no og key.
  const { env, a } = isoEnv({ aKeys: { OPENCODE_GO_API_KEY: undefined } });
  const stored = JSON.parse((await env.KEYS.get(`ukeys:${a.uid}`)) || "{}");
  assert(!stored.OPENCODE_GO_API_KEY, "precondition: alice has no og key");
  const res = await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    () => post(env, a.token, ogBody()),
  );
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error?.message || JSON.stringify(body), /OPENCODE_GO_API_KEY not configured/);
});

test("disabled user → 401 on translate, upstream never called", async () => {
  const { env, a } = isoEnv({ aEnabled: false });
  const res = await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    () => post(env, a.token, ogBody()),
  );
  assert.equal(res.status, 401);
});

// round-485 (coverage-driven): the unknown-/v1/-path 404 arm had ZERO pins.
test("POST /v1/<unknown> with a valid token → 404, upstream never called", async () => {
  const { env, token } = gwEnv();
  const res = await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    () => post(env, token, { model: "og/deepseek-v4-flash", messages: [] }, "/v1/nope"),
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.type, "not_found_error");
});

// round-488 (coverage-driven): the or/ keyless 502 arm had ZERO pins.
test("or/ without the user's own key → 502, upstream never called", async () => {
  const { env, a } = isoEnv({ aKeys: { OPENROUTER_API_KEY: undefined } });
  const res = await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    () => post(env, a.token, { ...ogBody(), model: "or/openai/gpt-5.6-luna:floor[1m]" }),
  );
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /OPENROUTER_API_KEY not configured/);
});

// round-496 (coverage-driven): the nv/gmi/amd/cm keyless 502 arms had ZERO
// pins (isoEnv users carry none of those keys by default).
// round-504 correction: the cm case pins the shared PRE-BRANCH guard — the
// translate-path cm arm is shadowed by it (same !cmdKey) and unreachable.
test("nv/gmi/amd/cm without the user's own key → 502, upstream never called", async () => {
  const { env, a } = isoEnv();
  const cases = [
    ["nv/nvidia/nemotron-3-ultra-550b-a55b", /NVAPI_KEY not configured/],
    ["gmi/MiniMaxAI/MiniMax-M3", /GMI_API_KEY not configured/],
    ["amd/DeepSeek-V4-Flash", /AMD_API_KEY not configured/],
    ["cm/deepseek/deepseek-v4-flash", /CMD_API_KEY not configured/],
  ];
  await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    async () => {
      for (const [model, re] of cases) {
        const res = await post(env, a.token, { ...ogBody(), model });
        assert.equal(res.status, 502, model);
        assert.match((await res.json()).error.message, re, model);
      }
    },
  );
});

// round-497 (coverage-driven): the upstream retry-after passthrough arm had
// ZERO pins (extra rides as a response header, not the body — and only the
// /v1/chat/completions branch passes it; the /v1/messages branch does not).
// NOTE: the inspectFailure-status arms nearby are defensive-only — no
// translate call site passes inspect, so the 502 default always applies.
test("og chat/completions: upstream 429 retry-after surfaces as a response header", async () => {
  const { env, token } = gwEnv();
  const res = await withFetch(async () => new Response(JSON.stringify({
    error: { message: "slow down", type: "rate_limit_error" },
  }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } }), () =>
    post(env, token, { model: "og/deepseek-v4-flash", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, "/v1/chat/completions"),
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "1");
  assert.equal((await res.json()).error.type, "rate_limit_error");
});

// round-499 (coverage-driven): the ds/qw passthrough keyless 502 arms had
// ZERO pins.
test("ds/qw passthrough without the user's own key → 502, upstream never called", async () => {
  const { env, a } = isoEnv({ aKeys: { DEEPSEEK_API_KEY: undefined, QWEN_API_KEY: undefined } });
  const cases = [
    ["ds/deepseek-v4-flash", /DEEPSEEK_API_KEY not configured/],
    ["qw/qwen3.8-max-preview", /QWEN_API_KEY not configured/],
  ];
  await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    async () => {
      for (const [model, re] of cases) {
        const res = await post(env, a.token, { ...ogBody(), model });
        assert.equal(res.status, 502, model);
        assert.match((await res.json()).error.message, re, model);
      }
    },
  );
});

// round-500 (REAL FIND): the translate-path og-key guard was unscoped — a
// cm/ request with a valid CMD key but no og key 502'd on an unrelated
// credential (the branch only ever sends cmdKey). Scoped to opencode kind.
test("cm/ with CMD key but no og key reaches the upstream (no og-key gate)", async () => {
  const { env, a } = isoEnv({ aKeys: { CMD_API_KEY: "sk-cm", OPENCODE_GO_API_KEY: undefined } });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url: String(url), init };
    return okChoices();
  }, () => post(env, a.token, { ...ogBody(), model: "cm/deepseek/deepseek-v4-flash" }));
  assert.equal(res.status, 200);
  const auth = seen.init.headers.get ? seen.init.headers.get("authorization") : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-cm", "cm translate sends the CMD key, not an og key");
  assert.equal((await res.json()).content[0].text, "ok");
});

// round-501 (coverage-driven): the translate-path circuit-open arm had ZERO
// pins (only the passthrough-branch breaker test existed).
test("og translate with an open breaker fails fast (502), upstream never called", async () => {
  const { __clearDegradedCache } = await import("../src/reliability.ts");
  __clearDegradedCache();
  const { env, token } = gwEnv({ breakerOpen: true });
  const res = await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    () => post(env, token, ogBody()),
  );
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /circuit open/);
});

// round-503 (coverage-driven): the /v1/chat/completions-path keyless guards
// had ZERO pins — rounds 488/496/499 only exercised the /v1/messages ladder.
// Same arms, OpenAI-format body on the chat path.
// round-504 correction: the cm/or cases pin the shared PRE-BRANCH guards —
// the chat-path cm arm doesn't exist and the or arm is shadowed (same var).
test("chat/completions without the user's own key → 502, upstream never called", async () => {
  const { env, a } = isoEnv({ aKeys: { DEEPSEEK_API_KEY: undefined, QWEN_API_KEY: undefined, OPENROUTER_API_KEY: undefined } });
  const cases = [
    ["nv/nvidia/nemotron-3-ultra-550b-a55b", /NVAPI_KEY not configured/],
    ["gmi/MiniMaxAI/MiniMax-M3", /GMI_API_KEY not configured/],
    ["amd/DeepSeek-V4-Flash", /AMD_API_KEY not configured/],
    ["cm/deepseek/deepseek-v4-flash", /CMD_API_KEY not configured/],
    ["ds/deepseek-v4-flash", /DEEPSEEK_API_KEY not configured/],
    ["qw/qwen3.8-max-preview", /QWEN_API_KEY not configured/],
    ["or/openai/gpt-5.6-luna:floor[1m]", /OPENROUTER_API_KEY not configured/],
  ];
  await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    async () => {
      for (const [model, re] of cases) {
        const res = await post(env, a.token, { model, messages: [{ role: "user", content: "hi" }] }, "/v1/chat/completions");
        assert.equal(res.status, 502, model);
        assert.match((await res.json()).error.message, re, model);
      }
    },
  );
});

// round-503b: the two remaining reachable chat-path arms — og keyless +
// og breaker-open. NOTE: the chat-path openrouter arm is defensive-only:
// the pre-branch or/ guard (same openRouterKey) always fires first.
test("chat/completions og keyless and breaker-open → 502, upstream never called", async () => {
  const { __clearDegradedCache } = await import("../src/reliability.ts");
  const chatBody = (model) => ({ model, messages: [{ role: "user", content: "hi" }] });
  await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    async () => {
      const { env, a } = isoEnv({ aKeys: { OPENCODE_GO_API_KEY: undefined } });
      const keyless = await post(env, a.token, chatBody("og/deepseek-v4-flash"), "/v1/chat/completions");
      assert.equal(keyless.status, 502);
      assert.match((await keyless.json()).error.message, /OPENCODE_GO_API_KEY not configured/);

      __clearDegradedCache();
      const { env: env2, token } = gwEnv({ breakerOpen: true });
      const open = await post(env2, token, chatBody("og/deepseek-v4-flash"), "/v1/chat/completions");
      assert.equal(open.status, 502);
      assert.match((await open.json()).error.message, /circuit open/);
    },
  );
});

// round-505 (coverage-driven): the invalid-JSON 502 arm had ZERO pins —
// it needs stream:true with a JSON (non-SSE) upstream body, not stream:false.
test("og translate stream:true, upstream 200 with garbage JSON → 502 invalid JSON", async () => {
  const { __clearDegradedCache } = await import("../src/reliability.ts");
  __clearDegradedCache();
  const { env, token } = gwEnv();
  const res = await withFetch(async () => new Response("not json{{{", {
    status: 200, headers: { "content-type": "application/json" },
  }), () => post(env, token, { ...ogBody(), stream: true }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /upstream returned invalid JSON/);
});

// round-506 (coverage-driven): the developer→system role normalization had
// ZERO pins (zen/go rejects the developer role with [1214]).
test("og chat/completions: developer role is normalized to system upstream", async () => {
  const { env, token } = gwEnv();
  let sent;
  const res = await withFetch(async (url, init) => {
    sent = JSON.parse(init.body);
    return okChoices();
  }, () => post(env, token, {
    model: "og/deepseek-v4-flash",
    messages: [
      { role: "developer", content: "be brief" },
      { role: "user", content: "hi" },
    ],
  }, "/v1/chat/completions"));
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(sent.messages).includes('"developer"'));
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.messages[0].content, "be brief");
});

// round-508 (coverage-driven): the model=auto resolution arm had ZERO pins.
test('model "auto" resolves to the first usable channel (ds) and serves', async () => {
  const { env, token } = gwEnv();
  let sent;
  const res = await withFetch(async (url, init) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "auto ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, { model: "auto", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(res.status, 200);
  assert.equal(sent.model, "deepseek-v4-flash");
  assert.equal((await res.json()).content[0].text, "auto ok");
});

// round-509 (coverage-driven): the passthrough needsParse-true arm had ZERO
// pins (og translate tests take the else arm; only a passthrough route with
// a web_search/image trigger parses).
test("ds passthrough with web_search tools parses the body and forwards", async () => {
  const { env, token } = gwEnv();
  let sent;
  const res = await withFetch(async (url, init) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "ds search ok" }],
      usage: { input_tokens: 3, output_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "ds/deepseek-v4-flash", max_tokens: 8,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: "search this" }],
  }));
  assert.equal(res.status, 200);
  assert.equal(sent.model, "deepseek-v4-flash");
  assert.equal((await res.json()).content[0].text, "ds search ok");
});

// round-510 (coverage-driven): the ox-alpha-free reasoning default had ZERO
// pins (mirrors the or/ rule on the translate path).
test("og ox-alpha-free without client reasoning gets effort=max upstream", async () => {
  const { env, token } = gwEnv();
  let sent;
  const res = await withFetch(async (url, init) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ox ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, { model: "og/ox-alpha-free", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(res.status, 200);
  assert.deepEqual(sent.reasoning, { effort: "max" });
});

// round-511 (coverage-driven): the chat-path non-JSON error arm had ZERO
// pins (the amd 429 test covers the JSON envelope variant).
test("og chat/completions: upstream 500 with a text body keeps status + default message", async () => {
  const { env, token } = gwEnv({ timeout: 1000 });
  const res = await withFetch(async () => new Response("boom", { status: 500 }), () =>
    post(env, token, { model: "og/deepseek-v4-flash", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, "/v1/chat/completions"),
  );
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.message, "Upstream 500");
  assert.equal(body.error.type, "api_error");
});

// round-512 (REAL FIND): the passthrough !ok arm had no status-based 429
// default — a non-JSON 429 collapsed to api_error (give up) instead of
// rate_limit_error (back off). One-line parity fix with the chat + og arms.
// Self-caught×2: og failures take the translate branch; fast 500s aren't
// retried — a retried ds 429 reaches this arm.
test("ds passthrough: retried 429 with a text body keeps status + rate_limit type", async () => {
  const { env, token } = gwEnv({ timeout: 1000 });
  const res = await withFetch(async () => new Response("slow down", { status: 429 }), () =>
    post(env, token, { model: "ds/deepseek-v4-flash", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.message, "Upstream 429");
  assert.equal(body.error.type, "rate_limit_error");
});

// round-513 (coverage-driven): the nv/gmi non-JSON error arm had ZERO pins
// (the round-498 test covers the JSON envelope variant). A 400 is not
// retried, so the test stays fast.
test("nv translate: upstream 400 with a text body keeps status, no retry", async () => {
  __clearCaches();
  const { env, token } = gwEnv({ keys: { NVAPI_KEY: "sk-nv" } });
  let calls = 0;
  const res = await withFetch(async () => (++calls, new Response("bad request", { status: 400 })), () =>
    post(env, token, {
      model: "nv/minimaxai/minimax-m3",
      max_tokens: 8,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(calls, 1);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /nvidia: upstream 400/);
});

// round-514 (coverage-driven): the responses-path og keyless + breaker arms
// had ZERO pins (rounds 495/501/503b covered other paths/arms).
test("/v1/responses muse-spark keyless and breaker-open → 502, upstream never called", async () => {
  const { __clearDegradedCache } = await import("../src/reliability.ts");
  const respBody = { model: "og/muse-spark-1.3-contributor", input: "hi", max_output_tokens: 10 };
  await withFetch(
    async () => {
      throw new Error("must not be called");
    },
    async () => {
      const { env, a } = isoEnv({ aKeys: { OPENCODE_GO_API_KEY: undefined } });
      const keyless = await post(env, a.token, respBody, "/v1/responses");
      assert.equal(keyless.status, 502);
      assert.match((await keyless.json()).error.message, /OPENCODE_GO_API_KEY not configured/);

      __clearDegradedCache();
      const { env: env2, token } = gwEnv({ breakerOpen: true });
      const open = await post(env2, token, respBody, "/v1/responses");
      assert.equal(open.status, 502);
      assert.match((await open.json()).error.message, /circuit open/);
    },
  );
});
