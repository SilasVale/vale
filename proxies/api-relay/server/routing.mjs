// vrelay routing — pure URL routing + entry plumbing helpers for the VPS
// entry. Rationale (SOLID Round-18): handler function refs exist only in
// dist/, so unparameterized moves would be untestable in the source tree;
// entry.mjs passes its real ROUTES, tests pass synthetic tables.

/**
 * Real public host for proxied URL building (SOLID Round-68: verbatim move
 * from entry.mjs). nginx fronts vrelay (location /api/ -> 127.0.0.1:8081,
 * Host preserved), so request.url origins are https://<public host> — gform's
 * body rewriting builds proxy URLs from that origin and must see the REAL
 * host, hence x-forwarded-host first.
 */
export function resolveHost(headers) {
  return headers["x-forwarded-host"] || headers.host || "localhost";
}

/**
 * Inbound headers for the upstream Request (SOLID Round-68: verbatim move).
 * Drops hop-by-hop noise (host — rebuilt from the upstream URL; HTTP/2
 * pseudo-headers); multi-value headers append in order.
 */
export function forwardHeaders(rawHeaders) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (k === "host" || k.startsWith(":")) continue;
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else headers.set(k, v);
  }
  return headers;
}

/**
 * Plain-object headers for the node:http reply from an upstream Response
 * (SOLID Round-69: verbatim move — the last testable logic in entry.mjs;
 * entry keeps only socket plumbing). Multi set-cookie values ride as an
 * array (gform reCAPTCHA needs ALL cookies, not the first).
 */
export function collectResponseHeaders(response) {
  const out = Object.fromEntries(response.headers.entries());
  if (typeof response.headers.getSetCookie === "function") {
    const sc = response.headers.getSetCookie();
    if (sc.length) out["set-cookie"] = sc;
  }
  return out;
}

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
