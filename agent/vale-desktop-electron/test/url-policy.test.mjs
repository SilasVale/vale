// Electron first tests (coverage audit row 15): the pure origin/URL
// security predicates behind the IPC hardening. Compiled JS is imported
// (dist/ mirrors src/); run via `npm test` in this directory.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { isBaseOrigin, frameUrlOk, sanitizeBrowserUrl } = require("../src/url-policy.js");

test("isBaseOrigin: userinfo-trick bypass stays closed (IPC audit #1)", () => {
  assert.equal(isBaseOrigin("http://127.0.0.1:18080/desktop/"), true);
  assert.equal(isBaseOrigin("http://127.0.0.1:18080@evil.com/x"), false, "userinfo prefix must NOT pass");
  assert.equal(isBaseOrigin("http://evil.com/?u=http://127.0.0.1:18080"), false);
  assert.equal(isBaseOrigin("http://127.0.0.1:18081/"), false, "port matters");
  assert.equal(isBaseOrigin("not a url"), false);
  assert.equal(isBaseOrigin(""), false);
});

test("frameUrlOk: only pinned-origin frames reach the IPC bridge (audit #2)", () => {
  assert.equal(frameUrlOk("http://127.0.0.1:18080/panel/"), true);
  assert.equal(frameUrlOk("data:text/html,hi"), false, "wait-page frames get no bridge");
  assert.equal(frameUrlOk("file:///etc/passwd"), false);
  assert.equal(frameUrlOk(""), false);
});

test("sanitizeBrowserUrl: http/https/about:blank only", () => {
  assert.equal(sanitizeBrowserUrl("file:///C:/Windows/win.ini"), "about:blank");
  assert.equal(sanitizeBrowserUrl("javascript:alert(1)"), "about:blank");
  assert.equal(sanitizeBrowserUrl("chrome://settings"), "about:blank");
  assert.equal(sanitizeBrowserUrl("https://ok.example/a?x=1"), "https://ok.example/a?x=1");
  assert.equal(sanitizeBrowserUrl(undefined), "about:blank");
});
