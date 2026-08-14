/**
 * Vale gateway "translate" plugin (round-73) — /v1/* model translation routes.
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

import { findUserByToken, getUserKeys, getGlobalSetting, getUserRoute } from "../store.js";
import { toOpenAIRequest, toAnthropicResponse, streamOgToAnthropic, toSSE } from "../anthropic-translate.js";
import { fetchWithTimeout, fetchWithRetry, upstreamTimeoutMs, ogTimeoutMs, passthroughTimeoutMs, isChannelDegraded, recordChannelFailure, recordChannelSuccess } from "../reliability.js";
import { rawWithModel, scanTopLevelModel, estimateTokens } from "../body-scan.js";
import { jsonOk, jsonError, CORS_HEADERS } from "../http.js";
import { MODELS, OG_NATIVE_ANTHROPIC, OG_ZEN_ANTHROPIC, VERIFY_PATH } from "../channels.js";

const COUNT_PATH = "/v1/messages/count_tokens";

/* ---------------- /v1/* gateway ---------------- */

// In-memory per-token rate-limit counters (per isolate). The old KV
// get-then-put counters cost 2 reads + 2 writes per /v1/messages request —
// that alone burned the Free-plan daily KV WRITE quota (1000/day) at ~250
// requests. Never written; each window's first request per token reads KV
// once to inherit other isolates' counts.
const __rlMin = new Map(); // `min:${token}:${minute}` → count
const __rlDay = new Map(); // `day:${token}:${day}`   → count
async function handleGatewayImpl(request, env, url, preReadText = null, ctx = { model: "" }) {
  const path = url.pathname;
  const method = request.method;

  // Auth: x-api-key = the user's gateway token
  const token = request.headers.get("x-api-key") || "";
  const user = await findUserByToken(env, token);
  // For the log wrapper (round-58): resolved user id, not the token prefix.
  ctx.user = user?.id || "";
  if (!user || !user.enabled) {
    return jsonError(401, "Missing or invalid x-api-key", "authentication_error");
  }
  const ukeys = await getUserKeys(env, user.id);
  const deepseekKey = ukeys.DEEPSEEK_API_KEY || null;
  const opencodeGoKey = ukeys.OPENCODE_GO_API_KEY || null;
  const openRouterKey = ukeys.OPENROUTER_API_KEY || null;
  const qwenKey = ukeys.QWEN_API_KEY || null;

  // Per-token rate limit: a valid token previously meant UNLIMITED upstream
  // spend (Free-plan quota exhaustion + surprise billing). Counters are IN
  // MEMORY per isolate — the old get-then-put KV counters cost 2 reads + 2
  // writes per /v1/messages request, which alone burned the Free-plan daily
  // KV WRITE quota (1000/day) at ~250 requests and tripped the 90% usage
  // alert. Each window's first request per token still reads KV once
  // (inherits other isolates' counts); we never write. With 1-3 hot isolates
  // overshoot is bounded (~48→~144/min worst case) — the thresholds already
  // budget ~20% headroom, and a KV 429 can no longer 500 a chat request
  // (all KV reads here are wrapped).
  // Skipped when KEYS is unbound (tests/local) — the limiter is a prod guard.
  // count_tokens is a LOCAL estimate (no upstream spend) — excluding it stops
  // the double-count that halved the effective budget for Claude Code turns.
  if (env.KEYS && method === "POST" && path.endsWith("/messages") && !path.endsWith(COUNT_PATH)) {
    const minuteKey = `rl-min:${token}:${Math.floor(Date.now() / 60000)}`;
    const dayKey = `rl-day:${token}:${Math.floor(Date.now() / 86400000)}`;
    const mk = `min:${token}:${Math.floor(Date.now() / 60000)}`;
    const dk = `day:${token}:${Math.floor(Date.now() / 86400000)}`;
    const [minute, day] = await Promise.all([
      (async () => {
        const hit = __rlMin.get(mk);
        if (hit !== undefined) return hit;
        let v = 0;
        try { v = Number(await env.KEYS.get(minuteKey)) || 0; } catch {}
        __rlMin.set(mk, v);
        if (__rlMin.size > 4096) __rlMin.delete(__rlMin.keys().next().value);
        return v;
      })(),
      (async () => {
        const hit = __rlDay.get(dk);
        if (hit !== undefined) return hit;
        let v = 0;
        try { v = Number(await env.KEYS.get(dayKey)) || 0; } catch {}
        __rlDay.set(dk, v);
        if (__rlDay.size > 4096) __rlDay.delete(__rlDay.keys().next().value);
        return v;
      })(),
    ]);
    if (minute >= 48) {
      return jsonError(429, "Rate limit: ~60 requests/minute per token", "rate_limit_error");
    }
    if (day >= 4000) {
      return jsonError(429, "Rate limit: ~5000 requests/day per token", "rate_limit_error");
    }
    __rlMin.set(mk, minute + 1);
    __rlDay.set(dk, day + 1);
  }

  // GET /v1/models — list of prefixed models this gateway supports
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

  const isCount = method === "POST" && path.endsWith(COUNT_PATH);
  const isMessages = method === "POST" && path.endsWith(VERIFY_PATH);
  if (!(isCount || isMessages)) {
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
    // Claude Code 固定模型名 auto：按用户网页选择路由
    model = await resolveAutoModel(env, user.id);
  }
  // og/gpt-5.6-luna is region-blocked on zen (upstream 403 for CN) but fully
  // usable via OpenRouter's US exit. Map it to the or/ channel so both og/ and
  // or/ spellings hit the same working route (OpenRouter key + proxy exit).
  let effectiveModel = model;
  if (model === "og/gpt-5.6-luna" || model === "og/openai/gpt-5.6-luna:floor[1m]") {
    effectiveModel = "or/openai/gpt-5.6-luna:floor[1m]";
  } else {
    effectiveModel = model;
  }
  const prefix2 = effectiveModel.split("/")[0];
  // 美国出口开关:控制台 KV 设置优先,回退 Worker secret(env.US_PROXY)。
  // KV 写透传后立即生效(同 isolate 零延迟)。
  const usProxy = await getGlobalSetting(env, "US_PROXY");
  const baseRoute = pickRoute(prefix2, env, usProxy);
  let upstreamModel = stripBracket(baseRoute.stripPrefix ? effectiveModel.slice(prefix2.length + 1) : effectiveModel);
  // og/deepseek-v4-flash is Anthropic-native on zen/go/v1/messages (x-api-key
  // auth, verified 2026-08-10) — bypass the OpenAI translation; other og models
  // (minimax-m3, mimo-v2.5, kimi, glm) keep the translate path. upstreamModel is
  // already bracket-stripped, so a [1m] marker cannot mask the check.
  // US_PROXY 开启时:deepseek-v4-flash 也走 translate(chat/completions 经美国
  // 代理)—— 实测代理 chat/completions 1.6s vs 原生 /v1/messages 11s(5 倍),
  // 且 translate 完整支持 thinking(reasoning_content)。关闭时保持原生直连
  // (直连原生 8s 优于直连 chat/completions 7.8s 相当,原生已验证)。
  const route =
    baseRoute.kind === "opencode" && OG_NATIVE_ANTHROPIC.has(upstreamModel) && !usProxy
      ? { ...baseRoute, type: "passthrough", upstream: OG_ZEN_ANTHROPIC }
      : baseRoute;

  // The full body object is only needed on the og translate path (web_search
  // detection, image pre-processing, toOpenAIRequest). Passthrough routes
  // (ds/qw/or) forward the raw text with the model field swapped — parsing a
  // multi-MB body into an object graph would blow the Free plan CPU budget.
  let body = null;

  // ---- Gateway web search (og/ model answers, DeepSeek executes the search) ----
  // Claude Code's WebSearch is executed server-side via Anthropic's web_search
  // server tool. opencode zen (og/) doesn't implement it — for any og model,
  // native-Anthropic or not — but DeepSeek official's Anthropic endpoint does.
  // So for og/ models, run the search through DeepSeek official and let the
  // requested og/ model answer from the results — the model stays og/, DeepSeek
  // is only the search backend. Requires this user's DEEPSEEK_API_KEY. ds/ and
  // or/ requests pass through untouched (ds/ handles web_search natively).
  if (isMessages && (route.type === "translate" || route.kind === "opencode")) {
    // CPU guard: parsing a multi-MB body into an object graph blows the Free
    // plan's 10ms budget (Error 1102) — but web_search detection and image
    // preprocessing NEED the object. The translate path MUST parse (it
    // reshapes the request), so the scan-skip ONLY applies to the native
    // opencode PASSTHROUGH (deepseek-v4-flash, route.type === "passthrough"):
    // scan the RAW text for the triggers ("web_search" tool, image blocks)
    // BEFORE parsing — a plain text-only request (the common case) skips the
    // parse entirely. Translate models (minimax/mimo/kimi) always parse.
    if (route.kind === "opencode" && route.type === "passthrough") {
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
          if (ch === '[' || ch === '{') depth++;
          else if (ch === ']' || ch === '}') { depth--; if (depth < 0) { end = i; break; } }
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
    const webSearchToolChoice = body?.tool_choice &&
      ((body.tool_choice.type === "tool" && body.tool_choice.name === "web_search") ||
       (body.tool_choice.type === "any" && Array.isArray(body.tool_choice.tools) &&
        body.tool_choice.tools.some((t) => t?.name === "web_search")));
    if (webSearchToolChoice && body) {
      const searchModel = "og/deepseek-v4-flash";
      // Swap when the route is NOT already the native search-capable
      // passthrough (covers the translate path AND US_PROXY=1 where the
      // flagship model would otherwise ride the broken chat/completions
      // translation — round-46 Medium #3).
      if (route.type !== "passthrough" || route.upstream !== OG_ZEN_ANTHROPIC) {
        model = searchModel;
        effectiveModel = searchModel;
        body.model = "deepseek-v4-flash";
        upstreamModel = "deepseek-v4-flash";
        // Rebuild rawText from the parsed body — the passthrough forwards
        // rawWithModel(rawText, upstreamModel), which overwrites the top-level
        // model with upstreamModel; both now say deepseek-v4-flash.
        rawText = JSON.stringify(body);
        // Re-point the (const) route object at the native passthrough so the
        // web_search tool rides through to zen /v1/messages untouched.
        route.type = "passthrough";
        route.upstream = OG_ZEN_ANTHROPIC;
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
      const prep = await preprocessImages(body.messages, env, ukeys, model, upstreamModel);
      if (prep.changed) body.messages = prep.messages;
    }
  }

  // or/ goes through the openrouter-proxy using "this user's" OpenRouter key (BYOK)
  if (route.kind === "openrouter" && !openRouterKey) {
    return jsonError(502, "OPENROUTER_API_KEY not configured — add your own key in the console", "config_error");
  }
  // ds / no prefix use this user's DeepSeek key; qw/ uses their Qwen key;
  // og/ (translate or native) uses their OpenCode Go key — never the DeepSeek key.
  const bearerKey = route.kind === "openrouter" ? openRouterKey
    : route.kind === "qwen" ? qwenKey
    : route.kind === "opencode" ? opencodeGoKey
    : deepseekKey;

  // count_tokens — local estimate for EVERY channel (2026-08-12). The upstream
  // count endpoint used to be called per-request (one extra round-trip on every
  // Claude Code turn, ~hundreds of ms); a local estimate is within the module's
  // own ±20% accuracy stance and cuts that latency entirely. Missing-key checks
  // are still real config errors and stay.
  if (isCount) {
    if (route.kind === "deepseek" && !deepseekKey) {
      return jsonError(502, "DEEPSEEK_API_KEY not configured — add your own key in the console", "config_error");
    }
    if (route.kind === "qwen" && !qwenKey) {
      return jsonError(502, "QWEN_API_KEY not configured — add your own key in the console", "config_error");
    }
    return jsonOk({ input_tokens: estimateTokens(rawText) });
  }

  // ---- POST /v1/messages ----
  // Passthrough routes (or/ds/qw): the upstream already speaks the Anthropic
  // protocol, forward the body unchanged + stream the response.
  if (route.type === "passthrough") {
    if (route.kind === "deepseek" && !deepseekKey) {
      return jsonError(502, "DEEPSEEK_API_KEY not configured — add your own key in the console", "config_error");
    }
    if (route.kind === "qwen" && !qwenKey) {
      return jsonError(502, "QWEN_API_KEY not configured — add your own key in the console", "config_error");
    }
    // og-native (deepseek-v4-flash via /v1/messages) needs the OpenCode Go key
    // too — without it the request would go out headerless and return a bare
    // "Upstream 401" instead of a clear config error (translate path checks).
    if (route.kind === "opencode" && !opencodeGoKey) {
      return jsonError(502, "OPENCODE_GO_API_KEY not configured — add your own key in the console", "config_error");
    }
    // The og-native passthrough previously BYPASSED the circuit breaker — a
    // dead channel kept getting routed (health lied, model=auto stuck on it).
    // Check the breaker up front like the translate path does.
    if (route.kind === "opencode" && await isChannelDegraded(env)) {
      return jsonError(502, "og: circuit open (recent upstream failures, try again in ~1 min)", "api_error");
    }
    // og-native parsed the body above (web-search detection, image
    // pre-processing) — forward THAT (images must arrive described, deepseek
    // is text-only). ds/qw/or never parse: raw text with only the top-level
    // model field swapped — no parse, no spread, no full re-stringify (Free
    // plan 10ms CPU budget). og-native authenticates with x-api-key;
    // every other passthrough channel uses Bearer.
    const forwardBody = body !== null
      ? JSON.stringify({ ...body, model: upstreamModel })
      : rawWithModel(rawText, upstreamModel, scanned);
    const { response: upstream, detail } = await fetchWithRetry(route.upstream, {
      method: "POST",
      headers: passthroughHeaders(bearerKey, { apiKeyHeader: route.kind === "opencode" ? "x-api-key" : false }),
      body: forwardBody,
    }, { timeoutMs: passthroughTimeoutMs(env, route.kind) });
    if (!upstream) {
      // Slow failure (timeout / network error) — single attempt, no retry.
      // A hard network failure counts toward the og breaker.
      // A blackholed channel (packet-drop) times out rather than erroring —
      // previously timeouts NEVER counted, so the circuit never opened and
      // every request burned the full timeout budget. Count timeouts too:
      // 3 CONSECUTIVE timeouts within the window means the channel is dead.
      if (route.kind === "opencode") await recordChannelFailure(env);
      return jsonError(502, `upstream ${route.kind}: ${detail}`, "api_error");
    }
    if (!upstream.ok) {
      let message = `Upstream ${upstream.status}`;
      let type = "api_error";
      let extra = {};
      try {
        const err = await upstream.json();
        message = err.error?.message || err.message || JSON.stringify(err).slice(0, 200) || message;
        // Forward the upstream's OWN error.type (Claude Code keys retry and
        // auth flows off it) — a DeepSeek 429 rate_limit_error collapsed to
        // api_error was NON-retryable for the client. Whitelist the known
        // Anthropic types; unknown → api_error.
        const upType = err.error?.type || err.type;
        const KNOWN = ["rate_limit_error", "overloaded_error", "authentication_error",
          "invalid_request_error", "permission_error", "not_found_error", "request_too_large", "api_error"];
        if (upType && KNOWN.includes(upType)) type = upType;
        // Carry Retry-After so the client paces against the upstream limit.
        const ra = upstream.headers?.get?.("retry-after");
        if (ra) extra = { "retry-after": ra };
      } catch { /* non-JSON error body */ }
      // A real response resets the og consecutive-failure count.
      if (route.kind === "opencode") await recordChannelSuccess(env);
      return jsonError(upstream.status, message, type, extra);
    }
    if (route.kind === "opencode") await recordChannelSuccess(env);
    const headers = new Headers(upstream.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    // Idle watchdog REMOVED (round-61): it aborted legitimate slow streams
    // (>60s without bytes during model thinking) with an api_error frame.
    // The relay is untimed again — dead streams are the client's problem.
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // Translation route (og, non-native models only): Anthropic → OpenAI → zen/go,
  // then reshape back to Anthropic SSE. deepseek-v4-flash / minimax-m3 never get
  // here — they were switched to passthrough above.
  if (!opencodeGoKey) {
    return jsonError(502, "OPENCODE_GO_API_KEY not configured — add your own key in the console", "config_error");
  }
  if (await isChannelDegraded(env)) {
    // Circuit open: repeated hard failures — fail fast instead of waiting on zen again.
    return jsonError(502, "og: circuit open (recent upstream failures, try again in ~1 min)", "api_error");
  }
  const openaiReq = toOpenAIRequest(body, upstreamModel);
  const { response: upstream, detail } = await fetchWithRetry(route.upstream, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opencodeGoKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(openaiReq),
  }, { timeoutMs: ogTimeoutMs(env) });
  if (!upstream || !upstream.ok) {
    // Count toward the breaker ONLY channel-death signals: a hard network
    // error OR a timeout (a blackholed channel hangs instead of erroring).
    // A fast 5xx/429 (retries exhausted) is zen being flaky, not dead — it
    // must NOT trip. The BreakerDO's 10-min window means a live-but-slow
    // channel's occasional hang won't accumulate to a trip either.
    if (detail?.startsWith("network error") || detail?.startsWith("timeout")) {
      await recordChannelFailure(env);
    }
    return jsonError(502, `og: ${detail || `upstream ${upstream?.status || "error"}`}`, "api_error");
  }
  // A real response (even a retried 5xx→2xx) resets the consecutive-failure
  // count — otherwise yesterday's blips would combine with today's to trip.
  await recordChannelSuccess(env);
  // True streaming: when the client asked for a stream, forward zen's OpenAI SSE
  // chunks to Anthropic SSE increments as they arrive (instead of buffering the
  // whole response and flushing it at once — that made thinking look frozen and
  // could time out long generations).
  if (body.stream) {
    const ctype = upstream.headers?.get?.("content-type") || "";
    if (ctype.includes("application/json") && !ctype.includes("text/event-stream")) {
      // The upstream ignored stream:true and returned a plain JSON completion
      // (a proxy/backend quirk, or a 200-wrapped error). Feeding JSON into the
      // SSE parser produced an EMPTY Anthropic message — the whole answer was
      // silently dropped. Buffer + translate as a one-shot SSE instead.
      const json = await upstream.json().catch(() => null);
      if (json) {
        // A 200-wrapped OpenAI ERROR envelope ({error:{...}}) must NOT become
        // a silent empty assistant message — surface it.
        if (json.error || !Array.isArray(json.choices) || json.choices.length === 0) {
          return jsonError(502, json.error?.message || json.message || "upstream returned an error envelope", "api_error");
        }
        const oneShot = toSSE(toAnthropicResponse(json, upstreamModel));
        return new Response(oneShot, {
          headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...CORS_HEADERS },
        });
      }
      // Parse failed AND the body was consumed — a fall-through to the SSE
      // translator would read an empty stream and fabricate an empty message.
      return jsonError(502, "upstream returned invalid JSON", "api_error");
    }
    // Extract the scalars the encoder needs, then drop the big body object so
    // the GC can reclaim it while the (potentially minutes-long) stream runs —
    // keeping a multi-MB parsed body resident the whole time pushes the Free
    // plan's 128MB isolate limit.
    const clientModel = body.model;
    const streamBody = streamOgToAnthropic(upstream.body, clientModel, upstreamModel);
    body = null;
    return new Response(streamBody, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...CORS_HEADERS },
    });
  }
  const upJson = await upstream.json().catch(() => null);
  // A 200-wrapped OpenAI error envelope must not become an empty assistant
  // message (silent failure, no retry signal).
  if (!upJson || upJson.error || !Array.isArray(upJson.choices) || upJson.choices.length === 0) {
    return jsonError(502, upJson?.error?.message || upJson?.message || "upstream returned an invalid response", "api_error");
  }
  const anthropicRes = toAnthropicResponse(upJson, upstreamModel);
  return jsonOk(anthropicRes);
}
/**
 * Structured request log for the /v1/* hot path — one line per gateway
 * request (user/model/status/latency). Visible via `wrangler tail`; no
 * persistent storage on the Free plan, but enough to see who used what and
 * which channel misbehaves.
 */
export async function handleGateway(request, env, url) {
  const started = Date.now();
  // Read the raw body ONCE here and hand it to the impl (round-55: the old
  // clone().text() re-read + re-scan on every /v1 request was ~30MB extra
  // memory + double the scan CPU). The impl scans it for routing AND the
  // model swap — that single scan result is also the log's model. The model
  // travels in a per-request context object (round-57: a module variable
  // cross-talked between CONCURRENT requests — request A's log line could
  // read request B's model after an await boundary).
  let rawText = null;
  try {
    rawText = await request.text();
  } catch { /* impl will re-try; a broken stream fails there with a clear error */ }
  const ctx = { model: "", user: "" };
  const res = await handleGatewayImpl(request, env, url, rawText, ctx);
  try {
    // One structured line per /v1 request — tail-visible usage/health signal.
    // round-58: log the resolved user id instead of the x-api-key prefix —
    // the key's first 8 chars (~48bit entropy) leak token material and
    // cross-correlate requests across logs; findUserByToken already resolved
    // the user in the impl.
    console.log(JSON.stringify({
      ts: started, ms: Date.now() - started, status: res.status,
      user: ctx.user,
      path: url.pathname,
      model: ctx.model,
    }));
  } catch { /* log must never break the request */ }
  return res;
}
// Claude Code appends a [context-window] marker (e.g. [1m]) to model names and strips it
// before sending; strip it here too as a safety net so a literal "[1m]" never hits zen/OpenRouter.
function stripBracket(s) {
  return s.replace(/\[[^\]]*\]$/, "");
}

function pickRoute(prefix, env, usProxy) {
  // 美国出口开关:US_PROXY=1 时所有模型经 Vercel 代理(v.saisi.online/api/zen)
  // 从美国边缘出口访问上游,规避区域限制/拥堵。target=og|ds|qw|or 选上游,
  // path 参数带上游相对路径(代理 base 已含主机级前缀)。usProxy is a local
  // per-request value — never mutate the shared env object with it.
  const via = (direct, path) => usProxy
    ? `https://v.saisi.online/api/zen?target=${prefix}&path=${encodeURIComponent(path)}`
    : direct;
  switch (prefix) {
    case "or":
      return {
        type: "passthrough",
        kind: "openrouter", // passes through the user's own OPENROUTER_API_KEY
        stripPrefix: true,
        // 代理 base 是 openrouter.ai/api,path 只用 /v1/messages(不含 /api,
        // 否则拼出 openrouter.ai/api/api/v1/messages → 404)
        upstream: via((env.OPENROUTER_PROXY_URL || "https://openrouter.example.com/api/proxy") + VERIFY_PATH, "/v1/messages"),
      };
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
        upstream: via("https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic" + VERIFY_PATH, "/apps/anthropic/v1/messages"),
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

function passthroughHeaders(bearerKey, { apiKeyHeader = false } = {}) {
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
/* ---------------- Gateway-side vision pre-processing ---------------- */
// The gateway's own models (deepseek, minimax, ...) are text-only. If an incoming
// request carries Anthropic image blocks and the target model isn't on the
// vision-capable allowlist, describe each image with a vision model (default
// og/mimo-v2.5, configurable via env VISION_MODEL) and replace the image blocks
// with the returned text so every model can "see" the picture.

function isVisionCapable(model, upstreamModel, env) {
  const list = String(env.VISION_CAPABLE_MODELS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(model) || list.includes(upstreamModel);
}

async function preprocessImages(messages, env, ukeys, model, upstreamModel) {
  if (!Array.isArray(messages)) return { messages, changed: false };
  if (isVisionCapable(model, upstreamModel, env)) return { messages, changed: false };
  const visionModel = env.VISION_MODEL || "og/mimo-v2.5";
  let changed = false;
  const out = [];
  // Every image block gets a REAL description (round-43's placeholder carried
  // no content — a turn-2 follow-up about a turn-1 screenshot was answered
  // blind because the description existed only in the forwarded body, never
  // in the client transcript). describeImage has a KV cache (keyed by the
  // base64 data hash), so re-sent history images hit the cache — no vision
  // call, no extra cost. Image conversations parse every turn (they must, to
  // swap history images for their cached descriptions) — acceptable: image
  // sessions are rare and the 1102 risk is bounded to them.
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content !== "object" || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    if (!m.content.some((b) => b.type === "image")) {
      out.push(m);
      continue;
    }
    const newContent = [];
    for (const b of m.content) {
      if (b.type === "image") {
        const desc = await describeImage(env, ukeys, b.source, visionModel);
        newContent.push({ type: "text", text: `[图片内容描述]\n${desc}` });
        changed = true;
      } else {
        newContent.push(b);
      }
    }
    out.push({ ...m, content: newContent });
  }
  return { messages: out, changed };
}
/** Cheap hex hash (FNV-1a) for the image description cache key. */
function hashHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Cache a successful image description (never cache failures/empties). */
async function cacheImageDesc(cacheKey, env, desc) {
  if (!cacheKey || !env?.KEYS) return;
  if (!desc || /图片描述失败|图片描述为空/.test(desc)) return;
  try { await env.KEYS.put(cacheKey, desc, { expirationTtl: 7 * 24 * 60 * 60 }); } catch {}
}
async function describeImage(env, ukeys, source, visionModel) {
  const mediaType = source?.media_type || "image/png";
  const data = source?.data || "";
  if (!data) return "(图片数据为空)";
  // KV description cache: the client re-sends the same base64 image every
  // turn, so a per-image cache turns N vision calls per follow-up into 1.
  // Keyed by a short hash of the payload (hex, no special chars).
  // User-scoped cache key (the shared KEYS namespace must never serve one
  // user's image content to another — round-45 Medium #1). hashHex is 32-bit,
  // so use TWO independent FNV passes for ~64 bits of key space (no .slice
  // illusion — the old slice(0,24) was a no-op on an 8-char hex).
  const h1 = hashHex(data);
  const h2 = hashHex(visionModel + ":" + data);
  const cacheKey = data.length > 16 ? `img-desc:${h1}${h2}` : "";
  if (cacheKey && env.KEYS) {
    try {
      const hit = await env.KEYS.get(cacheKey);
      if (hit) return hit;
    } catch {}
  }
  const prefix = visionModel.split("/")[0];
  const route = pickRoute(prefix, env);
  const upstreamModel = stripBracket(route.stripPrefix ? visionModel.slice(prefix.length + 1) : visionModel);
  const content = [
    { type: "image", source: { type: "base64", media_type: mediaType, data } },
    { type: "text", text: "请用中文详细描述这张图片的内容，包括所有可见文字（OCR）、界面元素、布局。若是截图或表格，请逐行说明关键内容。只输出描述，不要额外说明。" },
  ];
  const miniReq = { model: visionModel, max_tokens: 1500, messages: [{ role: "user", content }] };

  if (route.type === "passthrough") {
    // or/ (openrouter) or ds/ (deepseek) vision model — Anthropic passthrough
    const bearerKey = route.kind === "openrouter" ? ukeys.OPENROUTER_API_KEY : ukeys.DEEPSEEK_API_KEY;
    if (!bearerKey) return "(图片描述失败：视觉模型后端未配置)";
    let resp;
    try {
      resp = await fetchWithTimeout(route.upstream, {
        method: "POST",
        headers: passthroughHeaders(bearerKey),
        body: JSON.stringify({ ...miniReq, model: upstreamModel }),
      }, upstreamTimeoutMs(env));
    } catch (e) {
      return `(图片描述失败：${e.message})`;
    }
    if (!resp.ok) return `(图片描述失败：${resp.status})`;
    let json;
    try { json = await resp.json(); } catch { return "(图片描述失败：响应解析失败)"; }
    const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const descPt = text || "(图片描述为空)";
    await cacheImageDesc(cacheKey, env, descPt);
    return descPt;
  }

  // og/ vision model (opencode zen) — needs the Anthropic→OpenAI translation,
  // which now forwards image_url parts (see toOpenAIRequest).
  if (!ukeys.OPENCODE_GO_API_KEY) return "(图片描述失败：OPENCODE_GO_API_KEY 未配置)";
  const openaiReq = toOpenAIRequest(miniReq, upstreamModel);
  let resp;
  try {
    resp = await fetchWithTimeout(route.upstream, {
      method: "POST",
      headers: { Authorization: `Bearer ${ukeys.OPENCODE_GO_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(openaiReq),
    }, upstreamTimeoutMs(env));
  } catch (e) {
    return `(图片描述失败：${e.message})`;
  }
  if (!resp.ok) return `(图片描述失败：${resp.status})`;
  let json;
  try { json = await resp.json(); } catch { return "(图片描述失败：响应解析失败)"; }
  const desc = (json.choices?.[0]?.message?.content || "").trim() || "(图片描述为空)";
  await cacheImageDesc(cacheKey, env, desc);
  return desc;
}
/** Model usable for routing? In the whitelist, (og) breaker not open, AND
 *  the REQUESTING user's key for that channel is configured — a channel
 *  without a key 502s every request, so model=auto must not route to it.
 *  round-68: the old code checked ADMIN_ID's keys — a BYOK user with only an
 *  og key was told og was "unusable" (the admin lacks it) and routed to ds,
 *  which the user lacks → 502 on every model=auto request. */
export async function isModelUsable(env, model, uid) {
  if (!MODELS.some((m) => m.id === model)) return false;
  const userKeys = await getUserKeys(env, uid).catch(() => ({}));
  const prefix = model.split("/")[0] + "/";
  if (prefix === "og/" && !(userKeys.OPENCODE_GO_API_KEY || env.OPENCODE_GO_API_KEY)) return false;
  if (prefix === "ds/" && !(userKeys.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY)) return false;
  if (prefix === "qw/" && !(userKeys.QWEN_API_KEY || env.QWEN_API_KEY)) return false;
  if (prefix === "or/" && !(userKeys.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY)) return false;
  if (model.startsWith("og/")) return !(await isChannelDegraded(env));
  return true;
}

// Default channel when the user hasn't made a selection: the stable,
// cheapest direct channel (DeepSeek official).
const DEFAULT_ROUTE_MODEL = "ds/deepseek-v4-flash";

/**
 * Resolve Claude Code's fixed `auto` model name to this user's chosen
 * channel (per-user route selection). Falls back to the default channel
 * (ds/deepseek-v4-flash) when unset or unusable.
 */
export async function resolveAutoModel(env, uid) {
  const chosen = await getUserRoute(env, uid);
  if (chosen && (await isModelUsable(env, chosen, uid))) return chosen;
  return DEFAULT_ROUTE_MODEL;
}

/* ---------------- Plugin registration ---------------- */

export default {
  name: "translate",
  deps: [],
  setup(ctx) {
    // Every /v1/* entry dispatches through handleGateway → handleGatewayImpl
    // exactly as index.js's fetch did; the impl owns the endsWith checks.
    const handler = (request, env, url) => handleGateway(request, env, url);
    ctx.routes.push({ match: (m, p) => m === "GET" && p.startsWith("/v1/models"), handler });
    ctx.routes.push({ match: (m, p) => m === "POST" && p.startsWith("/v1/messages"), handler });
    ctx.routes.push({ match: (m, p) => m === "POST" && p.startsWith("/v1/chat/completions"), handler });
    // Cross-plugin API surface (mirrors the exports index.js exposes today).
    ctx.api.translate = { handleGateway, handleGatewayImpl, resolveAutoModel, isModelUsable };
  },
};
