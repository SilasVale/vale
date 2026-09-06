// TempClaimDO compat-gate tests (node:test, no Cloudflare runtime needed).
//
// Gate semantics (see src/claim.js authorized()): has-then-verify /
// absent-then-pass. The claim token itself is a ~131-bit crypto-random
// capability, so the x-do-auth header is defense-in-depth that activates
// only when DO_AUTH is configured — deploys without the secret keep
// working. The worker (src/index.js) attaches the header when env.DO_AUTH
// is set (gateway breakerHeaders pattern), overwriting any client-forged
// value.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { TempClaimDO } from "../src/index.js";
import { makeR2, seedFile, respBytes, assertJsonError } from "./helpers.mjs";

const TOKEN = "ABCDEFGHIJKLMNOPabcdefgh";
const BYTES = new TextEncoder().encode("auth-gated-payload");
const SECRET = "do-internal-secret";

const dummyState = () => ({ storage: { get: async () => null, put: async () => {}, delete: async () => {} } });
const claim = (r2, extraEnv = {}) => new TempClaimDO(dummyState(), { TEMP_FILES: r2, ...extraEnv });
const getReq = (token = TOKEN, headers = {}) => new Request(`https://worker.local/files/${token}`, { headers });

// Worker env stub capturing the exact Request forwarded to the DO stub.
function makeEnv(r2, extraEnv = {}) {
  const seen = [];
  return {
    seen,
    env: {
      TEMP_FILES: r2,
      ...extraEnv,
      TEMP_CLAIM: {
        idFromName: (name) => ({ __name: name }),
        get: (_id) => ({
          fetch: (req) => {
            seen.push(req);
            return new TempClaimDO(dummyState(), { TEMP_FILES: r2, ...(extraEnv.DO_AUTH ? { DO_AUTH: extraEnv.DO_AUTH } : {}) }).fetch(req);
          },
        }),
      },
    },
  };
}

test("compat: DO without DO_AUTH serves an ungated claim (existing deploys keep working)", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  const resp = await claim(r2).fetch(getReq());
  assert.equal(resp.status, 200);
  assert.deepEqual(await respBytes(resp), BYTES);
});

test("DO with DO_AUTH serves when the correct header is presented", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  const resp = await claim(r2, { DO_AUTH: SECRET }).fetch(getReq(TOKEN, { "x-do-auth": SECRET }));
  assert.equal(resp.status, 200);
  assert.deepEqual(await respBytes(resp), BYTES);
});

test("DO with DO_AUTH refuses a missing header with 401 JSON (key NOT consumed)", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  await assertJsonError(await claim(r2, { DO_AUTH: SECRET }).fetch(getReq()), 401, "unauthorized");
  assert.notEqual(await r2.get(`files/${TOKEN}`), null, "refused claim must not consume the file");
});

test("DO with DO_AUTH refuses a wrong header with 401 JSON", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  await assertJsonError(
    await claim(r2, { DO_AUTH: SECRET }).fetch(getReq(TOKEN, { "x-do-auth": "wrong-secret" })),
    401,
    "unauthorized",
  );
  await assertJsonError(
    await claim(r2, { DO_AUTH: SECRET }).fetch(getReq(TOKEN, { "x-do-auth": "short" })),
    401,
    "unauthorized",
  );
});

test("worker attaches x-do-auth when env.DO_AUTH is set (end to end through the route)", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  const { env, seen } = makeEnv(r2, { DO_AUTH: SECRET });
  const resp = await worker.fetch(new Request(`https://dl.local/files/${TOKEN}`), env);
  assert.equal(resp.status, 200);
  assert.deepEqual(await respBytes(resp), BYTES);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get("x-do-auth"), SECRET);
});

test("worker omits x-do-auth when env.DO_AUTH is unset (compat: DO without secret serves)", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  const { env, seen } = makeEnv(r2);
  const resp = await worker.fetch(new Request(`https://dl.local/files/${TOKEN}`), env);
  assert.equal(resp.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get("x-do-auth"), null);
});

test("worker overwrites a client-forged x-do-auth value", async () => {
  const r2 = makeR2();
  await seedFile(r2, TOKEN, BYTES, { expiresAt: Date.now() + 3600_000 });
  const { env, seen } = makeEnv(r2, { DO_AUTH: SECRET });
  const resp = await worker.fetch(
    new Request(`https://dl.local/files/${TOKEN}`, { headers: { "x-do-auth": "forged" } }),
    env,
  );
  assert.equal(resp.status, 200);
  assert.equal(seen[0].headers.get("x-do-auth"), SECRET);
});
