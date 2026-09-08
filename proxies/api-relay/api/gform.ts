// /api/gform → Google Forms reverse proxy.
// Route format: /api/gform/{gle|docs|www|gstatic|ssl-gstatic|fontscss|fonts|usercontent}/... .
// Anonymous public forms only; cookies are never forwarded. Bodies of text-ish
// responses are rewritten so every blocked Google host loads through this proxy.

export const config = { runtime: "edge" };

const UPSTREAMS: Record<string, string> = {
  gle: "https://forms.gle", // short link; resolved via the redirect loop below
  docs: "https://docs.google.com", // viewform HTML + formResponse POST target
  www: "https://www.google.com",
  gstatic: "https://www.gstatic.com",
  "ssl-gstatic": "https://ssl.gstatic.com",
  fontscss: "https://fonts.googleapis.com",
  fonts: "https://fonts.gstatic.com",
  usercontent: "https://lh3.googleusercontent.com", // form header images
};
const ALLOWED_REDIRECT_HOSTS = new Set([
  "forms.gle",
  "docs.google.com",
  "www.google.com",
  "www.gstatic.com",
  "ssl.gstatic.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "lh3.googleusercontent.com",
]);
// No accept-encoding: upstream returns identity-encoded bytes so response.text()
// is safe for rewriting; no cookies/origin/referer: anonymous forms need none
// (formResponse accepts cross-site POSTs — that's how Google's embed works).
const REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "user-agent",
];
// The whitelist IS the stripping policy: CSP (per-response nonces would block
// rewritten content), set-cookie, cross-origin-*, location all stay out.
const RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "etag",
  "expires",
  "last-modified",
];
const MAX_REDIRECTS = 5;

// Upstream fetch budget: fail fast instead of hanging a client.
const UPSTREAM_TIMEOUT_MS = 30000;
// Rewrite ceiling: response bodies are fully buffered by response.text()
// before rewriting, so bound memory explicitly. Bodies declaring MORE than
// this via content-length skip the rewrite and stream straight through
// (passthrough) — slightly un-rewritten assets, never an OOM kill.
const MAX_REWRITE_BYTES = 10 * 1024 * 1024;

type Route = { base: string; path: string };

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    // Errors must not be edge-cached: a cached transient failure would outlive
    // its cause.
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0, must-revalidate",
    },
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

function rewritable(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase();
  return type.startsWith("text/") ||
    type.includes("javascript") ||
    type.includes("ecmascript") ||
    type.includes("json");
}

// Literal replacement pairs per upstream host, escaped variants first so the
// plain `https://` form never half-matches inside an escaped variant. Proxy
// URLs are absolute so JS that inspects URL structure keeps working. The
// backslash is built with String.fromCharCode to keep this source free of
// escape sequences that tools routinely mangle. Deliberately lossy: a missed
// variant only leaves one asset loading direct-to-Google (visible in
// verification), never breaks the page.
// SRI integrity hashes cover the un-rewritten bytes: the browser recomputes
// the digest over OUR rewritten output, the original value no longer matches,
// and Google's runtime-injected script tags (reCAPTCHA, freebird) get blocked.
// The proxy is already the trust root for these hosts, so neutralize SRI: strip
// static attributes during the rewrite, and inject a tiny script that no-ops
// the integrity setter and strips the attribute off any dynamically-added
// element before its fetch's SRI check runs.
const SRI_NEUTRALIZER = `
<!-- SRI hashes do not survive byte rewriting; neutralize static + injected integrity -->
<script>
(function () {
  try { Object.defineProperty(HTMLScriptElement.prototype, 'integrity', { configurable: true, get: function () { return ''; }, set: function () {} }); } catch (e) {}
  new MutationObserver(function (ms) {
    for (var i = 0; i < ms.length; i++) {
      var ns = ms[i].addedNodes;
      for (var j = 0; j < ns.length; j++) {
        var el = ns[j];
        if (!el || !el.querySelectorAll) continue;
        var at = el.querySelectorAll('[integrity]');
        for (var k = 0; k < at.length; k++) at[k].removeAttribute('integrity');
      }
    }
  }).observe(document.documentElement || document, { subtree: true, childList: true });
})();
</script>`;

function rewriteBody(body: string, origin: string, isHtml: boolean): string {
  if (isHtml) {
    body = body.replace(/\s+integrity="[^"]*"/g, " ");
    const head = body.indexOf("<head");
    if (head >= 0) body = body.slice(0, head + 5) + SRI_NEUTRALIZER + body.slice(head + 5);
  }
  const proxyHost = new URL(origin).host;
  const bs = String.fromCharCode(92); // backslash
  for (const [key, base] of Object.entries(UPSTREAMS)) {
    const host = new URL(base).host;
    const proxy = `${origin}/api/gform/${key}`;
    const escapedProxy = (esc: string) => proxy.split("/").join(esc);
    const pairs: [string, string][] = [
      [`https:${bs}/${bs}/${host}`, escapedProxy(`${bs}/`)], // https:\/\/host (JSON \/ escape)
      [`https:${bs}u002F${bs}u002F${host}`, escapedProxy(`${bs}u002F`)], // JSON.stringify style
      [`https:${bs}u002f${bs}u002f${host}`, escapedProxy(`${bs}u002f`)],
      [`https:${bs}x2f${bs}x2f${host}`, escapedProxy(`${bs}x2f`)], // obfuscated JS strings
      [`https://${host}`, proxy],
      [`//${host}`, `//${proxyHost}/api/gform/${key}`], // protocol-relative
    ];
    for (const [from, to] of pairs) body = body.split(from).join(to);
  }
  return body;
}

// Set-Cookie may appear multiple times in one response; Headers#get() only
// returns the first, so collect them all explicitly.
function setCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(headers);
  const values: string[] = [];
  headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") values.push(value);
  });
  return values;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    return bad("method not allowed", 405);
  }

  const incoming = new URL(request.url);
  const route = parseRoute(incoming.searchParams.get("path"));
  if (!route) return bad("unsupported Google route");

  let upstream = new URL(route.path, route.base);
  upstream.search = incoming.search;
  upstream.searchParams.delete("path");
  const headers = copyRequestHeaders(request);
  const origin = incoming.origin;

  let method = request.method;
  let body = method === "POST" ? request.body : undefined;

  try {
    for (let redirects = 0; ; redirects += 1) {
      // reCAPTCHA is stateful across anchor/reload/verify on the same origin;
      // forward only its own cookie so the session survives.
      const effectiveHeaders = new Headers(headers);
      if (upstream.hostname === "www.google.com" && upstream.pathname.startsWith("/recaptcha/")) {
        const cookie = request.headers.get("cookie");
        if (cookie) effectiveHeaders.set("cookie", cookie);
      }
      const response = await fetch(upstream, {
        method,
        headers: effectiveHeaders,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const target = redirectTarget(response, upstream);
        if (!target) {
          return bad(
            `upstream redirect to disallowed host: ${response.headers.get("location")}`,
            502,
          );
        }
        if (redirects >= MAX_REDIRECTS) return bad("too many Google redirects", 502);
        upstream = target;
        // POST→302 becomes GET, browser semantics (formResponse → confirmation page).
        method = "GET";
        body = undefined;
        continue;
      }
      const out = copyResponseHeaders(response);
      // Same session cookies for reCAPTCHA: set them on our origin so the
      // widget persists between anchor and reload.
      if (upstream.hostname === "www.google.com" && upstream.pathname.startsWith("/recaptcha/")) {
        for (const cookie of setCookieValues(response.headers)) out.append("set-cookie", cookie);
      }
      if (response.status === 304) return new Response(null, { status: 304, headers: out });
      const contentType = response.headers.get("content-type");
      if (rewritable(contentType)) {
        // Oversized bodies skip the rewrite (see MAX_REWRITE_BYTES): stream
        // the pristine upstream bytes through instead of buffering them.
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_REWRITE_BYTES) {
          return new Response(response.body, { status: response.status, headers: out });
        }
        return new Response(
          rewriteBody(await response.text(), origin, (contentType ?? "").startsWith("text/html")),
          { status: response.status, headers: out },
        );
      }
      return new Response(response.body, { status: response.status, headers: out });
    }
  } catch (error) {
    // Never leak internal detail — generic client text, full detail in log.
    console.error(`[vercel-gform] upstream error: ${error instanceof Error ? error.stack || error.message : error}`);
    return bad("Google upstream unavailable", 502);
  }
}
