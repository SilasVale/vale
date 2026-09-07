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

// Main-window tripwire allow-list: parsed-origin + parsed-pathname (the
// string-prefix startsWith(BASE + "/desktop") it replaced was the exact
// class IPC audit #1 flagged).
test("isDesktopSpaUrl: parsed origin + /desktop subtree only", async () => {
  const { isDesktopSpaUrl } = await import("../src/url-policy.js");
  assert.equal(isDesktopSpaUrl("http://127.0.0.1:18080/desktop"), true);
  assert.equal(isDesktopSpaUrl("http://127.0.0.1:18080/desktop/settings"), true);
  assert.equal(isDesktopSpaUrl("http://127.0.0.1:18080/desktopx"), false, "/desktop must be a path segment");
  assert.equal(isDesktopSpaUrl("http://127.0.0.1:18080/"), false);
  assert.equal(isDesktopSpaUrl("http://127.0.0.1:18080.evil.com/desktop"), false, "sibling-host lookalike");
  assert.equal(isDesktopSpaUrl("http://127.0.0.1:18080@evil.com/desktop"), false, "userinfo trick");
  assert.equal(isDesktopSpaUrl("https://127.0.0.1:18080/desktop"), false, "scheme is part of the origin");
  assert.equal(isDesktopSpaUrl("data:text/html,wait"), false);
  assert.equal(isDesktopSpaUrl("about:blank"), false);
  assert.equal(isDesktopSpaUrl("not a url"), false);
});

test("isPrivateHost: RFC1918 + loopback + .local only", async () => {
  const { isPrivateHost } = await import("../src/url-policy.js");
  assert.equal(isPrivateHost("192.168.1.1"), true, "ONT lab net");
  assert.equal(isPrivateHost("10.0.0.5"), true);
  assert.equal(isPrivateHost("172.16.0.1"), true);
  assert.equal(isPrivateHost("172.31.255.255"), true);
  assert.equal(isPrivateHost("127.0.0.1"), true);
  assert.equal(isPrivateHost("localhost"), true);
  assert.equal(isPrivateHost("printer.local"), true);
  assert.equal(isPrivateHost("172.15.0.1"), false, "just outside 172.16/12");
  assert.equal(isPrivateHost("172.32.0.1"), false, "just outside 172.16/12");
  assert.equal(isPrivateHost("8.8.8.8"), false, "public stays strict");
  assert.equal(isPrivateHost("example.com"), false);
  assert.equal(isPrivateHost("192.168.1.1.evil.com"), false, "suffix lookalike");
  assert.equal(isPrivateHost(""), false);
});

test("certBypassAllowed: private http(s) only", async () => {
  const { certBypassAllowed } = await import("../src/url-policy.js");
  assert.equal(certBypassAllowed("https://192.168.1.1:8000/?Role=Gpon"), true, "ONT web UI");
  assert.equal(certBypassAllowed("http://10.1.2.3/"), true);
  assert.equal(certBypassAllowed("https://example.com/"), false, "public internet stays validated");
  assert.equal(certBypassAllowed("file:///C:/Windows/win.ini"), false, "schemes stay gated");
  assert.equal(certBypassAllowed("not a url"), false);
});
