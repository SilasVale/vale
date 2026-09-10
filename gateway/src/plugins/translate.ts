/**
 * Vale gateway "translate" plugin (round-73) — /v1/* model translation routes.
 * (migrated from translate.js to TS, logic verbatim — types added only)
 *
 * Capability: OpenAI/Anthropic chat-completions translation. Extracted
 * VERBATIM from index.js's handleGatewayImpl /v1 branches and their helpers
 * (round-73 structural split; zero logic change — no refactor, no rename).
 *
 * Routes registered (same method+path semantics index.js had):
 *   GET  /v1/models           — model list (impl: path.endsWith("/models"))
 *   POST /v1/messages         — Anthropic chat completions (impl: path.endsWith(VERIFY_PATH));
 *                               the /v1/messages prefix also covers POST /v1/messages/count_tokens
 *                               (impl: isCount branch — index.js dispatched it into the same handler)
 *   POST /v1/chat/completions — OpenAI-format entry (impl currently 404s any path other than
 *                               /v1/messages* /v1/models — identical to index.js behavior)
 *
 * Every route dispatches through the copied handleGateway() wrapper, exactly
 * as index.js's fetch did (`if (!path.startsWith("/v1/")) ... else handleGateway(...)`).
 * The copied functions are the /v1 branch of the old single dispatcher, so the
 * impl's own endsWith checks remain authoritative; the route table above is
 * just the entry points.
 */

import { findUserByToken, getUserKeys, getGlobalSetting, globalSettingEnabled } from "../store.ts";
import {
  toOpenAIRequest,
  toAnthropicResponse,
  streamOgToAnthropic,
  toSSE,
} from "../anthropic-translate.ts";
import {
  fetchWithRetry,
  ogTimeoutMs,
  passthroughTimeoutMs,
  isChannelDegraded,
  recordChannelFailure,
  isChannelDownFailure,
  recordChannelSuccess,
} from "../reliability.ts";
import {
  rawWithDeepSeekProvider,
  rawWithOxAlphaReasoningDefault,
  rawWithModel,
  scanTopLevelModel,
  estimateTokens,
} from "../body-scan.ts";
import { jsonOk, jsonError, CORS_HEADERS, stampCors } from "../http.ts";
import {
  MODELS,
  OG_FORCE_US_PROXY,
  OG_NATIVE_ANTHROPIC,
  OG_ZEN_ANTHROPIC,
  VERIFY_PATH,
  museResponsesExit,
  usProxyBase,
} from "../channels.ts";
// Route table lives in the shared upstream module (also used by index.ts's
// valeProbe — the copies had drifted on the or/ US_PROXY behavior).
import { pickRoute, passthroughHeaders, stripBracket, opencodeSessionHeader } from "../upstream.ts";
import { preprocessImages } from "./translate-vision.ts";
import { isModelUsable, resolveAutoModel } from "./model-route.ts";
// Keep the old import paths working for the moved fns' external consumers.
export { isModelUsable, resolveAutoModel } from "./model-route.ts";
import type { PluginContext } from "./registry.ts";
import { provideApi } from "./registry.ts";

const COUNT_PATH = "/v1/messages/count_tokens";

/**
 /**
 * Reshape an OpenAI chat/completions upstream response into an Anthropic
 * Messages response for the client. Shared by the og translate path and the
 * nv/gmi translation (Anthropic-only clients like Claude Code riding
 * /v1/messages against OpenAI-format upstreams). Handles all three upstream
 * behaviors: true SSE streaming (translated chunk-by-chunk to Anthropic
 * SSE), a stream:true request answered with a plain JSON completion
 * (wrapped as a one-shot Anthropic SSE), and a one-shot JSON completion.
 */
// Exported for direct pins (SOLID Round-57; additive — call sites untouched).
export async function openAIUpstreamToAnthropicResponse(
  upstream: Response,
  body: any,
  clientModel: string,
  upstreamModel: string,
): Promise<Response> {
  // True streaming: when the client asked for a stream, forward the upstream's
  // OpenAI SSE chunks to Anthropic SSE increments as they arrive (instead of
  // buffering the whole response and flushing it at once — that made thinking
  // look frozen and could time out long generations).
  if (body.stream) {
    const ctype = upstream.headers?.get?.("content-type") || "";
    if (ctype.includes("application/json") && !ctype.includes("text/event-stream")) {
      // The upstream ignored stream:true and returned a plain JSON completion
      // (a proxy/backend quirk, or a 200-wrapped error). Feeding JSON into the
      // SSE parser produced an EMPTY Anthropic message — the whole answer was
      // silently dropped. Buffer + translate as a one-shot SSE instead.
      const json: any = await upstream.json().catch(() => null);
      if (json) {
        // A 200-wrapped OpenAI ERROR envelope ({error:{...}}) must NOT become
        // a silent empty assistant message — surface it.
        if (json.error || !Array.isArray(json.choices) || json.choices.length === 0) {
          return jsonError(
            502,
            json.error?.message || json.message || "upstream returned an error envelope",
            "api_error",
          );
        }
        const oneShot = toSSE(toAnthropicResponse(json, upstreamModel));
        return sseResponse(oneShot);
      }
      // Parse failed AND the body was consumed — a fall-through to the SSE
      // translator would read an empty stream and fabricate an empty message.
      return jsonError(502, "upstream returned invalid JSON", "api_error");
    }
    const streamBody = streamOgToAnthropic(
      upstream.body as ReadableStream,
      clientModel,
      upstreamModel,
    );
    return sseResponse(streamBody);
  }
  const upJson: any = await upstream.json().catch(() => null);
  // A 200-wrapped OpenAI error envelope must not become an empty assistant
  // message (silent failure, no retry signal).
  if (!upJson || upJson.error || !Array.isArray(upJson.choices) || upJson.choices.length === 0) {
    return jsonError(
      502,
      upJson?.error?.message || upJson?.message || "upstream returned an invalid response",
      "api_error",
    );
  }
  return jsonOk(toAnthropicResponse(upJson, upstreamModel));
}

/* ---------------- /v1/* gateway ---------------- */

// round-158: scrub leaked provider keys out of any surfaced 502/503 body so a
// gateway error can never echo `sk-…` back to the caller (money).
// Exported (coverage audit row 3) so the regex is unit-tested.
export function scrubKeys(msg: string): string {
  return String(msg || "").replace(/\b(?:sk|rc|sc|or|xox[baprs])-[A-Za-z0-9_-]{8,}/g, "***");
}

/** SSE passthrough response — the one-shot and streaming relay sites used to
 *  build the same text/event-stream + no-cache + CORS header set twice. */
function sseResponse(body: BodyInit | null): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      ...CORS_HEADERS,
    },
  });
}

// One place owns "which route kind needs which BYOK key + what the missing-
// key 502 says". Every /v1 branch used to hand-roll the same
// `if (route.kind === X && !keyX) return jsonError(502, "<KEY> not
// configured — <hint>", "config_error")` — 21 copies that drifted on every
// channel add (a new kind needed its guard in four separate flow sites with
// the message re-typed each time). Call sites gate on the key themselves and
// delegate the 502 shape here; the messages live ONLY in this table, so a
// message tweak or a new kind touches one place.
const KEY_MISSING_MESSAGES: Record<string, string> = {
  deepseek: "DEEPSEEK_API_KEY not configured — add your own key in the console",
  opencode: "OPENCODE_GO_API_KEY not configured — add your own key in the console",
  openrouter: "OPENROUTER_API_KEY not configured — add your own key in the console",
  qwen: "QWEN_API_KEY not configured — add your own key in the console",
  nvidia: "NVAPI_KEY not configured — add your NVIDIA build.nvidia.com key",
  gmi: "GMI_API_KEY not configured — add your GMI Cloud key in the console",
  amd: "AMD_API_KEY not configured — add your AMD Radeon Cloud (rc-…) key in the console",
  commandgoat: "CMD_API_KEY not configured — add your Command Code key in the console",
};
/** Missing-key 502 for a route kind, or null when the kind needs no key.
 *  Callers invoke it only inside their own `!key` guard (they own which
 *  kinds a flow gates on), so the returned error is never conditional on
 *  anything but the message table lookup. */
export function keyMissingError(kind: string): Response | null {
  const msg = KEY_MISSING_MESSAGES[kind];
  return msg ? jsonError(502, msg, "config_error") : null;
}

/**
 * Circuit-open guard for og/: when the channel breaker is open, fail fast
 * with the "circuit open" 502 instead of waiting on zen again. Every /v1
 * flow that can reach the og upstream (chat/completions, responses,
 * messages) used to inline the same three-line check.
 */
async function channelDegradedError(env: any, kind: string): Promise<Response | null> {
  if (kind === "opencode" && (await isChannelDegraded(env))) {
    return jsonError(
      502,
      "og: circuit open (recent upstream failures, try again in ~1 min)",
      "api_error",
    );
  }
  return null;
}

/**
 * Error response when the upstream call itself failed (network throw /
 * fetchWithRetry exhaustion): surface the in-band inspect failure's status
 * digits when it is a real HTTP status, else 502, so downstream classifiers
 * (DSH/Claude Code) recognize the failure as transient, not fatal. Records
 * the channel failure for og. Shared by the chat/completions, og-translate
 * and /v1/responses arms (used to be copy-pasted at all three sites).
 */
async function upstreamFetchFailedResponse(
  env: any,
  kind: string,
  inspectFailure: any,
  detail: string,
): Promise<Response> {
  if (kind === "opencode") await recordChannelFailure(env);
  const failStatus =
    typeof inspectFailure?.status === "number" &&
    inspectFailure.status >= 400 &&
    inspectFailure.status <= 599
      ? inspectFailure.status
      : 502;
  return jsonError(
    failStatus,
    `upstream ${failStatus} (${kind}): ${detail}`,
    failStatus === 429 ? "rate_limit_error" : "api_error",
  );
}

/**
 * Normalize a non-OK upstream body into a gateway jsonError: unwrap
 * {"detail":{...}} (AMD Radeon's FastAPI envelope), scrub any leaked key,
 * keep the upstream's OWN error.type when it is a known Anthropic type
 * (Claude Code keys retry/auth flows off it), and carry Retry-After when
 * present. Shared by the three /v1 arms' !upstream.ok handlers — they used
 * to each maintain a copy of the unwrap + KNOWN-whitelist logic (round-512
 * fixed one arm and the others had to be walked to parity by hand).
 */
async function upstreamBodyErrorResponse(upstream: any): Promise<Response> {
  let message = `Upstream ${upstream.status}`;
  // Default by status BEFORE body sniffing: OpenRouter's error envelope
  // carries no Anthropic-style type, and a bare api_error on a 429 told
  // clients to give up instead of backing off.
  let type = upstream.status === 429 ? "rate_limit_error" : "api_error";
  let extra: Record<string, string> = {};
  try {
    const rawErr: any = await upstream.json();
    const err: any = rawErr?.detail && typeof rawErr.detail === "object" ? rawErr.detail : rawErr;
    message =
      scrubKeys(err.error?.message || err.message || JSON.stringify(err).slice(0, 200)) || message;
    const upType = err.error?.type || err.type;
    const KNOWN = [
      "rate_limit_error",
      "overloaded_error",
      "authentication_error",
      "invalid_request_error",
      "permission_error",
      "not_found_error",
      "request_too_large",
      "api_error",
    ];
    if (upType && KNOWN.includes(upType)) type = upType;
    // Pace the client against the upstream limit.
    const ra = upstream.headers?.get?.("retry-after");
    if (ra) extra = { "retry-after": ra };
  } catch {
    /* non-JSON error body */
  }
  return jsonError(upstream.status, message, type, extra);
}
/**
 * Shared upstream-result relay for the direct-forward arms (chat/
 * completions, /v1/responses, and the messages passthrough): breaker
 * failure/success recording for og, CORS stamping, generation-id
 * capture, and the upstream body streamed back untouched. The three
 * arms used to each carry a byte-identical copy of this tail (the
 * round-14 extraction covered only the two failure helpers).
 * recordOgBodyFailure: a down-shaped 5xx BODY also counts toward the
 * breaker on all three arms (chat/completions + responses + messages
 * passthrough, unified by product sign-off 2026-09-08 — the passthrough
 * arm's historical gap is closed).
 */
/// or/stealth/ox-alpha requests default reasoning.effort=max when the
/// client sent no top-level reasoning. Applied by BOTH the /v1/messages
/// and the chat/completions flows — used to be inlined at both sites.
// Exported for direct pins (SOLID Round-27; additive — call sites untouched).
export function oxAlphaReasoningDefault(
  routeKind: string,
  upstreamModel: string,
  body: string,
): string {
  if (routeKind === "openrouter" && upstreamModel === "stealth/ox-alpha") {
    return rawWithOxAlphaReasoningDefault(body);
  }
  return body;
}

async function relayUpstreamResult(
  env: any,
  request: Request,
  routeKind: string,
  upstream: Response | null,
  detail: string,
  inspectFailure: any,
  ctx: { generationId?: string | undefined },
  recordOgBodyFailure: boolean,
): Promise<Response> {
  if (!upstream) {
    // Shared fetch-failure path (all /v1 arms) — see upstreamFetchFailedResponse.
    return upstreamFetchFailedResponse(env, routeKind, inspectFailure, detail);
  }
  if (!upstream.ok) {
    if (recordOgBodyFailure && routeKind === "opencode" && isChannelDownFailure(detail)) {
      await recordChannelFailure(env);
    }
    // Shared upstream-body normalization (all /v1 arms) — see upstreamBodyErrorResponse.
    return upstreamBodyErrorResponse(upstream);
  }
  if (routeKind === "opencode") await recordChannelSuccess(env);
  const headers = new Headers(upstream.headers);
  stampCors(request, headers);
  ctx.generationId = upstream.headers.get("x-generation-id") || undefined;
  return new Response(upstream.body, { status: upstream.status, headers });
}

// get-then-put counters cost 2 reads + 2 writes per /v1/messages request —
// that alone burned the Free-plan daily KV WRITE quota (1000/day) at ~250
// requests. Never written; each window's first request per token reads KV
// once to inherit other isolates' counts.
const __rlMin = new Map(); // `min:${token}:${minute}` → count
const __rlDay = new Map(); // `day:${token}:${day}`   → count
/** Per-token rate limiter: in-memory minute + day counters (no KV).
 *  Returns a 429 Response if the token is over budget, else null (proceed).
 *  Shared by the /v1/messages, /v1/chat/completions and /v1/responses arms. */
// Exported for direct pins (SOLID Round-27; additive — call sites untouched).
export function checkRateLimit(
  env: any,
  method: string,
  path: string,
  token: string,
): Response | null {
  if (!(
    env.KEYS &&
    method === "POST" &&
    (path.endsWith("/messages") ||
      path.endsWith("/chat/completions") ||
      path.endsWith("/responses")) &&
    !path.endsWith(COUNT_PATH)
  )) {
    return null;
  }
  const mk = `min:${token}:${Math.floor(Date.now() / 60000)}`;
  const dk = `day:${token}:${Math.floor(Date.now() / 86400000)}`;
  const minute = __rlMin.get(mk) ?? 0;
  const day = __rlDay.get(dk) ?? 0;
  if (minute >= 48) {
    return jsonError(429, "Rate limit: ~60 requests/minute per token", "rate_limit_error");
  }
  if (day >= 4000) {
    return jsonError(429, "Rate limit: ~5000 requests/day per token", "rate_limit_error");
  }
  __rlMin.set(mk, minute + 1);
  __rlDay.set(dk, day + 1);
  if (__rlMin.size > 4096) __rlMin.delete(__rlMin.keys().next().value);
  if (__rlDay.size > 4096) __rlDay.delete(__rlDay.keys().next().value);
  return null;
}

/** Extract BYOK (bring-your-own-key) keys from the user's key record.
 *  Each key maps to a specific upstream provider. null when unset. */
// Exported for direct pins (SOLID Round-27; additive — call sites untouched).
export function extractByokKeys(ukeys: Record<string, any>) {
  return {
    deepseek: ukeys.DEEPSEEK_API_KEY || null,
    opencodeGo: ukeys.OPENCODE_GO_API_KEY || null,
    openRouter: ukeys.OPENROUTER_API_KEY || null,
    qwen: ukeys.QWEN_API_KEY || null,
    nv: ukeys.NVAPI_KEY || null,
    gmi: ukeys.GMI_API_KEY || null,
    cmd: ukeys.CMD_API_KEY || null,
    amd: ukeys.AMD_API_KEY || null,
  };
}

/** Detect the route kind from method + path. */
// Exported for direct pins (SOLID Round-27; additive — call sites untouched).
export function detectRoute(method: string, path: string) {
  const isCount = method === "POST" && path.endsWith(COUNT_PATH);
  const isMessages = method === "POST" && path.endsWith(VERIFY_PATH);
  const isChatCompletions = method === "POST" && path.endsWith("/v1/chat/completions");
  const isResponses = method === "POST" && path.endsWith("/v1/responses");
  return { isCount, isMessages, isChatCompletions, isResponses };
}

async function handleGatewayImpl(
  request: Request,
  env: any,
  url: URL,
  preReadText: string | null = null,
  ctx: { model: string; user?: string; generationId?: string } = { model: "" },
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  // GET /v1/models — public, no auth required (DSH/OpenAI clients list models first)
  if (method === "GET" && path.endsWith("/models")) {
    return jsonOk({
      object: "list",
      data: MODELS.map((m, i) => ({
        id: m.id,
        object: "model",
        created: 1785000000 + i,
        owned_by: m.owned_by,
      })),
    });
  }

  // Auth: x-api-key = the user's gateway token; also accept Authorization: Bearer
  // (OpenAI-compatible clients like DSH send Bearer, not x-api-key)
  const token = request.headers.get("x-api-key") || "";
  const bearerToken = (() => {
    const auth = request.headers.get("authorization") || "";
    return auth.startsWith("Bearer ") ? auth.slice(7) : "";
  })();
  const effectiveToken = token || bearerToken;
  const user = await findUserByToken(env, effectiveToken);
  // For the log wrapper (round-58): resolved user id, not the token prefix.
  ctx.user = user?.id || "";
  if (!user || !user.enabled) {
    return jsonError(401, "Missing or invalid x-api-key", "authentication_error");
  }

  // F3 step 3 (ADR-0007): operator cutover switch, default OFF (dual-accept
  // window stays open until announced). When settings:RELAY_ADMIN_CUTOVER
  // is "1", admin tokens stop working on relay paths — clients still on the
  // admin token get 401 until they swap settings.json to a relay token
  // (POST /api/me/token/relay). Relay-role tokens are unaffected, and so
  // are /mcp + console recovery (admin-only by construction, untouched).
  if (
    user.role === "admin" &&
    globalSettingEnabled(await getGlobalSetting(env, "RELAY_ADMIN_CUTOVER"))
  ) {
    return jsonError(
      401,
      "Admin token revoked from relay paths — use a relay token (POST /api/me/token/relay)",
      "authentication_error",
    );
  }

  // Per-token rate limit (see checkRateLimit).
  const rl = checkRateLimit(env, method, path, effectiveToken);
  if (rl) return rl;
  const ukeys = await getUserKeys(env, user.id);
  const byok = extractByokKeys(ukeys);
  const { isCount, isMessages, isChatCompletions, isResponses } = detectRoute(method, path);
  if (!(isCount || isMessages || isChatCompletions || isResponses)) {
    return jsonError(404, "Not Found", "not_found_error");
  }

  // Read the body as raw text ONCE and extract the top-level "model" field
  // with a lightweight scan. Passthrough routes (ds/qw/or) NEVER parse the
  // body — they forward it unchanged — so there is NO app-level size limit:
  // rejecting large bodies (the old MAX_BODY_BYTES 413) broke legitimate
  // 1M-context / big-document requests. CPU is bounded by the scan design
  // (2MB sampling window + cheap indexOf image scan; full parse only on the
  // og translate path, which walks the message array). The platform's own
  // request-body ceiling is the only bound.
  let rawText = preReadText !== null ? preReadText : await request.text();
  // The full scan result (model + value span) is reused by the passthrough
  // model-swap below — re-scanning a multi-MB body just to replace the field
  // doubled the scan CPU on every passthrough request (round-55).
  const scanned = scanTopLevelModel(rawText);
  let model = scanned.model || "";
  // The log wrapper reads the same model via the per-request context
  // (round-57) — avoids a duplicate scan on the 10ms budget AND keeps
  // concurrent requests' log attribution correct.
  ctx.model = model;
  if (model === "auto") {
    // Claude Code fixed model name auto: route by the user's web selection
    model = await resolveAutoModel(env, user.id);
  }
  // Model-level forced US egress (see OG_FORCE_US_PROXY in channels.ts):
  // gpt-5.6-luna (zen region-blocks it for CN) and muse-spark Contributor
  // (Meta Geographic Use Policy) always ride the Vercel US exit, regardless
  // of the global US_PROXY switch. Kept as a set lookup so each model keeps
  // its og/ identity without consuming OPENROUTER_API_KEY.
  const forceUsProxy = OG_FORCE_US_PROXY.has(model);
  let effectiveModel = model;
  const prefix2 = effectiveModel.split("/")[0] || "";
  // US egress switch: the console KV setting takes precedence, falling back to the Worker secret (env.US_PROXY).
  // Takes effect immediately after the KV write-through (zero delay within the same isolate).
  const usProxyRaw = await getGlobalSetting(env, "US_PROXY");
  // round-94: normalize — an explicit OFF is persisted as "0" (truthy as a
  // string); raw truthiness would treat it as ON.
  const usProxy = forceUsProxy || globalSettingEnabled(usProxyRaw) ? "1" : null;
  const baseRoute = pickRoute(prefix2, env, usProxy);
  let upstreamModel = stripBracket(
    baseRoute.stripPrefix ? effectiveModel.slice(prefix2.length + 1) : effectiveModel,
  );
  // og/deepseek-v4-flash is Anthropic-native on zen/go/v1/messages (x-api-key
  // auth, verified 2026-08-10) — bypass the OpenAI translation; other og models
  // (minimax-m3, mimo-v2.5, kimi, glm) keep the translate path. upstreamModel is
  // already bracket-stripped, so a [1m] marker cannot mask the check.
  // With US_PROXY on: deepseek-v4-flash also goes through translate (chat/completions via the US
  // proxy) — measured: proxied chat/completions 1.6s vs native /v1/messages 11s (5x faster),
  // and translate fully supports thinking (reasoning_content). When off, keep the native direct
  // connection (direct native 8s vs direct chat/completions 7.8s — comparable, native verified).
  const route =
    baseRoute.kind === "opencode" && OG_NATIVE_ANTHROPIC.has(upstreamModel) && !usProxy
      ? { ...baseRoute, type: "passthrough", upstream: OG_ZEN_ANTHROPIC }
      : baseRoute;

  // zen/go requires a stable per-conversation x-opencode-session on every
  // request (2026-09-05+; 400 "Request is missing x-opencode-session"
  // otherwise — the muse-spark 1.3 breakage). Relayed from the client's own
  // conversation id when present (x-opencode-session / x-client-request-id /
  // session_id), else a stable per-user digest. Only the og wire carries it.
  const ogSession =
    route.kind === "opencode" ? opencodeSessionHeader(request.headers, user?.id || "") : {};

  // The full body object is only needed on the og translate path (web_search
  // detection, image pre-processing, toOpenAIRequest). Passthrough routes
  // (ds/qw/or) forward the raw text with the model field swapped — parsing a
  // multi-MB body into an object graph would blow the Free plan CPU budget.
  let body: any = null;

  // ---- Gateway web search (og/ model answers, DeepSeek executes the search) ----
  // Claude Code's WebSearch is executed server-side via Anthropic's web_search
  // server tool. opencode zen (og/) doesn't implement it — for any og model,
  // native-Anthropic or not — but DeepSeek official's Anthropic endpoint does.
  // So for og/ models, run the search through DeepSeek official and let the
  // requested og/ model answer from the results — the model stays og/, DeepSeek
  // is only the search backend. Requires this user's DEEPSEEK_API_KEY. ds/ and
  // or/ requests pass through untouched (ds/ handles web_search natively).
  // round-119: the vision-preprocess gate excluded ds/ (passthrough+deepseek)
  // — text-only DeepSeek received raw Anthropic image blocks and answered
  // blind (or rejected them). Every route kind must preprocess images when
  // the target model isn't vision-capable; the CPU-guard below (scan raw
  // text before parsing) still bounds the parse to image/search requests.
  if (
    isMessages &&
    (route.type === "translate" ||
      route.kind === "opencode" ||
      route.kind === "deepseek" ||
      // nv/gmi ride the translation branch below (toOpenAIRequest needs the
      // parsed body) — always parse, same as the og translate models.
      route.kind === "gmi" ||
      // amd/ models are text-only (its /v1/models reports input_modalities
      // ["text"]), so image blocks must be described by the vision model like
      // on ds/ — but the body still goes out un-translated (native Anthropic).
      route.kind === "amd" ||
      route.kind === "nvidia")
  ) {
    // CPU guard: parsing a multi-MB body into an object graph blows the Free
    // plan's 10ms budget (Error 1102) — but web_search detection and image
    // preprocessing NEED the object. The translate path MUST parse (it
    // reshapes the request), so the scan-skip applies to the NATIVE-Anthropic
    // passthrough channels (og/deepseek-v4-flash, ds/, amd/ — amd's upstream
    // speaks Anthropic directly, so its body needs no reshaping):
    // scan the RAW text for the triggers ("web_search" tool, image blocks)
    // BEFORE parsing — a plain text-only request (the common case) skips the
    // parse entirely. Translate models (minimax/mimo/kimi) always parse.
    if (
      route.type === "passthrough" &&
      (route.kind === "opencode" || route.kind === "deepseek" || route.kind === "amd")
    ) {
      // Precise triggers. IMAGE: scan ONLY the LAST user message (from the
      // last '"role":"user"' to the end) — the current image's
      // "type":"image" marker always sits in the freshly-sent message,
      // BEFORE its base64 payload (tens of KB to >1MB). History images
      // (round-41's whole-body scan) re-triggered parse + re-described ALL
      // past images on every follow-up — the 1102 regression. The client
      // keeps original image blocks in its transcript, so only the last
      // message is authoritative for "new image".
      // WEB_SEARCH: scan only the tools region, anchored AFTER the tools
      // array starts — indexOf('"messages"', toolsStart) so a schema
      // property named "messages" inside the tools array cannot truncate it
      // (round-42 Medium: the first-"messages" anchor cut the region off).
      const toolsStart = rawText.indexOf('"tools":[');
      // Bound the region at the tools array's CLOSING bracket — searching for
      // the next '"messages"' still truncates at a tool schema property named
      // "messages" (round-43 Medium), cutting off a later web_search
      // declaration. A naive bracket count is fine: tool schemas may nest
      // braces, so scan depth-aware from the opening '['.
      let toolsRegion = "";
      if (toolsStart >= 0) {
        let depth = 0;
        let end = -1;
        for (let i = toolsStart + 8; i < rawText.length; i++) {
          const ch = rawText[i];
          if (ch === "[" || ch === "{") depth++;
          else if (ch === "]" || ch === "}") {
            depth--;
            if (depth < 0) {
              end = i;
              break;
            }
          }
        }
        toolsRegion = end > 0 ? rawText.slice(toolsStart, end + 1) : "";
      }
      const lastUserStart = rawText.lastIndexOf('"role":"user"');
      const lastUserMsg = lastUserStart >= 0 ? rawText.slice(lastUserStart) : rawText;
      // Parse if the LAST user message has a NEW image (needs describing) OR
      // any HISTORY image exists (needs the placeholder swap — a text-only
      // follow-up asking about a turn-1 screenshot must still get the
      // described context, not the raw base64). Both cases parse ONCE; the
      // vision call only fires for the last message's image (preprocessImages
      // swaps history images to placeholders without calling vision).
      const needsParse =
        /"type"\s*:\s*"image"/.test(lastUserMsg) ||
        /"type"\s*:\s*"image"/.test(rawText) ||
        /"web_search"/.test(toolsRegion);
      if (!needsParse) {
        body = null;
      } else {
        body = JSON.parse(rawText);
      }
    } else {
      body = JSON.parse(rawText);
    }
    // Web search is handled NATIVELY by opencode zen (verified 2026-08-13:
    // og/deepseek-v4-flash returns server_tool_use + web_search_tool_result +
    // a text answer for a web_search_20250305 tool). The old DeepSeek-fallback
    // interception (runWebSearch/ogWebSearchAnswer) is REMOVED — web_search
    // requests flow through the passthrough/translate path untouched and zen
    // performs the search itself. (The needsParse trigger above still parses
    // the body when web_search is declared, so preprocessImages can run for
    // mixed image+search requests; a pure search request parses once and is
    // forwarded — no DeepSeek key required.)
    // VERIFIED (2026-08-13): zen implements web_search NATIVELY only for
    // deepseek-v4-flash. Translate-path models (mimo-v2.5/minimax/kimi/glm)
    // do NOT search — the forced tool_choice makes them fabricate a query and
    // return a plain text answer with no web_search_tool_result. So a REAL
    // search request is FORCED to the native search-capable model.
    // Trigger: ONLY a forced tool_choice naming web_search — Claude Code
    // DECLARES web_search_20250305 in the tools array of EVERY ordinary turn,
    // so a declaration-only check silently hijacked the user's model on
    // every request (round-46 High). The tool_choice check is the true
    // search intent.
    // Dedicated search-only requests (DSH's web-search provider et al):
    // the tools array holds EXACTLY the web_search server tool and no
    // tool_choice. zen/go then treats the search as optional, the model may
    // decline, and the response comes back with EMPTY content blocks. A
    // request whose only tool is web_search exists solely to search, so
    // inject the force HERE — before the detection below — so the existing
    // swap machinery (native /v1/messages route incl. the US_PROXY via()
    // branch) takes over unchanged. The exact-one-tool guard keeps Claude
    // Code's multi-tool ordinary turns untouched.
    if (
      body &&
      route.kind === "opencode" &&
      !body.tool_choice &&
      Array.isArray(body.tools) &&
      body.tools.length === 1 &&
      body.tools[0]?.type === "web_search_20250305"
    ) {
      body.tool_choice = { type: "tool", name: "web_search" };
    }
    const webSearchToolChoice =
      body?.tool_choice &&
      ((body.tool_choice.type === "tool" && body.tool_choice.name === "web_search") ||
        (body.tool_choice.type === "any" &&
          Array.isArray(body.tool_choice.tools) &&
          body.tool_choice.tools.some((t: any) => t?.name === "web_search")));
    if (webSearchToolChoice && body && route.kind !== "commandgoat") {
      const searchModel = "og/deepseek-v4-flash";
      // Swap when the route is NOT already the native search-capable
      // passthrough (covers the translate path AND US_PROXY=1 where the
      // flagship model would otherwise ride the broken chat/completions
      // translation — round-46 Medium #3).
      if (route.type !== "passthrough" || route.upstream !== OG_ZEN_ANTHROPIC) {
        model = searchModel;
        // eslint-disable-next-line no-useless-assignment
        effectiveModel = searchModel;
        body.model = "deepseek-v4-flash";
        upstreamModel = "deepseek-v4-flash";
        // Rebuild rawText from the parsed body — the passthrough forwards
        // rawWithModel(rawText, upstreamModel), which overwrites the top-level
        // model with upstreamModel; both now say deepseek-v4-flash.
        rawText = JSON.stringify(body);
        // round-116: the old swap set route.upstream to the RAW OG_ZEN_ANTHROPIC
        // constant — with US_PROXY=1 this silently bypassed the US exit that
        // pickRoute's via() had chosen (direct zen is exactly what US_PROXY
        // exists to avoid; search requests 403'd/timed out while ordinary ones
        // rode the proxy). Preserve the via() proxy prefix when present.
        route.type = "passthrough";
        route.upstream = usProxy
          ? `${usProxyBase(env)}/api/zen?target=og&path=${encodeURIComponent("/v1/messages")}`
          : OG_ZEN_ANTHROPIC;
        route.kind = "opencode";
      }
    }

    // ---- Gateway-side vision pre-processing ----
    // Text-only models (deepseek, minimax, ...) can't see images. When a request
    // carries image blocks and the target model isn't on the vision-capable
    // allowlist, describe each image with the configured vision model (default
    // og/mimo-v2.5) and swap the image blocks for that text, so any model can
    // answer image questions. count_tokens skips this. (body is null when the
    // raw scan found no web_search/image triggers — nothing to preprocess.)
    if (body) {
      const prep = await preprocessImages(
        body.messages,
        env,
        ukeys,
        model,
        upstreamModel,
        user?.id || "",
      );
      if (prep.changed) body.messages = prep.messages;
    }
  }

  // or/ uses "this user's" OpenRouter key (BYOK); upstream is direct
  // openrouter.ai or the US exit per the proxy switch (see pickRoute).
  if (route.kind === "openrouter" && !byok.openRouter) {
    return keyMissingError("openrouter") as Response;
  }
  // cm/ is pure BYOK like or/ — both the messages and chat/completions flows
  // need the user's own Command Code key.
  if (route.kind === "commandgoat" && !byok.cmd) {
    return keyMissingError("commandgoat") as Response;
  }
  // ds / no prefix use this user's DeepSeek key; qw/ uses their Qwen key;
  // og/ (translate or native) uses their OpenCode Go key — never the DeepSeek key.
  const bearerKey =
    route.kind === "openrouter"
      ? byok.openRouter
      : route.kind === "commandgoat"
        ? byok.cmd
        : route.kind === "qwen"
          ? byok.qwen
          : route.kind === "nvidia"
            ? byok.nv
            : route.kind === "gmi"
              ? byok.gmi
              : route.kind === "amd"
                ? byok.amd
                : route.kind === "opencode"
                  ? byok.opencodeGo
                  : byok.deepseek;

  // ---- POST /v1/chat/completions (OpenAI format passthrough) ----
  // Accepts OpenAI-format requests directly and forwards to the upstream
  // without Anthropic↔OpenAI translation. Enables DSH and other OpenAI-native
  // clients to use og/ models without format conversion.
  if (isChatCompletions) {
    // Key-existence guards for the chat/completions flow — one per provider
    // kind the endpoint serves. Table-driven: identical shape, order matters
    // only relative to the degraded-channel probe below.
    const chatKeys: [string, string | null][] = [
      ["nvidia", byok.nv],
      ["gmi", byok.gmi],
      ["amd", byok.amd],
      ["opencode", byok.opencodeGo],
    ];
    for (const [kind, key] of chatKeys) {
      if (route.kind === kind && !key) {
        return keyMissingError(kind) as Response;
      }
    }
    {
      const dg = await channelDegradedError(env, route.kind);
      if (dg) return dg;
    }
    const chatKeysAfterProbe: [string, string | null][] = [
      ["deepseek", byok.deepseek],
      ["openrouter", byok.openRouter],
      ["qwen", byok.qwen],
    ];
    for (const [kind, key] of chatKeysAfterProbe) {
      if (route.kind === kind && !key) {
        return keyMissingError(kind) as Response;
      }
    }
    // The OpenAI format must hit OpenRouter's chat/completions endpoint — the route.upstream
    // picked by the messages flow is /v1/messages; reusing it directly would stuff an OpenAI body
    // into the Anthropic endpoint (bugfix 2026-08-22). Re-fetch the chat-path upstream per the switch:
    // off = direct openrouter.ai/api/v1/chat/completions; on = via the US egress (target=or).
    // qwen/ is the same trap: the /apps/anthropic endpoint rejects OpenAI bodies, so chat
    // completions re-pick the compatible-mode upstream (bugfix 2026-08-30).
    // amd/ is the same shape again: pickRoute defaults to Radeon's native
    // /v1/messages URL (Anthropic clients), an OpenAI body must go to
    // /v1/chat/completions instead.
    if (
      route.kind === "openrouter" ||
      route.kind === "commandgoat" ||
      route.kind === "qwen" ||
      route.kind === "amd"
    ) {
      // Re-pick by the REQUEST prefix (kind→prefix is 1:1 for these four);
      // pickRoute ignores the US exit for amd — that host is CN-served.
      route.upstream = pickRoute(prefix2, env, usProxy, "/v1/chat/completions").upstream;
    }
    // Body is already OpenAI format — forward as-is with model field swapped.
    let forwardBody = rawWithModel(rawText, upstreamModel, scanned);
    // zen/go rejects OpenAI's "developer" role with "[1214] Incorrect role
    // information". Reasoning-effort-aware SDKs switch system→developer when
    // reasoning_effort is set (the o-series convention). Normalize the role so
    // effort-carrying requests from DSH & co. pass through unchanged.
    if (forwardBody.includes('"role":"developer"')) {
      forwardBody = forwardBody.split('"role":"developer"').join('"role":"system"');
    }
    // or/stealth/ox-alpha: default reasoning.effort=max only when the client
    // sent no top-level reasoning (see the /v1/messages site).
    forwardBody = oxAlphaReasoningDefault(route.kind, upstreamModel, forwardBody);
    const {
      response: upstream,
      detail,
      inspectFailure,
    } = await fetchWithRetry(
      route.upstream,
      {
        method: "POST",
        // zen/go (og) gets the per-conversation session header; every other
        // passthrough channel keeps its existing wire untouched.
        headers: passthroughHeaders(bearerKey, {
          ...(route.kind === "opencode" ? { extra: ogSession } : {}),
        }),
        body: forwardBody,
      },
      // or/: glm-5.2:free ONLY — its Decart shared pool is a lottery where rapid
      // knocks win slots but paced retries never land (2026-08-24). Other or/
      // models, paid and free alike, keep the standard paced retry.
      // nv//gmi/: NIM sheds bursts with fast 5xx BEFORE processing — retry502
      // absorbs them instead of surfacing "temporarily overloaded".
      route.kind === "nvidia" || route.kind === "gmi"
        ? { timeoutMs: ogTimeoutMs(env), attempts: 4, retry502: true }
        : route.kind === "openrouter"
          ? upstreamModel === "z-ai/glm-5.2:free"
            ? {
                timeoutMs: ogTimeoutMs(env),
                attempts: 10,
                backoffMs: 300,
                retry502: true,
                ignoreRetryAfter: true,
              }
            : {
                timeoutMs: ogTimeoutMs(env),
                attempts: 4,
                retry502: true,
              }
          : { timeoutMs: ogTimeoutMs(env) },
    );
    return relayUpstreamResult(
      env,
      request,
      route.kind,
      upstream,
      detail,
      inspectFailure,
      ctx,
      true,
    );
  }

  // ---- POST /v1/responses (OpenAI Responses API) ----
  // Serves og/muse-spark-1.2/1.3-contributor ONLY. Those models are
  // responses-only on zen/go — chat/completions 500s upstream (verified
  // 2026-09-04) — and are forced through the US exit (Meta Geographic Use
  // Policy; see OG_FORCE_US_PROXY). The request body is already Responses
  // format; forward it as-is with only the model field swapped.
  if (isResponses) {
    // Only registered og/muse-spark-* Contributor models ride this endpoint.
    // Responses requests naming anything else are client bugs (other og/
    // models speak chat/completions; nothing else here is responses-native;
    // unregistered muse-spark versions must not reach the upstream).
    if (
      !MODELS.some((m) => m.id === model) ||
      !upstreamModel.startsWith("muse-spark-") ||
      prefix2 !== "og"
    ) {
      return jsonError(
        400,
        `Model ${model} is not served via /v1/responses — only og/muse-spark-* Contributor models use this endpoint`,
        "invalid_request",
      );
    }
    if (route.kind !== "opencode") {
      return jsonError(
        400,
        `/v1/responses only serves og/ models (requested ${model})`,
        "invalid_request",
      );
    }
    if (route.kind === "opencode" && !byok.opencodeGo) {
      return keyMissingError("opencode") as Response;
    }
    {
      const dg = await channelDegradedError(env, route.kind);
      if (dg) return dg;
    }
    // Model is og/muse-spark-*: force the US exit (Meta region policy). The
    // route picked above already rode via() when forceUsProxy was true — but
    // pickRoute's og branch hardcodes /v1/chat/completions as the path, so
    // rebuild the upstream for the responses path explicitly. The default
    // exit is the zen-us Cloudflare worker (untimed streams — the Vercel
    // relay truncated muse generations at ~30 s); MUSE_RESPONSES_EXIT=vercel
    // restores the old relay. See museResponsesExit in channels.ts.
    const responsesUpstream = forceUsProxy
      ? museResponsesExit(env)
      : `${OG_ZEN_ANTHROPIC.replace("/v1/messages", "")}/v1/responses`;
    const forwardBody = rawWithModel(rawText, upstreamModel, scanned);
    // zen's responses endpoint is OpenAI-native: Bearer auth, no
    // anthropic-version header (passthroughHeaders would add one; zen ignores
    // it on chat/completions but keep the responses wire clean). Carry the
    // per-conversation session header — zen/go 400s muse requests without
    // x-opencode-session (2026-09-05+).
    const responsesHeaders = new Headers();
    responsesHeaders.set("Content-Type", "application/json");
    if (bearerKey) responsesHeaders.set("Authorization", `Bearer ${bearerKey}`);
    if (ogSession["x-opencode-session"]) {
      responsesHeaders.set("x-opencode-session", ogSession["x-opencode-session"]);
    }
    const {
      response: upstream,
      detail,
      inspectFailure,
    } = await fetchWithRetry(
      responsesUpstream,
      {
        method: "POST",
        headers: responsesHeaders,
        body: forwardBody,
      },
      { timeoutMs: ogTimeoutMs(env) },
    );
    return relayUpstreamResult(
      env,
      request,
      route.kind,
      upstream,
      detail,
      inspectFailure,
      ctx,
      true,
    );
  }

  // count_tokens — local estimate for EVERY channel (2026-08-12). The upstream
  // count endpoint used to be called per-request (one extra round-trip on every
  // Claude Code turn, ~hundreds of ms); a local estimate is within the module's
  // own ±20% accuracy stance and cuts that latency entirely. Missing-key checks
  // are still real config errors and stay.
  if (isCount) {
    const countKeys: [string, string | null][] = [
      ["deepseek", byok.deepseek],
      ["qwen", byok.qwen],
      ["amd", byok.amd],
    ];
    for (const [kind, key] of countKeys) {
      if (route.kind === kind && !key) {
        return keyMissingError(kind) as Response;
      }
    }
    return jsonOk({ input_tokens: estimateTokens(rawText) });
  }

  // ---- POST /v1/messages ----
  // nv/ and gmi/ upstreams (NVIDIA NIM, GMI Cloud) are OpenAI-format only —
  // translate the Anthropic request to chat/completions (toOpenAIRequest) and
  // reshape the response back to Anthropic, so Anthropic-only clients (Claude
  // Code) can ride these channels via /v1/messages. OpenAI-native clients
  // keep using the /v1/chat/completions direct passthrough above.
  if (route.kind === "nvidia" || route.kind === "gmi") {
    if (route.kind === "nvidia" && !byok.nv) {
      return keyMissingError("nvidia") as Response;
    }
    if (route.kind === "gmi" && !byok.gmi) {
      return keyMissingError("gmi") as Response;
    }
    const openaiReq = toOpenAIRequest(body, upstreamModel);
    const { response: upstream, detail } = await fetchWithRetry(
      route.upstream,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${route.kind === "nvidia" ? byok.nv : byok.gmi}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(openaiReq),
      },
      // Same as the chat/completions site for these upstreams: NIM/GMI shed
      // bursts with fast 5xx BEFORE processing — retry502 absorbs them.
      { timeoutMs: ogTimeoutMs(env), attempts: 4, retry502: true },
    );
    if (!upstream || !upstream.ok) {
      const upStatus = upstream?.status || 502;
      let message = `${route.kind}: ${detail || `upstream ${upStatus}`}`;
      const extra: Record<string, string> = {};
      try {
        if (upstream && !upstream.ok) {
          const err: any = await upstream.json();
          const m = err.error?.message || err.message;
          if (m) message = m;
          // Carry Retry-After so the client paces against the upstream limit.
          const ra = upstream.headers?.get?.("retry-after");
          if (ra) extra["retry-after"] = ra;
        }
      } catch {
        /* non-JSON error body */
      }
      return jsonError(
        upStatus,
        message,
        upStatus === 429 ? "rate_limit_error" : "api_error",
        extra,
      );
    }
    return openAIUpstreamToAnthropicResponse(upstream, body, body.model, upstreamModel);
  }

  // Passthrough routes (or/ds/qw/amd): the upstream already speaks the Anthropic
  // protocol, forward the body unchanged + stream the response.
  if (route.type === "passthrough") {
    if (route.kind === "deepseek" && !byok.deepseek) {
      return keyMissingError("deepseek") as Response;
    }
    if (route.kind === "qwen" && !byok.qwen) {
      return keyMissingError("qwen") as Response;
    }
    // amd/ (AMD Radeon Cloud) is pure BYOK too — without the user's rc-… key
    // the request would go out headerless and 401 at the upstream.
    if (route.kind === "amd" && !byok.amd) {
      return keyMissingError("amd") as Response;
    }
    // og-native (deepseek-v4-flash via /v1/messages) needs the OpenCode Go key
    // too — without it the request would go out headerless and return a bare
    // "Upstream 401" instead of a clear config error (translate path checks).
    if (route.kind === "opencode" && !byok.opencodeGo) {
      return keyMissingError("opencode") as Response;
    }
    // The og-native passthrough previously BYPASSED the circuit breaker — a
    // dead channel kept getting routed (health lied, model=auto stuck on it).
    // Check the breaker up front like the translate path does.
    {
      const dg = await channelDegradedError(env, route.kind);
      if (dg) return dg;
    }
    // og-native parsed the body above (web-search detection, image
    // pre-processing) — forward THAT (images must arrive described, deepseek
    // is text-only). ds/qw/or never parse: raw text with only the top-level
    // model field swapped — no parse, no spread, no full re-stringify (Free
    // plan 10ms CPU budget). amd/ parses only when the raw scan finds an
    // image (its models are text-only, so vision needs preprocessing); a plain
    // request rides the same raw-swap path. og-native authenticates with
    // x-api-key (amd/ too — its docs use that header, though it accepts
    // Bearer as well); every other passthrough channel uses Bearer.
    let forwardBody =
      body !== null
        ? JSON.stringify({ ...body, model: upstreamModel })
        : rawWithModel(rawText, upstreamModel, scanned);
    if (route.kind === "openrouter" && upstreamModel === "deepseek/deepseek-v4-flash-0731") {
      forwardBody =
        body !== null
          ? JSON.stringify({
              ...body,
              model: upstreamModel,
              provider: { order: ["deepseek"], allow_fallbacks: false },
            })
          : rawWithDeepSeekProvider(forwardBody);
    }
    // Ox Alpha reasons with effort levels (low/high/max) and OpenRouter takes
    // the unified `reasoning` param on both /v1/messages and chat/completions.
    // 2026-08-22: respect a client-sent top-level reasoning as-is; only
    // default to effort=max when the request carries none.
    forwardBody = oxAlphaReasoningDefault(route.kind, upstreamModel, forwardBody);
    const {
      response: upstream,
      detail,
      inspectFailure,
    } = await fetchWithRetry(
      route.upstream,
      {
        method: "POST",
        headers: passthroughHeaders(bearerKey, {
          apiKeyHeader: route.kind === "opencode" || route.kind === "amd" ? "x-api-key" : false,
          ...(route.kind === "opencode" ? { extra: ogSession } : {}),
        }),
        body: forwardBody,
      },
      // or/: same free-pool lottery pacing as the chat/completions site above.
      // nv/: NIM 5xx burst-shedding gets retried here too.
      route.kind === "nvidia"
        ? { timeoutMs: passthroughTimeoutMs(env, route.kind), attempts: 4, retry502: true }
        : route.kind === "openrouter"
          ? upstreamModel === "z-ai/glm-5.2:free"
            ? {
                timeoutMs: passthroughTimeoutMs(env, route.kind),
                attempts: 10,
                backoffMs: 300,
                retry502: true,
                ignoreRetryAfter: true,
              }
            : {
                timeoutMs: passthroughTimeoutMs(env, route.kind),
                attempts: 4,
                retry502: true,
              }
          : { timeoutMs: passthroughTimeoutMs(env, route.kind) },
    );
    return relayUpstreamResult(
      env,
      request,
      route.kind,
      upstream,
      detail,
      inspectFailure,
      ctx,
      true,
    );
  }

  // Translation route (og non-native models, cm): Anthropic → OpenAI →
  // chat/completions, then reshape back to Anthropic SSE. deepseek-v4-flash /
  // minimax-m3 on og never get here — they were switched to passthrough above.
  // cm/ always gets here on /v1/messages: the Command Code Anthropic endpoint
  // serves claude-* only, deepseek & co. live on chat/completions.
  // round-504: shadowed by the pre-branch commandgoat guard (same !byok.cmd,
  // same message) — unreachable, kept as defense-in-depth like the chat-path
  // openrouter arm. Not pinned: keyless-cm tests land on the live guard.
  if (route.kind === "commandgoat" && !byok.cmd) {
    return keyMissingError("commandgoat") as Response;
  }
  // round-500: this guard was unscoped — a cm/ request (Bearer byok.cmd,
  // cm upstream; byok.opencodeGo unused below) was 502'd for lacking an
  // unrelated og key. Scope to the opencode kind it actually protects.
  if (route.kind === "opencode" && !byok.opencodeGo) {
    return keyMissingError("opencode") as Response;
  }
  // Circuit open: repeated hard failures — fail fast instead of waiting on
  // zen again (shared channelDegradedError guard, same as the other /v1 arms).
  {
    const dg = await channelDegradedError(env, route.kind);
    if (dg) return dg;
  }
  const openaiReq = toOpenAIRequest(body, upstreamModel);
  // ox-alpha-free takes reasoning effort levels (low/high/max) via the unified
  // reasoning param — mirror the or/ rule on this translate path: respect a
  // client-sent reasoning, else default effort=max (2026-08-22). Claude Code's
  // Anthropic `thinking` param is not mapped; the default covers it.
  if (upstreamModel === "ox-alpha-free" && openaiReq.reasoning === undefined) {
    openaiReq.reasoning = { effort: "max" };
  }
  const translateKey = route.kind === "commandgoat" ? byok.cmd : byok.opencodeGo;
  const translateLabel = route.kind === "commandgoat" ? "cm" : "og";
  const { response: upstream, detail } = await fetchWithRetry(
    route.upstream,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${translateKey}`,
        "Content-Type": "application/json",
        // zen/go per-conversation session header (see ogSession above).
        ...(route.kind === "opencode" ? ogSession : {}),
      },
      body: JSON.stringify(openaiReq),
    },
    { timeoutMs: ogTimeoutMs(env) },
  );
  if (!upstream || !upstream.ok) {
    // Count toward the og breaker ONLY channel-death signals (og-specific — cm
    // has no breaker): a hard network error OR a timeout (a blackholed channel
    // hangs instead of erroring). A fast 5xx/429 (retries exhausted) is the
    // upstream being flaky, not dead — it must NOT trip. The BreakerDO's
    // 10-min window means a live-but-slow channel's occasional hang won't
    // accumulate to a trip either.
    if (
      route.kind === "opencode" &&
      (detail?.startsWith("network error") || detail?.startsWith("timeout"))
    ) {
      await recordChannelFailure(env);
    }
    // round-116: preserve the upstream status/type — the old code collapsed
    // EVERY failure to a non-retryable 502 api_error, dropping zen's 429
    // (client should back off, not fail) and its Retry-After. The passthrough
    // branch keeps the status; the translate branch must too.
    const upStatus = upstream?.status || 502;
    return jsonError(
      upStatus,
      `${translateLabel}: ${detail || `upstream ${upStatus}`}`,
      upStatus === 429 ? "rate_limit_error" : "api_error",
    );
  }
  // A real response (even a retried 5xx→2xx) resets the consecutive-failure
  // count — otherwise yesterday's blips would combine with today's to trip.
  if (route.kind === "opencode") await recordChannelSuccess(env);
  // Response reshaping (SSE translation, one-shot JSON fallback, error-envelope
  // guard) is shared with the nv/gmi translation branch below.
  return openAIUpstreamToAnthropicResponse(upstream, body, body.model, upstreamModel);
}
/**
 * Structured request log for the /v1/* hot path — one line per gateway
 * request (user/model/status/latency). Visible via `wrangler tail`; no
 * persistent storage on the Free plan, but enough to see who used what and
 * which channel misbehaves.
 */
export async function handleGateway(request: Request, env: any, url: URL): Promise<Response> {
  const started = Date.now();
  // Read the raw body ONCE here and hand it to the impl (round-55: the old
  // clone().text() re-read + re-scan on every /v1 request was ~30MB extra
  // memory + double the scan CPU). The impl scans it for routing AND the
  // model swap — that single scan result is also the log's model. The model
  // travels in a per-request context object (round-57: a module variable
  // cross-talked between CONCURRENT requests — request A's log line could
  // read request B's model after an await boundary).
  let rawText: string | null = null;
  try {
    rawText = await request.text();
  } catch {
    /* impl will re-try; a broken stream fails there with a clear error */
  }
  const ctx = { model: "", user: "", generationId: "" };
  const res = await handleGatewayImpl(request, env, url, rawText, ctx);
  try {
    // One structured line per /v1 request — tail-visible usage/health signal.
    // round-58: log the resolved user id instead of the x-api-key prefix —
    // the key's first 8 chars (~48bit entropy) leak token material and
    // cross-correlate requests across logs; findUserByToken already resolved
    // the user in the impl.
    console.log(
      JSON.stringify({
        ts: started,
        ms: Date.now() - started,
        status: res.status,
        user: ctx.user,
        path: url.pathname,
        model: ctx.model,
        generation_id: ctx.generationId || undefined,
      }),
    );
  } catch {
    /* log must never break the request */
  }
  return res;
}
// Gateway-side vision pre-processing + per-user auto-model resolution now
// live in their own modules (structure refactor — code moved verbatim):
//   ./translate-vision.ts  isVisionCapable / preprocessImages / describeImage
//                          (VISION_* env, img-desc KV cache)
//   ./model-route.ts       isModelUsable / resolveAutoModel
// Re-exported below so every existing consumer keeps its import path
// (src/index.ts's re-export, auth.ts's ctx.api.translate, health.test.mjs).

/* ---------------- Plugin registration ---------------- */

export default {
  name: "translate",
  deps: [],
  setup(ctx: PluginContext) {
    // Every /v1/* entry dispatches through handleGateway → handleGatewayImpl
    // exactly as index.js's fetch did; the impl owns the endsWith checks.
    const handler = (request: Request, env: any, url: URL) => handleGateway(request, env, url);
    ctx.routes.push({ match: (m, p) => m === "GET" && p.startsWith("/v1/models"), handler });
    ctx.routes.push({ match: (m, p) => m === "POST" && p.startsWith("/v1/messages"), handler });
    ctx.routes.push({
      match: (m, p) => m === "POST" && p.startsWith("/v1/chat/completions"),
      handler,
    });
    // OpenAI Responses API entry — the impl already serves it (isResponses
    // branch) but the route was never registered, so plugin dispatch 404'd
    // before reaching the impl.
    ctx.routes.push({
      match: (m, p) => m === "POST" && p.startsWith("/v1/responses"),
      handler,
    });
    // Cross-plugin API surface (mirrors the exports index.js exposes today).
    provideApi(ctx, "translate", {
      handleGateway,
      handleGatewayImpl,
      resolveAutoModel,
      isModelUsable,
    });
  },
};
