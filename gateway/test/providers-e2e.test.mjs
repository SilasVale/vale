// Custom PROVIDERS end to end, through the REAL dispatcher and the REAL /v1
// request path.
//
// `providers-store.test.mjs` covers the registry and the resolution ORDER in
// isolation. This covers what that cannot:
//
//   * the three admin routes are WIRED and a session is REQUIRED for every one
//     of them (a previous round shipped an unauthenticated admin surface by
//     omitting requireAdmin, so each route is pinned here the same way
//     model-catalogue-e2e.test.mjs pins the model handlers);
//   * a custom provider's models actually SERVE requests — the URL the request
//     goes to, the model name the upstream is asked for, and WHICH KEY rides it
//     (the operator's, never the requesting user's BYOK keys);
//   * what a client and the console SEE: /v1/models, the console catalogue, and
//     the deliberate absence from /api/health.
import test from "node:test";
import assert from "node:assert/strict";
import { issueSessionToken, SESSION_COOKIE } from "../src/auth.ts";
import { makeEnv, withFetch, assertFetchCalls } from "./helpers.mjs";
import { createPluginContext, registerPlugins, dispatch } from "../src/plugins/registry.ts";
import { buildHealth } from "../src/tooling.ts";
import { dropProviderCache } from "../src/store/providers.ts";

const PW = "e2e-admin-password";
const ADMIN_ID = "admin";
const USER_ID = "u1";
const USER_TOKEN = "tok-u1";
const PROVIDER_KEY = "sk-provider-key-99887766";
const KEY_ENV = "MY_PROVIDER_KEY";

/** Every plugin that owns a route these tests touch. */
async function harness(extraKv = {}, extraEnv = {}) {
  const env = makeEnv({
    users: {
      [ADMIN_ID]: { id: ADMIN_ID, username: "admin", role: "admin", enabled: true, token: "" },
      [USER_ID]: { id: USER_ID, username: "user", role: "user", enabled: true, token: USER_TOKEN },
    },
    kv: {
      "auth:admin_password": PW,
      _admin_seeded: "1",
      [`token:${USER_TOKEN}`]: USER_ID,
      [`ukeys:${USER_ID}`]: {
        DEEPSEEK_API_KEY: "sk-ds",
        OPENCODE_GO_API_KEY: "sk-og",
        OPENROUTER_API_KEY: "sk-or",
      },
      ...extraKv,
    },
    extra: extraEnv,
  });
  const ctx = createPluginContext(env);
  await registerPlugins(ctx, [
    (await import("../src/plugins/admin.ts")).default,
    (await import("../src/plugins/auth.ts")).default,
    (await import("../src/plugins/translate.ts")).default,
  ]);
  const cookie = await issueSessionToken(PW, ADMIN_ID, "admin");
  const call = (method, path, { auth = true, body, token = USER_TOKEN } = {}) => {
    const headers = { "content-type": "application/json" };
    if (auth) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
    else if (token) headers["x-api-key"] = token;
    const url = `https://api.saisi.online${path}`;
    const req = new Request(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return dispatch(ctx, method, path, req, env, new URL(url));
  };
  const json = async (r) => {
    assert.ok(r, "no response for a dispatched route");
    return {
      status: r.status,
      body: await r
        .clone()
        .json()
        .catch(() => null),
    };
  };
  return { env, call, json };
}

/** The body of the provider the tests register. */
function providerBody(over = {}) {
  return {
    prefix: "my/",
    label: "My Provider",
    baseURL: "https://api.example.com",
    api: "openai-completions",
    apiKey: PROVIDER_KEY,
    models: [{ id: "llama-3", contextWindow: 1000000, maxTokens: 128000 }],
    ...over,
  };
}

/** Register the provider through the ADMIN API (what an operator does). */
async function addProvider(call, json, over = {}) {
  const added = await json(await call("POST", "/api/admin/providers", { body: providerBody(over) }));
  assert.equal(added.status, 200, `provider add failed: ${JSON.stringify(added.body)}`);
  return added;
}

const openaiReply = (content = "ok") =>
  new Response(
    JSON.stringify({
      id: "cmpl-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** One outbound header off a recorded fetch init (Headers or plain object). */
function sentHeader(seen, name) {
  if (seen.init.headers instanceof Headers) return seen.init.headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(seen.init.headers || {})) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/* ---------------- the admin surface ---------------- */

test("SECURITY: every provider route refuses an unauthenticated caller", async () => {
  // The regression that matters, and it has already happened once in this
  // plugin: shipped answering 200 to anyone while every sibling admin route
  // answered 401. Pinned for the three new routes exactly like the model
  // handlers, INCLUDING the side effect: the POST body below is VALID, so an
  // unguarded handler would not merely answer 200 — it would register a
  // provider (endpoint + key) for an anonymous caller.
  const { env, call, json } = await harness();
  for (const [method, path] of [
    ["GET", "/api/admin/providers"],
    ["POST", "/api/admin/providers"],
    ["DELETE", "/api/admin/providers/my/"],
  ]) {
    const opts = { auth: false, ...(method === "GET" ? {} : { body: providerBody() }) };
    const r = await json(await call(method, path, opts));
    assert.equal(r.status, 401, `${method} ${path} answered ${r.status} with NO session`);
  }
  assert.equal(env._kv.get("providers:custom"), undefined, "an anonymous POST wrote a provider");
});

test("ADMIN: add → list → delete round-trips, and the key never comes back", async () => {
  const { env, call, json } = await harness();
  const added = await addProvider(call, json);

  assert.ok(
    !JSON.stringify(added.body).includes(PROVIDER_KEY),
    `the add response echoed the provider key: ${JSON.stringify(added.body)}`,
  );
  assert.match(String(added.body.provider.keyMasked), /…/);
  assert.equal(added.body.provider.keyReady, true);
  // The record IS stored (the masking is presentation, not omission).
  assert.ok(String(env._kv.get("providers:custom")).includes(PROVIDER_KEY));

  const listed = await json(await call("GET", "/api/admin/providers"));
  assert.equal(listed.status, 200);
  assert.equal(listed.body.providers.length, 1);
  assert.equal(listed.body.providers[0].prefix, "my/");
  assert.deepEqual(listed.body.providers[0].advertised, ["my/llama-3"]);
  assert.ok(!JSON.stringify(listed.body).includes(PROVIDER_KEY), "the list echoed the key");

  // A bare prefix (how a CLI user types it) deletes the same record.
  const del = await json(await call("DELETE", "/api/admin/providers/my"));
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.removed, "my/");
  assert.deepEqual(await json(await call("GET", "/api/admin/providers")).then((r) => r.body.providers), []);

  const again = await json(await call("DELETE", "/api/admin/providers/my/"));
  assert.equal(again.status, 404, "deleting an unknown provider did not 404");
});

test("VALIDATION: the API refuses a reserved prefix, a private host and an unsupported protocol", async () => {
  const { call, json } = await harness();
  const cases = [
    [providerBody({ prefix: "og/" }), 409, /reserved/i],
    [providerBody({ prefix: "ds/" }), 409, /reserved/i],
    [providerBody({ baseURL: "http://api.example.com" }), 400, /https/i],
    [providerBody({ baseURL: "https://127.0.0.1:8080" }), 400, /private|internal/i],
    [providerBody({ baseURL: "https://169.254.169.254" }), 400, /private|internal/i],
    [providerBody({ api: "anthropic-messages" }), 400, /openai-completions/],
    [providerBody({ apiKey: undefined, apiKeyEnv: undefined }), 400, /apiKeyEnv|apiKey/],
    [providerBody({ models: [] }), 400, /non-empty/],
  ];
  for (const [body, status, want] of cases) {
    const r = await json(await call("POST", "/api/admin/providers", { body }));
    assert.equal(r.status, status, `${JSON.stringify(body.baseURL || body.prefix)} → ${r.status}`);
    assert.match(String(r.body?.error?.message ?? ""), want, `unhelpful error: ${JSON.stringify(r.body)}`);
  }
});

/* ---------------- serving requests ---------------- */

test("ROUTING: a provider's model is served — right URL, right model, right key", async () => {
  const { call, json } = await harness();
  await addProvider(call, json);

  let seen;
  const res = await withFetch(
    async (url, init) => {
      seen = { url: String(url), init };
      return openaiReply("hello from my provider");
    },
    () =>
      call("POST", "/v1/chat/completions", {
        auth: false,
        body: { model: "my/llama-3", messages: [{ role: "user", content: "hi" }] },
      }),
  );

  assert.equal(res.status, 200, "the provider's model did not serve");
  // baseURL is a PREFIX and the dialect's path is appended (DSH's join).
  assert.equal(seen.url, "https://api.example.com/chat/completions");
  assert.equal(JSON.parse(seen.init.body).model, "llama-3", "the prefix was not stripped upstream");
  assert.equal(sentHeader(seen, "authorization"), `Bearer ${PROVIDER_KEY}`);
  // THE KEY THAT MUST NOT RIDE: the requesting user's BYOK keys. A custom
  // provider is a third-party host; sending this user's DeepSeek/OpenCode key
  // there would be a credential leak to an operator-chosen destination.
  const headers = JSON.stringify([...(seen.init.headers?.entries?.() || [])]);
  assert.ok(!headers.includes("sk-ds"), "the user's DeepSeek key was sent to the provider");
  assert.ok(!headers.includes("sk-og"), "the user's OpenCode key was sent to the provider");

  const body = await res.json();
  assert.equal(body.choices[0].message.content, "hello from my provider");
});

test("ROUTING: /v1/messages is translated onto the provider's OpenAI endpoint", async () => {
  const { call, json } = await harness();
  await addProvider(call, json);

  let seen;
  const res = await withFetch(
    async (url, init) => {
      seen = { url: String(url), init };
      return openaiReply("translated");
    },
    () =>
      call("POST", "/v1/messages", {
        auth: false,
        body: {
          model: "my/llama-3",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        },
      }),
  );

  assert.equal(res.status, 200);
  assert.equal(seen.url, "https://api.example.com/chat/completions");
  const sent = JSON.parse(seen.init.body);
  // An OpenAI body, not the Anthropic one the client sent: the existing
  // translator (toOpenAIRequest) did the reshaping — no new wire code.
  assert.equal(sent.model, "llama-3");
  assert.ok(Array.isArray(sent.messages), "the Anthropic body was forwarded untranslated");
  assert.equal(sent.messages[0].role, "user");
  assert.equal(sent.messages[0].content, "hi");
  // ...and the reply came back in Anthropic shape.
  const body = await res.json();
  assert.equal(body.content[0].text, "translated");
});

test("ROUTING: no resolvable key is a 502 that names it — never a headerless request", async () => {
  const { call, json } = await harness();
  // apiKeyEnv names a Worker secret this deployment does not bind.
  await addProvider(call, json, { apiKey: undefined, apiKeyEnv: KEY_ENV });

  const res = await withFetch(
    async () => {
      throw new Error("the gateway must not dial a provider with no key");
    },
    () =>
      call("POST", "/v1/chat/completions", {
        auth: false,
        body: { model: "my/llama-3", messages: [{ role: "user", content: "hi" }] },
      }),
  );
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.type, "config_error");
  assert.match(body.error.message, new RegExp(KEY_ENV), "the 502 does not name the missing secret: ");
  assertFetchCalls(0, "an unkeyed provider request reached the network");
});

test("ROUTING: a hand-edited record that cannot be routed is a 502, NOT the default channel", async () => {
  // The dangerous fall-through: an unknown prefix normally resolves to Command
  // Code. A record that EXISTS but is unroutable must not silently become that.
  const { call, json } = await harness({
    "providers:custom": JSON.stringify([
      {
        prefix: "my/",
        label: "bogus",
        baseURL: "https://api.example.com",
        api: "google-generative-ai",
        apiKey: PROVIDER_KEY,
        models: [{ id: "llama-3" }],
      },
    ]),
  });
  const res = await withFetch(
    async () => {
      throw new Error("an unroutable provider dialled something");
    },
    () =>
      call("POST", "/v1/chat/completions", {
        auth: false,
        body: { model: "my/llama-3", messages: [{ role: "user", content: "hi" }] },
      }),
  );
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.type, "config_error");
  assert.match(body.error.message, /cannot be routed/);
  assertFetchCalls(0);
  assert.equal((await json(await call("GET", "/api/admin/providers"))).status, 200);
});

/* ---------------- what clients and the console see ---------------- */

test("LISTING: /v1/models advertises the provider's models, and they are selectable", async () => {
  const { call, json } = await harness();
  await addProvider(call, json, {
    models: [
      { id: "llama-3", name: "Llama 3", contextWindow: 1000000, maxTokens: 128000 },
      "mistral-small",
    ],
  });

  const models = await json(await call("GET", "/v1/models", { auth: false }));
  assert.equal(models.status, 200);
  const entry = models.body.data.find((m) => m.id === "my/llama-3");
  assert.ok(entry, "the provider's model is not advertised /v1/models");
  assert.equal(entry.owned_by, "My Provider");
  // The declared facets are advertised because a client USES them: DSH's model
  // discovery reads exactly context_window/max_tokens off this listing.
  assert.equal(entry.context_window, 1000000);
  assert.equal(entry.max_tokens, 128000);
  assert.equal(entry.name, "Llama 3");
  const bare = models.body.data.find((m) => m.id === "my/mistral-small");
  assert.ok(bare, "a model given as a plain string id was not advertised");
  assert.equal(bare.context_window, undefined, "facets leaked onto a model that declared none");

  // Advertised means selectable: /api/me/route gates on isAdvertised.
  const set = await json(await call("PUT", "/api/me/route", { body: { model: "my/llama-3" } }));
  assert.equal(set.status, 200, `an advertised provider model could not be set: ${JSON.stringify(set.body)}`);

  // The console catalogue explains the channel rather than showing a bare id.
  const cat = await json(await call("GET", "/api/admin/public", { auth: false }));
  const card = cat.body.routes.find((r) => r.prefix === "my/");
  assert.ok(card, "no console route card for the provider");
  assert.equal(card.backend, "My Provider");
  assert.deepEqual(card.models, ["llama-3", "mistral-small"]);
  assert.match(card.desc, /api\.example\.com/);
  assert.match(card.desc, /openai-completions/);

  // Deleting takes the models away everywhere — advertising AND routing.
  await call("DELETE", "/api/admin/providers/my");
  dropProviderCache();
  const after = await json(await call("GET", "/v1/models", { auth: false }));
  assert.ok(!after.body.data.some((m) => m.id === "my/llama-3"), "still advertised after delete");
  const setAgain = await json(await call("PUT", "/api/me/route", { body: { model: "my/llama-3" } }));
  assert.equal(setAgain.status, 400, "a deleted provider's model could still be selected");
});

test("HEALTH: a custom provider gets NO probe card on the public endpoint", async () => {
  // Deliberate: HEALTH_CHANNELS is a compile-time probe list and every card
  // costs an upstream call on an UNAUTHENTICATED endpoint. Adding
  // operator-declared destinations there would turn /api/health into an
  // amplifier aimed wherever a provider record points.
  const { env, call, json } = await harness();
  await addProvider(call, json);
  const health = await withFetch(
    async () => new Response("0", { status: 200 }),
    () => buildHealth(env),
  );
  assert.ok(
    !health.channels.some((c) => c.id === "my" || String(c.model).startsWith("my/")),
    "a custom provider appeared in the public health cards",
  );
  assert.ok(health.channels.length > 0, "the built-in cards vanished");
});

/* ---------------- vision ---------------- */

test("VISION: a provider model that declares image input is handed the image itself", async () => {
  const { call, json } = await harness();
  await addProvider(call, json, {
    models: [{ id: "llama-3", input: ["text", "image"] }],
  });
  const imageBody = {
    model: "my/llama-3",
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
          { type: "text", text: "what is this?" },
        ],
      },
    ],
  };
  let seen;
  const res = await withFetch(
    async (url, init) => {
      seen = { url: String(url), init };
      return openaiReply("seen");
    },
    () => call("POST", "/v1/messages", { auth: false, body: imageBody }),
  );
  assert.equal(res.status, 200);
  assertFetchCalls(1, "the image was described for a model declared to see images");
  assert.equal(seen.url, "https://api.example.com/chat/completions");
  assert.ok(
    JSON.stringify(JSON.parse(seen.init.body)).includes("image_url"),
    "the image did not reach the provider that can see it",
  );
});

test("VISION: a text-only provider model still gets its images described first", async () => {
  // The complement of the test above: without the declaration the gateway must
  // keep describing images (the behaviour every text-only channel relies on),
  // so the declared-vision branch cannot be "always skip".
  const { call, json } = await harness();
  await addProvider(call, json, { models: [{ id: "llama-3" }] });
  const seen = [];
  const res = await withFetch(
    async (url, init) => {
      seen.push({ url: String(url), init });
      if (String(url).includes("zen/go")) return openaiReply("a small cat");
      return openaiReply("described");
    },
    () =>
      call("POST", "/v1/messages", {
        auth: false,
        body: {
          model: "my/llama-3",
          max_tokens: 16,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
                { type: "text", text: "what is this?" },
              ],
            },
          ],
        },
      }),
  );
  assert.equal(res.status, 200);
  assert.equal(seen.length, 2, "the image was NOT described before the provider call");
  assert.match(seen[0].url, /zen\.go|opencode\.ai/, "the vision model did not run first");
  assert.equal(seen[1].url, "https://api.example.com/chat/completions");
  assert.ok(
    JSON.stringify(JSON.parse(seen[1].init.body)).includes("a small cat"),
    "the description did not replace the image in the provider's request",
  );
});
