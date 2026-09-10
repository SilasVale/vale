// upstream.ts route-table unit tests — pickRoute/stripBracket/
// passthroughHeaders are pure (env only feeds usProxyBase) but had ZERO
// direct tests; every /v1 call and valeProbe flow through pickRoute, so a
// drifted table misroutes silently. Pins each prefix + the US-egress wrap.
import test from "node:test";
import assert from "node:assert/strict";
import { pickRoute, stripBracket, passthroughHeaders, registerRoute, ROUTE_TABLE, opencodeSessionHeader, clientSessionId, syntheticSessionId, fnvHex, wireModelName } from "../src/upstream.ts";
import { MODELS, OG_WIRE_REMAP } from "../src/channels.ts";

test("wireModelName: og display names alias to zen/go lane slugs; others verbatim", () => {
  assert.equal(wireModelName("og", "deepseek-v4.1-flash"), "deepseek-flash", "clear name → lane slug");
  assert.equal(wireModelName("og", "deepseek-flash"), "deepseek-flash", "raw lane slug passes through");
  assert.equal(wireModelName("og", "deepseek-v4-flash"), "deepseek-v4-flash", "no remap entry → verbatim");
  assert.equal(wireModelName("ds", "deepseek-v4.1-flash"), "deepseek-v4.1-flash", "remap is og-only");
  // Every remap target must itself be remap-free (no chains).
  for (const t of Object.values(OG_WIRE_REMAP)) {
    assert.equal(OG_WIRE_REMAP[t], undefined, `remap target ${t} must not remap again`);
  }
});

test("stripBracket trims a trailing [context] marker only", () => {
  assert.equal(stripBracket("og/model[1m]"), "og/model");
  assert.equal(stripBracket("plain"), "plain");
  assert.equal(stripBracket("a[b]c"), "a[b]c");
  assert.equal(stripBracket(""), "");
});

test("pickRoute: per-prefix kind/type/upstream (direct, no egress)", async () => {
  const r = (prefix, path) => pickRoute(prefix, {}, null, path);
  assert.deepEqual(r("or", "/v1/messages"), {
    type: "passthrough",
    kind: "openrouter",
    stripPrefix: true,
    upstream: "https://openrouter.ai/api/v1/messages",
  });
  assert.deepEqual(r("or", "/v1/chat/completions"), {
    type: "passthrough",
    kind: "openrouter",
    stripPrefix: true,
    upstream: "https://openrouter.ai/api/v1/chat/completions",
  });
  assert.equal(r("ds", "/v1/messages").upstream, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(r("ds", "/v1/messages").kind, "deepseek");
  // qw/: format picked by request path
  assert.equal(r("qw", "/v1/chat/completions").upstream, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(r("qw", "/v1/messages").upstream, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages");
  assert.equal(r("og", "/v1/messages").type, "translate");
  assert.equal(r("og", "/v1/messages").upstream, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(r("nv", "/v1/chat/completions").kind, "nvidia");
  assert.equal(r("gmi", "/v1/chat/completions").kind, "gmi");
  assert.equal(r("cm", "/v1/messages").type, "translate");
  // unknown / empty prefix → DeepSeek official, no strip
  const d = r("xx", "/v1/messages");
  assert.equal(d.kind, "deepseek");
  assert.equal(d.stripPrefix, false);
  assert.equal(r("", "/v1/messages").upstream, d.upstream);
});

test("pickRoute: amd/ always direct, both formats, even under US egress", () => {
  const eg = { US_PROXY_BASE: "https://egress.example" };
  const chat = pickRoute("amd", eg, "1", "/v1/chat/completions");
  const msgs = pickRoute("amd", eg, "1", "/v1/messages");
  assert.equal(chat.upstream, "https://developer.amd.com.cn/radeon/api/v1/chat/completions");
  assert.match(msgs.upstream, /developer\.amd\.com\.cn\/radeon\/api\/v1\/messages$/);
  assert.equal(chat.kind, "amd");
});

test("pickRoute: US egress wraps with encoded target+path (F4 injection pin)", () => {
  const eg = { US_PROXY_BASE: "https://egress.example" };
  const r = pickRoute("ds", eg, "1", "/v1/messages");
  assert.match(r.upstream, /^https:\/\/egress\.example\/api\/zen\?target=ds&path=/);
  // model-derived prefix is one opaque value: &path= inside it must encode
  const evil = pickRoute("ds&path=/evil", eg, "1", "/v1/messages");
  const u = new URL(evil.upstream);
  assert.equal(u.searchParams.get("target"), "ds&path=/evil");
  assert.equal(u.searchParams.get("path"), "/anthropic/v1/messages");
});

test("passthroughHeaders: bearer default, api-key mode, keyless", () => {
  const b = passthroughHeaders("k123");
  assert.equal(b.get("authorization"), "Bearer k123");
  assert.equal(b.get("content-type"), "application/json");
  assert.equal(b.get("anthropic-version"), "2023-06-01");
  const x = passthroughHeaders("k123", { apiKeyHeader: "x-api-key" });
  assert.equal(x.get("x-api-key"), "k123");
  assert.equal(x.get("authorization"), null);
  const n = passthroughHeaders(null);
  assert.equal(n.get("authorization"), null);
  assert.equal(n.get("content-type"), "application/json");
});

// SOLID Round-1 (OCP): new channels register without editing pickRoute.
// Pins the extension point; cleans up so no other test sees the temp entry.
test("registerRoute: new prefix resolves via the table, unknown still falls back", () => {
  assert.equal(ROUTE_TABLE["zz-test-ocp"], undefined, "temp prefix must start absent");
  registerRoute("zz-test-ocp", ({ via }) => ({
    type: "passthrough",
    kind: "zztest",
    stripPrefix: true,
    upstream: via("https://example.invalid/chat", "/chat"),
  }));
  try {
    const r = pickRoute("zz-test-ocp", {}, null, "/v1/messages");
    assert.equal(r.kind, "zztest");
    assert.equal(r.upstream, "https://example.invalid/chat");
    // unknown prefixes still hit the DeepSeek default (no strip)
    const d = pickRoute("zz-unknown", {}, null, "/v1/messages");
    assert.equal(d.kind, "deepseek");
    assert.equal(d.stripPrefix, false);
  } finally {
    delete ROUTE_TABLE["zz-test-ocp"];
  }
  assert.equal(ROUTE_TABLE["zz-test-ocp"], undefined, "temp prefix cleaned up");
});

// SOLID Round-4 (SRP): session-id extraction vs synthesis are independently
// pinned; the composer preserves the historical client-wins-then-fallback
// semantics relied on by translate/translate-vision/tooling/auth callers.
test("clientSessionId: priority order, trimming, blank falls through", () => {
  assert.equal(clientSessionId(undefined), "", "no headers → blank");
  assert.equal(
    clientSessionId({ "x-opencode-session": "sess-1", "x-client-request-id": "req-9" }),
    "sess-1",
    "native session wins over request id",
  );
  assert.equal(clientSessionId({ "x-client-request-id": "req-9" }), "req-9");
  assert.equal(clientSessionId({ session_id: "openai-conv" }), "openai-conv");
  assert.equal(clientSessionId({ "x-session-id": "hdr-conv" }), "hdr-conv");
  assert.equal(clientSessionId({ "x-opencode-session": "  padded  " }), "padded", "trims");
  assert.equal(
    clientSessionId({ "x-opencode-session": "   ", "x-client-request-id": "req-9" }),
    "req-9",
    "blank first candidate falls through to the next",
  );
});

test("syntheticSessionId+fnvHex: stable vale-prefixed 16-hex digest, per-uid distinct", () => {
  const a1 = syntheticSessionId("user-a");
  const a2 = syntheticSessionId("user-a");
  const b = syntheticSessionId("user-b");
  assert.equal(a1, a2, "stable across calls (KV-free cache reuse)");
  assert.match(a1, /^vale-[0-9a-f]{16}$/, "vale- + 16 hex chars");
  assert.notEqual(a1, b, "distinct uids → distinct fallbacks");
  assert.equal(fnvHex("abc"), fnvHex("abc"), "deterministic");
  assert.match(fnvHex("abc"), /^[0-9a-f]{16}$/);
  assert.notEqual(fnvHex("abc"), fnvHex("abd"));
});

test("opencodeSessionHeader: relays client id verbatim, else synthetic fallback", () => {
  const relayed = opencodeSessionHeader({ "x-client-request-id": "conv-42" }, "user-a");
  assert.deepEqual(relayed, { "x-opencode-session": "conv-42" }, "client id wins verbatim");
  const fallback = opencodeSessionHeader(undefined, "user-a");
  assert.deepEqual(fallback, { "x-opencode-session": syntheticSessionId("user-a") });
  assert.deepEqual(opencodeSessionHeader({}, "user-a"), fallback, "empty headers ≡ absent");
});

// SOLID Round-53: the OCP tables must cover every live prefix — a new
// channel added to MODELS without a route builder would silently ride the
// DeepSeek default (wrong upstream AND wrong key).
test("ROUTE_TABLE covers every MODELS prefix", () => {
  const prefixes = new Set(MODELS.map((m) => m.id.split("/")[0]));
  assert.ok(prefixes.size >= 8, "whitelist non-trivial");
  for (const p of prefixes) {
    assert.equal(typeof ROUTE_TABLE[p], "function", `${p}/ models need a route builder`);
  }
});
