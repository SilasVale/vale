// Front-door branches (index.ts fetch) with zero direct pins: the
// /models + /chat/completions aliases, the http→https 308, and the
// never-leak-internals 500. All worker.fetch-level, no auth needed
// except where the alias target itself requires it.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { makeEnv as makeBaseEnv } from "./helpers.mjs";

const env = () => makeBaseEnv({});

test("bare /models aliases to /v1/models (public model list)", async () => {
  const a = await worker.fetch(new Request("https://x/models"), env());
  const b = await worker.fetch(new Request("https://x/v1/models"), env());
  assert.equal(a.status, 200);
  const ja = await a.json();
  const jb = await b.json();
  assert.deepEqual(ja, jb);
  assert.ok(Array.isArray(ja.data) && ja.data.length > 0, "model list must be non-empty");
});

test("bare /chat/completions aliases to /v1/chat/completions transparently", async () => {
  const body = JSON.stringify({ model: "ds/deepseek-chat", messages: [] });
  const mk = (p) =>
    new Request(`https://x${p}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const a = await worker.fetch(mk("/chat/completions"), env());
  const b = await worker.fetch(mk("/v1/chat/completions"), env());
  assert.equal(a.status, b.status);
  assert.deepEqual(await a.json(), await b.json());
});

test("plain-http request 308-redirects to https (never serves the Secure cookie over http)", async () => {
  const res = await worker.fetch(
    new Request("https://x/api/me", { headers: { "x-forwarded-proto": "http" } }),
    env(),
  );
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), "https://x/api/me");
});

test("unhandled throw answers 500 Internal error without internals", async () => {
  const origErr = console.error;
  console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://x/api/me"), null);
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.error.message, "Internal error");
    assert.ok(!JSON.stringify(data).includes("CONSOLE_HOST"), "no internals leak");
  } finally {
    console.error = origErr;
  }
});
