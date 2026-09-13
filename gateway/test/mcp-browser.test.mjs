// Browser-tool routing tests: callTool forwards browser tools to the device's
// own HTTP API (/api/tools/mcp_client_call → playwright-mcp via the agent's
// mcp_client plugin), maps gateway tool names to playwright names, and
// self-heals the "rebooted device" case: nothing starts playwright-mcp nor
// opens the client session after boot, so the first browser_* call hits
// "not connected" — the bridge then start → connect → retries once.
// Pure local — global fetch is stubbed, no network calls. The handleMcp-level
// case verifies a screenshot data-URL becomes an MCP image content block.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMcp, callTool } from "../src/mcp.ts";
import { makeEnv as makeBaseEnv } from "./helpers.mjs";

// A REALISTIC hostname: the dial path now applies the suffix allowlist (it used to be
// registration-only, so this fixture got away with a placeholder), and no device can be
// registered under `example.com`. The check is what a production dial actually faces.
const DEVICE = { name: "d1", hostname: "d1.agent.saisi.online", token: "devtok" };

// fetch stub: records every call, replies from a handler per URL.
function makeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, impl };
}

async function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

const okJson = (result) => ({
  status: 200,
  json: async () => ({ ok: true, result }),
});

test("browser tool routes to the device mcp_client_call API with mapped name + bearer", async () => {
  const { calls, impl } = makeFetch((url) => {
    assert.equal(url, "https://d1.agent.saisi.online/api/tools/mcp_client_call");
    return okJson({ title: "Vale" });
  });
  await withFetch(impl, () =>
    callTool({ name: "browser_open" }, {}, DEVICE, { device: "d1", url: "https://example.com" }),
  );
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  // the gateway name browser_open maps to playwright's browser_navigate
  assert.equal(body.tool, "browser_navigate");
  assert.deepEqual(body.arguments, { device: "d1", url: "https://example.com" });
  assert.equal(calls[0].init.headers.Authorization, "Bearer devtok");
});

// RUN IDENTITY AND THE BRIDGE (round: run feature). A `run_id` reaches the
// gateway as an ordinary argument of a browser tool, but the DEVICE reads it
// from the top level of the mcp_client_call body — `arguments` is forwarded
// verbatim to playwright-mcp, which knows nothing about runs. Nested, the id
// would be dropped silently and a run would show its commands with ZERO browser
// actions: indistinguishable from "the AI never opened the browser", which is
// the exact silent-absence class this repo keeps paying for. So the lift is
// pinned in BOTH directions.
test("run_id is lifted OUT of the playwright arguments to the device call's top level", async () => {
  const { calls, impl } = makeFetch(() => okJson({ title: "Vale" }));
  await withFetch(impl, () =>
    callTool({ name: "browser_click" }, {}, DEVICE, {
      device: "d1",
      element_ref: 6,
      run_id: "run-1700000000000-abc123",
    }),
  );
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(
    body.run_id,
    "run-1700000000000-abc123",
    "the device reads run_id from the TOP level — this is what makes the " +
      "browser half of a run visible at all",
  );
  assert.ok(
    !("run_id" in body.arguments),
    "run_id must NOT also ride into playwright-mcp's own arguments, which " +
      "would forward an unknown key to a server that has no concept of runs",
  );
  // The rest of the arguments still pass through untouched — bar the
  // documented element_ref -> target translation (round-138), which this
  // asserts so a lift that accidentally ate other keys fails here.
  assert.equal(body.arguments.target, "e6");
});

test("a browser call with no run_id sends no run_id key at all", async () => {
  const { calls, impl } = makeFetch(() => okJson({ title: "Vale" }));
  await withFetch(impl, () =>
    callTool({ name: "browser_open" }, {}, DEVICE, { device: "d1", url: "https://example.com" }),
  );
  const body = JSON.parse(calls[0].init.body);
  assert.ok(
    !("run_id" in body),
    "an unattributed action must read as unattributed — an explicit null or " +
      "empty string would let it be grouped with a run named ''",
  );
});

// round-475 (coverage-driven): the device-tool divert arm (browser_pw_info /
// browser_run_script go to the DEVICE agent, not the playwright bridge)
// had ZERO pins.
test("device tools bypass the bridge: browser_run_script/pw_info hit the device API", async () => {
  for (const name of ["browser_run_script", "browser_pw_info"]) {
    const { calls, impl } = makeFetch((url) => {
      assert.equal(url, `https://d1.agent.saisi.online/api/tools/${name}`);
      return new Response(JSON.stringify({ ok: true, result: { ran: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    // deviceFetch injects the device Bearer internally (device-fetch.test.mjs
    // pins the hygiene); here the URL proves the bridge was bypassed.
    const out = await withFetch(impl, () => callTool({ name }, {}, DEVICE, { device: "d1" }));
    assert.equal(calls.length, 1, `${name} dialed the device directly`);
    assert.deepEqual(out, { ok: true, result: { ran: true } });
  }
});

test("self-heal: not connected → playwright/start + mcp_client_connect → retry succeeds", async () => {
  let n = 0;
  const { calls, impl } = makeFetch((url, init) => {
    if (String(url).endsWith("/api/tools/mcp_client_call")) {
      n += 1;
      if (n === 1) {
        return {
          status: 200,
          json: async () => ({
            ok: false,
            error: "not connected — call mcp_client_connect first",
            code: "invalid_params",
          }),
        };
      }
      return okJson({ elements: [] });
    }
    // heal endpoints
    assert.ok(
      String(url).endsWith("/api/plugins/playwright/start") ||
        String(url).endsWith("/api/tools/mcp_client_connect"),
      `unexpected heal URL ${url}`,
    );
    return okJson({ status: "started" });
  });
  const result = await withFetch(impl, () =>
    callTool({ name: "browser_snapshot" }, {}, DEVICE, { device: "d1" }),
  );
  assert.deepEqual(result, { ok: true, result: { elements: [] } });
  // order: call → start → connect → retry(call)
  const urls = calls.map((c) => c.url.split("/").pop());
  assert.deepEqual(urls, ["mcp_client_call", "start", "mcp_client_connect", "mcp_client_call"]);
});

test("browser_click element_ref integer 7 → playwright target e7", async () => {
  const { calls, impl } = makeFetch((url) => {
    assert.equal(url, "https://d1.agent.saisi.online/api/tools/mcp_client_call");
    return okJson({ ok: true });
  });
  const res = await withFetch(impl, () =>
    callTool({ name: "browser_click" }, {}, DEVICE, { device: "d1", element_ref: 7 }),
  );
  assert.equal(res.ok, true);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.tool, "browser_click");
  assert.equal(body.arguments.target, "e7"); // round-138 conversion
  assert.equal(body.arguments.element_ref, undefined);
});

test("browser_click element_ref e7 passes through as target", async () => {
  const { calls, impl } = makeFetch(() => okJson({ ok: true }));
  await withFetch(impl, () =>
    callTool({ name: "browser_click" }, {}, DEVICE, { device: "d1", element_ref: "e7" }),
  );
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.arguments.target, "e7");
});

test("browser_click without element_ref forwards args unchanged", async () => {
  const { calls, impl } = makeFetch(() => okJson({ ok: true }));
  await withFetch(impl, () =>
    callTool({ name: "browser_click" }, {}, DEVICE, { device: "d1", target: "f1e6" }),
  );
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.arguments.target, "f1e6");
  assert.equal(body.arguments.element_ref, undefined);
});

test("browser_type element_ref converts to target and keeps text", async () => {
  const { calls, impl } = makeFetch(() => okJson({ ok: true }));
  await withFetch(impl, () =>
    callTool({ name: "browser_type" }, {}, DEVICE, { device: "d1", element_ref: 3, text: "hello" }),
  );
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.tool, "browser_type");
  assert.equal(body.arguments.target, "e3");
  assert.equal(body.arguments.text, "hello");
  assert.equal(body.arguments.element_ref, undefined);
});

test("persistent failure after heal → rejects with the device error", async () => {
  const { impl } = makeFetch(() => ({
    status: 200,
    json: async () => ({ ok: false, error: "MCP connect failed: refused" }),
  }));
  await withFetch(impl, () =>
    assert.rejects(
      callTool({ name: "browser_click" }, {}, DEVICE, { device: "d1" }),
      /MCP connect failed: refused/,
    ),
  );
});

test("mcp: browser_screenshot data-URL → MCP image content block", async () => {
  const { impl } = makeFetch(() => okJson("data:image/png;base64,aGVsbG8="));
  const res = await withFetch(impl, () =>
    handleMcp(
      new Request("https://x/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer admintoken",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "browser_screenshot",
            arguments: { device: "d1", full_page: true },
          },
          id: 5,
        }),
      }),
      makeEnv(),
    ),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.result.content, [
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ]);
});

// KV stub for handleMcp-level tests — shared Map-KV stub (helpers.mjs)
// seeded with this file's MCP base.
function makeEnv() {
  return makeBaseEnv({
    devices: [DEVICE],
    users: {
      admin: { id: "admin", username: "admin", role: "admin", enabled: true, token: "admintoken" },
    },
    kv: { "token:admintoken": "admin" },
  });
}

// ── Bridge guardrails (round-369: semaphore, timeout clamp, unknown-tool
// passthrough, hostname gate — all had zero pins) ──

test("timeout_secs clamps to 1..300 before reaching the device (M2 audit)", async () => {
  const { calls, impl } = makeFetch(() => okJson({}));
  const bodies = [];
  const saving = async (url, init) => {
    bodies.push(JSON.parse(init.body).arguments);
    return impl(url, init);
  };
  await withFetch(saving, () =>
    callTool({ name: "browser_snapshot" }, {}, DEVICE, { timeout_secs: 99999 }),
  );
  await withFetch(saving, () =>
    callTool({ name: "browser_snapshot" }, {}, DEVICE, { timeout_secs: 0 }),
  );
  await withFetch(saving, () =>
    callTool({ name: "browser_snapshot" }, {}, DEVICE, { timeout_secs: 12.9 }),
  );
  assert.equal(bodies[0].timeout_secs, 300, "huge timeout clamps to the 300s ceiling");
  assert.equal(bodies[1].timeout_secs, 1, "zero timeout floors to 1s");
  assert.equal(bodies[2].timeout_secs, 12, "fractional timeout truncates");
});

test("unknown browser tool name passes through verbatim (toolMap fallback)", async () => {
  const { calls, impl } = makeFetch(() => okJson({}));
  await withFetch(impl, () => callTool({ name: "browser_future_tool" }, {}, DEVICE, { foo: 1 }));
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).tool, "browser_future_tool");
});

test("private device hostname → DEVICE_UNREACHABLE before any fetch", async () => {
  const evil = { name: "evil", hostname: "169.254.169.254", token: "tok" };
  let fetched = false;
  await withFetch(
    async () => {
      fetched = true;
      throw new Error("must not be called");
    },
    async () => {
      const err = await callTool({ name: "browser_snapshot" }, {}, evil, {}).catch((e) => e);
      assert.equal(err?.code, "DEVICE_UNREACHABLE");
    },
  );
  assert.equal(fetched, false, "SSRF guard must fire before the first fetch");
});

// round-482 (coverage-driven): the URL round-trip mismatch arm (hostname
// smuggling a port/userinfo/path past the IP guards) had ZERO pins.
test("hostname with port/userinfo/path → DEVICE_UNREACHABLE before any fetch", async () => {
  for (const hostname of [
    "d1.agent.saisi.online:8443",
    "u@d1.agent.saisi.online",
    "d1.agent.saisi.online/evil",
  ]) {
    const evil = { name: "evil", hostname, token: "tok" };
    let fetched = false;
    await withFetch(
      async () => {
        fetched = true;
        throw new Error("must not be called");
      },
      async () => {
        const err = await callTool({ name: "browser_snapshot" }, {}, evil, {}).catch((e) => e);
        assert.equal(err?.code, "DEVICE_UNREACHABLE", hostname);
        assert.match(String(err?.message || ""), /invalid device hostname/, hostname);
      },
    );
    assert.equal(fetched, false, `no dial for ${hostname}`);
  }
});

test("5th concurrent browser call on one device → SESSION_BUSY (semaphore of 4)", async () => {
  // Gate stub: hold all 4 slots until released — no timers, fully
  // deterministic (each call parks on the pending fetch synchronously
  // until the 5th is rejected).
  let release;
  const gate = new Promise((res) => {
    release = res;
  });
  const failJson = () =>
    new Response(JSON.stringify({ ok: false, error: "boom" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const impl = () => gate.then(() => failJson());
  const run = () => callTool({ name: "browser_snapshot" }, {}, DEVICE, {}).catch((e) => e);
  await withFetch(impl, async () => {
    const flying = [run(), run(), run(), run()];
    // Let the four calls park inside their slots (microtask drain, no sleep).
    await Promise.resolve();
    await Promise.resolve();
    const fifth = await run();
    assert.equal(fifth?.code, "SESSION_BUSY", "5th concurrent call must back off");
    assert.match(String(fifth?.message || fifth), /too many concurrent/);
    release();
    const settled = await Promise.all(flying);
    assert.equal(settled.length, 4);
    assert(
      settled.every((e) => String(e?.message || e).includes("boom")),
      "the parked four fail with the device error once released",
    );
  });
});

// ── Heal-arm + failure-shape remainder (round-400) ──

test("self-heal: 'session not found' (round-132 idle reclaim) heals like 'not connected'", async () => {
  let n = 0;
  const { calls, impl } = makeFetch((url) => {
    if (String(url).endsWith("/api/tools/mcp_client_call")) {
      n += 1;
      if (n === 1) {
        return {
          status: 200,
          json: async () => ({
            ok: false,
            error: "Session not found: abc (idle reclaim?)",
            code: "session_not_found",
          }),
        };
      }
      return okJson({ elements: [] });
    }
    return okJson({ status: "started" });
  });
  const result = await withFetch(impl, () =>
    callTool({ name: "browser_snapshot" }, {}, DEVICE, { device: "d1" }),
  );
  assert.deepEqual(result, { ok: true, result: { elements: [] } });
  const urls = calls.map((c) => c.url.split("/").pop());
  assert.deepEqual(urls, ["mcp_client_call", "start", "mcp_client_connect", "mcp_client_call"]);
});

test("non-JSON device body throws mcp_client_call failed with the status", async () => {
  const { impl } = makeFetch(() => ({
    status: 502,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  }));
  const err = await withFetch(impl, () =>
    callTool({ name: "browser_snapshot" }, {}, DEVICE, { device: "d1" }).catch((e) => e),
  );
  assert.match(String(err?.message || err), /mcp_client_call failed: 502/);
});

test("slot released after a failed call: same device serves the next call", async () => {
  let mode = "fail";
  const { impl } = makeFetch((url) => {
    if (String(url).endsWith("/api/tools/mcp_client_call")) {
      if (mode === "fail")
        return { status: 200, json: async () => ({ ok: false, error: "permanent boom" }) };
      return okJson({ done: true });
    }
    return okJson({ status: "started" });
  });
  await withFetch(impl, async () => {
    // 4 concurrent failures occupy then release all slots …
    const errs = await Promise.all(
      [1, 2, 3, 4].map(() =>
        callTool({ name: "browser_snapshot" }, {}, DEVICE, {}).catch((e) => e),
      ),
    );
    assert.ok(errs.every((e) => String(e?.message || e).includes("permanent boom")));
    // … so the next call is NOT SESSION_BUSY and succeeds.
    mode = "ok";
    const result = await callTool({ name: "browser_snapshot" }, {}, DEVICE, {});
    assert.deepEqual(result, { ok: true, result: { done: true } });
  });
});

/* ---------------- the suffix allowlist, AT DIAL TIME ----------------
 * It used to run only at REGISTRATION (`/api/register`, self-register), and two admin write
 * paths skipped even that — so a record with a hostile hostname could exist. A dial-time
 * check is the one that cannot be bypassed by a path someone forgot to guard, which is
 * exactly how the registration-only version failed.
 *
 * This fixture is a LEGACY RECORD: it exists, and the dial must still refuse it.
 */
test("a device record outside the suffix allowlist is never dialled, token included", async () => {
  const legacy = { name: "legacy", hostname: "attacker.example.com", token: "leaked-token-xyz" };
  const calls = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  // The refusal REJECTS (DEVICE_UNREACHABLE), it does not silently no-op — so the caller
  // learns why instead of seeing an empty result.
  await assert.rejects(
    withFetch(impl, () =>
      callTool({ name: "browser_run_script" }, {}, legacy, { device: "legacy" }),
    ),
    /hostname must be under/,
    "the dial must refuse with the allowlist reason",
  );
  assert.equal(
    calls.length,
    0,
    "a record outside the allowlist must not be dialled at all -- and this is why the check belongs at DIAL time, not only at registration",
  );
});

test("...and a record INSIDE the allowlist still dials (the guard is a filter, not a wall)", async () => {
  const ok = { name: "ok1", hostname: "ok1.agent.saisi.online", token: "t" };
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  await withFetch(impl, () => callTool({ name: "browser_run_script" }, {}, ok, { device: "ok1" }));
  assert.equal(calls.length, 1, "a legitimate device must still be dialled");
});
