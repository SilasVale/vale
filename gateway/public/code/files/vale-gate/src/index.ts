/**
 * vale-gate — Cloudflare Worker front door (thin bootstrap).
 *
 * The file used to be a 90KB single dispatcher where every console route
 * lived inline; since round-73 the routes live in DSH-style plugins and this
 * module only wires them up. Since the 2026-08 refactor it owns NOTHING but
 * the front door:
 *
 *   fetch()            host split (console vs API), HTTPS redirect, static
 *                      assets, /v1/* dispatch, public tooling endpoints
 *   ensurePluginCtx()  builds the plugin context once per isolate:
 *                      auth / devices / mcp / translate / admin plugins own
 *                      every /api/* route + /mcp + /v1/* (see src/plugins/)
 *   handleGateway()    thin wrapper over the translate plugin's /v1 impl
 *
 * The public CLI-facing tooling surface (GET /api/health, POST
 * /api/vale-probe + its rate limiter, the /api/vale-* installer payloads)
 * lives in tooling.ts — index.ts routes to it and re-exports it for the
 * historical import path.
 *
 * Module map:
 *   channels.ts          channel registry (MODELS/ROUTE_INFO/HEALTH + og endpoints)
 *   upstream.ts          pickRoute/passthroughHeaders/stripBracket (route table)
 *   body-scan.ts         10ms-CPU-budget raw-string scans (never parse big bodies)
 *   anthropic-translate.ts Anthropic↔OpenAI SSE translation (pure, zero env)
 *   reliability.ts       fetchWithTimeout/Retry + BreakerDO + timeouts
 *   session.ts           requireSession/sessionSecret (single copy)
 *   http.ts              jsonOk/jsonError/readJson/CORS
 *   store.ts             KV persistence (users/tokens/devices/plugin links)
 *   tooling.ts           public CLI surface (health/probe/installers)
 *   mcp.ts               MCP endpoint handler (Claude Code)
 *   plugins/*            DSH-style route plugins (auth/devices/mcp/translate/admin)
 */

import { seedAdmin } from "./store.ts";
import { jsonOk, jsonError, readJson, CORS_HEADERS, corsHeadersFor, withCors } from "./http.ts";
import {
  buildHealth,
  probeRateLimited,
  valeProbe,
  encodeBase64Utf8,
  posixInstaller,
  psInstaller,
  serveAssetText,
} from "./tooling.ts";
// Re-export the public tooling surface: tests + external tooling import it
// from the front-door module (historical path).
export {
  buildHealth,
  probeRateLimited,
  valeProbe,
  encodeBase64Utf8,
  posixInstaller,
  psInstaller,
} from "./tooling.ts";
import { createPluginContext, registerPlugins, dispatch } from "./plugins/registry.ts";
import authPlugin from "./plugins/auth.ts";
import { csrfCookieViolation } from "./auth.ts";
import devicesPlugin from "./plugins/devices.ts";
import mcpPlugin from "./plugins/mcp.ts";
import translatePlugin, { handleGateway as translateHandleGateway } from "./plugins/translate.ts";
import adminPlugin from "./plugins/admin.ts";

// Re-exported for tooling/tests that target the front door surface.
// BreakerDO/RouteDO must be exported from the entrypoint —
// wrangler binds the Durable Object classes from here.
export { BreakerDO } from "./reliability.ts";
export { RouteDO } from "./route-do.ts";
export { resolveAutoModel, isModelUsable } from "./plugins/translate.ts";

/**
 * Plugin context: built once per isolate with the shared helpers; every
 * /api/* route, /mcp and /v1/* lives in a plugin now. Lazy so a reload never
 * re-registers duplicate routes.
 */
let __pluginCtx: any = null;
function ensurePluginCtx() {
  if (__pluginCtx) return __pluginCtx;
  __pluginCtx = createPluginContext(null, {
    jsonOk,
    jsonError: jsonError as (status: number, message: string, code?: string) => Response,
    readJson,
    CORS_HEADERS,
  });
  registerPlugins(__pluginCtx, [
    authPlugin,
    devicesPlugin,
    mcpPlugin,
    translatePlugin,
    adminPlugin,
  ]);
  return __pluginCtx;
}

/** /v1/* entry — dispatches through the plugin table, then the translate impl. */
export async function handleGateway(request: Request, env: any, url: URL) {
  const pctx = ensurePluginCtx();
  if (pctx.routes.length) {
    const hit = dispatch(
      pctx,
      request.method,
      url.pathname,
      request,
      env,
      url,
      url.protocol === "https:",
    );
    if (hit !== null) return withCors(request, await hit);
  }
  // No plugin matched (e.g. /v1/<unknown>) — the translate impl owns the
  // same 404/405 semantics the inline dispatcher had.
  // withCors: per-request reflect-if-allowlisted (default-closed otherwise).
  const res = await translateHandleGateway(request, env, url);
  return withCors(request, res);
}

export default {
  async fetch(request: Request, env: any) {
    // Auth-core audit MED-1: global CSRF gate for cookie-authed mutations
    // (device panels are SAME-SITE with the console; SameSite=Lax does not
    // help there). Bearer clients carry no cookie — untouched.
    if (csrfCookieViolation(request)) {
      return withCors(request, jsonError(403, "Cross-site request blocked", "csrf_error"));
    }
    const url = new URL(request.url);

    // Force HTTPS: the Secure session cookie is only stored over https; on plain http
    // the browser drops it and login appears to "succeed then bounce back".
    // (Cloudflare normalizes url.protocol to https, so inspect x-forwarded-proto.)
    const proto = String(request.headers.get("x-forwarded-proto") || "")
      .split(",")[0]!
      .trim()
      .toLowerCase();
    if (proto && proto !== "https") {
      return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 308);
    }

    if (request.method === "OPTIONS") {
      // Global preflight: reflect-if-allowlisted + Vary, NO ACAO otherwise.
      return new Response(null, { headers: corsHeadersFor(request) });
    }

    try {
      // Hostname isolation: the console (static page + /api/*) lives only on the
      // CONSOLE_HOST var(s). localhost / 127.0.0.1 are allowed for local `wrangler dev`.
      const consoleHosts = String(env.CONSOLE_HOST || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const isPageHost =
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        consoleHosts.includes(url.hostname);
      const path = url.pathname;

      // ---- Public tooling endpoints (any host) ----
      if (path === "/api/health") {
        return withCors(request, jsonOk(await buildHealth(env)));
      }
      if (request.method === "POST" && path === "/api/vale-probe") {
        if (await probeRateLimited(env, request)) {
          return withCors(request, jsonError(429, "probe rate limit exceeded", "rate_limit_error"));
        }
        const body = await readJson(request);
        return withCors(request, await valeProbe(env, String(body.model || "")));
      }
      if (
        path === "/api/vale-cli" ||
        path === "/api/vale-install" ||
        path === "/api/vale-install.ps1"
      ) {
        const cli = await serveAssetText(env, "/vale");
        if (cli === null)
          return withCors(request, jsonError(404, "vale CLI not found", "not_found_error"));
        // Genuinely-public installer payloads (curl|sh / irm|iex — CORS-
        // irrelevant non-browser clients): KEEP the ACAO:* wildcard so any
        // browser-hosted install helper keeps working. No session, no secret.
        const publicCors = { "Access-Control-Allow-Origin": "*" };
        if (path === "/api/vale-cli") {
          return new Response(cli, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              ...CORS_HEADERS,
              ...publicCors,
            },
          });
        }
        const b64 = encodeBase64Utf8(cli);
        const body = path === "/api/vale-install" ? posixInstaller(b64) : psInstaller(b64);
        return new Response(body, {
          headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS, ...publicCors },
        });
      }

      await seedAdmin(env);

      // ---- Console API + MCP endpoint (page hosts) — all plugin-owned ----
      if (isPageHost && (path.startsWith("/api/") || path === "/mcp")) {
        const pctx = ensurePluginCtx();
        const hit = dispatch(
          pctx,
          request.method,
          path,
          request,
          env,
          url,
          url.protocol === "https:",
        );
        if (hit !== null) return withCors(request, await hit);
        return withCors(request, jsonError(404, "Not Found", "not_found_error"));
      }

      // ---- OpenAI-compatible alias: /models → /v1/models, /chat/completions → /v1/chat/completions ----
      if ((path === "/models" || path === "/chat/completions") && request.method !== "OPTIONS") {
        const v1Url = new URL(url);
        v1Url.pathname = "/v1" + path;
        return await handleGateway(request, env, v1Url);
      }

      // ---- Static page (Workers Assets): non-/v1/ paths → ai domain only ----
      if (!path.startsWith("/v1/")) {
        if (!isPageHost) return withCors(request, jsonError(404, "Not Found", "not_found_error"));
        if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
          return withCors(request, await env.ASSETS.fetch(request));
        }
        return withCors(request, jsonError(404, "Not Found", "not_found_error"));
      }

      // ---- /v1/* gateway (both domains) ----
      // (handleGateway already applies withCors; re-stamping is idempotent.)
      return await handleGateway(request, env, url);
    } catch (error) {
      // Never echo raw error internals to clients (logged server-side).
      console.error("[gateway] unhandled:", error);
      return withCors(request, jsonError(500, "Internal error", "api_error"));
    }
  },
};
