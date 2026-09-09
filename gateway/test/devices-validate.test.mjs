// Device-registration validation pins (SOLID Round-28 — four helpers
// exported additively; handlers untouched). The registration boundary
// (suffix allowlist, name/hostname/token shapes, MCP snippet) previously
// had zero direct pins — only incidental exercise through handler suites.
// A wrong regex here either locks out legit devices or admits hostile
// names/hostnames, so the table is fixed exactly as implemented.
import test from "node:test";
import assert from "node:assert/strict";
import {
  hostAllowError,
  validateDevice,
  validatedDeviceOrError,
  mcpConfig,
} from "../src/plugins/devices.ts";

test("hostAllowError: default suffix, case-insensitive, bare suffix refused", () => {
  assert.equal(hostAllowError("d1.agent.saisi.online", {}), null);
  assert.equal(hostAllowError("D1.Agent.Saisi.Online", {}), null, "case-insensitive");
  assert.match(hostAllowError("evil.example.com", {}) || "", /agent\.saisi\.online/);
  assert.ok(hostAllowError("agent.saisi.online", {}) !== null, "bare suffix (no label) refused");
  assert.ok(hostAllowError(".agent.saisi.online", {}) !== null, "dot-only label refused");
});

test("hostAllowError: configurable suffix overrides the default", () => {
  const env = { DEVICE_HOST_SUFFIX: ".example.com" };
  assert.equal(hostAllowError("d.example.com", env), null);
  assert.match(
    hostAllowError("d1.agent.saisi.online", env) || "",
    /\.example\.com/,
    "default no longer applies",
  );
});

test("validateDevice: trims and returns the record", () => {
  assert.deepEqual(
    validateDevice({ name: " d1 ", hostname: " d1.agent.saisi.online ", token: " 01234567 " }),
    { name: "d1", hostname: "d1.agent.saisi.online", token: "01234567" },
  );
});

test("validateDevice: name/hostname/token shapes rejected", () => {
  const good = { name: "d1", hostname: "d1.agent.saisi.online", token: "01234567" };
  for (const name of ["", "a b", "a/b", "a".repeat(33), "d!1"]) {
    assert.throws(() => validateDevice({ ...good, name }), /Device name/, JSON.stringify(name));
  }
  assert.doesNotThrow(() => validateDevice({ ...good, name: "a".repeat(32) }), "32 chars ok");
  assert.doesNotThrow(() => validateDevice({ ...good, name: "a_B-9" }), "word chars + dash ok");
  for (const hostname of ["", "not a host", "a_b.com", "localhost", "d1.", ".d1.x"]) {
    assert.throws(() => validateDevice({ ...good, hostname }), /hostname/, JSON.stringify(hostname));
  }
  assert.throws(() => validateDevice({ ...good, token: "1234567" }), /Token/, "7 chars short");
  assert.throws(() => validateDevice({ ...good, token: "" }), /Token/);
  assert.doesNotThrow(() => validateDevice({ ...good, token: "12345678" }), "exactly 8 ok");
  assert.throws(() => validateDevice(null), /Device name/, "null body");
});

test("validatedDeviceOrError: record or 400 envelope, never throws", () => {
  const ok = validatedDeviceOrError({ name: "d1", hostname: "d1.agent.saisi.online", token: "01234567" });
  assert.ok(!(ok instanceof Response));
  assert.equal(ok.name, "d1");
  const bad = validatedDeviceOrError({ name: "no good!", hostname: "x", token: "y" });
  assert.ok(bad instanceof Response);
  assert.equal(bad.status, 400);
});

test("mcpConfig: snippet shape carries the Bearer token", () => {
  const { url, json } = mcpConfig({ name: "d1", hostname: "d1.agent.saisi.online", token: "tok-1" });
  assert.equal(url, "https://d1.agent.saisi.online/mcp");
  const snippet = JSON.parse(json);
  assert.equal(
    snippet.mcpServers["vale-agent"].headers.Authorization,
    "Bearer tok-1",
  );
});
