// /api/github → controlled GitHub HTTP reverse proxy.
// Route format: /api/github/{web|raw|api|release}/... .
// Only public GitHub hosts are reachable; credentials are never forwarded.

export const config = { runtime: "edge" };

const UPSTREAMS: Record<string, string> = {
  web: "https://github.com",
  raw: "https://raw.githubusercontent.com",
  api: "https://api.github.com",
  release: "https://github.com",
};
const ALLOWED_REDIRECT_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const REQUEST_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "if-none-match",
  "if-modified-since",
  "range",
  "user-agent",
];
const RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "vary",
];
const MAX_REDIRECTS = 5;

type Route = { base: string; path: string };

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function safePath(value: string): boolean {
  if (!value || !value.startsWith("/")) return false;
  if (value.includes("\\") || value.includes("\0") || value.includes("..")) return false;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.startsWith("/") &&
      !decoded.includes("\\") &&
      !decoded.includes("..") &&
      !/[\0-\x1f]/.test(decoded);
  } catch {
    return false;
  }
}

function parseRoute(value: string | null): Route | null {
  if (!value || !safePath(value)) return null;
  const slash = value.indexOf("/", 1);
  if (slash < 0) return null;
  const type = value.slice(1, slash);
  const path = value.slice(slash);
  const base = UPSTREAMS[type];
  return base && safePath(path) ? { base, path } : null;
}

function copyRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function copyResponseHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function redirectTarget(response: Response, currentUrl: URL): URL | null {
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    const target = new URL(location, currentUrl);
    return target.protocol === "https:" && ALLOWED_REDIRECT_HOSTS.has(target.hostname)
      ? target
      : null;
  } catch {
    return null;
  }
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "Accept, Range, If-None-Match, If-Modified-Since",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return bad("method not allowed", 405);

  const requestUrl = new URL(request.url);
  const route = parseRoute(requestUrl.searchParams.get("path"));
  if (!route) return bad("unsupported GitHub route");

  let upstream = new URL(route.path, route.base);
  upstream.search = requestUrl.search;
  upstream.searchParams.delete("path");
  const headers = copyRequestHeaders(request);

  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetch(upstream, {
        method: request.method,
        headers,
        redirect: "manual",
      });
      const target = redirectTarget(response, upstream);
      if (!target || response.status < 300 || response.status >= 400) {
        const responseHeaders = copyResponseHeaders(response);
        responseHeaders.set("access-control-allow-origin", "*");
        return new Response(response.body, { status: response.status, headers: responseHeaders });
      }
      if (redirects >= MAX_REDIRECTS) return bad("too many GitHub redirects", 502);
      upstream = target;
    }
  } catch (error) {
    return bad(error instanceof Error ? error.message : "GitHub upstream unavailable", 502);
  }
}
