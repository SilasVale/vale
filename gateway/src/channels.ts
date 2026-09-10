/**
 * Channel registry — the single source of truth for backend channels.
 * MODELS / ROUTE_INFO / HEALTH_CHANNELS / HEALTH_PRIORITY and the og endpoints
 * derive from here; adding a channel touches only this file. Extracted from
 * index.js (2026-08-12).
 *
 * Boundary (architecture review 2026-09-06): this module is the DATA registry
 * — endpoints, whitelists, display/health metadata, and the two env-derived
 * exit helpers (usProxyBase/museResponsesExit). The routing DECISION layer
 * (pickRoute/passthroughHeaders) lives in upstream.ts, one-way upstream ->
 * channels. Reviewed as correctly layered; no split warranted — the muse
 * exit policy stays beside its registry data for documentation coherence.
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

// zen/go wire-slug aliases: advertised og/ names that differ from the slug
// the upstream actually accepts (applied after prefix-strip, og/ only — see
// wireModelName in upstream.ts). deepseek-v4.1-flash → deepseek-flash: zen/go
// runs the Flash line as a version-less lane (slug = family, version lives in
// the display name) and has NO deepseek-v4.1-flash slug; we advertise the
// clear name and rewrite on the wire. The raw lane name stays reachable by
// exact spelling too (it strips to a slug with no remap entry → passthrough).
export const OG_WIRE_REMAP: Record<string, string> = {
  "deepseek-v4.1-flash": "deepseek-flash",
};

// zen/go server-side web_search capability, keyed by WIRE slug (i.e. after
// OG_WIRE_REMAP — the search-model swap in plugins/translate.ts checks the wire
// name). "deepseek-flash" is the version-less lane = V4.1, the remap target of
// og/deepseek-v4.1-flash: it executes Anthropic's web_search_20250305 natively
// and answers with server_tool_use + web_search_tool_result (live-verified
// 2026-09-10 against zen/go/v1/messages with a forced
// tool_choice:{type:"tool",name:"web_search"}: HTTP 200 + 4 searches). The V4
// slug `deepseek-v4-flash` was search-capable too but retired with the V4 line
// on 2026-09-10 (RETIRED_MODELS) and is no longer a swap target.
// Every other og/ model on the translate path (minimax-m3, mimo-v2.5, kimi,
// glm) fabricates a query and returns NO web_search_tool_result, so a search
// request naming one of those still falls back to the lane slug.
export const SEARCH_CAPABLE_WIRE_MODELS: Set<string> = new Set(["deepseek-flash"]);

// Retired models — the whole DeepSeek V4 Flash line, taken down 2026-09-10 in
// favour of V4.1 Flash. DeepSeek official retired V4 first (its docs: the old
// names `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` still answer but
// are served BY V4.1), AMD's pool never got a V4.1, and every other channel we
// advertise serves V4.1. Requests naming a retired id (or its bare upstream
// wire spelling) are REJECTED with the replacement in the message instead of
// silently riding an alias: a silent alias hides which model actually
// answered and lets dead names live in client configs forever.
// Keys are lowercase — the lookup lowercases + trims the requested model, so
// AMD's case-sensitive catalogue ids are covered by one entry.
export const RETIRED_MODELS: Record<string, string> = {
  // Advertised ids that left the catalog.
  "ds/deepseek-v4-flash": "cm/deepseek/deepseek-v4.1-flash",
  "og/deepseek-v4-flash": "og/deepseek-v4.1-flash",
  "cm/deepseek/deepseek-v4-flash": "cm/deepseek/deepseek-v4.1-flash",
  "cm/deepseek/deepseek-v4-flash-vision-exp": "cm/deepseek/deepseek-v4.1-flash",
  "or/deepseek/deepseek-v4-flash-0731": "cm/deepseek/deepseek-v4.1-flash",
  "amd/deepseek-v4-flash": "cm/deepseek/deepseek-v4.1-flash",
  "amd/deepseek-v4-flash-vision-exp": "cm/deepseek/deepseek-v4.1-flash",
  // Bare upstream spellings (unprefixed names and wire names), for clients
  // that never used a prefix.
  "deepseek-v4-flash": "cm/deepseek/deepseek-v4.1-flash",
  "deepseek-v4-flash-vision-exp": "cm/deepseek/deepseek-v4.1-flash",
  "deepseek-v4-flash-0731": "cm/deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-flash": "cm/deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-flash-vision-exp": "cm/deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-flash-0731": "cm/deepseek/deepseek-v4.1-flash",
};

/** Replacement id for a retired model, or null when the model is not retired.
 *  Lookup is case-insensitive on the trimmed name (AMD ids are mixed-case). */
export function retiredModelHint(model: string): string | null {
  const key = String(model || "")
    .trim()
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(RETIRED_MODELS, key)
    ? (RETIRED_MODELS[key] as string)
    : null;
}

// Model-level forced US egress. These og/ models are region-blocked when zen
// is reached directly from CN clients, so requests ALWAYS ride a US exit
// regardless of the global US_PROXY switch:
//   - og/gpt-5.6-luna — zen region-blocks it for CN (translate.ts remaps the
//     og/ spellings to the or/ route via OpenRouter's US exit).
//   - og/muse-spark-1.2/1.3-contributor — Meta Geographic Use Policy blocks
//     the contributor tier outside permitted regions; the US exit clears the
//     RegionError (verified 2026-09-04: direct = 403 RegionError, via US exit
//     = 200).
export const OG_FORCE_US_PROXY: Set<string> = new Set([
  "og/gpt-5.6-luna",
  "og/openai/gpt-5.6-luna:floor[1m]",
  "og/muse-spark-1.2-contributor",
  "og/muse-spark-1.3-contributor",
]);

export function usProxyBase(env: any): string {
  return env?.US_PROXY_BASE || "https://v.saisi.online";
}

// US exit for og/muse-spark-* via POST /v1/responses (translate.ts). The
// muse Contributor tier is responses-only upstream AND Meta region-blocks it
// for CN, so it is FORCED through a US exit. The default exit is the Oracle
// Cloud relay: oracle.saisi.online (grey-cloud DNS + Let's Encrypt cert) → an
// Always-Free ARM VM in US West (Phoenix) whose nginx forwards /v1/responses
// to opencode zen (US egress clears the Meta RegionError — verified live
// 2026-09-08: full chain gateway→oracle→zen returns completed responses).
// The previous default, the Vercel relay (v.saisi.online/api/zen), is now
// UNAVAILABLE: the free team exceeded the 10 GB Fast Origin Transfer cap
// (304%) and the account was paused (402 DEPLOYMENT_DISABLED, 2026-09-07).
// MUSE_RESPONSES_EXIT selects the exit:
//   - "vercel"        → legacy NAME: routes muse through the generic zen
//                       relay ({US_PROXY_BASE}/api/zen?target=og&path=…).
//                       Since the 2026-09-08 Vercel retirement that endpoint
//                       is served by the SAME Oracle box (vrelay) — a
//                       distinct code path (BYOK gate + path allowlist),
//                       not a distinct machine.
//   - "zen-us"        → the zen-us Cloudflare worker (zen-us.saisi.online/
//                       v1/responses). US-pinned via WNAM D1 + placement,
//                       but the CF egress still hits 403 RegionError live
//                       (verified 2026-09-08) — experimental, do not set.
//   - a http(s) URL   → used verbatim (any US exit speaking the same
//                       BYOK /v1/responses contract)
//   - unset / other   → the Oracle relay default (oracle.saisi.online)
export function museResponsesExit(env: any): string {
  const v = env?.MUSE_RESPONSES_EXIT;
  if (v === "vercel")
    return `${usProxyBase(env)}/api/zen?target=og&path=${encodeURIComponent("/v1/responses")}`;
  if (v === "zen-us") return "https://zen-us.saisi.online/v1/responses";
  if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
  return "https://oracle.saisi.online/v1/responses";
}

export const MODELS: { id: string; owned_by: string }[] = [
  // 2026-09-10: the whole V4 Flash line is RETIRED (see RETIRED_MODELS below)
  // — DeepSeek official turned `deepseek-v4-flash` into a V4.1 alias, AMD's
  // pool never got a V4.1, and the channels we advertise all serve V4.1 now.
  // No ds/ line is advertised either: the official key is out of balance
  // (402 on every request, verified 2026-09-10), so the ds/ route stays
  // reachable by exact name (`ds/deepseek-flash` after a top-up) without
  // sitting in the catalog.
  // DeepSeek V4.1 Flash (released 2026-09-10). Advertised under the CLEAR
  // name; zen/go serves it under the version-less lane slug `deepseek-flash`
  // (verified live against /v1/models 2026-09-10 — there is no
  // deepseek-v4.1-flash slug upstream), so requests ride the OG_WIRE_REMAP
  // alias below. effort low/high/max, 1M ctx / 384K out. Vision is merged
  // into the V4.1 core — V4 kept it in a separate -vision-exp variant and
  // its core still 400s on image blocks. Live-verified on zen/go 2026-09-10:
  // a 1x1 PNG was read back correctly, so V4.1 rides the
  // VISION_CAPABLE_MODELS allowlist (wrangler.jsonc, wire name). Only
  // OpenCode Go serves V4.1 for now — the official API and OpenRouter lists
  // stop at V4; register a ds/ or or/ line when those catalogs pick it up.
  { id: "og/deepseek-v4.1-flash", owned_by: "opencode" },
  { id: "og/minimax-m3", owned_by: "opencode" },
  { id: "og/mimo-v2.5", owned_by: "opencode" },
  { id: "og/ox-alpha-free", owned_by: "opencode" },
  // Meta Muse Spark Contributor tier — data-for-discount coding model on zen/go.
  // Served via /v1/responses ONLY (chat/completions 500s — verified 2026-09-04),
  // forced through the US exit (Meta Geographic Use Policy), and requires the
  // workspace-level data-collection opt-in ("allow data-training models").
  // reasoning.effort accepts off/minimal/low/medium/high (max rejected).
  { id: "og/muse-spark-1.3-contributor", owned_by: "opencode" },
  { id: "og/muse-spark-1.2-contributor", owned_by: "opencode" },
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
  // or/ deepseek line retired with the rest of V4 (2026-09-10). OpenRouter
  // does carry `deepseek/deepseek-v4.1-flash`, but this account's guardrails
  // reject every endpoint of it ("0 endpoints out of 1 requested are
  // available matching your guardrail restrictions and data policy",
  // verified 2026-09-10) — advertising a model that 404s for the account
  // would be worse than dropping the line. Flip the OpenRouter privacy
  // setting and re-add it here if that changes.
  { id: "qw/qwen3.8-max-preview", owned_by: "qwen" },
  { id: "qw/qwen3.8-flash", owned_by: "qwen" },
  // cm/ — Command Code (api.commandcode.ai/provider). GOAT plan and above have
  // Provider API access (the Go plan doesn't); one CMD_API_KEY works for both
  // the CLI and the API, usage meters against the plan credits. The Anthropic
  // /v1/messages endpoint serves claude-* only — cm/ rides chat/completions
  // (translated for /v1/messages, direct for /v1/chat/completions). Model id
  // is the provider-catalog slug verbatim (any catalog model works as cm/<id>).
  // 2026-09-03: Command Code now advertises two :free models — Meituan's
  // LongCat-2.0 (1M ctx) and Poolside's Laguna S 2.1 (256K ctx) — metered
  // against the same plan quota as the paid catalog.
  { id: "cm/meituan/LongCat-2.0:free", owned_by: "command-code" },
  { id: "cm/poolside/laguna-s-2.1-free", owned_by: "command-code" },
  // 2026-09-10: V4.1 Flash reached the Command Code catalog as
  // `deepseek/deepseek-v4.1-flash` (1M ctx) — same slug SHAPE as the V4 line,
  // so cm/ needs NO wire remap (unlike og/, whose zen/go lane slug is
  // version-less; here the version is in the slug itself). Live-verified
  // through this gateway the same day: text on /v1/chat/completions and
  // /v1/messages, and a 240x80 PNG read back verbatim on the
  // chat/completions passthrough — that path never pre-describes images, so
  // the image truly reached the upstream model (native vision, hence the
  // VISION_CAPABLE_MODELS entry in wrangler.jsonc).
  { id: "cm/deepseek/deepseek-v4.1-flash", owned_by: "command-code" },
  // amd/ — AMD Radeon Cloud (developer.amd.com.cn/radeon), free BYOK pool.
  // RETIRED 2026-09-10: the pool never got a V4.1 (every spelling of
  // DeepSeek-V4.1-Flash / deepseek-v4.1-flash 404s "not available",
  // verified live) and both models we advertised were V4 Flash variants,
  // so the whole prefix left the catalog with the V4 line. The route
  // builder and the AMD key probe stay (an exact `amd/<slug>` still
  // routes); re-add entries when the pool serves a V4.1.
];

// Route info shown in the console ("model routing" section). Public, no keys.
export const ROUTE_INFO: { prefix: string; backend: string; desc: string; models: string[] }[] = [
  {
    prefix: "og/",
    backend: "OpenCode Go",
    desc: "opencode.ai/zen/go — all models via chat/completions (OpenAI format); gpt-5.6-luna auto-routes via OpenRouter US exit (zen region-blocks it); muse-spark-* via /v1/responses forced through the US exit (Meta region policy)",
    models: [
      "deepseek-v4.1-flash",
      "minimax-m3",
      "mimo-v2.5",
      "ox-alpha-free",
      "gpt-5.6-luna",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2-contributor",
    ],
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
    models: [
      "deepseek/deepseek-v4.1-flash",
      "meituan/LongCat-2.0:free",
      "poolside/laguna-s-2.1-free",
    ],
  },
  {
    prefix: "none",
    backend: "Command Code (default)",
    desc: "no prefix → the default channel, Command Code (GOAT) with the model name passed through as-is; `auto` resolves to cm/deepseek/deepseek-v4.1-flash (per-user selection first, see model-route.ts). Note: cm/ rides Command Code's OpenAI endpoint, which rejects claude-* ids (those exist only on their Anthropic endpoint) — use a prefixed deepseek/OSS model there",
    models: ["deepseek/deepseek-v4.1-flash"],
  },
];

// ---- Channel health (public /api/health) ----
// 2026-09-10 (V4 retirement): the ds/ and amd/ cards left with their models —
// ds/ is unpayable (402 on every request) and amd/ has no V4.1 to advertise.
export const HEALTH_CHANNELS: { id: string; model: string }[] = [
  { id: "qw", model: "qw/qwen3.8-max-preview" },
  { id: "qw", model: "qw/qwen3.8-flash" },
  { id: "og", model: "og/deepseek-v4.1-flash" },
  // More og/ route cards: gpt-5.6-luna (auto-routes via the OpenRouter US
  // exit — translate.ts remaps it), mimo, ox-alpha. Duplicate ids are safe
  // here: buildHealth checks the og circuit for each and recommended uses
  // find() (first match).
  { id: "og", model: "og/gpt-5.6-luna" },
  { id: "og", model: "og/mimo-v2.5" },
  { id: "og", model: "og/ox-alpha-free" },
  // muse-spark Contributor — /v1/responses model; health probe must ride the
  // responses endpoint through the US exit (see translate.ts).
  { id: "og", model: "og/muse-spark-1.3-contributor" },
  { id: "or", model: "or/openai/gpt-5.6-luna:floor[1m]" },
  { id: "or", model: "or/z-ai/glm-5.2:free" },
  { id: "or", model: "or/nvidia/nemotron-3-ultra-550b-a55b:free" },
  { id: "or", model: "or/stealth/ox-alpha" },
  { id: "nv", model: "nv/nvidia/nemotron-3-ultra-550b-a55b" },
  // MiniMax Week free tier on GMI Cloud — one card per free LLM.
  { id: "gmi", model: "gmi/MiniMaxAI/MiniMax-M3" },
  { id: "gmi", model: "gmi/MiniMaxAI/MiniMax-M2.7" },
  { id: "cm", model: "cm/deepseek/deepseek-v4.1-flash" },
  { id: "cm", model: "cm/meituan/LongCat-2.0:free" },
  { id: "cm", model: "cm/poolside/laguna-s-2.1-free" },
];
// The default channel leads: `auto`/no-prefix now resolve to Command Code
// V4.1 (model-route.ts / upstream.ts defaultRoute), so the console's
// "recommended" badge points at the same place the gateway defaults to.
export const HEALTH_PRIORITY: string[] = ["cm", "qw", "og", "or"];
