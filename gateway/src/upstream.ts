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

import { VERIFY_PATH, usProxyBase } from "./channels.ts";

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
  // 美国出口开关:US_PROXY=1 时所有模型经 Vercel 代理(v.saisi.online/api/zen)
  // 从美国边缘出口访问上游,规避区域限制/拥堵。target=og|ds|qw|or 选上游,
  // path 参数带上游相对路径(代理 base 已含主机级前缀)。usProxy is a local
  // per-request value — never mutate the shared env object with it.
  const via = (direct: string, path: string): string =>
    usProxy
      ? `${usProxyBase(env)}/api/zen?target=${prefix}&path=${encodeURIComponent(path)}`
      : direct;
  switch (prefix) {
    case "or": {
      // 开关统一管到 or(2026-08-22):关=直连 openrouter.ai;开=经美国出口。
      // requestPath 区分双格式:/v1/messages(Claude Code)与
      // /v1/chat/completions(DSH)。出口实测为纯管道——透传 Authorization,
      // BYOK 不受影响。openrouter-proxy 不再在链路上(worker 保留但闲置)。
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
      return {
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
