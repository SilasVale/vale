/**
 * Channel registry — the single source of truth for backend channels.
 * MODELS / ROUTE_INFO / HEALTH_CHANNELS / HEALTH_PRIORITY and the og endpoints
 * derive from here; adding a channel touches only this file. Extracted from
 * index.js (2026-08-12).
 */

// OpenCode Zen/Go endpoints. deepseek-v4-flash is Anthropic-native on
// zen/go/v1/messages (announced 2026-08-06) and authenticates with x-api-key
// (verified 2026-08-10 per handoff 2.5.6: ~54s full response, thinking +
// answer). Native passthrough forwards the Anthropic stream untouched — no
// per-chunk OpenAI translation, so no 1102 CPU risk on huge streams. Other og
// models (minimax-m3, mimo-v2.5) only speak chat/completions and keep the
// translate path (verified 2026-08-07 with this user's key).
export const VERIFY_PATH: string = "/v1/messages";
export const OG_ZEN_ANTHROPIC: string = "https://opencode.ai/zen/go" + VERIFY_PATH;
export const OG_ZEN_CHAT: string = "https://opencode.ai/zen/go/v1/chat/completions";
// deepseek-v4-flash 走原生 /v1/messages(US_PROXY 关时直连原生,US_PROXY 开时
// 走 translate chat 代理)。2026-08-11 交错实测:本时段原生直连总耗时最优
// (10.7-14.4s vs chat 直连 13.8-16.1s);首字节 chat 直连最稳,原生也不差。
// 时段敏感:之前测过 chat 代理 1.6s 最快——固定路径无法保证长期最优,
// 控制台 US_PROXY 开关可随时切换。其他 og 模型(minimax/mimo/kimi/glm)
// 始终走 translate(chat/completions)。
export const OG_NATIVE_ANTHROPIC: Set<string> = new Set(["deepseek-v4-flash"]);

export function usProxyBase(env: any): string {
  return env?.US_PROXY_BASE || "https://v.saisi.online";
}

export const MODELS: { id: string; owned_by: string }[] = [
  { id: "ds/deepseek-v4-flash", owned_by: "deepseek" },
  { id: "og/deepseek-v4-flash", owned_by: "opencode" },
  { id: "og/minimax-m3", owned_by: "opencode" },
  { id: "og/mimo-v2.5", owned_by: "opencode" },
  // og/ spellings of luna are accepted here and remapped to the or/ channel
  // (translate.ts): zen region-blocks gpt-5.6-luna for CN, OpenRouter's US
  // exit works. Both og/ variants resolve to the same working route.
  { id: "og/gpt-5.6-luna", owned_by: "opencode" },
  { id: "og/openai/gpt-5.6-luna:floor[1m]", owned_by: "opencode" },
  { id: "or/openai/gpt-5.6-luna:floor[1m]", owned_by: "openrouter" },
  { id: "or/z-ai/glm-5.2:free", owned_by: "openrouter" },
  { id: "or/deepseek/deepseek-v4-flash-0731", owned_by: "openrouter" },
  { id: "qw/qwen3.8-max-preview", owned_by: "qwen" },
];

// Route info shown in the console ("model routing" section). Public, no keys.
export const ROUTE_INFO: { prefix: string; backend: string; desc: string; models: string[] }[] = [
  {
    prefix: "og/",
    backend: "OpenCode Go",
    desc: "opencode.ai/zen/go — deepseek-v4-flash native /v1/messages; others chat/completions translation; gpt-5.6-luna auto-routes via OpenRouter US exit (zen region-blocks it)",
    models: ["deepseek-v4-flash", "minimax-m3", "mimo-v2.5", "gpt-5.6-luna"],
  },
  {
    prefix: "ds/",
    backend: "DeepSeek Official",
    desc: "api.deepseek.com/anthropic — Bearer passthrough",
    models: ["deepseek-v4-flash"],
  },
  {
    prefix: "or/",
    backend: "OpenRouter",
    desc: "openrouter.ai — user's own key, proxied via openrouter-proxy",
    models: ["openai/gpt-5.6-luna:floor[1m]", "z-ai/glm-5.2:free", "deepseek/deepseek-v4-flash-0731"],
  },
  {
    prefix: "qw/",
    backend: "Qwen MaaS (Aliyun)",
    desc: "token-plan.ap-southeast-1.maas.aliyuncs.com — Anthropic passthrough",
    models: ["qwen3.8-max-preview"],
  },
  {
    prefix: "none",
    backend: "DeepSeek Official (default)",
    desc: "fallback route",
    models: ["deepseek-v4-flash"],
  },
];

// ---- Channel health (public /api/health) ----
export const HEALTH_CHANNELS: { id: string; model: string }[] = [
  { id: "ds", model: "ds/deepseek-v4-flash" },
  { id: "qw", model: "qw/qwen3.8-max-preview" },
  { id: "og", model: "og/deepseek-v4-flash" },
  // Second og/ route card: gpt-5.6-luna (auto-routes via the OpenRouter US
  // exit — translate.ts remaps it). Duplicate ids are safe here: buildHealth
  // checks the og circuit for both and recommended uses find() (first match).
  { id: "og", model: "og/gpt-5.6-luna" },
  { id: "og", model: "og/mimo-v2.5" },
  { id: "or", model: "or/openai/gpt-5.6-luna:floor[1m]" },
  { id: "or", model: "or/z-ai/glm-5.2:free" },
  { id: "or", model: "or/deepseek/deepseek-v4-flash-0731" },
];
export const HEALTH_PRIORITY: string[] = ["qw", "ds", "og", "or"];
