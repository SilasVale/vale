/**
 * Reliability cluster: fetchWithTimeout / fetchWithRetry, per-channel timeouts,
 * BreakerDO (Durable Object circuit breaker) + breaker helpers.
 * Extracted from index.js (2026-08-12 refactor). Behavior unchanged.
 */

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
 */
export async function fetchWithRetry(url, init, { attempts = 3, backoffMs = 750, timeoutMs = 30000 } = {}) {
  let last = null;
  let detail = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      last = await fetchWithTimeout(url, { ...init, body: init.body }, timeoutMs);
    } catch (e) {
      detail = e.name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : `network error: ${e.message}`;
      break;
    }
    if (last.ok || !(last.status >= 500 || last.status === 429)) {
      return { response: last, detail: "" };
    }
    detail = `upstream ${last.status} (retried ${attempt}/${attempts})`;
    console.error(`[gateway] upstream ${last.status} on attempt ${attempt}/${attempts} — retrying`);
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }
  return { response: last, detail };
}


export async function fetchWithTimeout(url, init = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
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
export function upstreamTimeoutMs(env) {
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
export function ogTimeoutMs(env) {
  const v = Number(env?.OG_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 120000;
}

/**
 * Timeout for passthrough routes. og-native (e.g. deepseek-v4-flash) must use
 * the 120s og budget — zen's latency intermittently spikes past 30s and real
 * max-thinking runs 40-54s to first byte — while every other passthrough
 * channel (ds/qw/or) keeps the generic 30s upstream budget.
 */
export function passthroughTimeoutMs(env, kind) {
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
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
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
          await this.state.storage.delete("fail");
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
        await this.state.storage.delete("fail");
        return new Response("ok");
      }
      if (action === "/clear") {
        await this.state.storage.delete("degradedUntil");
        await this.state.storage.delete("fail");
        return new Response("ok");
      }
      if (action === "/check") {
        const degradedUntil = (await this.state.storage.get("degradedUntil")) || 0;
        return new Response(degradedUntil > Date.now() ? "1" : "0");
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response(`breaker error: ${e.message}`, { status: 500 });
    }
  }
}

function breakerStub(env) {
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

export async function isChannelDegraded(env) {
  const now = Date.now();
  if (now - degradedCache.at < DEGRADED_CACHE_TTL_MS) return degradedCache.value;
  try {
    const res = await breakerStub(env).fetch("https://breaker/check");
    degradedCache = { at: now, value: (await res.text()) === "1" };
    return degradedCache.value;
  } catch (e) {
    console.error("[breaker] check failed:", e.message);
    return false;
  }
}

export async function recordChannelFailure(env) {
  try {
    await breakerStub(env).fetch("https://breaker/trip");
  } catch (e) {
    console.error("[breaker] trip failed:", e.message);
  }
}

export async function recordChannelSuccess(env) {
  try {
    await breakerStub(env).fetch("https://breaker/reset");
  } catch (e) {
    console.error("[breaker] reset failed:", e.message);
  }
}
