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
import { scanTopLevelModel, rawWithModel, estimateTokens } from "../src/body-scan.ts";
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
