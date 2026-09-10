// vrelay routing pins (SOLID Round-18 — the relay's FIRST tests: the whole
// api-relay tree had zero). resolveRoute/buildUrl are pure (no sockets, no
// fetch), so they run under plain `node --test` with synthetic tables.
// What must never regress: /api/git vs /api/github disambiguation (a naive
// startsWith would route github traffic to the git handler), exact-prefix
// matches, query preservation for smart-http, and dropping a
// caller-supplied path= that would collide with the rewritten one.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveRoute, buildUrl, resolveHost, forwardHeaders } from "../routing.mjs";

// Synthetic table mirroring entry.mjs's ROUTES shape (handlers stay opaque:
// resolveRoute never calls them — real fns only exist in dist/).
const ROUTES = [
  { prefix: "/api/zen", handler: "zen" },
  { prefix: "/api/proxy", handler: "proxy" },
  { prefix: "/api/github", handler: "github", pathFromRest: true },
  { prefix: "/api/git", handler: "git", pathFromRest: true },
  { prefix: "/api/gform", handler: "gform", pathFromRest: true },
];

test("query-target routes match with search preserved", () => {
  const hit = resolveRoute(ROUTES, "/api/zen?target=og&path=%2Fv1%2Fresponses");
  assert.equal(hit.r.handler, "zen");
  assert.equal(hit.pathname, "/api/zen");
  assert.equal(hit.search, "target=og&path=%2Fv1%2Fresponses");
  assert.equal(resolveRoute(ROUTES, "/api/proxy/x").r.handler, "proxy");
});

test("git vs github stay distinguishable (prefix+sep guard)", () => {
  assert.equal(resolveRoute(ROUTES, "/api/git").r.handler, "git", "exact prefix");
  assert.equal(
    resolveRoute(ROUTES, "/api/git/info/refs?service=git-upload-pack").r.handler,
    "git",
  );
  assert.equal(resolveRoute(ROUTES, "/api/github/o/r").r.handler, "github");
  assert.equal(resolveRoute(ROUTES, "/api/github").r.handler, "github", "exact prefix");
  assert.equal(resolveRoute(ROUTES, "/api/gitx"), null, "no sep → no match");
  assert.equal(resolveRoute(ROUTES, "/api/githubx/y"), null);
});

test("unknown paths and roots miss", () => {
  assert.equal(resolveRoute(ROUTES, "/"), null);
  assert.equal(resolveRoute(ROUTES, "/api/unknown"), null);
  assert.equal(resolveRoute(ROUTES, "/api"), null, "bare /api matches no route");
  assert.equal(resolveRoute(ROUTES, "/healthz"), null, "served before routing in entry");
});

test("buildUrl: query-target routes pass through verbatim with the host", () => {
  const hit = resolveRoute(ROUTES, "/api/zen?target=og");
  assert.equal(buildUrl(hit, "oracle.saisi.online"), "https://oracle.saisi.online/api/zen?target=og");
  const bare = resolveRoute(ROUTES, "/api/proxy");
  assert.equal(buildUrl(bare, "h.example"), "https://h.example/api/proxy");
});

test("buildUrl: pathFromRest folds the tail into ?path=, keeps smart-http args", () => {
  const hit = resolveRoute(ROUTES, "/api/git/deepseek-ai/x.git/info/refs?service=git-upload-pack");
  const url = new URL(buildUrl(hit, "oracle.saisi.online"));
  assert.equal(url.hostname, "oracle.saisi.online");
  assert.equal(url.pathname, "/api/git");
  assert.equal(url.searchParams.get("path"), "/deepseek-ai/x.git/info/refs");
  assert.equal(url.searchParams.get("service"), "git-upload-pack");
});

test("buildUrl: bare prefix → path=/; caller path= dropped (collision)", () => {
  const bare = resolveRoute(ROUTES, "/api/git");
  assert.equal(
    new URL(buildUrl(bare, "h.example")).searchParams.get("path"),
    "/",
    "empty rest becomes root",
  );
  const evil = resolveRoute(ROUTES, "/api/git/a?path=/smuggled&service=x");
  const params = new URL(buildUrl(evil, "h.example")).searchParams;
  assert.equal(params.get("path"), "/a", "rewritten tail wins, caller value dropped");
  assert.equal(params.get("service"), "x", "innocent args survive");
});

// SOLID Round-68: entry-plumbing helpers extracted verbatim (entry.mjs
// binds a socket on import, so these could never be pinned in place).
// resolveHost decides the origin gform's rewriter builds proxy URLs from;
// forwardHeaders decides what rides upstream.
test("resolveHost: x-forwarded-host wins (nginx), then host, then localhost", () => {
  assert.equal(resolveHost({ "x-forwarded-host": "oracle.saisi.online", host: "127.0.0.1:8081" }), "oracle.saisi.online");
  assert.equal(resolveHost({ host: "127.0.0.1:8081" }), "127.0.0.1:8081");
  assert.equal(resolveHost({}), "localhost", "direct curl with no Host");
});

test("forwardHeaders: host/pseudo dropped, arrays appended, scalars set", () => {
  const h = forwardHeaders({
    host: "127.0.0.1:8081",
    ":method": "GET",
    "x-api-key": "sk-1",
    cookie: ["a=1", "b=2"],
  });
  assert.equal(h.get("host"), null, "rebuilt from the upstream URL instead");
  // NOTE: h.get(":method") itself throws (invalid name) — absence is proven
  // by enumerating what survived instead.
  assert.ok(![...h.keys()].some((k) => k.startsWith(":")), "HTTP/2 pseudo-headers never ride");
  assert.equal(h.get("x-api-key"), "sk-1");
  assert.equal(h.get("cookie"), "a=1; b=2", "multi-values preserved in order (cookie ; join per spec)");
});
