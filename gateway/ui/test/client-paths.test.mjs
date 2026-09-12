// The console's requested paths, checked against the paths the worker serves.
//
// WHY THIS EXISTS. `api/client.ts` holds every URL the console calls, and the
// console's tests ALL MOCK `fetch` — so a path that no worker route answers
// produces a 404 that every test happily feeds into an empty view. The page
// renders blank, the suite stays green, and the defect appears only in production.
// I proved how easy that is to hit: while hand-writing browser mocks I guessed
// `/api/users`, which is 404 — the real path is `/api/admin/users` — and spent time
// reading an empty card as a product bug when only my mock was wrong.
//
// HOW IT COMPARES. Both sides are READ, not hardcoded: the client's paths come from
// `api/client.ts`'s `request(...)` calls, and the worker's from the `add(method,
// path, handler)` declarations its plugins push into the route table, with the
// `${X_BASE}` prefixes resolved from their own constants. A hardcoded list on
// either side would be a third copy of the thing being checked.
//
// WHAT IT DOES NOT COVER, stated rather than implied: paths built at runtime
// (template literals with an id, e.g. `/api/devices/{id}/...`) cannot be matched by
// string equality, so they are reported as PREFIX-matched and verified against the
// worker's `startsWith` matchers. Anything neither exact nor prefix-matched is
// listed at the end rather than silently passed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `${ADMIN_BASE}/users` and `${ADMIN_BASE}` with the constants resolved. */
function resolveBases(src, dir) {
  const bases = {};
  for (const m of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*"(\/api\/[^"]*)"/g)) {
    bases[m[1]] = m[2];
  }
  void dir;
  return bases;
}

function expand(template, bases) {
  return template.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name) => {
    if (!(name in bases)) throw new Error(`unknown base ${name}`);
    return bases[name];
  });
}

/** The worker's own source, plugins and the main dispatcher together. */
function workerSource() {
  const dirs = [path.join(ROOT, "src", "plugins"), path.join(ROOT, "src")];
  let src = "";
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".ts")) src += readFileSync(path.join(dir, f), "utf8") + "\n";
    }
  }
  return src;
}

const SRC = workerSource();
const BASES = resolveBases(SRC);

/** Drop a query string: `/api/me/keys?name=` is a request for `/api/me/keys`. */
const bare = (p) => p.split("?")[0];

/**
 * Exact (method, path) pairs, from ALL THREE declaration styles the worker uses.
 * Missing one style would silently shrink the route set and turn this check into a
 * comparison against a list that is too small — which is the failure it exists to
 * catch, one level up.
 */
function workerRoutes() {
  const out = new Set();
  // 1. `add("GET", `${BASE}/x`, ...)` and `add("GET", "/api/x", ...)`
  for (const m of SRC.matchAll(/add\(\s*"([A-Z]+)"\s*,\s*(`[^`]*`|"[^"]*")/g)) {
    out.add(`${m[1]} ${expand(m[2].slice(1, -1), BASES)}`);
  }
  // 2. `route(ctx, "POST", "/api/x", ...)`
  for (const m of SRC.matchAll(/route\(\s*ctx\s*,\s*"([A-Z]+)"\s*,\s*"([^"]+)"/g)) {
    out.add(`${m[1]} ${m[2]}`);
  }
  // 3. inline matchers: `match: (m, p) => m === "GET" && p === `${BASE}/x``
  for (const m of SRC.matchAll(/m\s*===\s*"([A-Z]+)"\s*&&\s*p\s*===\s*(`[^`]*`|"[^"]*")/g)) {
    out.add(`${m[1]} ${expand(m[2].slice(1, -1), BASES)}`);
  }
  // ...and `p === DEVICE_BASE` (a bare constant, no template)
  for (const m of SRC.matchAll(/m\s*===\s*"([A-Z]+)"\s*&&\s*p\s*===\s*([A-Z][A-Z0-9_]*)/g)) {
    if (m[2] in BASES) out.add(`${m[1]} ${BASES[m[2]]}`);
  }
  // 4. `add("GET", ME_BASE, ...)` — a bare identifier, no quotes at all.
  for (const m of SRC.matchAll(/add\(\s*"([A-Z]+)"\s*,\s*([A-Z][A-Z0-9_]*)\s*,/g)) {
    if (m[2] in BASES) out.add(`${m[1]} ${BASES[m[2]]}`);
  }
  // 5. index.ts's dispatcher: `path === "/api/health"`, with the METHOD tested
  //    separately. Recorded against every verb, because this list is about which
  //    PATHS exist; the client-path check compares paths.
  for (const m of SRC.matchAll(/(?<!m )path\s*===\s*"([^"]+)"/g)) {
    for (const verb of ["GET", "POST", "PUT", "DELETE"]) out.add(`${verb} ${m[1]}`);
  }
  return out;
}

/** Prefixes from the worker's REGEX matchers, up to the first metacharacter. */
function workerPrefixes() {
  const out = new Set();
  for (const m of SRC.matchAll(/startsWith\(\s*`([^`]*\$\{[A-Z][A-Z0-9_]*\}[^`]*)`/g)) {
    out.add(expand(m[1], BASES));
  }
  for (const m of SRC.matchAll(/RegExp\(\s*`\^([^`]+)`/g)) {
    const t = expand(m[1], BASES);
    const cut = t.search(/[\[\^$*+?()|\\]/);
    out.add(cut > 0 ? t.slice(0, cut) : t);
  }
  return out;
}

/** Paths the console requests, normalised to a leading slash. */
function clientPaths() {
  const src = readFileSync(path.join(ROOT, "ui", "src", "api", "client.ts"), "utf8");
  const out = new Set();
  for (const m of src.matchAll(/request<[^>]*>\(\s*"(\/api\/[^"]*)"/g)) out.add(bare(m[1]));
  for (const m of src.matchAll(/request<[^>]*>\(\s*`(\/api\/[^`$]*)/g)) out.add(bare(m[1]));
  return out;
}

const routes = workerRoutes();
const prefixes = workerPrefixes();
const client = clientPaths();

test("the worker route table was actually READ", () => {
  // A comparison over zero routes would pass for ever. This is the same guard the
  // token contract carries, for the same reason.
  assert.ok(routes.size >= 15, `only ${routes.size} worker routes found — the parser read the wrong thing`);
  assert.ok(client.size >= 15, `only ${client.size} client paths found — the parser read the wrong thing`);
});

test("every path the console requests is answered by a worker route", () => {
  const missing = [];
  const dynamic = [];
  for (const p of client) {
    if ([...routes].some((r) => r.endsWith(" " + p))) continue;
    // A prefix match ignores the method on purpose: the worker's regex matchers
    // are written method-aware, but pinning the method here would make this check
    // fail on a correct route whenever a handler accepts two verbs.
    
    if ([...prefixes].some((pre) => p.startsWith(pre))) { dynamic.push(p); continue; }
    missing.push(p);
  }
  assert.deepEqual(
    missing,
    [],
    `the console requests ${missing.length} path(s) no worker route answers — every UI test MOCKS ` +
      `fetch, so these would 404 in production with a green suite: ${missing.join(", ")}`,
  );
  // Reported, not asserted: these are real paths matched by the worker's dynamic
  // matchers, and the count is here so a change in how many there are is visible.
  assert.ok(dynamic.length >= 1, "expected at least one dynamically-matched path");
});
