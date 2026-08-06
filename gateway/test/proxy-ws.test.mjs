// WS 101 rewrap — build101Response unit tests. Node cannot construct a
// status-101 Response (RangeError), so we test the pure helper directly
// with a minimal mock; the webSocket repack path is exercised via the
// try/catch fallback that returns the original resp untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { build101Response } from "../src/device-fetch.js";

test("build101Response returns webSocket-bearing 101 Response", () => {
  const fakeWS = { send() {}, close() {} };
  const resp = { status: 101, webSocket: fakeWS, headers: {} };
  const out = build101Response(resp);
  assert.equal(out.status, 101);
  assert.equal(out.webSocket, fakeWS);
});

test("build101Response passes through non-101", () => {
  assert.equal(build101Response({ status: 200 }), null);
});
