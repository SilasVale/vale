// The model catalogue END TO END, through the REAL dispatcher.
//
// `model-catalogue-store.test.mjs` covers the merge logic in isolation. This covers
// what that cannot: that the routes are WIRED, that a session is REQUIRED, and that a
// change made through the admin API shows up in what `/v1/models` serves — the loop an
// operator actually performs, and the one I could not exercise against the live worker
// because `workerd` will not run on this box (needs GLIBC 2.32+; it is 20.04).
import test from "node:test";
import assert from "node:assert/strict";
import { issueSessionToken, SESSION_COOKIE } from "../src/auth.ts";
import { makeEnv } from "./helpers.mjs";
import { createPluginContext, registerPlugins, dispatch } from "../src/plugins/registry.ts";

const PW = "e2e-admin-password";
const ADMIN_ID = "admin";

/** Every plugin registered, so the real route table is under test. */
async function harness() {
  const env = makeEnv({
    users: {
      [ADMIN_ID]: { id: ADMIN_ID, username: "admin", role: "admin", enabled: true, token: "" },
    },
    kv: { "auth:admin_password": PW, _admin_seeded: "1" },
  });
  const ctx = createPluginContext(env);
  await registerPlugins(ctx, [
    (await import("../src/plugins/admin.ts")).default,
    (await import("../src/plugins/auth.ts")).default,
    (await import("../src/plugins/translate.ts")).default,
  ]);
  const cookie = await issueSessionToken(PW, ADMIN_ID, "admin");
  const call = (method, path, { auth = true, body } = {}) => {
    const headers = { "content-type": "application/json" };
    if (auth) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
    const url = `https://api.saisi.online${path}`;
    const req = new Request(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return dispatch(ctx, method, path, req, env, new URL(url));
  };
  const json = async (r) => {
    assert.ok(r, `no response for a dispatched route`);
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

/** The ids `/v1/models` serves — what a CLIENT sees. */
async function v1Models(call, json) {
  const r = await json(await call("GET", "/v1/models", { auth: false }));
  assert.equal(r.status, 200, "GET /v1/models did not answer 200");
  return r.body.data.map((m) => m.id);
}

/** The catalogue the CONSOLE renders. */
async function publicCatalogue(call, json) {
  const r = await json(await call("GET", "/api/admin/public", { auth: false }));
  assert.equal(r.status, 200);
  return r.body;
}

test("SECURITY: every model route refuses an unauthenticated caller", async () => {
  // The regression that mattered: these shipped answering 200 to anyone, while every
  // sibling admin route answered 401. Pinned here so it cannot come back.
  const { call, json } = await harness();
  for (const [method, path] of [
    ["GET", "/api/admin/models"],
    ["POST", "/api/admin/models"],
    ["DELETE", "/api/admin/models/og/anything"],
    ["PUT", "/api/admin/models/og/anything/enabled"],
  ]) {
    // No body on GET — `new Request` rejects one outright, which is how this test
    // failed the first time.
    const opts = { auth: false, ...(method === "GET" ? {} : { body: {} }) };
    const r = await json(await call(method, path, opts));
    assert.equal(r.status, 401, `${method} ${path} answered ${r.status} with NO session`);
  }
});

test("ADD: a model added through the API is advertised, listed and routed", async () => {
  const { call, json } = await harness();
  const id = "og/console-e2e-added";

  const added = await json(await call("POST", "/api/admin/models", { body: { id } }));
  assert.equal(added.status, 200, `add failed: ${JSON.stringify(added.body)}`);

  assert.ok((await v1Models(call, json)).includes(id), "not in /v1/models after add");

  const cat = await publicCatalogue(call, json);
  assert.ok(cat.models.includes(id), "not in the console catalogue after add");
  // THE BARE-vs-PREFIXED CASE: the console groups by channel using BARE names.
  const og = cat.routes.find((r) => r.prefix === "og/");
  assert.ok(
    og.models.includes("console-e2e-added"),
    `not under og/ — got ${JSON.stringify(og.models.slice(0, 3))}`,
  );

  // And it can be set as a route, which is the whole point of advertising it.
  const set = await json(await call("PUT", "/api/me/route", { body: { model: id } }));
  assert.equal(set.status, 200, "a freshly added model could not be selected");
});

test("DELETE: a custom model goes away everywhere", async () => {
  const { call, json } = await harness();
  const id = "og/console-e2e-added";
  await call("POST", "/api/admin/models", { body: { id } });

  const del = await json(await call("DELETE", `/api/admin/models/${id}`));
  assert.equal(del.status, 200);
  assert.equal(del.body.removed, id, "the DELETE did not report a removal");

  assert.ok(!(await v1Models(call, json)).includes(id), "still advertised after delete");
  const og = (await publicCatalogue(call, json)).routes.find((r) => r.prefix === "og/");
  assert.ok(!og.models.includes("console-e2e-added"), "still in its channel list after delete");
});

test("DISABLE: a built-in leaves the catalogue AND stops being usable", async () => {
  const { call, json } = await harness();
  const id = "og/mimo-v2.5"; // a real built-in

  const off = await json(await call("DELETE", `/api/admin/models/${id}`));
  assert.equal(off.status, 200);
  assert.equal(off.body.disabled, id, "a built-in should be DISABLED, not deleted");

  assert.ok(!(await v1Models(call, json)).includes(id), "still advertised after disable");
  // THE POINT OF DISABLING: an existing route must stop working too.
  const set = await json(await call("PUT", "/api/me/route", { body: { model: id } }));
  assert.equal(set.status, 400, "a disabled model could still be set as the route");

  // Reported so the console can offer a way back.
  const state = await json(await call("GET", "/api/admin/models"));
  assert.ok(state.body.disabled.includes(id), "the disabled list does not name it");
  assert.ok(!state.body.custom.includes(id), "a built-in must not appear as custom");

  // And back on.
  const on = await json(await call("PUT", `/api/admin/models/${id}/enabled`));
  assert.equal(on.status, 200);
  assert.ok((await v1Models(call, json)).includes(id), "did not come back after re-enable");
});

test("VALIDATION: the channel prefix is checked against the REAL route table", async () => {
  const { call, json } = await harness();
  // A prefix nothing routes is the failure that matters: the model would be
  // advertised and then fail upstream.
  const bad = await json(await call("POST", "/api/admin/models", { body: { id: "zz/nope" } }));
  assert.equal(bad.status, 400, "an unknown channel prefix was accepted");
  assert.match(
    String(bad.body?.error?.message ?? ""),
    /prefix/i,
    "the error does not name the prefix problem",
  );

  // A built-in cannot be re-added as custom — that would shadow a record carrying six
  // facets with one carrying a fraction of them.
  const dup = await json(await call("POST", "/api/admin/models", { body: { id: "og/mimo-v2.5" } }));
  assert.equal(dup.status, 409, "re-adding a built-in as custom was allowed");

  // And an id without a prefix at all.
  const noprefix = await json(
    await call("POST", "/api/admin/models", { body: { id: "mimo-v2.5" } }),
  );
  assert.equal(noprefix.status, 400);
});
