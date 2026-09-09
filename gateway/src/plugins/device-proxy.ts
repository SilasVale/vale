/**
 * device-proxy — the device reverse-proxy route, extracted verbatim from
 * plugins/devices.ts (structure refactor; zero logic change).
 *
 * <any> /api/devices/<name>/proxy/<rest> → reverse-proxy to the device panel.
 * Auth: admin session cookie OR paired plugin token (Authorization: Bearer)
 * OR the per-device vale_pt_<name> cookie minted by the ?token= 302
 * bootstrap flow. The route wiring itself stays in devices.ts's setup()
 * (ctx.routes.push, before the session-gated device routes) — only the code
 * moved here.
 *
 * Also home to the two helpers devices.ts shares with this module:
 *   DEVICE_BASE       the /api/devices base path (devices.ts's other routes
 *                     import it from here — keeps module deps one-way:
 *                     devices.ts → device-proxy.ts, never a cycle)
 *   decodeDeviceName  URL-encoded device name decode (null on bad escapes)
 */
import { getDevice, getPluginByToken, type Device } from "../store.ts";
import { parseCookie } from "../auth.ts";
import { build101Response, deviceFetch } from "../device-fetch.ts";
import { jsonError, stampCors } from "../http.ts";
import { requireSession } from "../session.ts";

export const DEVICE_BASE = "/api/devices";

// round-107: decode a URL-encoded device name, null on malformed escapes
// (a raw decodeURIComponent threw URIError → unhandled 500).
export function decodeDeviceName(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

// ---- Device reverse-proxy: admin session cookie OR paired plugin token ----
// <any> /api/devices/<name>/proxy/<rest> → reverse-proxy to the device panel.
// The console admin browses the panel with the session cookie; the browser
// extension's terminal page is cross-site (no console cookie, SameSite=Lax),
// so it authenticates with the plugin token it was paired with
// (Authorization: Bearer <token>, the same credential as /api/plugins/ws).
// The token grants access ONLY to the device it's paired to — no other
// device, no admin APIs, no /api/me.
export async function handleDeviceProxy(request: Request, env: any, url: URL): Promise<Response> {
  const path = url.pathname;
  // The `if (proxyMatch)` guard from index.js is the route's match fn below —
  // the handler is only reached when the regex matched.
  const proxyMatch = path.match(new RegExp(`^${DEVICE_BASE}/([^/]+)/proxy(.*)$`))!;
  // round-106/107: a malformed percent-escape in the device name (e.g. %zz)
  // made decodeURIComponent throw URIError — an unhandled 500. 400 instead.
  const deviceName = decodeDeviceName(proxyMatch[1]!);
  if (deviceName === null) return jsonError(400, "Invalid device name", "invalid_request");
  const d = await getDevice(env, deviceName);
  const user = await requireSession(request, env);
  if (!d) {
    // round: the 404 here was an UNAUTHENTICATED device-name oracle (probe
    // names → 404 vs 401). Unveil existence only to admin sessions.
    if (user && user.role === "admin") return jsonError(404, "Device not found", "not_found_error");
    return jsonError(401, "Not logged in or invalid plugin token", "authentication_error");
  }
  if (user && user.role === "admin") {
    return await proxyDevice(request, env, d, proxyMatch[2] || "/");
  }
  const auth = String(request.headers.get("authorization") || "");
  const qToken = url.searchParams.get("token") || "";
  // ?token= is accepted ONLY for a top-level browser navigation (the
  // extension's Terminal button) — a browser navigation cannot carry an
  // Authorization header. Any other request with a query token is rejected:
  // a leaked URL (history/sync/screenshot/log) would otherwise grant full
  // device terminal control via /proxy/* for the 30-day plugin-link TTL.
  // Sec-Fetch-Mode is set by browsers on every fetch/navigation and cannot
  // be spoofed cross-origin (it is a forbidden header for fetch()).
  const isNav = String(request.headers.get("sec-fetch-mode") || "") === "navigate";
  if (qToken && !auth && !isNav) {
    return jsonError(401, "Invalid plugin token", "authentication_error");
  }
  // Bootstrap-navigation reload support: the navigation pins the plugin
  // token in a PER-DEVICE cookie so the panel's relative subresources
  // (panel.css/js/vendor/*) and an F5/history-forward reload authenticate.
  // The cookie is scoped to THIS device's proxy path and carries the device
  // name in its key — one origin-wide cookie would let a later-opened
  // device's page steal an earlier device's terminal (cross-device hijack)
  // and would clobber a multi-device pairing.
  // The cookie was written with encodeURIComponent — decode on read so a
  // future non-hex token charset (base64 +/=, etc.) still matches the
  // plugin-link map (hex tokens are a no-op, but the decode must exist).
  let cookieToken = "";
  try {
    cookieToken = decodeURIComponent(
      parseCookie(request.headers.get("cookie") || "")[`vale_pt_${deviceName}`] || "",
    );
  } catch {
    /* malformed — treat as absent */
  }
  const token = (auth.startsWith("Bearer ") ? auth.slice(7).trim() : "") || qToken || cookieToken;
  const link = token ? await getPluginByToken(env, token) : null;
  if (link && link.device === deviceName) {
    // round-124: a top-level navigation carrying ?token= is the ONLY way
    // the per-device cookie gets minted (the extension Terminal button). The
    // old code proxied the panel and appended Set-Cookie — the token stayed
    // in the omnibox/history until the panel JS scrubbed it, and if the
    // panel failed to boot (device offline → 502 body) it stayed forever.
    // 302 to the SAME url with ?token= stripped + Set-Cookie: the token
    // never reaches the omnibox, the cookie is minted regardless of whether
    // the panel boots, and a refresh/reload re-authenticates via cookie.
    if (qToken && isNav) {
      const clean = new URL(request.url);
      clean.searchParams.delete("token");
      return new Response(null, {
        status: 302,
        headers: {
          Location: clean.pathname + clean.search,
          "Set-Cookie": `vale_pt_${deviceName}=${encodeURIComponent(qToken)}; Path=${DEVICE_BASE}/${deviceName}/proxy; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
          // round-126: a cached 302 would drop the Set-Cookie on a re-pair
          // (stale cookie → panel 401s forever).
          "Cache-Control": "no-store",
        },
      });
    }
    // Never cache a response that carried a token in the URL.
    const resp = await proxyDevice(request, env, d, proxyMatch[2] || "/");
    resp.headers.set("Cache-Control", "no-store");
    return resp;
  }
  // A top-level navigation with a bad/expired token gets a readable page
  // (with a re-pair hint) instead of a raw JSON 401 — the panel's own
  // recovery UI can never load if the bootstrap navigation itself 401s.
  if (!auth && isNav) {
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vale — session expired</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;color:#1d1d1f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:14px;padding:32px 40px;max-width:400px;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,.12)}h1{font-size:18px;margin:0 0 8px}p{color:#6e6e73;font-size:14px;margin:0 0 4px}.mark{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:10px;background:#1d1d1f;color:#fff;font-weight:700;font-size:24px;margin-bottom:14px}</style></head><body><div class="card"><span class="mark">V</span><h1>Device session expired</h1><p>This device pairing has expired or the browser was restarted.</p><p>Expired session — sign in to the console again to get a fresh device link.</p></div></body></html>`,
      { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  return jsonError(401, "Not logged in or invalid plugin token", "authentication_error");
}

/** Reverse-proxy to the device panel, injecting the Bearer token server-side. */
async function proxyDevice(
  request: Request,
  env: any,
  device: Device,
  restPath: string,
): Promise<Response> {
  const url = new URL(request.url);

  // The panel sits behind a tunnel that adds its own x-forwarded-*; don't pass
  // the console's through. deviceFetch injects the Bearer token and strips
  // host/cookie; restPath carries the request query string.
  const headers = new Headers(request.headers);
  headers.delete("x-forwarded-proto");
  headers.delete("x-forwarded-for");
  headers.delete("cf-connecting-ip");
  headers.set("x-forwarded-proto", "https");
  // round-103: the device's /panel/ injects its Bearer token ONLY when the
  // request carries the shared proxy secret (X-Vale-Auth) — the R102 marker
  // header was client-spoofable end-to-end (a direct curl could set it and
  // read the token → /api/tools RCE). The secret is read from the device at
  // registration; only this authenticated proxy path presents it.
  // Strip inbound FIRST: a client-sent x-vale-auth must never ride through
  // when the record has no proxySecret (the header is ours to mint).
  headers.delete("x-vale-auth");
  if (device.proxySecret) headers.set("x-vale-auth", device.proxySecret);

  // Never forward the extension's ?token= to the device — the plugin token
  // is a console-side credential; the device authenticates with its own
  // Bearer (injected by deviceFetch). A leaked token must not reach device
  // query logs.
  const q = new URLSearchParams(url.search);
  q.delete("token");
  const qs = q.toString();
  const { resp, error } = await deviceFetch(env, device, restPath + (qs ? `?${qs}` : ""), {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
  });
  if (!resp) return jsonError(502, error || "Device unreachable", "proxy_error");

  const outHeaders = new Headers(resp.headers);
  // CORS: reflect-if-allowlisted (console origins + loopback) with Vary —
  // NO wildcard. The proxied panel runs at the console origin and can read
  // console APIs (accepted trust limitation, round-133/134 note below), so
  // an arbitrary cross-origin reader must not be invited in on top of that.
  stampCors(request, outHeaders);
  const ct = String(outHeaders.get("content-type") || "").toLowerCase();

  if (resp.status === 101) {
    return build101Response(resp) ?? resp;
  }
  // Streaming (SSE / octet-stream): pass the body through untouched.
  if (resp.body && (ct.includes("text/event-stream") || ct.includes("application/octet-stream"))) {
    return new Response(resp.body, { status: resp.status, headers: outHeaders });
  }

  // Text assets (HTML/JS/CSS): rewrite absolute panel paths to the proxy mount.
  if (resp.body && ct.includes("text/")) {
    const text = await resp.text();
    const rewritten = rewriteDeviceBody(text, device.name);
    if (outHeaders.has("content-length")) {
      outHeaders.set("content-length", String(new TextEncoder().encode(rewritten).length));
    }
    // round-132/133: REVERTED the round-131 CSP sandbox — sandbox without
    // allow-same-origin makes the panel origin opaque: localStorage throws
    // SecurityError at mount (white screen) and cookies are never sent (all
    // /proxy/* API calls 401). The sandbox is fundamentally incompatible
    // with the panel's same-origin architecture.
    // ACTUAL INVARIANT (round-133/134): the ADMIN opens-panel flow opens the
    // panel at the DEVICE origin (https://<hostname>/panel/) where no console
    // cookie is reachable — that surface is closed. The console-origin proxy
    // path (/api/devices/<n>/proxy/panel/) remains reachable by BOTH the
    // extension flow AND an admin visiting it directly; device HTML runs at
    // a CONSOLE_HOST origin there and could read console APIs. This is an
    // ACCEPTED trust limitation (opening a device's panel is an explicit
    // trust action; the sandbox alternative breaks the panel entirely), and
    // it applies to every entry point of the proxy path.
    return new Response(rewritten, { status: resp.status, headers: outHeaders });
  }

  // JSON / binary: pass through — EXCEPT strip the proxy_secret (round-104:
  // a plugin-token holder proxying /api/status could read the secret and
  // escalate to the permanent device token, defeating unpair/revoke scope).
  if (resp.body && ct.includes("application/json")) {
    const text = await resp.text();
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object" && "proxy_secret" in j) {
        delete j.proxy_secret;
        const out = JSON.stringify(j);
        if (outHeaders.has("content-length")) {
          outHeaders.set("content-length", String(new TextEncoder().encode(out).length));
        }
        return new Response(out, { status: resp.status, headers: outHeaders });
      }
    } catch {
      /* non-JSON — fall through */
    }
    return new Response(text, { status: resp.status, headers: outHeaders });
  }
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

// Absolute paths a vale-agent panel serves from its own root. When proxied
// through the console they must carry the proxy mount so the SPA's absolute
// paths (/api/*, /app.js, /ui/*, ...) keep resolving through the proxy.
const PANEL_ROOT_PATHS: string[] = [
  "/api/",
  "/mcp",
  "/app.js",
  "/styles.css",
  "/state.js",
  "/ipc.js",
  "/events.js",
  "/transport.js",
  "/view.js",
  "/tabs.js",
  "/browser.js",
  "/term.js",
  "/conn.js",
  "/icons.js",
  "/ui/",
  "/vendor/",
];

/**
 * Rewrite absolute panel paths to the proxy mount + strip the injected
 * device token (SOLID Round-14: SRP export — previously module-private and
 * only exercisable through a live proxied fetch; the transform is pure and
 * carries the revocation-scope security invariant, so it is exported for
 * direct pins in device-proxy-rewrite.test.mjs. Export is additive: the
 * proxy path calls it exactly as before).
 */
export function rewriteDeviceBody(text: string, name: string): string {
  const prefix = `${DEVICE_BASE}/${name}/proxy`;
  const already = `${DEVICE_BASE}/[^/"']+/proxy/`;
  let out = text;
  for (const p of PANEL_ROOT_PATHS) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A quote/backtick OR template-interpolation close (}) followed by a
    // root path that isn't already the proxy prefix → insert the prefix
    // between them (avoids double-rewriting). The } case matters: panel.js
    // builds `https://${hostname}/api/events/term` where the path follows a
    // `}` — without it the SSE stream URL was never rewritten and the
    // proxied panel froze ("stream error 404", no needSync recovery).
    const re = new RegExp(`(["'\`}])(?!${already})${escaped}`, "g");
    out = out.replace(re, `$1${prefix}${p}`);
  }
  // Strip the agent's injected device token from proxied HTML. Direct
  // same-origin HTML never passes through this function (it only runs in
  // proxyDevice for /proxy/*), and the admin session-cookie flow authenticates
  // BEFORE any token parsing — so stripping costs nothing functionally, and
  // it prevents an extension user from reading the PERMANENT device token off
  // a console-origin page (DOM/devtools/XSS) and keeping direct control of
  // /api/tools/* and /mcp after the plugin-link TTL or unpair — the exact
  // revocation scope the plugin token exists to enforce.
  out = out.replace(
    /window\.__PANEL_TOKEN__\s*=\s*(?:"[^"]*"|'[^']*')/g,
    'window.__PANEL_TOKEN__=""',
  );
  return out;
}
