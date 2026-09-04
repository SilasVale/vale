// deviceHostError precision (SSRF guard shared by deviceFetch + the MCP
// browser bridge): 172.16/12 is second-octet 16-31 only (not all of 172/8),
// and the fc/fd/fe80 v6 prefixes must be actual address forms (contain ':'
// — hostnames never do), so 'fc.example.com' stays reachable.
import test from "node:test";
import assert from "node:assert/strict";
import { deviceHostError } from "../src/device-fetch.ts";

test("172.16/12 blocked: 172.16.x through 172.31.x", () => {
  for (const h of ["172.16.0.1", "172.20.5.4", "172.31.255.255"]) {
    assert.match(deviceHostError(h) || "", /private\/internal/, `${h} blocked`);
  }
});

test("172/8 outside 16/12 allowed: 172.15.x and 172.32.x", () => {
  for (const h of ["172.15.0.1", "172.32.0.1", "172.0.0.1", "172.33.1.2"]) {
    assert.equal(deviceHostError(h), null, `${h} allowed`);
  }
});

test("hostname strings with v6-like prefixes allowed: fc.example.com", () => {
  for (const h of ["fc.example.com", "fd.example.com", "fe80.example.com"]) {
    assert.equal(deviceHostError(h), null, `${h} allowed`);
  }
});

test("actual v6 private forms still blocked", () => {
  for (const h of ["fc00::1", "fd00::1234", "fe80::1"]) {
    assert.match(deviceHostError(h) || "", /private\/internal/, `${h} blocked`);
  }
});

test("classic guards unchanged: loopback, mapped, metadata, public", () => {
  for (const h of ["127.0.0.1", "::ffff:127.0.0.1", "localhost", "10.0.0.5", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1"]) {
    assert.match(deviceHostError(h) || "", /private\/internal/, `${h} blocked`);
  }
  for (const h of ["d1.agent.saisi.online", "example.com", "8.8.8.8"]) {
    assert.equal(deviceHostError(h), null, `${h} allowed`);
  }
});
