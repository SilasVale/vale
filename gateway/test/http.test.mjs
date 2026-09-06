// http.ts foundation pins (round-467, coverage-driven: the
// isLoopbackOrigin/requestOrigin catch arms had ZERO direct pins).
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ORIGINS,
  isLoopbackOrigin,
  isLoopbackHost,
  isAllowedOrigin,
} from "../src/http.ts";

test("loopback origin/host matrix + malformed input is never loopback", () => {
  assert.equal(isLoopbackOrigin("http://localhost:8787"), true);
  assert.equal(isLoopbackOrigin("https://127.0.0.1:443"), true);
  assert.equal(isLoopbackOrigin("https://console.example.com"), false);
  assert.equal(isLoopbackOrigin("http://[::1"), false, "unparseable → false, never throws");
  assert.equal(isLoopbackOrigin(""), false);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});

test("allowed-origin: empty no, allowlist yes, loopback only with loopback host", () => {
  assert.equal(isAllowedOrigin(""), false);
  const listed = [...ALLOWED_ORIGINS][0];
  assert.ok(listed, "allowlist is non-empty");
  assert.equal(isAllowedOrigin(listed), true);
  assert.equal(isAllowedOrigin("http://localhost:8787", "localhost"), true);
  assert.equal(isAllowedOrigin("http://localhost:8787", "console.example.com"), false,
    "loopback Origin at the deployed host gets no ACAO (audit P2)");
  assert.equal(isAllowedOrigin("http://localhost:8787"), false, "no host → no grant");
  assert.equal(isAllowedOrigin("https://evil.example.com", "localhost"), false);
});
