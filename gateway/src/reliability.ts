/**
 * Reliability cluster: fetchWithTimeout / fetchWithRetry, per-channel timeouts,
 * BreakerDO (Durable Object circuit breaker) + breaker helpers.
 * Extracted from index.js (2026-08-12 refactor). Behavior unchanged.
 */

/**
 * Result of inspecting one successful (2xx) response before it is handed back
 * to the caller. Used by the SSE in-band error guard: an OpenRouter-style
 * upstream can accept the request (HTTP 200) and THEN fail inside the stream.
 */
export interface RetryInspection {
  /** false → treat this 2xx as a failed attempt and run the retry ladder. */
  accepted: boolean;
  /** When rejected: human-readable failure detail for the surfaced error. */
  detail?: string;
  /** When rejected: numeric upstream status the in-band failure carried, if any. */
  status?: number;
  /** When accepted: replacement response (e.g. body re-joined after buffering). */
  response?: any;
}

/**
 * Fetch an upstream with retry on transient failures (5xx / 429).
 *
 * Used by the og translate path (zen/go, which intermittently returns 500 —
 * observed ~50% on 2026-08-03) and the ds/qw/or passthrough paths (official
 * APIs' transient 5xx/429s). Retrying the identical request a couple of times
 * makes the gateway transparently absorb those failures instead of surfacing
 * "API error" to the client. Only retries before any response body has started
 * (a streaming response that dies mid-stream cannot be replayed).
 *
 * Slow failures (timeout / network error) are NOT retried — an upstream that
 * takes 45s to fail will simply fail again; retries only help fast 5xx/429s.
 * Returns { response, detail } where detail explains the failure for the 502.
 * With `inspect`, a rejected 2xx returns { response: null, detail,
 * inspectFailure } so callers can surface status digits from the in-band body.
 *
 * Retry pacing (2026-08-24): the fixed backoffMs×attempt ladder raced free-pool
 * rate limits — OpenRouter's glm/nemotron :free providers answer 429 with
 * `Retry-After: 5` while the old ladder re-hit at 0.75s/1.5s/2.25s, i.e. every
 * retry landed INSIDE the upstream's cooldown and failed identically. The wait
 * now honors the Retry-After header (capped by maxWaitMs) and adds jitter so
 * concurrent workers don't retry in lockstep.
 */

export async function fetchWithRetry(
  url: string,
  init: any,
  {
    attempts = 3,
    backoffMs = 750,
    timeoutMs = 30000,
    idempotent = false,
    retry502 = false,
    maxWaitMs = 10000,
    ignoreRetryAfter = false,
    inspect = undefined,
  }: {
    attempts?: number;
    backoffMs?: number;
    timeoutMs?: number;
    idempotent?: boolean;
    /** Treat 502/503 as retryable — caller asserts the upstream rejects BEFORE
     * processing (OpenRouter's "Provider returned error"/provider-overload
     * envelope), so re-sending cannot double-bill a BYOK key. Other 5xx stay
     * gated by `idempotent`. */
    retry502?: boolean;
    maxWaitMs?: number;
    /** Lottery pacing for OpenRouter's :free shared pools: their 429 carries
     * `Retry-After: 5`, but empirically slots are won by RAPID knocks (~9th
     * attempt at sub-second spacing), not by waiting out the header — pacing
     * spreads attempts so thin that none lands. When true, the header is
     * ignored and attempts fire at backoffMs spacing. */
    ignoreRetryAfter?: boolean;
    /** Inspect every 2xx response before returning it; rejecting counts as a
     * failed attempt against the same attempt/backoff budget. Nothing has been
     * forwarded to the client at inspection time, so a rejection cannot leak
     * partial output. */
    inspect?: (response: any) => Promise<RetryInspection>;
  } = {},
) {
  let last: any = null;
  let detail = "";
  let inspectFailure: { status?: number } | undefined;
  const mayRetry5xx = (status: number) =>
    status === 502 || status === 503 ? idempotent || retry502 : idempotent;
  /** Wait between attempts: honor Retry-After (seconds) when the upstream sent
   * one, else the legacy linear ladder; jitter ±400ms desynchronizes workers;
   * everything clamped to maxWaitMs so a huge header can't stall the request. */
  const retryWaitMs = (): number => {
    const jitter = Math.floor(Math.random() * 200);
    if (ignoreRetryAfter) return Math.min(backoffMs + jitter, maxWaitMs);
    const ra = Number(last?.headers?.get?.("retry-after"));
    const raMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0;
    return Math.min(Math.max(raMs, backoffMs * attempt) + jitter, maxWaitMs);
  };
  let attempt = 1;
  for (; attempt <= attempts; attempt++) {
    try {
      last = await fetchWithTimeout(url, { ...init, body: init.body }, timeoutMs);
    } catch (e: any) {
      detail =
        e.name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : `network error: ${e.message}`;
      break;
    }
    if (last.ok || !(last.status >= 500 || last.status === 429)) {
      // 2xx (or a non-retryable status the caller must see): inspect before
      // handing back — an in-band stream failure counts as a failed attempt.
      if (inspect && last.ok) {
        let insp: RetryInspection;
        try {
          insp = await inspect(last);
        } catch (e: any) {
          insp = { accepted: false, detail: `inspection failed: ${e.message}` };
        }
        if (!insp.accepted) {
          detail = `in-band upstream error${insp.status ? ` ${insp.status}` : ""}: ${insp.detail || "rejected by inspection"}`;
          console.error(`[gateway] upstream 200 rejected on attempt ${attempt}/${attempts} — ${detail}`);
          inspectFailure = { status: insp.status };
          if (attempt < attempts) {
            await new Promise((r) => setTimeout(r, retryWaitMs()));
            continue;
          }
          return { response: null as any, detail, inspectFailure };
        }
        if (insp.response !== undefined) last = insp.response;
      }
      return { response: last, detail: "" };
    }
    // A 5xx AFTER the upstream processed the request may have billed the
    // user's BYOK key — re-sending the identical POST double-charges. Retry
    // 5xx only when the caller vouches for it (idempotent probes, or the
    // retry502 pre-processing contract above). 429 (rate-limited, NOT
    // processed) is always safe to retry.
    if (last.status === 429 || (last.status >= 500 && mayRetry5xx(last.status))) {
      detail = `upstream ${last.status} (retried ${attempt}/${attempts})`;
      console.error(`[gateway] upstream ${last.status} on attempt ${attempt}/${attempts} — retrying`);
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, retryWaitMs()));
        continue;
      }
      return { response: last, detail };
    }
    if (attempt >= attempts) {
      detail = `upstream ${last.status} (retried ${attempt}/${attempts})`;
      return { response: last, detail };
    }
    detail = `upstream ${last.status} (not retried — POST may have been billed)`;
    console.error(`[gateway] upstream ${last.status} — not retryable (billing guard)`);
    return { response: last, detail };
  }
  return { response: last, detail, inspectFailure };
}

export async function fetchWithTimeout(
  url: string,
  init: any = {},
  ms: number = 15000,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    if (e.name === "AbortError") {
      const err = new Error(`timeout after ${ms}ms`);
      err.name = "TimeoutError";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- Reliability: upstream timeout, circuit breaker, estimation ---------------- */

/** Effective upstream timeout: env UPSTREAM_TIMEOUT_MS, default 30s. */
export function upstreamTimeoutMs(env: any): number {
  const v = Number(env?.UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 30000;
}

/**
 * og (zen) timeout — 120s. zen is a third-party gateway whose latency
 * intermittently spikes past 30s (observed "og: timeout after 30000ms" 502s),
 * and real max-thinking requests run 40-54s before first byte (measured
 * 2026-08-09); a 60s budget was tight for those. 120s absorbs the spikes AND
 * the legitimate long thinking without surfacing a 502. Streaming note: this
 * timeout only gates time-to-headers (observed ~7s) — once the SSE stream
 * starts, it runs untimed.
 */
export function ogTimeoutMs(env: any): number {
  const v = Number(env?.OG_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 120000;
}

/**
 * Timeout for passthrough routes. og-native (e.g. deepseek-v4-flash) must use
 * the 120s og budget — zen's latency intermittently spikes past 30s and real
 * max-thinking runs 40-54s to first byte — while every other passthrough
 * channel (ds/qw/or) keeps the generic 30s upstream budget.
 */
export function passthroughTimeoutMs(env: any, kind: string): number {
  return kind === "opencode" ? ogTimeoutMs(env) : upstreamTimeoutMs(env);
}

// Circuit breaker for the og channel, backed by a Durable Object so every
// worker isolate shares one strongly-consistent state. Alternatives were
// tried and failed on Cloudflare platform semantics:
//   - in-memory counter: isolates restart the count → never trips
//   - KV counter: writes can take up to 60s to propagate → every request reads
//     the pre-write state → never trips
//   - Cache API: put() is not available on the free plan → silently no-ops
//
// Semantics: only HARD network failures (channel unreachable) count toward the
// breaker, and only BREAKER_FAIL_THRESHOLD (3) CONSECUTIVE failures open it for
// BREAKER_DEGRADE_MS (60s) — a single network blip must not take the whole og
// channel down. Slow responses (timeout) are zen's normal behavior (multi-second
// latency observed routinely) and do NOT count; fast 5xx/429 stays handled by
// fetchWithRetry's retries and does NOT trip, so zen's intermittent 500s
// (~50% observed 2026-08-03) never cut the channel. A successful response
// (/reset) zeroes the count. After the TTL the first request probes zen for
// real and re-trips on failure.
const BREAKER_DEGRADE_MS = 60000;
const BREAKER_FAIL_THRESHOLD = 3;
// True "consecutive" with bounded memory: failures older than this window
// don't accumulate (a stale count of 2 from yesterday + 1 today must not trip).
const BREAKER_WINDOW_MS = 10 * 60 * 1000;

/** Durable Object holding the breaker state (single instance per channel name). */
export class BreakerDO {
  state: any;
  constructor(state: any, _env: any) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname;
    try {
      if (action === "/trip") {
        // Record one hard failure; open the circuit only after N CONSECUTIVE
        // failures WITHIN the window (a stale count must not combine with a
        // fresh one days later to trip).
        const rec = await this.state.storage.get("fail");
        let count = 0;
        let firstAt = Date.now();
        if (rec && typeof rec.count === "number" && Date.now() - rec.firstAt < BREAKER_WINDOW_MS) {
          count = rec.count;
          firstAt = rec.firstAt; // inside the window — keep the anchor
        }
        // Outside the window: re-anchor to NOW. Keeping the stale anchor made
        // the next /trip see an expired window again, reset to 0, and the
        // circuit NEVER tripped.
        count += 1;
        if (count >= BREAKER_FAIL_THRESHOLD) {
          await this.state.storage.put("degradedUntil", Date.now() + BREAKER_DEGRADE_MS);
          // round-118: the old code DELETED 'fail' here — after the degrade
          // window the circuit closed with a zeroed count, so a dead channel
          // needed 3 FRESH probe failures (3 x full upstream timeout, ~6 min
          // of 120s hangs) to re-trip. The half-open probe must re-trip on
          // ONE failure (the design comment says 're-trips on failure').
          // Keep 'fail' as the opened-state marker; /reset clears it only
          // after two genuine successes.
          await this.state.storage.put("fail", { count, firstAt });
        } else {
          await this.state.storage.put("fail", { count, firstAt });
        }
        return new Response("ok");
      }
      if (action === "/reset") {
        // A success between failures — restart the consecutive count. The
        // degradedUntil is NOT cleared: while the circuit is open no real
        // request gets through, and the half-open probe that succeeds resets
        // the count for the next genuine failure.
        // round-55: ONE success must not zero the count — a channel stuck in
        // hard-fail/success alternation would never accumulate the 3
        // consecutive failures the breaker needs, and every request would
        // burn the full upstream timeout with the circuit never opening.
        // Two consecutive successes (a genuinely recovering channel) clear
        // the count.
        const succ = (await this.state.storage.get("succ")) || 0;
        if (succ >= 1) {
          await this.state.storage.delete("fail");
          await this.state.storage.delete("succ");
        } else {
          await this.state.storage.put("succ", succ + 1);
        }
        return new Response("ok");
      }
      if (action === "/clear") {
        await this.state.storage.delete("degradedUntil");
        await this.state.storage.delete("fail");
        await this.state.storage.delete("succ");
        return new Response("ok");
      }
      if (action === "/check") {
        const degradedUntil = (await this.state.storage.get("degradedUntil")) || 0;
        return new Response(degradedUntil > Date.now() ? "1" : "0");
      }
      return new Response("not found", { status: 404 });
    } catch (e: any) {
      return new Response(`breaker error: ${e.message}`, { status: 500 });
    }
  }
}

function breakerStub(env: any) {
  return env.BREAKER.get(env.BREAKER.idFromName("og"));
}

// In-isolate cache for the breaker check: the DO /check does a storage get
// (~5-20ms) on EVERY og translate request, /api/health, and probe, while
// degradedUntil only changes every 60s. A 5s TTL absorbs the per-request
// checks without delaying failover meaningfully.
/** Test hook: clear the in-isolate breaker cache. Tests that flip the
 *  breaker open/closed in the same process would otherwise read a stale
 *  cached value from an earlier test file. */
export function __clearDegradedCache() {
  degradedCache = { at: 0, value: false };
}

let degradedCache = { at: 0, value: false };
const DEGRADED_CACHE_TTL_MS = 5000;

export async function isChannelDegraded(env: any): Promise<boolean> {
  const now = Date.now();
  if (now - degradedCache.at < DEGRADED_CACHE_TTL_MS) return degradedCache.value;
  try {
    const res = await breakerStub(env).fetch("https://breaker/check");
    degradedCache = { at: now, value: (await res.text()) === "1" };
    return degradedCache.value;
  } catch (e: any) {
    console.error("[breaker] check failed:", e.message);
    return false;
  }
}

export async function recordChannelFailure(env: any): Promise<void> {
  try {
    await breakerStub(env).fetch("https://breaker/trip");
    // Invalidate the 5s stale cache immediately — otherwise this isolate's
    // health checks keep reporting ok for up to 5s after a trip.
    degradedCache = { at: 0, value: false };
    console.error("[breaker] channel failure recorded (may open the circuit)");
  } catch (e: any) {
    console.error("[breaker] trip failed:", e.message);
  }
}

export async function recordChannelSuccess(env: any): Promise<void> {
  try {
    await breakerStub(env).fetch("https://breaker/reset");
  } catch (e: any) {
    console.error("[breaker] reset failed:", e.message);
  }
}
