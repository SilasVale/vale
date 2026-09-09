// /api/gform gate pins (SOLID Round-23 — the richest relay handler:
// 8 route types, SRI-neutralizing rewriter, reCAPTCHA cookie exception).
// Pure units exported additively; handler reached with a stubbed fetch.
// What must never regress: route table shape, redirect allowlist, the
// rewritable predicate, host rewriting across escape variants, SRI
// neutralization, the reCAPTCHA cookie exception staying NARROW (only
// www.google.com/recaptcha/*), POST→GET downgrade on redirect, foreign
// redirect as 502 (not surfaced), and the oversize-stream passthrough.
import test from "node:test";
import assert from "node:assert/strict";
import handler, {
  safePath,
  parseRoute,
  redirectTarget,
  rewritable,
  rewriteBody,
  setCookieValues,
} from "../gform.ts";

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

// ── route table ────────────────────────────────────

test("parseRoute: eight types map; unknown/bare/evil are null", () => {
  assert.deepEqual(parseRoute("/gle/abc"), { base: "https://forms.gle", path: "/abc" });
  assert.deepEqual(parseRoute("/docs/forms/d/e/viewform"), {
    base: "https://docs.google.com",
    path: "/forms/d/e/viewform",
  });
  assert.deepEqual(parseRoute("/gstatic/x"), { base: "https://www.gstatic.com", path: "/x" });
  assert.deepEqual(parseRoute("/ssl-gstatic/y"), { base: "https://ssl.gstatic.com", path: "/y" });
  assert.deepEqual(parseRoute("/fontscss/z"), { base: "https://fonts.googleapis.com", path: "/z" });
  assert.deepEqual(parseRoute("/fonts/w"), { base: "https://fonts.gstatic.com", path: "/w" });
  assert.deepEqual(parseRoute("/usercontent/h"), {
    base: "https://lh3.googleusercontent.com",
    path: "/h",
  });
  assert.deepEqual(parseRoute("/www/q"), { base: "https://www.google.com", path: "/q" });
  for (const bad of [null, "", "/evil/x", "/docs", "docs/x", "/docs/../x"]) {
    assert.equal(parseRoute(bad), null, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.equal(safePath("/ok/path"), true);
  assert.equal(safePath("/a/../b"), false);
});

// ── redirect allowlist ─────────────────────────────

test("redirectTarget: eight Google hosts, https only", () => {
  const cur = new URL("https://docs.google.com/forms");
  const loc = (v) => new Response(null, { status: 302, headers: v ? { location: v } : {} });
  assert.equal(redirectTarget(loc(null), cur), null);
  assert.equal(redirectTarget(loc("/next"), cur)?.href, "https://docs.google.com/next");
  assert.equal(redirectTarget(loc("https://forms.gle/x"), cur)?.hostname, "forms.gle");
  assert.equal(redirectTarget(loc("https://lh3.googleusercontent.com/i"), cur)?.hostname, "lh3.googleusercontent.com");
  assert.equal(redirectTarget(loc("https://evil.example/"), cur), null);
  assert.equal(redirectTarget(loc("https://docs.google.com.evil.example/"), cur), null, "suffix spoof");
  assert.equal(redirectTarget(loc("http://docs.google.com/"), cur), null, "https only");
});

// ── rewritable predicate ───────────────────────────

test("rewritable: text/code/json yes; media/binary/empty no", () => {
  for (const ct of ["text/html", "TEXT/HTML; charset=utf-8", "application/javascript", "text/ecmascript", "application/json"]) {
    assert.equal(rewritable(ct), true, ct);
  }
  for (const ct of [null, "", "image/png", "application/octet-stream", "application/pdf"]) {
    assert.equal(rewritable(ct), false, String(ct));
  }
});

// ── rewriteBody ────────────────────────────────────

test("rewriteBody: hosts rewritten across escape variants; SRI neutralized in HTML", () => {
  const out = rewriteBody(
    '<html><head><title>f</title></head><body><script integrity="sha384-abc" src="https://www.gstatic.com/x.js"></script><img src="//docs.google.com/img.png"></body></html>',
    "https://r.example",
    true,
  );
  assert.ok(!out.includes("integrity="), "static SRI stripped");
  assert.ok(out.includes("MutationObserver"), "neutralizer injected after <head");
  assert.ok(out.includes("https://r.example/api/gform/gstatic/x.js"), "plain host rewritten");
  assert.ok(out.includes("//r.example/api/gform/docs/img.png"), "protocol-relative rewritten");
  assert.ok(!out.includes("gstatic.com/x.js\"") || out.includes("/api/gform/"), "no bare upstream left");
});

test("rewriteBody: non-HTML skips SRI work but still rewrites hosts", () => {
  const out = rewriteBody('{"u":"https://docs.google.com/a","i":"sha384-x"}', "https://r.example", false);
  assert.ok(out.includes("https://r.example/api/gform/docs/a"), "host rewritten in JSON");
  assert.ok(out.includes('"i":"sha384-x"'), "no integrity-shaped key mangled when not HTML");
});

// ── setCookieValues ────────────────────────────────

test("setCookieValues: collects all cookies via getSetCookie or forEach fallback", () => {
  const h = new Headers();
  h.append("set-cookie", "a=1");
  h.append("set-cookie", "b=2");
  assert.deepEqual(setCookieValues(h), ["a=1", "b=2"]);
  const legacy = { forEach: (cb) => cb("c=3", "Set-Cookie") };
  assert.deepEqual(setCookieValues(legacy), ["c=3"], "legacy Headers without getSetCookie");
  assert.deepEqual(setCookieValues(new Headers()), [], "none → empty");
});

// ── handler gates ──────────────────────────────────

test("methods: GET/HEAD/POST pass; others 405", async () => {
  const ok = async () => new Response("x", { status: 200, headers: { "content-type": "text/plain" } });
  for (const m of ["GET", "HEAD", "POST"]) {
    const r = await withStubFetch(ok, () =>
      handler(new Request("https://r.example/api/gform?path=/gle/abc", { method: m })),
    );
    assert.equal(r.status, 200, m);
  }
  for (const m of ["PUT", "DELETE", "OPTIONS"]) {
    const r = await withStubFetch(never, () =>
      handler(new Request("https://r.example/api/gform?path=/gle/abc", { method: m })),
    );
    assert.equal(r.status, 405, `${m} rejected`);
  }
});

test("missing/evil route → 400", async () => {
  for (const u of ["https://r.example/api/gform", "https://r.example/api/gform?path=/evil/x"]) {
    const r = await withStubFetch(never, () => handler(get(u)));
    assert.equal(r.status, 400);
  }
});

// ── upstream-reaching contract ─────────────────────

function okUpstream(seen, body = "<html><head></head></html>", headers = { "content-type": "text/html" }) {
  return async (url, init) => {
    seen.calls.push({ url: String(url), init });
    return new Response(body, { status: 200, headers });
  };
}

test("happy path: URL composed, cookies dropped (non-recaptcha), body rewritten", async () => {
  const seen = { calls: [] };
  const r = await withStubFetch(okUpstream(seen), () =>
    handler(get("https://r.example/api/gform?path=/docs/forms/d/e/viewform", { cookie: "NID=1" })),
  );
  assert.equal(r.status, 200);
  assert.equal(seen.calls.length, 1);
  const [call] = seen.calls;
  assert.equal(call.url, "https://docs.google.com/forms/d/e/viewform");
  assert.equal(new Headers(call.init.headers).get("cookie"), null, "anonymous forms: no cookies");
  const text = await r.text();
  assert.ok(text.includes("MutationObserver"), "HTML rewritten through the proxy");
});

test("reCAPTCHA exception stays narrow: cookie rides only www.google.com/recaptcha/*", async () => {
  const seen = { calls: [] };
  await withStubFetch(okUpstream(seen, "{}", { "content-type": "application/json" }), () =>
    handler(get("https://r.example/api/gform?path=/www/recaptcha/anchor", { cookie: "NID=9" })),
  );
  assert.equal(new Headers(seen.calls[0].init.headers).get("cookie"), "NID=9", "recaptcha session rides");
  await withStubFetch(okUpstream(seen, "{}", { "content-type": "application/json" }), () =>
    handler(get("https://r.example/api/gform?path=/www/search?q=x", { cookie: "NID=9" })),
  );
  assert.equal(new Headers(seen.calls[1].init.headers).get("cookie"), null, "other www paths stay cookieless");
});

test("redirect: followed in-allowlist with POST→GET downgrade; foreign → 502", async () => {
  const seen = { calls: [] };
  let n = 0;
  const hopping = async (url, init) => {
    seen.calls.push({ url: String(url), init });
    n += 1;
    if (n === 1) return new Response(null, { status: 302, headers: { location: "https://docs.google.com/done" } });
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  };
  const r = await withStubFetch(hopping, () =>
    handler(
      new Request("https://r.example/api/gform?path=/docs/forms/d/e/formResponse", {
        method: "POST",
        body: "a=1",
      }),
    ),
  );
  assert.equal(r.status, 200);
  assert.equal(seen.calls.length, 2);
  assert.equal(seen.calls[0].init.method, "POST");
  assert.equal(seen.calls[1].init.method, "GET", "browser semantics after 302");
  assert.equal(seen.calls[1].init.body, undefined, "body dropped with the downgrade");

  const seen2 = { calls: [] };
  const evilHop = async (url) => {
    seen2.calls.push(String(url));
    return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
  };
  const r2 = await withStubFetch(evilHop, () => handler(get("https://r.example/api/gform?path=/gle/abc")));
  assert.equal(r2.status, 502, "foreign redirect is an error here (not surfaced like github)");
  assert.match((await r2.json()).error, /disallowed host/);
  assert.equal(seen2.calls.length, 1);
});

test("oversize body streams pristine; storm capped; throw → 502", async () => {
  const big = async () =>
    new Response("x".repeat(100), {
      status: 200,
      headers: { "content-type": "text/html", "content-length": String(11 * 1024 * 1024) },
    });
  const r = await withStubFetch(big, () => handler(get("https://r.example/api/gform?path=/docs/x")));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "x".repeat(100), "declared-oversize skips the rewrite");

  let s = 0;
  const storm = async () => {
    s += 1;
    return new Response(null, { status: 302, headers: { location: "/loop" } });
  };
  const r2 = await withStubFetch(storm, () => handler(get("https://r.example/api/gform?path=/gle/abc")));
  assert.equal(r2.status, 502);
  assert.match((await r2.json()).error, /too many/);
  assert.equal(s, 6, "initial + 5 follows");

  const orig = console.error;
  console.error = () => {};
  try {
    const down = async () => {
      throw new Error("reset");
    };
    const r3 = await withStubFetch(down, () => handler(get("https://r.example/api/gform?path=/docs/x")));
    assert.equal(r3.status, 502);
    assert.match((await r3.json()).error, /unavailable/);
  } finally {
    console.error = orig;
  }
});
