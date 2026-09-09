// shared.js guard pins (SOLID Round-24 — the extension's FIRST unit
// tests: CI gated syntax only until now). httpsOrigin is the MITM guard
// for the code-server session cookies: http must never pass, and only a
// bare origin may come out. shared.js stays a classic script (manifest
// load order + isolated-world channel); the module.exports shim at its
// tail is inert in the browser and feeds this file under node.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DEFAULT_STUDIO_ORIGIN, httpsOrigin } = require("../shared.js");

test("default origin is the code-server host", () => {
  assert.equal(DEFAULT_STUDIO_ORIGIN, "https://vscode.saisi.online");
  assert.equal(httpsOrigin(DEFAULT_STUDIO_ORIGIN), DEFAULT_STUDIO_ORIGIN, "default passes its own guard");
});

test("https URLs normalize to the bare origin (path/query/port kept correctly)", () => {
  assert.equal(httpsOrigin("https://vscode.saisi.online/a/b?q=1"), "https://vscode.saisi.online");
  assert.equal(httpsOrigin("https://h.example:8443/x"), "https://h.example:8443", "explicit port kept");
  assert.equal(httpsOrigin("HTTPS://UPPER.example/x"), "https://upper.example", "scheme/host normalized");
});

test("http never passes (MITM guard for session cookies)", () => {
  for (const v of ["http://vscode.saisi.online/", "http://localhost:8080/", "http://127.0.0.1/"]) {
    assert.equal(httpsOrigin(v), null, `cleartext rejected: ${v}`);
  }
});

test("non-URLs are null, never throw", () => {
  for (const v of ["", "notaurl", "//protocol-relative", "ftp://h.example/x", null, undefined, 42]) {
    assert.equal(httpsOrigin(v), null, `rejected: ${JSON.stringify(v)}`);
  }
});
