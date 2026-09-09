// vrelay routing — pure URL routing for the VPS entry (SOLID Round-18:
// SRP/DIP extraction from server/entry.mjs, moved verbatim except for one
// seam: resolveRoute takes the routes TABLE as a parameter instead of
// closing over entry.mjs's module-level ROUTES. Rationale: the table holds
// handler function refs that only exist in dist/ (build-relay.sh transpiles
// api/ + copies server/), so an unparameterized move would be untestable in
// the source tree. entry.mjs passes its real ROUTES; tests pass synthetic
// tables. Adding a route = adding a table entry (OCP); this module never
// changes for it.
//
// Routing replicates vercel.json's rewrites in-process:
//   /api/git/<rest>     -> handler(Request at /api/git?path=/<rest>&<orig args>)
//   /api/github/...     -> /api/github?path=...
//   /api/gform/...      -> /api/gform?path=...
//   /api/zen?..., /api/proxy... -> passed through verbatim (query-target API)

/**
 * @param routes table entries { prefix, handler, pathFromRest? }
 * @param rawUrl request-target as received ("/path?query" or "/path")
 * @returns { r, pathname, search } on match, else null.
 */
export function resolveRoute(routes, rawUrl) {
  const qmark = rawUrl.indexOf("?");
  const pathname = qmark < 0 ? rawUrl : rawUrl.slice(0, qmark);
  const search = qmark < 0 ? "" : rawUrl.slice(qmark + 1);
  for (const r of routes) {
    // "/api/git/" vs "/api/github/…" stay distinguishable: tail must start
    // with "/" (prefix+sep) or be exactly the prefix itself.
    if (pathname === r.prefix || pathname.startsWith(r.prefix + "/")) {
      return { r, pathname, search };
    }
  }
  return null;
}

/**
 * Build the upstream Request URL for a route hit. pathFromRest routes fold
 * the tail into the `path` query param, mirroring vercel.json
 * "/api/git/:path*" -> "/api/git?path=/:path*" (extra query args of the
 * original request are preserved; git smart-http needs service=...).
 */
export function buildUrl({ r, pathname, search }, host) {
  if (!r.pathFromRest) {
    return `https://${host}${pathname}${search ? "?" + search : ""}`;
  }
  const rest = pathname.slice(r.prefix.length); // "" or "/deepseek-ai/x.git"
  const params = new URLSearchParams();
  params.set("path", "/" + rest.replace(/^\//, ""));
  if (search) {
    // original args win as-is (info/refs?service=git-upload-pack etc.);
    // a caller-supplied path= param would collide and is dropped.
    for (const [k, v] of new URLSearchParams(search)) if (k !== "path") params.append(k, v);
  }
  return `https://${host}${r.prefix}?${params.toString()}`;
}
