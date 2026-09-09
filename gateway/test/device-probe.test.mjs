// Device-probe classification pins (SOLID Round-31 — cachedDeviceProbe
// exported additively; plugin wiring untouched). The tunnel/agent split
// decides what the console health card shows, and its two historical bugs
// (round-98: cache never hit; round-101: down devices showed tunnel_up)
// were both silent misclassifications — exactly what direct pins prevent.
// deviceFetch dials through the stubbed global fetch; distinct device
// names isolate the 30s module cache per case (no sleeps).
import test from "node:test";
import assert from "node:assert/strict";
import { cachedDeviceProbe } from "../src/plugins/mcp.ts";
import { withFetch, assertFetchCalls } from "./helpers.mjs";

const dev = (name) => ({ name, hostname: "d1.agent.saisi.online", token: "tok-device-1" });
const statusJson = (obj) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });

test("tunnel down (fetch throws) → tunnel/agent false, no version", async () => {
  const p = await withFetch(async () => {
    throw new TypeError("fetch failed");
  }, () => cachedDeviceProbe({}, dev("r31-down")));
  assert.equal(p.tunnel, false, "round-101: unreachable tunnel must read false");
  assert.equal(p.agent, false);
  assert.equal(p.version, undefined);
});

test("tunnel up, agent down (HTTP error, no unreachable shape) → split verdict", async () => {
  const p = await withFetch(async () => new Response("bad", { status: 500 }), () =>
    cachedDeviceProbe({}, dev("r31-agentdown")),
  );
  assert.equal(p.tunnel, true, "an HTTP answer proves the tunnel");
  assert.equal(p.agent, false);
});

test("healthy device: agent+tunnel true, npm release preferred, version fallback", async () => {
  const rel = await withFetch(async () => statusJson({ release: "1.2.307", version: "1.0.145" }), () =>
    cachedDeviceProbe({}, dev("r31-rel")),
  );
  assert.equal(rel.agent, true);
  assert.equal(rel.tunnel, true);
  assert.equal(rel.version, "1.2.307", "release beats the frozen Cargo version");
  assert.ok(typeof rel.checkedAt === "number" && rel.checkedAt > 0);

  const leg = await withFetch(async () => statusJson({ version: "1.0.140" }), () =>
    cachedDeviceProbe({}, dev("r31-leg")),
  );
  assert.equal(leg.version, "1.0.140", "pre-release agents fall back to version");

  const bare = await withFetch(async () => statusJson({}), () => cachedDeviceProbe({}, dev("r31-bare")));
  assert.equal(bare.agent, true);
  assert.equal(bare.version, undefined, "no version fields → absent, not fabricated");
});

test("30s cache: repeat probe makes no second fetch; fresh=1 bypasses", async () => {
  await withFetch(async () => statusJson({ release: "1.2.307" }), async () => {
    const a = await cachedDeviceProbe({}, dev("r31-cache"));
    const b = await cachedDeviceProbe({}, dev("r31-cache"));
    assert.equal(a.version, "1.2.307");
    assert.equal(b.version, "1.2.307");
    assertFetchCalls(1, "round-98: second poll served from cache");
    await cachedDeviceProbe({}, dev("r31-cache"), true);
    assertFetchCalls(2, "fresh bypasses the read (console check-now)");
  });
});
