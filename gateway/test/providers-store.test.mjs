// Custom PROVIDERS as DATA — `store/providers.ts`, plus the routing contract
// `resolveRoute` implements on top of it (upstream.ts).
//
// The model catalogue had a store and a test; the layer under it — the channels
// themselves — was still code. These are the pins for the registry that makes a
// whole provider a runtime thing, and for the four ways that could go wrong
// quietly:
//
//   * SHADOWING. A record that re-points `og/` at a third party would take every
//     existing route — and the key riding it — with it. Built-ins must win even
//     when a record says otherwise, and creation must refuse the prefix too.
//   * THE DEFAULT-CHANNEL FALL-THROUGH. An unknown prefix resolves to the
//     built-in default (Command Code). That is right for a typo and WRONG for a
//     provider record that exists but cannot be routed: it would answer from a
//     channel the caller never asked for. Such a record must fail loudly.
//   * THE KEY. It is an operator credential pointed at an arbitrary host; it may
//     never come back out of the admin API, and it may never be confused with
//     the user's BYOK keys.
//   * SSRF. baseURL is operator-supplied and the gateway dials it with a
//     credential — the host checks are device-fetch's, reused, not re-written.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./helpers.mjs";

const {
  parseProviderSpec,
  putCustomProvider,
  customProviders,
  providerForPrefix,
  deleteCustomProvider,
  advertisedProviderModels,
  dropProviderCache,
  providerKey,
  publicProvider,
  SUPPORTED_PROVIDER_APIS,
} = await import("../src/store/providers.ts");
const { resolveRoute, ROUTE_TABLE, pickRoute } = await import("../src/upstream.ts");
const { RESERVED_PREFIXES } = await import("../src/channels.ts");

/** A fresh isolate per test: the store caches KV reads in a process-global map. */
function freshEnv(seed = {}) {
  return makeEnv({ kv: seed });
}

/** The DSH settings.yaml provider, as the admin API receives it (JSON). */
const VALE_LIKE = {
  prefix: "my/",
  label: "My Provider",
  baseURL: "https://api.example.com",
  api: "openai-completions",
  apiKeyEnv: "MY_PROVIDER_KEY",
  models: [
    { id: "llama-3", contextWindow: 1000000, maxTokens: 128000, input: ["text", "image"] },
    "mistral-small",
  ],
};

/** Parse, asserting success — a failure here fails the test that called it. */
function mustParse(body) {
  const { spec, error, status } = parseProviderSpec(body);
  assert.equal(error, undefined, `expected a valid provider, got: ${error} (${status})`);
  assert.ok(spec, "no spec and no error");
  return spec;
}

/* ---------------- reservation (shadowing) ---------------- */

test("RESERVED_PREFIXES is exactly the built-in route table plus the none sentinel", () => {
  // DRIFT PIN. The reservation list is spelled out in channels.ts while the
  // routes live in upstream.ts, so the two can only be kept equal by a test:
  // a channel added to ROUTE_TABLE without a reservation would become a
  // SHADOWABLE prefix — a provider could claim `ds/` and be advertised while
  // every ds/ request still rode the built-in route.
  assert.deepEqual(
    [...RESERVED_PREFIXES].sort(),
    [...Object.keys(ROUTE_TABLE), "none"].sort(),
    "channels.ts's RESERVED_PREFIXES no longer matches upstream.ts's ROUTE_TABLE",
  );
});

test("a reserved prefix is REFUSED at creation, with the collision named (409)", () => {
  for (const reserved of RESERVED_PREFIXES) {
    const { spec, error, status } = parseProviderSpec({ ...VALE_LIKE, prefix: `${reserved}/` });
    assert.equal(spec, undefined, `${reserved}/ was accepted as a custom provider prefix`);
    assert.equal(status, 409, `${reserved}/ was refused with ${status}, not 409`);
    assert.match(String(error), /reserved/i, `${reserved}/: the error does not say why`);
  }
});

/* ---------------- SSRF / scheme ---------------- */

test("baseURL must be https, credential-free, and NOT a private or loopback host", () => {
  // The hosts below are the ones device-fetch's guard stack exists for; the
  // point of reusing deviceHostError is that THIS list cannot drift from it.
  const bad = [
    ["http://api.example.com", /https/i],
    ["https://127.0.0.1", /private|internal/i],
    ["https://localhost", /private|internal/i],
    ["https://169.254.169.254", /private|internal/i],
    ["https://10.1.2.3", /private|internal/i],
    ["https://192.168.1.10", /private|internal/i],
    ["https://172.16.0.9", /private|internal/i],
    ["https://[::1]", /private|internal/i],
    ["https://0.0.0.0", /private|internal/i],
    ["https://user:pw@api.example.com", /credential/i],
    ["https://api.example.com/v1?key=1", /query|fragment/i],
    ["not a url", /not a URL/i],
  ];
  for (const [baseURL, want] of bad) {
    const { spec, error, status } = parseProviderSpec({ ...VALE_LIKE, baseURL });
    assert.equal(spec, undefined, `${baseURL} was accepted as a baseURL`);
    assert.equal(status, 400, `${baseURL} was refused with ${status}, not 400`);
    assert.match(String(error), want, `${baseURL}: unhelpful error ${JSON.stringify(error)}`);
  }
  // A public https host on a deployment PATH survives (baseURL is a prefix, not
  // a URL to resolve against — see providerRoute).
  const ok = mustParse({ ...VALE_LIKE, baseURL: "https://gateway.example.com/openai/v1/" });
  assert.equal(ok.baseURL, "https://gateway.example.com/openai/v1");
});

/* ---------------- protocol ---------------- */

test("an unsupported protocol is refused AT CREATION, naming what is served", () => {
  const { spec, error, status } = parseProviderSpec({ ...VALE_LIKE, api: "anthropic-messages" });
  assert.equal(spec, undefined, "a protocol this build cannot serve was accepted");
  assert.equal(status, 400);
  assert.match(String(error), /openai-completions/, "the error does not name a served protocol");
  // The named reason is what stops the next operator from re-asking: the gateway
  // has no OpenAI→Anthropic REQUEST translator, so such a provider would serve
  // half its clients.
  assert.match(String(error), /anthropic-messages/);
  assert.ok(
    Object.prototype.hasOwnProperty.call(SUPPORTED_PROVIDER_APIS, "openai-completions"),
    "the served dialect must be the one the error advertises",
  );
});

/* ---------------- the key ---------------- */

test("a key reference is required — exactly one of apiKeyEnv / apiKey", () => {
  const none = parseProviderSpec({ ...VALE_LIKE, apiKeyEnv: undefined });
  assert.equal(none.spec, undefined, "a keyless provider was accepted");
  assert.match(String(none.error), /apiKeyEnv|apiKey/);
  assert.equal(none.status, 400);

  const both = parseProviderSpec({ ...VALE_LIKE, apiKey: "sk-inline-key-1234" });
  assert.equal(both.spec, undefined, "two key sources were accepted");
  assert.match(String(both.error), /not both/);

  const inline = mustParse({ ...VALE_LIKE, apiKeyEnv: undefined, apiKey: "sk-inline-key-1234" });
  assert.equal(inline.apiKey, "sk-inline-key-1234");
  assert.equal(inline.apiKeyEnv, undefined);

  // A VALUE where a NAME belongs is the mistake this check exists for: it would
  // store the secret in a field the console prints.
  const valueAsName = parseProviderSpec({ ...VALE_LIKE, apiKeyEnv: "sk-live-abcdef123456" });
  assert.equal(valueAsName.spec, undefined, "a key VALUE was accepted as apiKeyEnv");
  assert.match(String(valueAsName.error), /NAME/i);
});

test("the inline key NEVER leaves the store in the clear (maskKey, like the model handlers)", async () => {
  const env = freshEnv();
  const spec = mustParse({ ...VALE_LIKE, apiKeyEnv: undefined, apiKey: "sk-inline-key-1234" });
  await putCustomProvider(env, spec);

  const view = publicProvider((await customProviders(env))[0], env);
  const serialized = JSON.stringify(view);
  assert.ok(
    !serialized.includes("sk-inline-key-1234"),
    `the admin view echoed the provider key: ${serialized}`,
  );
  assert.match(view.keyMasked, /…/, "the key is not reported in masked form at all");
  assert.equal(view.keyReady, true);

  // An env-referenced key is reported by NAME, and its VALUE is masked too.
  const envSpec = mustParse(VALE_LIKE);
  const view2 = publicProvider(envSpec, { MY_PROVIDER_KEY: "sk-env-secret-9876" });
  assert.equal(view2.keyEnv, "MY_PROVIDER_KEY");
  assert.ok(!JSON.stringify(view2).includes("sk-env-secret-9876"), "env key value leaked");
  assert.equal(view2.keyReady, true);
  // ...and is reported as absent when this deployment does not bind it, so an
  // operator sees the 502's cause in the console before making a request.
  const view3 = publicProvider(envSpec, {});
  assert.equal(view3.keyReady, false);
  assert.equal(view3.keyMasked, "");
});

test("providerKey: inline wins, else the named binding, else empty", () => {
  assert.equal(providerKey({}, { apiKey: "inline-key-1234" }), "inline-key-1234");
  assert.equal(
    providerKey({ MY_PROVIDER_KEY: "env-key-1234" }, { apiKeyEnv: "MY_PROVIDER_KEY" }),
    "env-key-1234",
  );
  assert.equal(providerKey({}, { apiKeyEnv: "MY_PROVIDER_KEY" }), "");
  assert.equal(providerKey({}, undefined), "");
});

/* ---------------- models ---------------- */

test("models are validated, stored as WIRE names, and advertised exactly once", () => {
  const spec = mustParse({ ...VALE_LIKE, models: [{ id: "my/llama-3" }, "mistral-small"] });
  assert.deepEqual(
    spec.models.map((m) => m.id),
    ["llama-3", "mistral-small"],
    "the full-id spelling must be normalized to the wire name",
  );

  const bad = [
    [[], /non-empty/],
    [[{ id: "" }], /id is required/],
    [[{ id: "a b" }], /whitespace/],
    [[{ id: "x", temperature: 1 }], /unsupported field/],
    [[{ id: "x", input: ["audio"] }], /modalit/],
    [[{ id: "x", contextWindow: 0 }], /positive integer/],
    [[{ id: "dup" }, { id: "my/dup" }], /duplicate/],
    [[42], /must be a model id string or an object/],
  ];
  for (const [models, want] of bad) {
    const r = parseProviderSpec({ ...VALE_LIKE, models });
    assert.equal(r.spec, undefined, `models ${JSON.stringify(models)} was accepted`);
    assert.equal(r.status, 400);
    assert.match(String(r.error), want);
  }

  // `input: [text, image]` is the one facet that changes ROUTING behaviour: the
  // gateway must not describe images for a model that sees them itself.
  const vision = mustParse({ ...VALE_LIKE, models: [{ id: "v", input: ["text", "image"] }] });
  assert.equal(vision.models[0].vision, true);
  const textOnly = mustParse({ ...VALE_LIKE, models: [{ id: "t", input: ["text"] }] });
  assert.equal(textOnly.models[0].vision, undefined);
});

test("the record round-trips through KV, and a write invalidates the read cache", async () => {
  const env = freshEnv();
  let puts = 0;
  const keys = env.KEYS;
  env.KEYS = {
    get: (k) => keys.get(k),
    delete: (k) => keys.delete(k),
    async put(k, v, o) {
      puts++;
      return keys.put(k, v, o);
    },
  };

  assert.deepEqual(await customProviders(env), []);
  const spec = mustParse(VALE_LIKE);
  await putCustomProvider(env, spec);

  // The write is write-through: the very next read sees it, and it cost no extra
  // KV get (the second read below is served from the cache).
  const found = await providerForPrefix(env, "my");
  assert.ok(found, "the provider just written is not readable");
  assert.equal(found.prefix, "my/");
  const raw = JSON.parse(env._kv.get("providers:custom"));
  assert.equal(raw.length, 1, "the record did not land under providers:custom");
  assert.equal(puts, 1);

  // A bare prefix and the slashed spelling name the same record — the routing
  // layer only ever has the bare form (it splits the model id on "/").
  assert.ok(await providerForPrefix(env, "my/"), "the slashed spelling did not match");
  assert.equal(await providerForPrefix(env, "other"), null);

  // Upsert by prefix, not append.
  await putCustomProvider(env, mustParse({ ...VALE_LIKE, label: "Renamed" }));
  assert.equal((await customProviders(env)).length, 1, "re-posting a prefix appended a record");
  assert.equal((await providerForPrefix(env, "my")).label, "Renamed");

  assert.equal(await deleteCustomProvider(env, "my/"), true);
  assert.deepEqual(await customProviders(env), [], "the cache still serves the deleted record");
  assert.equal(await deleteCustomProvider(env, "my"), false, "deleting twice reported a removal");

  // A malformed blob degrades to "no custom providers", never a throw — the same
  // discipline the model catalogue follows.
  dropProviderCache();
  const broken = freshEnv({ "providers:custom": "{not json" });
  assert.deepEqual(await customProviders(broken), []);
  assert.deepEqual(await advertisedProviderModels(broken), []);
});

test("a malformed RECORD cannot break the advertised listing", async () => {
  const env = freshEnv({
    "providers:custom": JSON.stringify([
      { prefix: "good/", models: [{ id: "a" }, { id: "" }, { noId: 1 }] },
      { prefix: "", models: [{ id: "x" }] },
      { models: [{ id: "y" }] },
      null,
      { prefix: "bad/", models: "not an array" },
    ]),
  });
  const advertised = await advertisedProviderModels(env);
  assert.deepEqual(
    advertised.map((m) => m.id),
    ["good/a"],
    "a hand-edited record leaked a malformed model into the listing",
  );
});

/* ---------------- resolution order ---------------- */

test("resolveRoute: BUILT-INS WIN over a record that claims their prefix", async () => {
  // The shadowing case, as it would actually arrive: a record written by hand, or
  // written before the built-in channel existed. Routing must not follow it —
  // every existing og/ route (and the user's OpenCode key) would go to a third
  // party.
  const shadow = {
    prefix: "og/",
    label: "shadow",
    baseURL: "https://evil.example.com",
    api: "openai-completions",
    apiKey: "sk-shadow-key-1234",
    models: [{ id: "mimo-v2.5" }],
  };
  const env = freshEnv({ "providers:custom": JSON.stringify([shadow]) });

  const route = await resolveRoute(env, "og", null, "/v1/messages");
  assert.equal(route.kind, "opencode", "a stored record re-pointed a built-in prefix");
  assert.equal(
    route.upstream,
    pickRoute("og", env, null, "/v1/messages").upstream,
    "the built-in route changed",
  );
  assert.equal(route.provider, undefined, "the built-in route picked up a provider record");
});

test("resolveRoute: a custom prefix resolves to its provider; unknown ones still default", async () => {
  const env = freshEnv();
  await putCustomProvider(env, mustParse(VALE_LIKE));

  const custom = await resolveRoute(env, "my", null, "/v1/chat/completions");
  assert.equal(custom.kind, "custom", "the custom prefix did not resolve to the provider");
  assert.equal(custom.upstream, "https://api.example.com/chat/completions");
  assert.equal(custom.type, "translate", "a custom provider must ride the translate machinery");
  assert.equal(custom.stripPrefix, true);
  assert.equal(custom.provider?.prefix, "my/");

  // US_PROXY must not wrap a custom provider: the operator's endpoint is not one
  // of the relay's targets, and its key must not be handed to the egress.
  const proxied = await resolveRoute(env, "my", "1", "/v1/chat/completions");
  assert.equal(proxied.upstream, "https://api.example.com/chat/completions");

  // The no-prefix and genuinely-unknown cases keep the historical default.
  assert.equal((await resolveRoute(env, "", null)).kind, "commandgoat");
  assert.equal((await resolveRoute(env, "nope", null)).kind, "commandgoat");
});

test("an unroutable record is an ERROR route — never a silent fall-through to the default", async () => {
  // Hand-edited KV with a dialect this build dropped. Falling through would dial
  // Command Code under the caller's DeepSeek key for a model the operator
  // pointed somewhere else entirely.
  const env = freshEnv({
    "providers:custom": JSON.stringify([
      {
        prefix: "my/",
        label: "bogus",
        baseURL: "https://api.example.com",
        api: "google-generative-ai",
        apiKey: "sk-bogus-key-1234",
        models: [{ id: "m" }],
      },
    ]),
  });
  const route = await resolveRoute(env, "my", null, "/v1/chat/completions");
  assert.equal(route.type, "error", "an unroutable provider fell through to a real channel");
  assert.match(String(route.reason), /cannot be routed/);
  assert.equal(route.upstream, "", "an error route must not carry a dialable upstream");
});
