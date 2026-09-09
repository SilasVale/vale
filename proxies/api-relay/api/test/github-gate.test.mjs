// /api/github gate pins (SOLID Round-21 — route/redirect guards exported
// additively; handler reached with a stubbed fetch, zero network). What
// must never regress: only the four route types ride, traversal dies in
// safePath, redirects are followed ONLY within the allowlist (no
// server-side open fetch), credentials never ride upstream, and response
// headers stay allowlisted with open CORS.
import test from "node:test";
import assert from "node:assert/strict";
import handler, { safePath, parseRoute, redirectTarget } from "../github.ts";

async function withStubFetch(handlerFn, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handlerFn;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const never = async () => {
  throw new Error("must not be called");
};
const get = (url, headers = {}) => new Request(url, { method: "GET", headers });

// ── safePath table ─────────────────────────────────────

test("safePath: rooted clean paths pass; hostile shapes fail", () => {
  assert.equal(safePath("/web/o/r"), true);
  assert.equal(safePath("/"), true);
  for (const evil of [
    "",
    "web/o",
    "/a\\b",
    "/a\0b",
    "/a/../b",
    "..",
    "%zz",
    "/%2e%2e/evil",
    "/a\r\nb",
    "/a\x1fb",
  ]) {
    assert.equal(safePath(evil), false, `rejected: ${JSON.stringify(evil)}`);
  }
});

// ── parseRoute table ───────────────────────────────────

test("parseRoute: four types map, everything else is null", () => {
  assert.deepEqual(parseRoute("/web/o/r/tarball"), { base: "https://github.com", path: "/o/r/tarball" });
  assert.deepEqual(parseRoute("/raw/o/r/main/f"), {
    base: "https://raw.githubusercontent.com",
    path: "/o/r/main/f",
  });
  assert.deepEqual(parseRoute("/api/repos/o/r"), { base: "https://api.github.com", path: "/repos/o/r" });
  assert.deepEqual(parseRoute("/release/o/r/a"), { base: "https://github.com", path: "/o/r/a" });
  for (const bad of [null, "", "/evil/o/r", "/web", "web/o/r", "/web/../evil"]) {
    assert.equal(parseRoute(bad), null, `rejected: ${JSON.stringify(bad)}`);
  }
});

// ── redirectTarget table ───────────────────────────────

test("redirectTarget: allowlisted https only, resolved against current", () => {
  const cur = new URL("https://github.com/o/r");
  const loc = (v) => new Response(null, { status: 302, headers: v ? { location: v } : {} });
  assert.equal(redirectTarget(loc(null), cur), null, "no location");
  assert.equal(redirectTarget(loc("/o/r2"), cur)?.href, "https://github.com/o/r2", "relative stays in-allowlist");
  assert.equal(
    redirectTarget(loc("https://objects.githubusercontent.com/x"), cur)?.hostname,
    "objects.githubusercontent.com",
    "release-asset hosts allowed",
  );
  assert.equal(redirectTarget(loc("https://evil.example/x"), cur), null, "foreign host");
  assert.equal(redirectTarget(loc("http://github.com/x"), cur), null, "http scheme");
  assert.equal(redirectTarget(loc("https://github.com.evil.example/"), cur), null, "suffix spoof");
});

// ── handler pre-fetch gates ────────────────────────────

test("OPTIONS answers open CORS without touching upstream", async () => {
  const r = await withStubFetch(never, () =>
    handler(new Request("https://r.example/api/github", { method: "OPTIONS" })),
  );
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("non-GET/HEAD → 405; bad route → 400", async () => {
  const m = await withStubFetch(never, () =>
    handler(new Request("https://r.example/api/github?path=/web/o", { method: "POST" })),
  );
  assert.equal(m.status, 405);
  const b = await withStubFetch(never, () => handler(get("https://r.example/api/github?path=/evil/o")));
  assert.equal(b.status, 400);
  const n = await withStubFetch(never, () => handler(get("https://r.example/api/github")));
  assert.equal(n.status, 400, "missing path param");
});

// ── upstream-reaching contract (stubbed fetch) ─────────

function okUpstream(seen, body = "data", headers = { "content-type": "text/plain", etag: '"e1"' }) {
  return async (url, init) => {
    seen.calls.push({ url: String(url), init });
    return new Response(body, { status: 200, headers });
  };
}

test("happy path: upstream URL composed, query kept minus path, headers filtered", async () => {
  const seen = { calls: [] };
  const r = await withStubFetch(okUpstream(seen), () =>
    handler(
      get("https://r.example/api/github?path=/raw/o/r/main/f&ref=abc", {
        authorization: "Bearer sk-should-not-ride",
        cookie: "sess=1",
        "x-evil": "nope",
        range: "bytes=0-99",
      }),
    ),
  );
  assert.equal(r.status, 200);
  assert.equal(seen.calls.length, 1);
  const [call] = seen.calls;
  assert.equal(call.url, "https://raw.githubusercontent.com/o/r/main/f?ref=abc");
  const uh = new Headers(call.init.headers);
  assert.equal(uh.get("authorization"), null, "credentials never forwarded");
  assert.equal(uh.get("cookie"), null);
  assert.equal(uh.get("x-evil"), null);
  assert.equal(uh.get("range"), "bytes=0-99", "allowlisted request headers pass");
  assert.equal(r.headers.get("etag"), '"e1"', "allowlisted response headers pass");
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("allowlisted redirect followed; foreign redirect returned, never fetched", async () => {
  const seen = { calls: [] };
  const hopping = async (url, init) => {
    seen.calls.push(String(url));
    if (seen.calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://objects.githubusercontent.com/asset" },
      });
    }
    return new Response("asset", { status: 200, headers: { "content-type": "application/octet-stream" } });
  };
  const r = await withStubFetch(hopping, () => handler(get("https://r.example/api/github?path=/release/o/r")));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "asset");
  assert.equal(seen.calls.length, 2);

  const seen2 = { calls: [] };
  const evilHop = async (url) => {
    seen2.calls.push(String(url));
    return new Response(null, { status: 302, headers: { location: "https://evil.example/loot" } });
  };
  const r2 = await withStubFetch(evilHop, () => handler(get("https://r.example/api/github?path=/web/o/r")));
  assert.equal(r2.status, 302, "foreign target surfaced, not followed server-side");
  assert.equal(seen2.calls.length, 1, "no second fetch to the attacker host");
});

test("redirect storm → 502 after the cap; upstream throw → 502 unavailable", async () => {
  let n = 0;
  const storm = async () => {
    n += 1;
    return new Response(null, { status: 302, headers: { location: "https://github.com/loop" } });
  };
  const r = await withStubFetch(storm, () => handler(get("https://r.example/api/github?path=/web/o")));
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /too many/);
  assert.equal(n, 6, "initial + 5 follows, then the cap trips");

  const down = async () => {
    throw new Error("conn reset");
  };
  // Silence the expected error log for the assertion run.
  const orig = console.error;
  console.error = () => {};
  try {
    const r2 = await withStubFetch(down, () => handler(get("https://r.example/api/github?path=/api/x")));
    assert.equal(r2.status, 502);
    assert.match((await r2.json()).error, /unavailable/);
  } finally {
    console.error = orig;
  }
});
