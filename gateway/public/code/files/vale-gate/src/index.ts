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
 *   buildHealth()      channel health for GET /api/health
 *   valeProbe()        POST /api/vale-probe — CLI channel probe (real
 *                      max_tokens=1 call through the requested channel)
 *   installers         POSIX/PowerShell one-liners embedding the vale CLI
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
 *   plugin-hub.ts        PluginHubDO (extension WebSocket hub)
 *   mcp.ts               MCP endpoint handler (Claude Code)
 *   plugins/*            DSH-style route plugins (auth/devices/mcp/translate/admin)
 */

import { seedAdmin } from "./store.ts";
import { jsonOk, jsonError, readJson, CORS_HEADERS } from "./http.ts";
import { fetchWithTimeout, upstreamTimeoutMs, isChannelDegraded } from "./reliability.ts";
import {
  HEALTH_CHANNELS,
  HEALTH_PRIORITY,
  MODELS,
  OG_ZEN_ANTHROPIC,
  OG_ZEN_CHAT,
  OG_NATIVE_ANTHROPIC,
} from "./channels.ts";
import { pickRoute, passthroughHeaders, stripBracket } from "./upstream.ts";
import { createPluginContext, registerPlugins, dispatch } from "./plugins/registry.ts";
import authPlugin from "./plugins/auth.ts";
import devicesPlugin from "./plugins/devices.ts";
import mcpPlugin from "./plugins/mcp.ts";
import translatePlugin, { handleGateway as translateHandleGateway } from "./plugins/translate.ts";
import adminPlugin from "./plugins/admin.ts";

// Re-exported for tooling/tests that target the front door surface.
// BreakerDO/PluginHubDO/RouteDO must be exported from the entrypoint —
// wrangler binds the Durable Object classes from here.
export { BreakerDO } from "./reliability.ts";
export { PluginHubDO } from "./plugin-hub.ts";
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
    if (hit !== null) return hit;
  }
  // No plugin matched (e.g. /v1/<unknown>) — the translate impl owns the
  // same 404/405 semantics the inline dispatcher had.
  return translateHandleGateway(request, env, url);
}

// Public /api/vale-probe rate limit: each probe costs a real upstream call
// (real money), so cap probes per-caller via a KV counter. Per-IP (the
// gateway-wide bucket let one caller exhaust the budget for everyone AND a
// minute-boundary race double-spent).
const PROBE_RATE_LIMIT = 60; // probes per minute, per IP
const PROBE_RATE_WINDOW_MS = 60000;

// In-memory per-IP probe counters (per isolate) — the KV version cost 1
// read + 1 write per probe call; probes are user-invoked but this keeps the
// "no per-request KV writes" invariant (KV quota). Each bucket's first call
// per IP reads KV once; nothing is written.
const __probeRate = new Map(); // `ip:${bucket}` → count

export async function probeRateLimited(env: any, request: Request) {
  try {
    const ip = request?.headers?.get?.("cf-connecting-ip") || "unknown";
    const bucket = Math.floor(Date.now() / PROBE_RATE_WINDOW_MS);
    const key = `probe-rate:${ip}:${bucket}`;
    const hit = __probeRate.get(key);
    if (hit !== undefined) {
      if (hit >= PROBE_RATE_LIMIT) return true;
      __probeRate.set(key, hit + 1);
      return false;
    }
    let cur = 0;
    try {
      cur = Number(await env.KEYS.get(key)) || 0;
    } catch {
      /* KV read failed */
    }
    __probeRate.set(key, cur + 1);
    if (__probeRate.size > 4096) __probeRate.delete(__probeRate.keys().next().value);
    return cur >= PROBE_RATE_LIMIT;
  } catch {
    return false;
  } // fail-open on KV errors, like the breaker
}

export default {
  async fetch(request: Request, env: any) {
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
      return new Response(null, { headers: CORS_HEADERS });
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
        return jsonOk(await buildHealth(env));
      }
      if (request.method === "POST" && path === "/api/vale-probe") {
        if (await probeRateLimited(env, request)) {
          return jsonError(429, "probe rate limit exceeded", "rate_limit_error");
        }
        const body = await readJson(request);
        return await valeProbe(env, String(body.model || ""));
      }
      if (
        path === "/api/vale-cli" ||
        path === "/api/vale-install" ||
        path === "/api/vale-install.ps1"
      ) {
        const cli = await serveAssetText(env, "/vale");
        if (cli === null) return jsonError(404, "vale CLI not found", "not_found_error");
        if (path === "/api/vale-cli") {
          return new Response(cli, {
            headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS },
          });
        }
        const b64 = encodeBase64Utf8(cli);
        const body = path === "/api/vale-install" ? posixInstaller(b64) : psInstaller(b64);
        return new Response(body, {
          headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS },
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
        if (hit !== null) return hit;
        return jsonError(404, "Not Found", "not_found_error");
      }

      // ---- OpenAI-compatible alias: /models → /v1/models, /chat/completions → /v1/chat/completions ----
      if ((path === "/models" || path === "/chat/completions") && request.method !== "OPTIONS") {
        const v1Url = new URL(url);
        v1Url.pathname = "/v1" + path;
        return await handleGateway(request, env, v1Url);
      }

      // ---- Static page (Workers Assets): non-/v1/ paths → ai domain only ----
      if (!path.startsWith("/v1/")) {
        if (!isPageHost) return jsonError(404, "Not Found", "not_found_error");
        if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
          return env.ASSETS.fetch(request);
        }
        return jsonError(404, "Not Found", "not_found_error");
      }

      // ---- /v1/* gateway (both domains) ----
      return await handleGateway(request, env, url);
    } catch (error) {
      return jsonError(500, (error as any).message || "Internal error", "api_error");
    }
  },
};

/* ---------------- Public endpoints: health / probe / installers ---------------- */

export async function buildHealth(env: any) {
  const channels: any[] = [];
  for (const c of HEALTH_CHANNELS) {
    let ok = true;
    let reason = "";
    if (c.id === "og") {
      ok = !(await isChannelDegraded(env));
      if (!ok) reason = "circuit open";
    }
    channels.push({ id: c.id, ok, model: c.model, ...(reason ? { reason } : {}) });
  }
  const recommended = HEALTH_PRIORITY.map((id) => channels.find((c) => c.id === id)).find(
    (c) => c.ok,
  );
  return {
    channels,
    recommended: recommended ? { channel: recommended.id, model: recommended.model } : null,
  };
}

/** UTF-8-safe base64: btoa is Latin1-only and throws on non-ASCII (the vale
 *  CLI is full of Chinese text). Encode to bytes first. */
export function encodeBase64Utf8(text: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/**
 * Channel probe for the vale CLI's `use` command (public POST /api/vale-probe).
 *
 * Fires a real max_tokens=1 request through the requested channel using the
 * WORKER-level provider keys, so the CLI can verify a channel serves BEFORE
 * rewriting settings — from any settings state. Public like /api/health;
 * each probe costs one tiny upstream call (og short-circuits on the open
 * breaker, so a degraded channel costs nothing).
 */
export async function valeProbe(env: any, model: string) {
  const prefix = model.split("/")[0] || "";
  if (!HEALTH_CHANNELS.some((c) => c.id === prefix) || !MODELS.some((m) => m.id === model)) {
    return jsonError(400, `Unknown channel model: ${model}`, "invalid_request");
  }
  // og → zen; respect the breaker first so a degraded channel fails fast at no cost.
  // All og models currently take the chat/completions translate path (Bearer);
  // native-Anthropic models listed in OG_NATIVE_ANTHROPIC probe zen/go/v1/messages
  // with x-api-key instead.
  if (prefix === "og") {
    if (await isChannelDegraded(env)) {
      return jsonOk({ ok: false, channel: prefix, detail: "circuit open" });
    }
    const key = env.OPENCODE_GO_API_KEY || "";
    if (!key)
      return jsonOk({ ok: false, channel: prefix, detail: "OPENCODE_GO_API_KEY not configured" });
    const upstreamModel = stripBracket(model.slice(prefix.length + 1));
    const native = OG_NATIVE_ANTHROPIC.has(upstreamModel);
    let res;
    try {
      // Native models hit zen /v1/messages with x-api-key; translate models
      // hit chat/completions with Bearer.
      const headers = native
        ? { "x-api-key": key, "Content-Type": "application/json" }
        : { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
      res = await fetchWithTimeout(
        native ? OG_ZEN_ANTHROPIC : OG_ZEN_CHAT,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: upstreamModel,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            stream: false,
          }),
        },
        upstreamTimeoutMs(env),
      );
    } catch (e) {
      return jsonOk({ ok: false, channel: prefix, detail: (e as any).message });
    }
    return jsonOk({
      ok: res.ok,
      channel: prefix,
      status: res.status,
      detail: res.ok ? "" : `upstream ${res.status}`,
    });
  }
  // Passthrough channels (ds/qw/or/nv/gmi): reuse the exact route config of
  // /v1/messages.
  const route = pickRoute(prefix, env);
  const key =
    prefix === "or"
      ? env.OPENROUTER_API_KEY || ""
      : prefix === "qw"
        ? env.QWEN_API_KEY || ""
        : prefix === "nv"
          ? env.NVAPI_KEY || ""
          : prefix === "gmi"
            ? env.GMI_API_KEY || ""
            : prefix === "cm"
              ? env.CMD_API_KEY || ""
              : env.DEEPSEEK_API_KEY || "";
  if (!key) return jsonOk({ ok: false, channel: prefix, detail: `${prefix}: key not configured` });
  const upstreamModel = stripBracket(route.stripPrefix ? model.slice(prefix.length + 1) : model);
  let res;
  try {
    res = await fetchWithTimeout(
      route.upstream,
      {
        method: "POST",
        headers: passthroughHeaders(key),
        body: JSON.stringify({
          model: upstreamModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      },
      upstreamTimeoutMs(env),
    );
  } catch (e) {
    return jsonOk({ ok: false, channel: prefix, detail: (e as any).message });
  }
  return jsonOk({
    ok: res.ok,
    channel: prefix,
    status: res.status,
    detail: res.ok ? "" : `upstream ${res.status}`,
  });
}

// POSIX one-liner installer — embeds the vale CLI as base64 (no quoting issues).
export function posixInstaller(b64: string) {
  return `#!/bin/sh
set -e
command -v node >/dev/null 2>&1 || { echo "error: Node.js required"; exit 1; }
DEST="\${VALE_BIN:-$HOME/.local/bin}"
mkdir -p "$DEST"
echo "${b64}" | (base64 -d 2>/dev/null || base64 -D) > "$DEST/vale"
chmod +x "$DEST/vale"
echo "installed: $DEST/vale"
echo "usage: vale check | vale use <ds|qw|og|or> | vale use auto | vale restore"
`;
}

// PowerShell one-liner installer (irm | iex) — installs vale + vale.cmd wrapper.
export function psInstaller(b64: string) {
  return `$ErrorActionPreference = "Stop"
try { node --version | Out-Null } catch { Write-Error "Node.js required"; exit 1 }
$dest = Join-Path $HOME ".local\\bin"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${b64}"))
Set-Content -Path (Join-Path $dest "vale") -Value $script -Encoding UTF8 -NoNewline
Set-Content -Path (Join-Path $dest "vale.cmd") -Value '@echo off\r\nnode "%~dp0vale" %*' -Encoding ASCII
Write-Host "installed: $dest\\vale  (command: vale)"
`;
}

async function serveAssetText(env: any, assetPath: string) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return null;
  }
  const res = await env.ASSETS.fetch(new Request(`https://assets.local${assetPath}`));
  return res.ok ? await res.text() : null;
}
