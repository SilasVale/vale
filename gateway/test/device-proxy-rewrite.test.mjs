// Proxy-body rewrite pins (SOLID Round-14, test completion).
//
// Audit finding: rewriteDeviceBody — the pure transform behind proxyDevice
// (mount-prefix rewriting + permanent-token stripping, i.e. the revocation
// scope the plugin token exists to enforce) — was module-private with zero
// direct pins. Round-14 exports it (additive; the proxy path is untouched)
// and fixes its contract here: prefix insertion per root-path class, the
// already-proxied no-double-write guard, the template-`}` arm, token
// stripping in both quote styles, and decodeDeviceName's null-on-bad-escape.
import test from "node:test";
import assert from "node:assert/strict";
import {
  rewriteDeviceBody,
  decodeDeviceName,
  DEVICE_BASE,
} from "../src/plugins/device-proxy.ts";

const M = (name = "d1") => `${DEVICE_BASE}/${name}/proxy`;

test("asset paths gain the proxy mount", () => {
  assert.equal(
    rewriteDeviceBody('<script src="/app.js"></script>', "d1"),
    `<script src="${M()}/app.js"></script>`,
  );
  assert.equal(
    rewriteDeviceBody('fetch("/api/status?x=1")', "d1"),
    `fetch("${M()}/api/status?x=1")`,
  );
  assert.equal(
    rewriteDeviceBody('<link href="/vendor/x.css">', "d1"),
    `<link href="${M()}/vendor/x.css">`,
  );
  assert.equal(rewriteDeviceBody("go('/mcp')", "d1"), `go('${M()}/mcp')`);
});

test("already-proxied URLs are never double-written", () => {
  const once = `"${M("d2")}/app.js"`;
  assert.equal(rewriteDeviceBody(once, "d1"), once, "foreign-device mount untouched");
  assert.equal(rewriteDeviceBody(`"${M()}/api/x"`, "d1"), `"${M()}/api/x"`, "own mount untouched");
});

test("template-interpolation close (}) arm rewrites built stream URLs", () => {
  // panel.js builds `https://${hostname}/api/events/term` — without the }
  // arm the proxied SSE stream 404'd and the panel froze.
  assert.equal(
    rewriteDeviceBody("const u=`https://${h}/api/events/term`", "d1"),
    "const u=`https://${h}" + `${M()}/api/events/term` + "`",
  );
});

test("injected device token stripped in both quote styles (revocation scope)", () => {
  assert.equal(
    rewriteDeviceBody('<script>window.__PANEL_TOKEN__="permanent-secret"</script>', "d1"),
    '<script>window.__PANEL_TOKEN__=""</script>',
  );
  assert.equal(
    rewriteDeviceBody("<script>window.__PANEL_TOKEN__ = 'permanent-secret' </script>", "d1"),
    '<script>window.__PANEL_TOKEN__="" </script>',
    "only the assignment is scrubbed, surrounding bytes kept",
  );
  // No token present → byte-identical (no collateral rewrite).
  assert.equal(rewriteDeviceBody("window.__PANEL_TOKEN__=x", "d1"), "window.__PANEL_TOKEN__=x");
});

test("non-panel text passes through byte-identical", () => {
  for (const t of ["hello world", '"app.js"', "GET /status 200", ""]) {
    assert.equal(rewriteDeviceBody(t, "d1"), t, JSON.stringify(t));
  }
});

test("decodeDeviceName: decodes, null on malformed escapes (no URIError)", () => {
  assert.equal(decodeDeviceName("d1"), "d1");
  assert.equal(decodeDeviceName("a%20b"), "a b");
  assert.equal(decodeDeviceName(""), "");
  assert.equal(decodeDeviceName("%zz"), null);
  assert.equal(decodeDeviceName("%"), null);
});
