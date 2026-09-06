// RouteDO CRUD + error paths — auth gates live in auth-gates.test.mjs;
// this pins the storage semantics: GET/PUT/DELETE roundtrip, PUT-null
// deletes, 400s, unknown-path 404, storage-throw 500 (never a hang).
import test from "node:test";
import assert from "node:assert/strict";
import { RouteDO } from "../src/route-do.ts";

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
