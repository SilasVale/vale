/**
 * tooling — the public CLI-facing surface of the gateway (structure refactor:
 * moved verbatim from index.ts so the front door owns NOTHING but the front
 * door, completing ADR-0001's intent). Everything here is UNAUTHENTICATED and
 * consumed by the vale CLI / ops tooling, never by the console SPA:
 *
 *   buildHealth        GET /api/health channel health
 *   probeRateLimited   per-IP budget for /api/vale-probe (KV-seeded,
 *                      isolate-local counters — see the quota note below)
 *   valeProbe          POST /api/vale-probe — real max_tokens=1 probe
 *   encodeBase64Utf8   UTF-8-safe base64 for the installer payloads
 *   posixInstaller /
 *   psInstaller        the curl|sh / irm|iex one-liners embedding the CLI
 *   serveAssetText     ASSETS text fetch helper for the installer payloads
 */

import {
  HEALTH_CHANNELS,
  HEALTH_PRIORITY,
  MODELS,
  OG_ZEN_ANTHROPIC,
  OG_ZEN_CHAT,
  OG_NATIVE_ANTHROPIC,
} from "./channels.ts";
import { pickRoute, passthroughHeaders, stripBracket, opencodeSessionHeader } from "./upstream.ts";
import { fetchWithTimeout, upstreamTimeoutMs, isChannelDegraded } from "./reliability.ts";
import { jsonOk, jsonError } from "./http.ts";
import { createIpRateLimiter } from "./lib/ratelimit.ts";

// Public /api/vale-probe rate limit: each probe costs a real upstream call
// (real money), so cap probes per-caller via a KV counter. Per-IP (the
// gateway-wide bucket let one caller exhaust the budget for everyone AND a
// minute-boundary race double-spent).
const probeLimiter = createIpRateLimiter({
  name: "probe-rate",
  limit: 60, // probes per minute, per IP
  windowMs: 60_000,
  kvSeed: true, // each bucket's first sight per IP reads/persists KV once —
  // audit round F2: without persistence every new isolate reseeded from 0
  // and the ceiling was per-isolate. ONE read+write per bucket per IP, not
  // per request (KV quota invariant preserved).
});

/** Historical (env, request) signature preserved for index.ts + tests. */
export async function probeRateLimited(env: any, request: Request): Promise<boolean> {
  return probeLimiter(request, env);
}

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
 *  CLI is full of Chinese text). Encode to bytes first. Chunked: spreading a
 *  big Uint8Array into String.fromCharCode blows the argument-length limit
 *  (RangeError) as the CLI grows — append per 32k chunk instead. */
export function encodeBase64Utf8(text: string) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Probe-result envelope for valeProbe's channel branches: {ok, channel,
 * status} with the upstream status as detail on failure. The og and
 * passthrough branches used to each inline this shape. */
function probeResultJson(prefix: string, res: Response) {
  return jsonOk({
    ok: res.ok,
    channel: prefix,
    status: res.status,
    detail: res.ok ? "" : `upstream ${res.status}`,
  });
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
      // hit chat/completions with Bearer. zen/go requires the per-conversation
      // x-opencode-session header (2026-09-05+; probe model is arbitrary, so
      // use the stable anonymous digest).
      const session = opencodeSessionHeader(undefined, "probe");
      const headers = native
        ? { "x-api-key": key, "Content-Type": "application/json", ...session }
        : { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...session };
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
    return probeResultJson(prefix, res);
  }
  // Passthrough channels (ds/qw/or/nv/gmi/amd): reuse the exact route config of
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
              : prefix === "amd"
                ? env.AMD_API_KEY || ""
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
  return probeResultJson(prefix, res);
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

export async function serveAssetText(env: any, assetPath: string) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return null;
  }
  const res = await env.ASSETS.fetch(new Request(`https://assets.local${assetPath}`));
  return res.ok ? await res.text() : null;
}
