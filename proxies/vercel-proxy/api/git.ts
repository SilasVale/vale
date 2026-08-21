// /api/git → GitHub smart HTTP reverse proxy.
// Configure Git with url."https://v.saisi.online/api/git/".insteadOf
// "https://github.com/"; repository URLs remain unchanged.

export const config = { runtime: "edge" };

const UPSTREAM = "https://github.com";
const REQUEST_HEADERS = [
  "accept",
  "accept-encoding",
  "content-type",
  "content-length",
  "if-none-match",
  "if-modified-since",
  "user-agent",
  "authorization",
];
const RESPONSE_HEADERS = [
  "cache-control",
  "clear-site-data",
  "content-encoding",
  "content-length",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "vary",
];
const MAX_REDIRECTS = 3;

function errorResponse(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    // Errors (404/401/413...) must not be edge-cached either — a cached
    // transient failure would outlive its cause.
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0, must-revalidate",
    },
  });
}

function validPath(value: string): boolean {
  if (!value || !value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.includes("..")) return false;
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

function requestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function allowedRedirect(response: Response, current: URL): URL | null {
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    const target = new URL(location, current);
    return target.protocol === "https:" && target.hostname === "github.com" ? target : null;
  } catch {
    return null;
  }
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    return errorResponse("method not allowed", 405);
  }

  const incoming = new URL(request.url);
  const path = incoming.searchParams.get("path");
  if (!path || !validPath(path)) return errorResponse("invalid GitHub path");

  let upstream = new URL(path, UPSTREAM);
  upstream.search = incoming.search;
  upstream.searchParams.delete("path");
  const headers = requestHeaders(request);

  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetch(upstream, {
        method: request.method,
        headers,
        body: request.method === "POST" ? request.body : undefined,
        redirect: "manual",
      });
      const target = allowedRedirect(response, upstream);
      if (!target || response.status < 300 || response.status >= 400) {
        const out = responseHeaders(response);
        // Git metadata MUST NOT be edge-cached: a cached info/refs made
        // pushes appear to fail (stale 404s / stale refs for minutes).
        out.set("cache-control", "no-store, max-age=0, must-revalidate");
        return new Response(response.body, {
          status: response.status,
          headers: out,
        });
      }
      if (redirects >= MAX_REDIRECTS) return errorResponse("too many GitHub redirects", 502);
      upstream = target;
    }
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "GitHub upstream unavailable", 502);
  }
}
