// VPS entry for the vercel-proxy handlers (migrated 2026-09-08 after the
// Vercel free team was paused). Runs the EXACT api/ sources (transpiled to
// .mjs by build-relay.sh) under plain Node ≥ 20 — the handlers are standard
// web-API edge functions (Request -> Response), so behavior parity with the
// Vercel deployment is by construction, not by re-implementation.
//
// Routing replicates vercel.json's rewrites in-process:
//   /api/git/<rest>     -> handler(Request at /api/git?path=/<rest>&<orig args>)
//   /api/github/...     -> /api/github?path=...
//   /api/gform/...      -> /api/gform?path=...
//   /api/zen?..., /api/proxy... -> passed through verbatim (query-target API)
//
// nginx fronts this (location /api/ -> 127.0.0.1:8081, Host preserved), so
// request.url origins are https://<public host> — gform's body rewriting
// builds proxy URLs from that origin and must see the REAL host.
import { createServer } from "node:http";
import { Readable } from "node:stream";

// Node-compat shim: undici REQUIRES `duplex: "half"` when a fetch body is a
// ReadableStream, but the web typings the handlers compile against don't carry
// that property (and Vercel edge runtime never needed it). Inject it here so
// api/ stays byte-identical between the two runtimes.
const undiciFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  if (init && init.body instanceof ReadableStream) {
    return undiciFetch(input, { ...init, duplex: "half" });
  }
  return undiciFetch(input, init);
};

import zen from "./zen.mjs";
import proxy from "./proxy.mjs";
import github from "./github.mjs";
import git from "./git.mjs";
import gform from "./gform.mjs";

const PORT = Number(process.env.PORT || 8081);

// pathFromRest: rewrite the tail into the `path` query param, mirroring
// vercel.json "/api/git/:path*" -> "/api/git?path=/:path*" (extra query args
// of the original request are preserved; git smart-http needs service=...).
const ROUTES = [
  { prefix: "/api/zen", handler: zen },
  { prefix: "/api/proxy", handler: proxy },
  { prefix: "/api/github", handler: github, pathFromRest: true },
  { prefix: "/api/git", handler: git, pathFromRest: true },
  { prefix: "/api/gform", handler: gform, pathFromRest: true },
];

function resolveRoute(rawUrl) {
  const qmark = rawUrl.indexOf("?");
  const pathname = qmark < 0 ? rawUrl : rawUrl.slice(0, qmark);
  const search = qmark < 0 ? "" : rawUrl.slice(qmark + 1);
  for (const r of ROUTES) {
    // "/api/git/" vs "/api/github/…" stay distinguishable: tail must start
    // with "/" (prefix+sep) or be exactly the prefix itself.
    if (pathname === r.prefix || pathname.startsWith(r.prefix + "/")) {
      return { r, pathname, search };
    }
  }
  return null;
}

function buildUrl({ r, pathname, search }, host) {
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

const server = createServer(async (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  try {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    const hit = resolveRoute(req.url || "/");
    if (!hit) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "host" || k.startsWith(":")) continue;
      if (Array.isArray(v)) for (const one of v) headers.append(k, one);
      else headers.set(k, v);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(buildUrl(hit, host), {
      method: req.method,
      headers,
      ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
    });
    const response = await hit.r.handler(request);
    const out = Object.fromEntries(response.headers.entries());
    if (typeof response.headers.getSetCookie === "function") {
      const sc = response.headers.getSetCookie();
      if (sc.length) out["set-cookie"] = sc; // gform reCAPTCHA needs ALL cookies
    }
    res.writeHead(response.status, out);
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (error) {
    console.error(`[vrelay] ${req.method} ${req.url}: ${error?.stack || error}`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
  }
});

server.listen(PORT, "127.0.0.1", () => console.error(`[vrelay] listening on 127.0.0.1:${PORT}`));
