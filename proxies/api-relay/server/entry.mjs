// VPS entry for the vercel-proxy handlers (migrated 2026-09-08 after the
// Vercel free team was paused). Runs the EXACT api/ sources (transpiled to
// .mjs by build-relay.sh) under plain Node ≥ 20 — the handlers are standard
// web-API edge functions (Request -> Response), so behavior parity with the
// Vercel deployment is by construction, not by re-implementation.
//
// Routing replicates vercel.json's rewrites in-process (pure table +
// matchers in ./routing.mjs — unit-tested; entry keeps only the handler
// wiring + HTTP plumbing):
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
import { resolveRoute, buildUrl, resolveHost, forwardHeaders, collectResponseHeaders } from "./routing.mjs";

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

const server = createServer(async (req, res) => {
  const host = resolveHost(req.headers);
  try {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    const hit = resolveRoute(ROUTES, req.url || "/");
    if (!hit) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const headers = forwardHeaders(req.headers);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(buildUrl(hit, host), {
      method: req.method,
      headers,
      ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
    });
    const response = await hit.r.handler(request);
    const out = collectResponseHeaders(response);
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
