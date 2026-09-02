/**
 * Channel registry — the single source of truth for backend channels.
 * MODELS / ROUTE_INFO / HEALTH_CHANNELS / HEALTH_PRIORITY and the og endpoints
 * derive from here; adding a channel touches only this file. Extracted from
 * index.js (2026-08-12).
 */

// OpenCode Zen/Go endpoints. All og/ models (including deepseek-v4-flash)
// route through /v1/chat/completions (OpenAI format) — zen natively supports
// OpenAI format for all models. No Anthropic passthrough needed.
export const VERIFY_PATH: string = "/v1/messages";
export const OG_ZEN_ANTHROPIC: string = "https://opencode.ai/zen/go" + VERIFY_PATH;
export const OG_ZEN_CHAT: string = "https://opencode.ai/zen/go/v1/chat/completions";
// Command Code Provider API (api.commandcode.ai/provider). The Anthropic
// /v1/messages endpoint serves claude-* models ONLY ("Use
// /provider/v1/chat/completions for OpenAI and OSS models" — verified against
// the live API); cm/ models therefore ride the OpenAI endpoint, and
// /v1/messages is Anthropic→OpenAI translated (the og pattern).
export const CMD_CHAT: string = "https://api.commandcode.ai/provider/v1/chat/completions";
// Qwen MaaS (Aliyun Token Plan) OpenAI-compatible endpoint — the Anthropic
// /apps/anthropic/v1/messages endpoint rejects OpenAI-format bodies (400
// "Request body format invalid"), so chat/completions requests (DSH & co.)
// must ride the compatible-mode endpoint instead.
export const QWEN_COMPAT_CHAT: string =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions";
// AMD Radeon Cloud (developer.amd.com.cn/radeon) — self-deploy inference pool
// ("Dynamic sglang/vllm-router service managed by Model Ops"), free tier with
// a per-model global concurrency cap. BOTH formats are native: /api/v1/messages
// really speaks Anthropic (thinking blocks + tool_use + SSE, verified against
// the live API 2026-09-02) and /api/v1/chat/completions speaks OpenAI — no
// translation needed on either path.
export const AMD_ANTHROPIC: string = "https://developer.amd.com.cn/radeon/api" + VERIFY_PATH;
export const AMD_CHAT: string = "https://developer.amd.com.cn/radeon/api/v1/chat/completions";
// Reserved for future use — currently empty. Models listed here would bypass
// the OpenAI translate path and use native Anthropic /v1/messages passthrough.
export const OG_NATIVE_ANTHROPIC: Set<string> = new Set();

export function usProxyBase(env: any): string {
  return env?.US_PROXY_BASE || "https://v.saisi.online";
}

export const MODELS: { id: string; owned_by: string }[] = [
  { id: "ds/deepseek-v4-flash", owned_by: "deepseek" },
  { id: "og/deepseek-v4-flash", owned_by: "opencode" },
  { id: "og/minimax-m3", owned_by: "opencode" },
  { id: "og/mimo-v2.5", owned_by: "opencode" },
  { id: "og/ox-alpha-free", owned_by: "opencode" },
  // og/ spellings of luna are accepted here and remapped to the or/ channel
  // (translate.ts): zen region-blocks gpt-5.6-luna for CN, OpenRouter's US
  // exit works. Both og/ variants resolve to the same working route.
  { id: "og/gpt-5.6-luna", owned_by: "opencode" },
  { id: "og/openai/gpt-5.6-luna:floor[1m]", owned_by: "opencode" },
  { id: "or/openai/gpt-5.6-luna:floor[1m]", owned_by: "openrouter" },
  { id: "or/z-ai/glm-5.2:free", owned_by: "openrouter" },
  { id: "or/nvidia/nemotron-3-ultra-550b-a55b:free", owned_by: "openrouter" },
  // nv/ — NVIDIA NIM official API (dedicated key capacity, no shared pool)
  { id: "nv/nvidia/nemotron-3-ultra-550b-a55b", owned_by: "nvidia" },
  { id: "nv/minimaxai/minimax-m3", owned_by: "nvidia" },
  { id: "nv/moonshotai/kimi-k3", owned_by: "nvidia" },
  // gmi/ — GMI Cloud Inference Engine (api.gmi-serving.com). MiniMax Week
  // free tier (2026-08-24 → 09-06): MiniMax-M3 / M2.7 free for 14 days, then
  // standard pricing. Any model in GMI's catalog is reachable as
  // gmi/<upstream-id> — these two are the free headline models.
  { id: "gmi/MiniMaxAI/MiniMax-M3", owned_by: "gmi" },
  { id: "gmi/MiniMaxAI/MiniMax-M2.7", owned_by: "gmi" },
  { id: "or/stealth/ox-alpha", owned_by: "openrouter" },
  { id: "or/deepseek/deepseek-v4-flash-0731", owned_by: "openrouter" },
  { id: "qw/qwen3.8-max-preview", owned_by: "qwen" },
  { id: "qw/qwen3.8-flash", owned_by: "qwen" },
  // cm/ — Command Code (api.commandcode.ai/provider). GOAT plan and above have
  // Provider API access (the Go plan doesn't); one CMD_API_KEY works for both
  // the CLI and the API, usage meters against the plan credits. The Anthropic
  // /v1/messages endpoint serves claude-* only — cm/ rides chat/completions
  // (translated for /v1/messages, direct for /v1/chat/completions). Model id
  // is the provider-catalog slug verbatim (any catalog model works as cm/<id>).
  { id: "cm/deepseek/deepseek-v4-flash", owned_by: "command-code" },
  // amd/ — AMD Radeon Cloud (developer.amd.com.cn/radeon), free BYOK pool. The
  // catalog is GET /v1/models; any catalog slug is reachable as amd/<id> (case
  // matters: DeepSeek-V4-Flash, not deepseek-v4-flash). Two live warnings from
  // the 2026-09-02 sweep: reasoning_effort IS validated upstream (absent param
  // = thinking OFF, so clients must declare it), and GLM-5.3-Flash /
  // Qwen3.8-Flash-Next were pulled from /v1/models / stuck at 503
  // no_available_workers — not advertised here until they serve again.
  { id: "amd/DeepSeek-V4-Flash", owned_by: "amd-radeon" },
  { id: "amd/DeepSeek-V4-Flash-Vision-Exp", owned_by: "amd-radeon" },
];

// Route info shown in the console ("model routing" section). Public, no keys.
export const ROUTE_INFO: { prefix: string; backend: string; desc: string; models: string[] }[] = [
  {
    prefix: "og/",
    backend: "OpenCode Go",
    desc: "opencode.ai/zen/go — all models via chat/completions (OpenAI format); gpt-5.6-luna auto-routes via OpenRouter US exit (zen region-blocks it)",
    models: ["deepseek-v4-flash", "minimax-m3", "mimo-v2.5", "ox-alpha-free", "gpt-5.6-luna"],
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
    desc: "openrouter.ai — user's own key (BYOK); dual-format passthrough, US-proxy switch decides direct vs exit",
    models: [
      "openai/gpt-5.6-luna:floor[1m]",
      "z-ai/glm-5.2:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "stealth/ox-alpha",
      "deepseek/deepseek-v4-flash-0731",
    ],
  },
  {
    prefix: "nv/",
    backend: "NVIDIA NIM",
    desc: "integrate.api.nvidia.com — official nemotron API, dedicated key capacity (build.nvidia.com), OpenAI format",
    models: ["nvidia/nemotron-3-ultra-550b-a55b", "minimaxai/minimax-m3", "moonshotai/kimi-k3"],
  },
  {
    prefix: "gmi/",
    backend: "GMI Cloud",
    desc: "api.gmi-serving.com — MiniMax Week free tier (MiniMax-M3/M2.7 free 14 days, user's own GMI key), OpenAI format; any catalog model reachable as gmi/<id>",
    models: ["MiniMaxAI/MiniMax-M3", "MiniMaxAI/MiniMax-M2.7"],
  },
  {
    prefix: "qw/",
    backend: "Qwen MaaS (Aliyun)",
    desc: "token-plan.ap-southeast-1.maas.aliyuncs.com — Anthropic passthrough",
    models: ["qwen3.8-max-preview", "qwen3.8-flash"],
  },
  {
    prefix: "cm/",
    backend: "Command Code (GOAT)",
    desc: "api.commandcode.ai/provider — GOAT plan & up get Provider API access (Go plan excluded); Anthropic /v1/messages translated to chat/completions (the Anthropic endpoint only serves claude-*), OpenAI format passes through; any catalog model reachable as cm/<id>",
    models: ["deepseek/deepseek-v4-flash"],
  },
  {
    prefix: "amd/",
    backend: "AMD Radeon Cloud",
    desc: "developer.amd.com.cn/radeon — free BYOK pool (user's own rc- key); native Anthropic /v1/messages AND OpenAI /v1/chat/completions, no translation; reasoning_effort is validated upstream (absent = thinking off); per-model global concurrency cap (429 model_concurrency_rate_limit_exceeded); always direct — the US exit has no amd target",
    models: ["DeepSeek-V4-Flash", "DeepSeek-V4-Flash-Vision-Exp"],
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
  { id: "qw", model: "qw/qwen3.8-flash" },
  { id: "og", model: "og/deepseek-v4-flash" },
  // More og/ route cards: gpt-5.6-luna (auto-routes via the OpenRouter US
  // exit — translate.ts remaps it), mimo, ox-alpha. Duplicate ids are safe
  // here: buildHealth checks the og circuit for each and recommended uses
  // find() (first match).
  { id: "og", model: "og/gpt-5.6-luna" },
  { id: "og", model: "og/mimo-v2.5" },
  { id: "og", model: "og/ox-alpha-free" },
  { id: "or", model: "or/openai/gpt-5.6-luna:floor[1m]" },
  { id: "or", model: "or/z-ai/glm-5.2:free" },
  { id: "or", model: "or/nvidia/nemotron-3-ultra-550b-a55b:free" },
  { id: "or", model: "or/stealth/ox-alpha" },
  { id: "or", model: "or/deepseek/deepseek-v4-flash-0731" },
  { id: "nv", model: "nv/nvidia/nemotron-3-ultra-550b-a55b" },
  // MiniMax Week free tier on GMI Cloud — one card per free LLM.
  { id: "gmi", model: "gmi/MiniMaxAI/MiniMax-M3" },
  { id: "gmi", model: "gmi/MiniMaxAI/MiniMax-M2.7" },
  { id: "cm", model: "cm/deepseek/deepseek-v4-flash" },
  // amd/ — Radeon Cloud free pool. One card per SERVING model so the console
  // switchboard lists them and `vale use amd/...` can probe. GLM-5.3-Flash and
  // Qwen3.8-Flash-Next were pulled (503 no_available_workers / GLM left the
  // upstream catalog on 2026-09-02) but stay reachable by exact name — the
  // route only strips the prefix, MODELS is an advertising/auto-routing
  // whitelist, not a gate. NOT in HEALTH_PRIORITY: buildHealth reports ok for
  // everything but og's breaker, and a global "recommended" must not point
  // users at a BYOK pool that 502s without their own key.
  { id: "amd", model: "amd/DeepSeek-V4-Flash" },
  { id: "amd", model: "amd/DeepSeek-V4-Flash-Vision-Exp" },
];
export const HEALTH_PRIORITY: string[] = ["qw", "ds", "og", "or"];
