// TempClaimDO tests: the serialized one-time claim against an in-memory
// R2 mock (node:test, no Cloudflare runtime needed).
//
// CONCURRENCY NOTE (faithful-test limitation): the once-only property under
// true concurrency comes from the DO *platform* — the runtime delivers one
// instance's requests strictly one at a time, so two racing claims can
// never interleave inside fetch(). Plain node cannot reproduce that input
// queue (two overlapping do.fetch() calls interleave at every await, and
// miniflare/workerd is not available in this repo). So this file proves:
//   (a) the claim logic itself is once-only *given* serialization, via a
//       minimal SerialClaimStub that preserves exactly the semantic relied
//       on (requests run one at a time, in arrival order); and
//   (b) without that serialization the same code double-serves (contrast
//       test below) — i.e. the test pins WHY the platform guarantee, not
//       the code alone, closes the race.
import test from "node:test";
import assert from "node:assert/strict";
import { TempClaimDO } from "../src/claim.js";
import { makeR2, seedFile, respBytes, assertJsonError } from "./helpers.mjs";

const TOKEN = "ABCDEFGHIJKLMNOPabcdefgh";
const BYTES = new TextEncoder().encode("one-time-payload");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gateway auth-gates style: the DO under test never touches storage.
const dummyState = () => ({ storage: { get: async () => null, put: async () => {}, delete: async () => {} } });
const claim = (r2) => new TempClaimDO(dummyState(), { TEMP_FILES: r2 });
const getReq = (token = TOKEN) => new Request(`https://worker.local/files/${token}`);

// Minimal DO stub preserving the serialization semantic relied on: chain
// each fetch behind the previous one's settlement (the platform input
// queue, in test form).
function serialStub(do_) {
  let tail = Promise.resolve();
  return {
    fetch(req) {
      const run = tail.then(() => do_.fetch(req));
      tail = run.catch(() => {});
      return run;
    },
  };
}

// R2 mock with deferred get/delete: widens the interleave window so the
// unserialized contrast test deterministically double-serves.
function deferredR2(r2, ms = 5) {
  return {
    ...r2,
    async get(key) {
      await sleep(ms);
      return r2.get(key);
    },
    async delete(key) {
      await sleep(ms);
      return r2.delete(key);
    },
  };
}

test("first claim streams bytes + exact headers and deletes the key", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, {
    contentType: "text/plain",
    disposition: 'attachment; filename="hello.txt"',
    expiresAt: Date.now() + 3600_000,
  });
  const resp = await claim(r2).fetch(getReq());
  assert.equal(resp.status, 200);
  assert.deepEqual(await respBytes(resp), BYTES);
  assert.equal(resp.headers.get("content-type"), "text/plain");
  assert.equal(resp.headers.get("content-disposition"), 'attachment; filename="hello.txt"');
  assert.equal(resp.headers.get("cache-control"), "no-store");
  assert.equal(await r2.get(`files/${TOKEN}`), null, "key must be deleted by the winning claim");
});

test("second claim 404s with the exact already-downloaded message", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  const do_ = claim(r2);
  assert.equal((await do_.fetch(getReq())).status, 200);
  await assertJsonError(await do_.fetch(getReq()), 404, "file not found or already downloaded");
});

test("missing file 404s with the exact message", async () => {
  await assertJsonError(await claim(makeR2()).fetch(getReq()), 404, "file not found or already downloaded");
});

test("expired file 410s with the exact message and is deleted", async () => {  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() - 1000 });
  const do_ = claim(r2);
  await assertJsonError(await do_.fetch(getReq()), 410, "file expired");
  assert.equal(await r2.get(`files/${TOKEN}`), null, "expired key must be cleaned up");
  await assertJsonError(await do_.fetch(getReq()), 404, "file not found or already downloaded");
});

test("legacy file without expiresAt is served", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES); // no expiresAt, like pre-field uploads
  const resp = await claim(r2).fetch(getReq());
  assert.equal(resp.status, 200);
  assert.deepEqual(await respBytes(resp), BYTES);
});

test("header defaults match the previous inline responses", async () => {
  const r2 = makeR2();
  await r2.put(`files/${TOKEN}`, BYTES); // no httpMetadata at all
  const resp = await claim(r2).fetch(getReq());
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("content-type"), "application/octet-stream");
  assert.equal(resp.headers.get("content-disposition"), "attachment");
  assert.equal(resp.headers.get("cache-control"), "no-store");
});

test("DO guards its own address: bad path / non-GET -> 404 Not Found", async () => {
  const do_ = claim(makeR2());
  assert.equal((await do_.fetch(new Request("https://worker.local/files/short"))).status, 404);
  assert.equal(await (await do_.fetch(new Request("https://worker.local/files/short"))).text(), "Not Found");
  assert.equal(
    (await do_.fetch(new Request(`https://worker.local/files/${TOKEN}`, { method: "POST" }))).status,
    404,
  );
});

test("WITH serialization (DO input-queue semantic): 5 racing claims -> exactly one 200", async () => {
  const r2 = deferredR2(makeR2());
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  const stub = serialStub(claim(r2));
  const resps = await Promise.all([getReq(), getReq(), getReq(), getReq(), getReq()].map((q) => stub.fetch(q)));
  const byStatus = resps.map((r) => r.status).sort();
  assert.deepEqual(byStatus, [200, 404, 404, 404, 404]);
  const winner = resps.find((r) => r.status === 200);
  assert.deepEqual(await respBytes(winner), BYTES);
  for (const loser of resps.filter((r) => r.status === 404)) {
    assert.equal(await loser.text(), JSON.stringify({ error: "file not found or already downloaded" }));
  }
});

test("WITHOUT serialization (contrast): overlapping claims both serve — the race the DO closes", async () => {
  const r2 = deferredR2(makeR2());
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  const do_ = claim(r2); // no queue: plain concurrent calls, as separate isolates did pre-fix
  const [a, b] = await Promise.all([do_.fetch(getReq()), do_.fetch(getReq())]);
  assert.equal(a.status, 200, "unserialized claim A serves");
  assert.equal(b.status, 200, "unserialized claim B serves too — the original bug");
});

// P1-1: R2 outages surface as a 503 JSON envelope, never an uncaught throw.
test("R2 get failure -> 503 temporarily unavailable (JSON envelope)", async () => {
  const r2 = makeR2();
  r2.get = async () => {
    throw new Error("R2 down");
  };
  await assertJsonError(await claim(r2).fetch(getReq()), 503, "temporarily unavailable");
});

test("R2 delete failure -> 503 temporarily unavailable (JSON envelope)", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  r2.delete = async () => {
    throw new Error("R2 down");
  };
  await assertJsonError(await claim(r2).fetch(getReq()), 503, "temporarily unavailable");
});

test("corrupt (non-numeric) expiresAt expires 410 and is cleaned up (P2-10 fail-closed)", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: "not-a-number" });
  const do_ = claim(r2);
  await assertJsonError(await do_.fetch(getReq()), 410, "file expired");
  assert.equal(await r2.get(`files/${TOKEN}`), null, "corrupt-deadline key must be cleaned up");
});
