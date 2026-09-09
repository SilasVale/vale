// /api/git gate pins (SOLID Round-22 — smart-HTTP relay; same treatment
// as the github handler with its deliberate differences pinned: stricter
// redirect allowlist (github.com EXACTLY — no asset hosts), tighter storm
// cap (3), Authorization forwarded (git protocol auth, unlike the github
// handler), POST body for upload-pack, NO CORS surface at all (git CLI is
// not a browser), and no-store forced on success AND errors. Stubbed
// fetch throughout — zero network.
import test from "node:test";
import assert from "node:assert/strict";
import handler, { validPath, allowedRedirect } from "../git.ts";

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

// ── validPath table ────────────────────────────────────

test("validPath: rooted clean paths pass; hostile shapes fail", () => {
  assert.equal(validPath("/o/r.git/info/refs"), true);
  assert.equal(validPath("/"), true);
  for (const evil of ["", "o/r", "/a\\b", "/a\0b", "/a/../b", "..", "%zz", "/%2e%2e/x", "/a\r\nb", "/a\x1fb"]) {
    assert.equal(validPath(evil), false, `rejected: ${JSON.stringify(evil)}`);
  }
  // Boundary as implemented: the control range is \0–\x1f, so DEL (\x7f)
  // passes. Pinned neutrally — narrowing it is a behavior change for another round.
  assert.equal(validPath("/a\x7fb"), true);
});

// ── allowedRedirect table (stricter than github.ts) ─────

test("allowedRedirect: github.com exactly — asset hosts rejected here", () => {
  const cur = new URL("https://github.com/o/r");
  const loc = (v) => new Response(null, { status: 302, headers: v ? { location: v } : {} });
  assert.equal(allowedRedirect(loc(null), cur), null);
  assert.equal(allowedRedirect(loc("/o/r2"), cur)?.href, "https://github.com/o/r2");
  assert.equal(allowedRedirect(loc("https://github.com/a"), cur)?.hostname, "github.com");
  assert.equal(allowedRedirect(loc("https://www.github.com/a"), cur), null, "no www here");
  assert.equal(
    allowedRedirect(loc("https://objects.githubusercontent.com/a"), cur),
    null,
    "no asset hosts here (unlike the github handler)",
  );
  assert.equal(allowedRedirect(loc("https://evil.example/"), cur), null);
  assert.equal(allowedRedirect(loc("http://github.com/a"), cur), null, "https only");
});

// ── handler method + path gates ────────────────────────

test("methods: GET/HEAD/POST pass the gate; everything else 405 (incl. OPTIONS)", async () => {
  const ok = async (url, init) => new Response("x", { status: 200 });
  for (const m of ["GET", "HEAD", "POST"]) {
    const r = await withStubFetch(ok, () =>
      handler(new Request("https://r.example/api/git?path=/o/r", { method: m })),
    );
    assert.equal(r.status, 200, m);
  }
  for (const m of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const r = await withStubFetch(never, () =>
      handler(new Request("https://r.example/api/git?path=/o/r", { method: m })),
    );
    assert.equal(r.status, 405, `${m} rejected (no CORS preflight: git CLI is not a browser)`);
  }
});

test("missing/evil path → 400 with no-store (errors never edge-cached)", async () => {
  for (const u of ["https://r.example/api/git", "https://r.example/api/git?path=/../x"]) {
    const r = await withStubFetch(never, () => handler(get(u)));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /invalid GitHub path/);
    assert.match(r.headers.get("cache-control") || "", /no-store/);
  }
});

// ── upstream-reaching contract ─────────────────────────

function okUpstream(seen, body = "refs", headers = { "content-type": "application/x-git-upload-pack-advertisement" }) {
  return async (url, init) => {
    seen.calls.push({ url: String(url), init });
    return new Response(body, { status: 200, headers });
  };
}

test("happy path: URL composed, service kept, auth forwarded, no-store forced", async () => {
  const seen = { calls: [] };
  const r = await withStubFetch(okUpstream(seen), () =>
    handler(
      get("https://r.example/api/git?path=/o/r.git/info/refs&service=git-upload-pack", {
        authorization: "Basic eGk6eQ==",
        cookie: "sess=1",
        "x-evil": "nope",
      }),
    ),
  );
  assert.equal(r.status, 200);
  assert.equal(seen.calls.length, 1);
  const [call] = seen.calls;
  assert.equal(call.url, "https://github.com/o/r.git/info/refs?service=git-upload-pack");
  const uh = new Headers(call.init.headers);
  assert.equal(uh.get("authorization"), "Basic eGk6eQ==", "git protocol auth rides (unlike github handler)");
  assert.equal(uh.get("cookie"), null);
  assert.equal(uh.get("x-evil"), null);
  assert.match(r.headers.get("cache-control") || "", /no-store/, "metadata never edge-cached");
  assert.equal(r.headers.get("access-control-allow-origin"), null, "no CORS surface at all");
});

test("POST carries its body (upload-pack); redirect followed within github.com", async () => {
  const seen = { calls: [] };
  let n = 0;
  const hopping = async (url, init) => {
    seen.calls.push({ url: String(url), init });
    n += 1;
    if (n === 1) return new Response(null, { status: 302, headers: { location: "/o/r2.git/info/refs" } });
    return new Response("refs2", { status: 200 });
  };
  const r = await withStubFetch(hopping, () =>
    handler(
      new Request("https://r.example/api/git?path=/o/r.git/git-upload-pack", {
        method: "POST",
        headers: { "content-type": "application/x-git-upload-pack-request" },
        body: "pkt",
      }),
    ),
  );
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "refs2");
  assert.equal(seen.calls.length, 2);
  assert.ok(seen.calls[0].init.body !== undefined, "POST body forwarded");
  assert.equal(seen.calls[1].url, "https://github.com/o/r2.git/info/refs");
});

test("foreign redirect surfaced (1 fetch); storm capped at 3; throw → 502", async () => {
  const seen = { calls: [] };
  const evilHop = async (url) => {
    seen.calls.push(String(url));
    return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
  };
  const r = await withStubFetch(evilHop, () => handler(get("https://r.example/api/git?path=/o/r")));
  assert.equal(r.status, 302);
  assert.equal(seen.calls.length, 1, "attacker host never fetched");

  let s = 0;
  const storm = async () => {
    s += 1;
    return new Response(null, { status: 302, headers: { location: "/loop" } });
  };
  const r2 = await withStubFetch(storm, () => handler(get("https://r.example/api/git?path=/o/r")));
  assert.equal(r2.status, 502);
  assert.match((await r2.json()).error, /too many/);
  assert.equal(s, 4, "initial + 3 follows (tighter cap than github handler)");

  const orig = console.error;
  console.error = () => {};
  try {
    const down = async () => {
      throw new Error("dns fail");
    };
    const r3 = await withStubFetch(down, () => handler(get("https://r.example/api/git?path=/o/r")));
    assert.equal(r3.status, 502);
    assert.match((await r3.json()).error, /unavailable/);
  } finally {
    console.error = orig;
  }
});
