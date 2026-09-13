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
/** ── THE MODEL REGISTRY ────────────────────────────────────────────────
 *
 * ONE record per advertised model, holding every facet that used to live in a
 * separate table. Before this, adding a model meant remembering SIX places:
 *
 *     MODELS          advertise it            (channels.ts)
 *     OG_WIRE_REMAP   its upstream wire slug  (channels.ts, og/ only)
 *     OG_FORCE_US_PROXY        region policy  (channels.ts)
 *     SEARCH_CAPABLE_WIRE_MODELS  can search  (channels.ts)
 *     HEALTH_CHANNELS          health card    (channels.ts)
 *     VISION_CAPABLE_MODELS    sees images    (wrangler.jsonc, ENV)
 *
 * plus hardcoded conditions in plugins/translate.ts. Nothing FAILED if you
 * forgot one — measured: adding an id to MODELS alone left all 737 tests
 * green while the model was half-wired. Every table below now DERIVES from
 * this registry, and `model-registry.test.mjs` makes the coverage
 * bidirectional, so a forgotten facet fails the build instead of shipping.
 *
 * ORDER IS PART OF THE CONTRACT: `MODELS` is served verbatim by
 * /v1/models, so records must stay in the advertised order.
 *
 * VISION is deliberately NOT a facet here — it stays the
 * `VISION_CAPABLE_MODELS` env var in wrangler.jsonc, because operators must
 * be able to correct it WITHOUT a redeploy (a live model's image support is
 * discovered in the field, not at commit time). The registry is the default
 * for the other facets; env wins where both exist.
 */
export interface ModelSpec {
  /** Advertised id — the `MODELS` entry and what clients send. */
  id: string;
  /** `owned_by` reported by /v1/models. */
  ownedBy: string;
  /** Upstream wire slug when it differs from the prefix-stripped id.
   *  ONLY `og/` records may set this: `wireModelName` (upstream.ts) consults
   *  the map for prefix "og" alone, so a wire on any other prefix would be
   *  silently ignored. Pinned. */
  wire?: string;
  /** Must ride the US egress pool (region block / geographic policy). */
  usEgress?: boolean;
  /** Executes Anthropic web_search natively — keyed by WIRE slug. */
  search?: boolean;
  /** Served ONLY by /v1/responses (chat/completions 5xxs upstream). */
  responsesOnly?: boolean;
  /** Reasoning-effort model: default effort=max when the client sends none.
   *
   *  The MECHANISM follows the path, so it is part of the facet:
   *    "raw"    — passthrough routes forward raw text (no parse, for CPU), so
   *               the default is injected textually before forwarding;
   *    "parsed" — translate routes already hold the parsed object, so it is
   *               set on that object.
   *  Encoding the mechanism keeps each call site scoped to the models it
   *  actually served before — a `true` here would have let a passthrough
   *  model pick up the parsed path's default (or vice versa), which is a
   *  behaviour change even when both would look reasonable. */
  reasoningMax?: "raw" | "parsed";
  /** Health-probe card in /api/health. `false` = deliberately NOT probed and
   *  MUST carry `probeWhy`, so the decision is explicit rather than an
   *  oversight (five models had silently gone unprobed before this). */
  probe?: boolean;
  probeWhy?: string;
}

/** See the header above. Order = the /v1/models order. */
export const MODEL_REGISTRY: ModelSpec[] = [
  // ── og/ — OpenCode Go (zen/go) ──────────────────────────────────────────
  // V4.1 Flash: advertised under the CLEAR name, served by zen/go under the
  // version-less lane slug `deepseek-flash` (verified live 2026-09-10 — there
  // is no deepseek-v4.1-flash slug upstream), hence the wire remap. Also the
  // one web_search-capable model (Anthropic web_search_20250305 natively).
  {
    id: "og/deepseek-v4.1-flash",
    ownedBy: "opencode",
    wire: "deepseek-flash",
    search: true,
    probe: true,
  },
  // Not separately probed: the og/ card already has a representative model
  // and a card per model multiplies upstream traffic on every /api/health.
  {
    id: "og/minimax-m3",
    ownedBy: "opencode",
    probe: false,
    probeWhy: "translate-only model; the og/ health card covers the channel",
  },
  { id: "og/mimo-v2.5", ownedBy: "opencode", probe: true },
  // Reasoning-effort model — see `reasoningMax` and `reasoningDefaultMaxFor`.
  { id: "og/ox-alpha-free", ownedBy: "opencode", reasoningMax: "parsed", probe: true },
  // Meta Muse Spark Contributor: /v1/responses ONLY (chat/completions 500s,
  // verified 2026-09-04) and forced through the US exit (Meta Geographic Use
  // Policy). Requires the workspace data-training opt-in.
  {
    id: "og/muse-spark-1.3-contributor",
    ownedBy: "opencode",
    usEgress: true,
    responsesOnly: true,
    probe: true,
  },
  {
    id: "og/muse-spark-1.2-contributor",
    ownedBy: "opencode",
    usEgress: true,
    responsesOnly: true,
    probe: false,
    probeWhy: "superseded by 1.3; one probe per model family is enough",
  },
  // zen region-blocks luna for CN → rides the OpenRouter US exit.
  { id: "og/gpt-5.6-luna", ownedBy: "opencode", usEgress: true, probe: true },
  {
    id: "og/openai/gpt-5.6-luna:floor[1m]",
    ownedBy: "opencode",
    usEgress: true,
    probe: false,
    probeWhy: "the or/ spelling below is the probed luna card",
  },
  // ── or/ — OpenRouter (BYOK) ─────────────────────────────────────────────
  { id: "or/openai/gpt-5.6-luna:floor[1m]", ownedBy: "openrouter", probe: true },
  { id: "or/z-ai/glm-5.2:free", ownedBy: "openrouter", probe: true },
  {
    id: "or/nvidia/nemotron-3-ultra-550b-a55b:free",
    ownedBy: "openrouter",
    probe: true,
  },
  // ── nv/ — NVIDIA NIM (BYOK, dedicated capacity) ─────────────────────────
  { id: "nv/nvidia/nemotron-3-ultra-550b-a55b", ownedBy: "nvidia", probe: true },
  // RETIRED 2026-09-11: `nv/minimaxai/minimax-m3` was advertised here and NVIDIA
  // does not offer it. `scripts/model-drift.mjs` flagged it on every run, and the
  // check held up under the obvious objection — that the wire name might differ
  // from the advertised one — because NVIDIA's catalogue has NO MiniMax entry at
  // all, bare or prefixed (82 models, of which 7 are Chinese-lab: yi, deepseek x3,
  // kimi x2, glm — and no minimax). Every other nv/ id resolves exactly.
  //
  // An advertised model that cannot work is worse than an absent one: it appears
  // in /v1/models, it is selectable in the console's catalogue, and choosing it
  // fails upstream. `og/minimax-m3` is a DIFFERENT channel and is untouched.
  {
    id: "nv/moonshotai/kimi-k3",
    ownedBy: "nvidia",
    probe: false,
    probeWhy: "the nv/ health card already probes nemotron",
  },
  // ── gmi/ — GMI Cloud ────────────────────────────────────────────────────
  { id: "gmi/MiniMaxAI/MiniMax-M3", ownedBy: "gmi", probe: true },
  { id: "gmi/MiniMaxAI/MiniMax-M2.7", ownedBy: "gmi", probe: true },
  // ox-alpha reasoning-effort model (the or/ spelling). Sits here — NOT in the
  // or/ group above — because order is the /v1/models contract and this is
  // where the catalogue has always listed it.
  { id: "or/stealth/ox-alpha", ownedBy: "openrouter", reasoningMax: "raw", probe: true },
  // ── qw/ — Qwen ──────────────────────────────────────────────────────────
  { id: "qw/qwen3.8-max-preview", ownedBy: "qwen", probe: true },
  { id: "qw/qwen3.8-flash", ownedBy: "qwen", probe: true },
  // ── cm/ — Command Code (GOAT plan) ──────────────────────────────────────
  { id: "cm/meituan/LongCat-2.0:free", ownedBy: "command-code", probe: true },
  { id: "cm/poolside/laguna-s-2.1-free", ownedBy: "command-code", probe: true },
  { id: "cm/deepseek/deepseek-v4.1-flash", ownedBy: "command-code", probe: true },
];

/** A record by advertised id. */
export function modelSpec(id: string): ModelSpec | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

/** A record by the name the UPSTREAM sees (prefix stripped, wire applied).
 *
 * This is the key the translate path holds — it has already resolved the
 * route, so the advertised prefix is gone by then. `responsesOnly` and
 * `reasoningMax` are consulted this way.
 *
 * AMBIGUOUS NAMES RESOLVE TO NOTHING. Stripping the channel makes two
 * channels that advertise the same upstream slug collide:
 * `og/openai/gpt-5.6-luna:floor[1m]` and `or/openai/gpt-5.6-luna:floor[1m]`
 * share the wire name `openai/gpt-5.6-luna:floor[1m]`. Picking either would
 * let one channel's model INHERIT the other's facet — silently wrong the
 * moment a facet is declared, which is exactly the class of bug this
 * registry exists to remove. So: exactly one match, or none.
 *
 * `model-registry.test.mjs` asserts that every model whose facets are
 * consulted BY WIRE NAME (responsesOnly, reasoningMax) has a unique wire
 * name, so the refusal can never silently disable a live rule. Facets
 * consulted by ADVERTISED id (usEgress via OG_FORCE_US_PROXY) are unaffected
 * by the collision. */
export function wireSpec(wireName: string): ModelSpec | undefined {
  let hit: ModelSpec | undefined;
  for (const m of MODEL_REGISTRY) {
    const wire = m.wire ?? m.id.slice(m.id.indexOf("/") + 1);
    if (wire !== wireName) continue;
    if (hit) return undefined; // ambiguous — refuse rather than guess
    hit = m;
  }
  return hit;
}

/** Does this model default its reasoning effort to `max`, on the RAW-BODY
 *  (passthrough) path? Scoped by mechanism — see ModelSpec.reasoningMax. */
export function reasoningMaxRawFor(wireName: string): boolean {
  return wireSpec(wireName)?.reasoningMax === "raw";
}

/** Same, for the PARSED-object (translate) path. */
export function reasoningMaxParsedFor(wireName: string): boolean {
  return wireSpec(wireName)?.reasoningMax === "parsed";
}

/** Is this model served ONLY by /v1/responses? (muse-spark Contributor.)
 *  Anything NOT in the registry is refused too — an unadvertised id must not
 *  reach the upstream through a route the catalogue does not describe. */
export function isResponsesOnlyModel(wireName: string): boolean {
  return wireSpec(wireName)?.responsesOnly === true;
}

export const OG_WIRE_REMAP: Record<string, string> = Object.fromEntries(
  MODEL_REGISTRY.filter((m) => m.wire && m.id.startsWith("og/")).map((m) => [
    m.id.slice("og/".length),
    m.wire as string,
  ]),
);

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
export const SEARCH_CAPABLE_WIRE_MODELS: Set<string> = new Set(
  MODEL_REGISTRY.filter((m) => m.search).map((m) => m.wire ?? m.id.slice(m.id.indexOf("/") + 1)),
);

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
export const OG_FORCE_US_PROXY: Set<string> = new Set(
  MODEL_REGISTRY.filter((m) => m.usEgress).map((m) => m.id),
);

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

/** The advertised catalogue, DERIVED from MODEL_REGISTRY (SOLID R120).
 *
 * The 22 hand-written entries that used to live here moved into the registry
 * verbatim — same ids, same order, same `owned_by` — so /v1/models is
 * byte-identical. The per-model rationale (why a model exists, what upstream
 * serves it, which region policy applies) moved with them; see MODEL_REGISTRY.
 *
 * Adding a model is now ONE record there instead of choosing among six
 * tables, and `model-registry.test.mjs` fails the build if a facet is
 * forgotten. */
export const MODELS: { id: string; owned_by: string }[] = MODEL_REGISTRY.map((m) => ({
  id: m.id,
  owned_by: m.ownedBy,
}));

/** The advertised models on one channel prefix, in catalogue order.
 *
 * `ROUTE_INFO[].models` used to be hand-maintained — the FIFTH copy of the
 * catalogue — and had silently drifted from MODELS: the `og/` list omitted
 * `openai/gpt-5.6-luna:floor[1m]` entirely (advertised by /v1/models, absent
 * from the console's route breakdown), and `og/` + `cm/` listed theirs in a
 * different order. Nothing caught it: the only ROUTE_INFO test checked that
 * the PREFIXES were covered, never the lists.
 *
 * Deriving makes `routes[].models` by construction "the advertised models
 * whose channel is this prefix" — the same relationship `adminPublic` states
 * by returning `models: MODELS.map(...)` right beside it.
 *
 * `prefix` is the ROUTE_INFO spelling (`"og/"`, `"none"`). `"none"` is the
 * no-prefix default channel: its ids carry no channel prefix at all, so it is
 * NOT a filtered view and stays an explicit argument — see the call site. */
export function routeModelsFor(prefix: string, noneModels: string[] = []): string[] {
  if (prefix === "none") return noneModels;
  return MODEL_REGISTRY.filter((m) => m.id.startsWith(prefix)).map((m) =>
    m.id.slice(prefix.length),
  );
}

// Route info shown in the console ("model routing" section). Public, no keys.
export const ROUTE_INFO: { prefix: string; backend: string; desc: string; models: string[] }[] = [
  {
    prefix: "og/",
    backend: "OpenCode Go",
    desc: "opencode.ai/zen/go — all models via chat/completions (OpenAI format); gpt-5.6-luna auto-routes via OpenRouter US exit (zen region-blocks it); muse-spark-* via /v1/responses forced through the US exit (Meta region policy)",
    models: routeModelsFor("og/"),
  },
  {
    prefix: "or/",
    backend: "OpenRouter",
    desc: "openrouter.ai — user's own key (BYOK); dual-format passthrough, US-proxy switch decides direct vs exit",
    models: routeModelsFor("or/"),
  },
  {
    prefix: "nv/",
    backend: "NVIDIA NIM",
    desc: "integrate.api.nvidia.com — official nemotron API, dedicated key capacity (build.nvidia.com), OpenAI format",
    models: routeModelsFor("nv/"),
  },
  {
    prefix: "gmi/",
    backend: "GMI Cloud",
    desc: "api.gmi-serving.com — MiniMax Week free tier (MiniMax-M3/M2.7 free 14 days, user's own GMI key), OpenAI format; any catalog model reachable as gmi/<id>",
    models: routeModelsFor("gmi/"),
  },
  {
    prefix: "qw/",
    backend: "Qwen MaaS (Aliyun)",
    desc: "token-plan.ap-southeast-1.maas.aliyuncs.com — Anthropic passthrough",
    models: routeModelsFor("qw/"),
  },
  {
    prefix: "cm/",
    backend: "Command Code (GOAT)",
    desc: "api.commandcode.ai/provider — GOAT plan & up get Provider API access (Go plan excluded); Anthropic /v1/messages translated to chat/completions (the Anthropic endpoint only serves claude-*), OpenAI format passes through; any catalog model reachable as cm/<id>",
    models: routeModelsFor("cm/"),
  },
  {
    prefix: "none",
    backend: "Command Code (default)",
    desc: "no prefix → the default channel, Command Code (GOAT) with the model name passed through as-is; `auto` resolves to cm/deepseek/deepseek-v4.1-flash (per-user selection first, see model-route.ts). Note: cm/ rides Command Code's OpenAI endpoint, which rejects claude-* ids (those exist only on their Anthropic endpoint) — use a prefixed deepseek/OSS model there",
    models: routeModelsFor("none", ["deepseek/deepseek-v4.1-flash"]),
  },
];

/**
 * Every prefix the BUILT-IN router reserves — what a custom provider's prefix
 * is validated against (store/providers.ts refuses to register one).
 *
 * The list is the union of two sources that live in two modules, so it is
 * spelled out and PINNED instead of derived: ROUTE_INFO's prefixes are read
 * from the registry above, while `ds` and `amd` are ROUTE_TABLE-only channels
 * (live routes with no console card — ds is unpayable since 402s on every
 * request, amd has no V4.1 to advertise), and `none` is the no-prefix sentinel
 * rather than a prefix at all. `upstream.test.mjs` asserts this EQUALS
 * Object.keys(ROUTE_TABLE) ∪ {"none"}: a channel added to the route table
 * without a reservation here would become a shadowable prefix, and that fails
 * the build instead of shipping.
 *
 * Why reserve at all, when resolveRoute consults ROUTE_TABLE first and a
 * built-in therefore cannot be shadowed? Because the alternative is a provider
 * that validates, is advertised in the console, and then never serves a
 * request — a lie in the catalogue. The routing order is the security guard;
 * this list is the correctness one.
 */
export const RESERVED_PREFIXES: string[] = [
  ...ROUTE_INFO.map((r) => r.prefix.replace(/\/$/, "")),
  "ds",
  "amd",
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
