// Electron binary proxy pins (SOLID Round-74 — the release-1.2.308 route
// serving Electron from the worker so installers avoid npmjs/GitHub
// directly). No env bindings involved (pure fetch-through), so plain env.
// Upstream traffic stubbed — zero network. Not pinned: network-throw path
// (no try/catch around the fetch — propagates as an unhandled rejection;
// flagged to the stage-n owner, deliberately not cemented here).
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const PATH = "/vale-agent/electron-win32-x64.zip";
const PINNED_UPSTREAM =
  "https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-win32-x64.zip";

async function withStubFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("electron proxy: 200 zip stream with fixed headers, pinned upstream URL", async () => {
  const seen = {};
  const r = await withStubFetch(async (url) => {
    seen.url = String(url);
    return new Response("ZIPBYTES", { status: 200 });
  }, () => worker.fetch(new Request(`https://dl.example${PATH}`), {}));
  assert.equal(r.status, 200);
  assert.equal(seen.url, PINNED_UPSTREAM, "version pinned to the installer's expectation");
  assert.equal(r.headers.get("content-type"), "application/zip");
  assert.equal(r.headers.get("content-disposition"), 'attachment; filename="electron-win32-x64.zip"');
  assert.equal(r.headers.get("cache-control"), "public, max-age=86400");
  assert.equal(await r.text(), "ZIPBYTES", "body streams through untouched");
});

test("electron proxy: upstream !ok → 502 without leaking internals", async () => {
  const r = await withStubFetch(async () => new Response("nope", { status: 404 }), () =>
    worker.fetch(new Request(`https://dl.example${PATH}`), {}),
  );
  assert.equal(r.status, 502);
  assert.match(await r.text(), /electron upstream fetch failed: 404/);
});
