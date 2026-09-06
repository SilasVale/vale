// upstream.ts route-table unit tests — pickRoute/stripBracket/
// passthroughHeaders are pure (env only feeds usProxyBase) but had ZERO
// direct tests; every /v1 call and valeProbe flow through pickRoute, so a
// drifted table misroutes silently. Pins each prefix + the US-egress wrap.
import test from "node:test";
import assert from "node:assert/strict";
import { pickRoute, stripBracket, passthroughHeaders } from "../src/upstream.ts";

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
