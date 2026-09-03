/**
 * Upstream route table — the single pickRoute/passthroughHeaders/stripBracket
 * implementation for every channel consumer.
 *
 * Was duplicated between plugins/translate.ts (the live /v1/* path) and
 * index.ts (valeProbe) — the copies had already drifted: translate's or/
 * route stays direct under US_PROXY while index's probe copy still proxied
 * it, so `vale use or` probed a different upstream than /v1/messages used.
 * One module, one contract. Semantics follow the translate plugin (the
 * battle-tested copy).
 */

import {
  VERIFY_PATH,
  usProxyBase,
  CMD_CHAT,
  QWEN_COMPAT_CHAT,
  AMD_ANTHROPIC,
  AMD_CHAT,
} from "./channels.ts";

export interface RouteInfo {
  type: string;
  kind: string;
  stripPrefix: boolean;
  upstream: string;
}

// Claude Code appends a [context-window] marker (e.g. [1m]) to model names and strips it
// before sending; strip it here too as a safety net so a literal "[1m]" never hits zen/OpenRouter.
export function stripBracket(s: string): string {
  return s.replace(/\[[^\]]*\]$/, "");
}

export function pickRoute(
  prefix: string,
  env: any,
  usProxy: string | null = null,
  requestPath: string = VERIFY_PATH,
): RouteInfo {
  // US egress switch: with US_PROXY=1 all models reach upstreams via the Vercel proxy (v.saisi.online/api/zen)
  // from US edge nodes, avoiding regional restrictions/congestion. target=og|ds|qw|or selects the upstream,
  // the path param carries the upstream relative path (the proxy base already includes the host-level prefix). usProxy is a local
  // per-request value — never mutate the shared env object with it.
  const via = (direct: string, path: string): string =>
    usProxy
      ? // audit round F4: prefix is model-derived ARBITRARY text — unencoded
        // it could inject &path=… into the egress URL and re-point the proxy
        // request. Encode (the proxy decodes) so it stays one opaque value.
        `${usProxyBase(env)}/api/zen?target=${encodeURIComponent(prefix)}&path=${encodeURIComponent(path)}`
      : direct;
  switch (prefix) {
    case "or": {
      // The switch now also covers or (2026-08-22): off = direct to openrouter.ai; on = via the US egress.
      // requestPath distinguishes the two formats: /v1/messages (Claude Code) and
      // /v1/chat/completions (DSH). The egress is measured to be a pure pipe — it passes Authorization
      // through, so BYOK is unaffected. openrouter-proxy is no longer on the path (the worker remains but is idle).
      const upstreamPath = requestPath || VERIFY_PATH;
      return {
        type: "passthrough",
        kind: "openrouter", // passes through the user's own OPENROUTER_API_KEY
        stripPrefix: true,
        upstream: via("https://openrouter.ai/api" + upstreamPath, upstreamPath),
      };
    }
    case "ds":
      return {
        type: "passthrough",
        kind: "deepseek",
        stripPrefix: true,
        upstream: via("https://api.deepseek.com/anthropic" + VERIFY_PATH, "/anthropic/v1/messages"),
      };
    case "qw":
      // Anthropic endpoint by default (/v1/messages — Claude Code & Anthropic
      // clients). OpenAI-format requests (/v1/chat/completions — DSH & co.)
      // must ride the compatible-mode endpoint: the /apps/anthropic endpoint
      // rejects OpenAI bodies (400 "Request body format invalid").
      return requestPath === "/v1/chat/completions"
        ? {
            type: "passthrough",
            kind: "qwen",
            stripPrefix: true,
            upstream: via(QWEN_COMPAT_CHAT, "/compatible-mode/v1/chat/completions"),
          }
        : {
            type: "passthrough",
            kind: "qwen",
            stripPrefix: true,
            upstream: via(
              "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic" + VERIFY_PATH,
              "/apps/anthropic/v1/messages",
            ),
          };
    case "og":
      return {
        type: "translate",
        kind: "opencode",
        stripPrefix: true,
        upstream: via("https://opencode.ai/zen/go/v1/chat/completions", "/v1/chat/completions"),
      };
    case "nv": {
      // NVIDIA NIM official API — OpenAI format only, dedicated per-key
      // capacity (no shared free pool). Registered models: nemotron family.
      const upstreamPath = "/v1/chat/completions";
      return {
        type: "passthrough",
        kind: "nvidia",
        stripPrefix: true,
        upstream: via("https://integrate.api.nvidia.com" + upstreamPath, upstreamPath),
      };
    }
    case "gmi": {
      // GMI Cloud Inference Engine (api.gmi-serving.com) — OpenAI-compatible
      // serverless endpoint; MiniMax Week free tier serves MiniMaxAI/MiniMax-M3
      // and MiniMaxAI/MiniMax-M2.7 free for 14 days (2026-08-24 → 09-06), then
      // standard pricing. Anthropic-format /v1/messages requests are translated
      // by the translate plugin (Anthropic → OpenAI → back), same as nv/.
      const upstreamPath = "/v1/chat/completions";
      return {
        type: "passthrough",
        kind: "gmi",
        stripPrefix: true,
        upstream: via("https://api.gmi-serving.com" + upstreamPath, upstreamPath),
      };
    }
    case "cm":
      // Command Code Provider API (api.commandcode.ai/provider) — Command
      // Code GOAT plan and above have API access (every plan except Go). The
      // Anthropic /v1/messages endpoint serves claude-* models ONLY (verified
      // against the live API: deepseek → 400 "Use /provider/v1/chat/completions
      // for OpenAI and OSS models"), so cm/ rides the OpenAI endpoint: the
      // translate plugin reshapes Anthropic /v1/messages → chat/completions
      // (the og pattern), while OpenAI-format /v1/chat/completions passes
      // through directly. Auth: the user's own CMD_API_KEY as Bearer.
      return {
        type: "translate",
        kind: "commandgoat",
        stripPrefix: true,
        upstream: via(CMD_CHAT, "/v1/chat/completions"),
      };
    case "amd":
      // AMD Radeon Cloud (developer.amd.com.cn/radeon) — a free BYOK pool that
      // speaks BOTH formats natively: Anthropic /v1/messages (thinking blocks,
      // tool_use and SSE verified against the live API 2026-09-02; accepts
      // x-api-key or Bearer) and OpenAI /v1/chat/completions (Bearer). So the
      // route is picked by requestPath, like qw/ — but no translation anywhere.
      //
      // Always DIRECT, never the US exit: developer.amd.com.cn is a CN-served
      // host (a US egress only adds a round the world), and the proxy's TARGETS
      // map has no amd entry — an unknown target silently falls back to zen,
      // which would answer with the wrong model AND the wrong key.
      return requestPath === "/v1/chat/completions"
        ? {
            type: "passthrough",
            kind: "amd",
            stripPrefix: true,
            upstream: AMD_CHAT,
          }
        : {
            type: "passthrough",
            kind: "amd",
            stripPrefix: true,
            upstream: AMD_ANTHROPIC,
          };
    default:
      // No prefix / unknown prefix → DeepSeek official
      return {
        type: "passthrough",
        kind: "deepseek",
        stripPrefix: false,
        upstream: via("https://api.deepseek.com/anthropic" + VERIFY_PATH, "/anthropic/v1/messages"),
      };
  }
}

export function passthroughHeaders(
  bearerKey: string | null,
  { apiKeyHeader = false }: { apiKeyHeader?: string | false } = {},
): Headers {
  const h = new Headers();
  h.set("Content-Type", "application/json");
  // All passthrough targets speak the Anthropic protocol (ds/qw native,
  // openrouter-proxy) — send the standard version header; OpenAI-format
  // backends ignore it.
  h.set("anthropic-version", "2023-06-01");
  // Do not forward the client's auth header — use this user's own key.
  // zen/go/v1/messages (native-Anthropic og) authenticates with x-api-key;
  // every other upstream accepts Bearer.
  if (bearerKey) {
    if (apiKeyHeader) h.set(apiKeyHeader, bearerKey);
    else h.set("Authorization", `Bearer ${bearerKey}`);
  }
  return h;
}
