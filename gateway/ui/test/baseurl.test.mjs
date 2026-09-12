// `clientBase` pins — the console's copy-paste client config.
//
// The old code prefixed `https://` unconditionally, so an operator who set
// `API_HOST=https://api.saisi.online` produced
// "ANTHROPIC_BASE_URL": "https://https://api.saisi.online" on the one screen
// whose entire purpose is to be pasted into Claude Code. The live value happens
// to be bare, so nothing was broken in production — the ASSUMPTION was.
import test from "node:test";
import assert from "node:assert/strict";
import { clientBase } from "../src/lib/baseUrl.ts";

test("a BARE host gets the scheme", () => {
  assert.equal(clientBase("api.saisi.online"), "https://api.saisi.online");
});

test("a host that ALREADY has a scheme is left alone", () => {
  // The regression. Both spellings are natural for an operator to write, and
  // only one of them used to work.
  assert.equal(clientBase("https://api.saisi.online"), "https://api.saisi.online");
  assert.equal(clientBase("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(clientBase("HTTPS://API.SAISI.ONLINE"), "HTTPS://API.SAISI.ONLINE");
});

test("nothing configured falls back to the public host", () => {
  assert.equal(clientBase(""), "https://api.saisi.online");
  assert.equal(clientBase(null), "https://api.saisi.online");
  assert.equal(clientBase(undefined), "https://api.saisi.online");
  assert.equal(clientBase("   "), "https://api.saisi.online");
});

test("no output ever contains a doubled scheme", () => {
  for (const input of ["api.saisi.online", "https://api.saisi.online", "", null, "  x  "]) {
    const out = clientBase(input);
    assert.ok(!out.includes("https://https://"), `doubled scheme from ${JSON.stringify(input)}: ${out}`);
    assert.ok(/^https?:\/\//.test(out), `no scheme from ${JSON.stringify(input)}: ${out}`);
    assert.ok(!/\s/.test(out), `whitespace survived from ${JSON.stringify(input)}: ${out}`);
  }
});
