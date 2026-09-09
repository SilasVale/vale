// RouteDO CRUD + error paths — auth gates live in auth-gates.test.mjs;
// this pins the storage semantics: GET/PUT/DELETE roundtrip, PUT-null
// deletes, 400s, unknown-path 404, storage-throw 500 (never a hang).
import test from "node:test";
import assert from "node:assert/strict";
import { RouteDO, DoAuthBase, authorizeDoRequest } from "../src/route-do.ts";

function makeDO(storage) {
  return new RouteDO({ storage }, { DO_AUTH: "sekret" });
}

function memStore() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
}

const H = { headers: { "x-do-auth": "sekret" } };
const get = (qs) => new Request(`https://d/route${qs}`, H);
const del = (qs) => new Request(`https://d/route${qs}`, { ...H, method: "DELETE" });
const put = (body) =>
  new Request("https://d/route", { ...H, method: "PUT", body: JSON.stringify(body) });

test("GET unknown uid → null model; PUT then GET roundtrips", async () => {
  const db = makeDO(memStore());
  assert.deepEqual(await (await db.fetch(get("?uid=ghost"))).json(), { model: null });
  const pr = await db.fetch(put({ uid: "u1", model: "ds/deepseek-v4-flash" }));
  assert.deepEqual(await pr.json(), { ok: true });
  assert.deepEqual(await (await db.fetch(get("?uid=u1"))).json(), { model: "ds/deepseek-v4-flash" });
});

test("PUT null model deletes; DELETE removes", async () => {
  const db = makeDO(memStore());
  await db.fetch(put({ uid: "u2", model: "qw/qwen3.8-max-preview" }));
  await db.fetch(put({ uid: "u2", model: null }));
  assert.deepEqual(await (await db.fetch(get("?uid=u2"))).json(), { model: null });
  await db.fetch(put({ uid: "u3", model: "og/deepseek-v4-flash" }));
  const dr = await db.fetch(del("?uid=u3"));
  assert.deepEqual(await dr.json(), { ok: true });
  assert.deepEqual(await (await db.fetch(get("?uid=u3"))).json(), { model: null });
});

test("missing uid → 400 on GET/PUT/DELETE; unknown path → 404", async () => {
  const db = makeDO(memStore());
  assert.equal((await db.fetch(get(""))).status, 400);
  assert.equal((await db.fetch(put({ model: "x" }))).status, 400);
  assert.equal((await db.fetch(del(""))).status, 400);
  assert.equal((await db.fetch(new Request("https://d/nope", H))).status, 404);
  assert.equal((await db.fetch(new Request("https://d/route", { ...H, method: "PATCH" }))).status, 404);
});

test("storage throw → 500 route-do error, never a hang", async () => {
  const bad = {
    async get() { throw new Error("kv down"); },
    async put() { throw new Error("kv down"); },
    async delete() { throw new Error("kv down"); },
  };
  const db = makeDO(bad);
  const res = await db.fetch(get("?uid=u"));
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /route-do/);
});

test("unauthenticated CRUD denied even with valid shape", async () => {
  const db = new RouteDO({ storage: memStore() }, { DO_AUTH: "sekret" });
  const bare = (url, init = {}) => new Request(url, init);
  assert.equal((await db.fetch(bare("https://d/route?uid=u"))).status, 401);
  assert.equal((await db.fetch(bare("https://d/route", { method: "PUT", body: "{}" }))).status, 401);
  assert.equal((await db.fetch(bare("https://d/route?uid=u", { method: "DELETE" }))).status, 401);
});

// ── SOLID Round-8: authorizeDoRequest truth table ───────────────
// The gate is now auth.ts's safeEq primitive behind the fail-closed
// empty-secret guard (previously a hand-rolled second copy of the loop).
// These pins fix the exact contract, especially the divergence that must
// NEVER regress: safeEq("","") is true, but an UNCONFIGURED gate must deny.
test("authorizeDoRequest: match → true; mismatch/missing → false", () => {
  const good = (h) => new Request("https://d/", { headers: h });
  assert.equal(authorizeDoRequest(good({ "x-do-auth": "sekret" }), "sekret"), true);
  assert.equal(authorizeDoRequest(good({ "x-do-auth": "sekreT" }), "sekret"), false, "same length, one bit off");
  assert.equal(authorizeDoRequest(good({ "x-do-auth": "short" }), "sekret"), false, "length mismatch");
  assert.equal(authorizeDoRequest(good({ "x-do-auth": "sekretsekret" }), "sekret"), false, "longer mismatch");
  assert.equal(authorizeDoRequest(good({}), "sekret"), false, "missing header");
});

test("authorizeDoRequest: empty expected secret FAILS CLOSED", () => {
  const bare = new Request("https://d/");
  const emptyHeader = new Request("https://d/", { headers: { "x-do-auth": "" } });
  const anyHeader = new Request("https://d/", { headers: { "x-do-auth": "anything" } });
  assert.equal(authorizeDoRequest(bare, ""), false, "unconfigured gate denies headerless callers");
  assert.equal(authorizeDoRequest(emptyHeader, ""), false, "empty-vs-empty still denies (≠ safeEq)");
  assert.equal(authorizeDoRequest(anyHeader, ""), false, "unconfigured gate denies keyed callers");
  assert.equal(authorizeDoRequest(bare, undefined), false, "undefined secret denies");
});

test("DoAuthBase.authorized: honors DO_AUTH, denies when unset", () => {
  const base = new DoAuthBase({}, { DO_AUTH: "sekret" });
  const naked = new DoAuthBase({}, {});
  const good = new Request("https://d/", { headers: { "x-do-auth": "sekret" } });
  const bad = new Request("https://d/", { headers: { "x-do-auth": "nope" } });
  assert.equal(base.authorized(good), true);
  assert.equal(base.authorized(bad), false);
  assert.equal(naked.authorized(good), false, "no DO_AUTH → deny even the right shape");
  assert.equal(naked.authorized(new Request("https://d/")), false);
});
