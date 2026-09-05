// Worker routing tests: GET /files/<token> must forward to the
// TempClaimDO instance named by the token (per-token serialization), and
// nothing else may touch the binding. The TEMP_CLAIM stub below delegates
// to the REAL TempClaimDO, so these tests prove routing end to end.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { TempClaimDO } from "../src/index.js";
import { makeR2, seedFile, respBytes, assertJsonError } from "./helpers.mjs";

const TOKEN = "ABCDEFGHIJKLMNOPabcdefgh";
const BYTES = new TextEncoder().encode("routed-payload");
const dummyState = { storage: { get: async () => null, put: async () => {}, delete: async () => {} } };

function makeEnv(r2) {
  const names = [];
  return {
    names,
    env: {
      TEMP_FILES: r2,
      TEMP_CLAIM: {
        idFromName(name) {
          names.push(name);
          return { __name: name };
        },
        get(_id) {
          const do_ = new TempClaimDO(dummyState, { TEMP_FILES: r2 });
          return { fetch: (req) => do_.fetch(req) };
        },
      },
    },
  };
}

test("GET /files/<token> forwards to the instance named by the token", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  const { env, names } = makeEnv(r2);
  const resp = await worker.fetch(new Request(`https://dl.local/files/${TOKEN}`), env);
  assert.equal(resp.status, 200);
  assert.deepEqual(await respBytes(resp), BYTES);
  assert.equal(resp.headers.get("cache-control"), "no-store");
  assert.deepEqual(names, [`files/${TOKEN}`], "instance must be named by the token");
});

test("repeat + unknown + expired route through the DO with exact semantics", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  const { env } = makeEnv(r2);
  assert.equal((await worker.fetch(new Request(`https://dl.local/files/${TOKEN}`), env)).status, 200);
  await assertJsonError(
    await worker.fetch(new Request(`https://dl.local/files/${TOKEN}`), env),
    404,
    "file not found or already downloaded",
  );
  await assertJsonError(
    await worker.fetch(new Request("https://dl.local/files/ZZZZZZZZZZZZZZZZZZZZZZ"), env),
    404,
    "file not found or already downloaded",
  );
  const EXP = "EEEEEEEEEEEEEEEEEEEEEEEE";
  await seedFile(r2, EXP, BYTES, { expiresAt: Date.now() - 1000 });
  await assertJsonError(await worker.fetch(new Request(`https://dl.local/files/${EXP}`), env), 410, "file expired");
});

test("non-matching paths and methods never touch TEMP_CLAIM", async () => {
  const { env, names } = makeEnv(makeR2());
  // Token too short for the route regex -> page 404, not the DO.
  const short = await worker.fetch(new Request("https://dl.local/files/short"), env);
  assert.equal(short.status, 404);
  // POST to a valid token path is not a download -> falls through, not the DO.
  const post = await worker.fetch(new Request(`https://dl.local/files/${TOKEN}`, { method: "POST" }), env);
  assert.equal(post.status, 404);
  assert.deepEqual(names, [], "TEMP_CLAIM must not be addressed off-route");
});

test("landing page still serves (routing change is scoped to /files/*)", async () => {
  const { env } = makeEnv(makeR2());
  const resp = await worker.fetch(new Request("https://dl.local/"), env);
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type"), /text\/html/);
});

test("DO boundary failure -> 503 temporarily unavailable (P1-1, JSON envelope)", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  // idFromName throws (DO unavailable).
  const { env: env1 } = makeEnv(r2);
  env1.TEMP_CLAIM.idFromName = () => {
    throw new Error("DO down");
  };
  await assertJsonError(
    await worker.fetch(new Request(`https://dl.local/files/${TOKEN}`), env1),
    503,
    "temporarily unavailable",
  );
  // Stub fetch itself throws (R2 outage inside the DO, uncaught path).
  const { env: env2 } = makeEnv(r2);
  env2.TEMP_CLAIM.get = () => ({
    fetch: async () => {
      throw new Error("R2 down");
    },
  });
  await assertJsonError(
    await worker.fetch(new Request(`https://dl.local/files/${TOKEN}`), env2),
    503,
    "temporarily unavailable",
  );
});
