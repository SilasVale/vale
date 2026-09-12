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

test("agent port: predicates follow setAgentPort, default stays 18080", async () => {
  const m = await import("../src/url-policy.js");
  try {
    assert.equal(m.getAgentPort(), 18080, "default is canonical");
    assert.equal(m.agentBase(), "http://127.0.0.1:18080");
    m.setAgentPort(7740);
    assert.equal(m.getAgentPort(), 7740);
    assert.equal(m.agentBase(), "http://127.0.0.1:7740");
    assert.equal(m.isBaseOrigin("http://127.0.0.1:7740/desktop/"), true, "bridge follows the port");
    assert.equal(m.isBaseOrigin("http://127.0.0.1:18080/desktop/"), false, "old port no longer matches");
    assert.equal(m.isDesktopSpaUrl("http://127.0.0.1:7740/desktop/settings"), true);
    m.setAgentPort(0);
    m.setAgentPort(99999);
    m.setAgentPort(NaN);
    assert.equal(m.getAgentPort(), 7740, "invalid ports are ignored");
  } finally {
    m.setAgentPort(18080);
  }
  assert.equal(m.isBaseOrigin("http://127.0.0.1:18080/desktop/"), true, "default restored");
});

test("parseAgentPort: server.port only, strict", async () => {
  const { parseAgentPort } = await import("../src/url-policy.js");
  assert.equal(parseAgentPort('server:\n  host: "0.0.0.0"\n  port: 7740\n'), 7740);
  assert.equal(parseAgentPort('server:\n  port: 18080\n'), 18080);
  assert.equal(parseAgentPort('server:\n  host: "127.0.0.1"\n'), null, "absent port");
  assert.equal(parseAgentPort('serial:\n  port: 1234\n'), null, "non-server section ignored");
  assert.equal(parseAgentPort('server:\n  port: 0\n'), null, "ephemeral rejected");
  assert.equal(parseAgentPort('server:\n  port: 99999\n'), null, "out of range rejected");
  assert.equal(parseAgentPort('server:\n  port: abc\n'), null, "non-numeric rejected");
  assert.equal(parseAgentPort(""), null);
});

// THE LOOPBACK CONTROL API'S ORIGIN VETO (port 9444).
//
// This predicate lived as an inline regex IN main.ts with no `$` anchor, so
// `http://127.0.0.1.evil.com` passed it — the exact class the module header
// records as IPC audit #1 ("startsWith(BASE) was BYPASSABLE"), whose
// `isDesktopSpaUrl` test TWO TESTS ABOVE pins the sibling-host lookalike for.
// The HTTP twin simply never moved into the policy module, and this suite ran
// NOWHERE in CI, so nothing could notice.
test("controlOriginOk: the loopback control API's origin veto", async () => {
  const { controlOriginOk } = await import("../src/url-policy.js");

  // Allowed: the desktop SPA and any loopback port.
  assert.equal(controlOriginOk("http://127.0.0.1:9444"), true);
  assert.equal(controlOriginOk("http://127.0.0.1:18080"), true);
  assert.equal(controlOriginOk("http://localhost:9444"), true);
  assert.equal(controlOriginOk("file:///C:/x/wait.html"), true);
  // ABSENT and "null" are deliberate: curl and native tooling send no Origin,
  // and the data: wait page sends "null". That carve-out is documented in
  // main.ts and is what keeps this a nuisance barrier rather than auth.
  assert.equal(controlOriginOk(undefined), true);
  assert.equal(controlOriginOk(""), true);
  assert.equal(controlOriginOk("null"), true);

  // THE LOOKALIKES THE OLD REGEX ADMITTED — each one a page an attacker hosts.
  assert.equal(controlOriginOk("http://127.0.0.1.evil.com"), false, "sibling-host lookalike");
  assert.equal(controlOriginOk("http://localhost.evil.com"), false, "sibling-host lookalike");
  assert.equal(controlOriginOk("http://127.0.0.1x"), false, "trailing character");
  assert.equal(controlOriginOk("http://127.0.0.1.evil.com:9444"), false);
  // The userinfo trick from IPC audit #1, applied to this path.
  assert.equal(controlOriginOk("http://127.0.0.1:9444@evil.com"), false, "userinfo trick");
  assert.equal(controlOriginOk("https://127.0.0.1:9444"), true, "https loopback is still loopback");
  assert.equal(controlOriginOk("http://evil.com"), false);
  assert.equal(controlOriginOk("http://192.168.1.5:9444"), false, "not loopback");
  assert.equal(controlOriginOk("chrome-extension://abcd"), false);
  // A value the policy cannot READ must never be treated as one it recognises.
  assert.equal(controlOriginOk("not a url"), false);
});
