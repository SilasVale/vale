/**
 * ratelimit — the single per-IP in-memory rate limiter (structure refactor:
 * three verbatim copies of the same algorithm collapsed into one factory).
 *
 * Policy is a parameter because the three historical call sites differ in
 * ONE deliberate dimension — whether the counter is KV-SEEDED:
 *   - kvSeed: true   (probe) — each bucket's first sight per IP reads KV
 *     once and persists the count, so a new isolate inherits the budget.
 *     Costs 1 read + 1 write on that first call only (KV quota).
 *   - kvSeed: false  (auth register, devices public gate) — memory-only.
 *     round-104: these endpoints cost 2-3 KV writes per attempt themselves;
 *     a per-request KV write HERE would let an attacker exhaust the
 *     Free-plan daily KV write quota. The per-isolate ceiling is the
 *     accepted trade (documented, not a bug).
 *
 * Semantics preserved verbatim from the three originals:
 *   - per-IP (cf-connecting-ip) per fixed window bucket, in-memory
 *     `name:${ip}:${bucket}` → count, per-isolate (never shared),
 *   - 4096-key capacity cap with insertion-order eviction,
 *   - fail-open on any internal error (same posture as the breaker).
 */

export interface IpRateLimiterOptions {
  /** Human-readable bucket prefix (e.g. "probe-rate", "auth-rate"). */
  name: string;
  /** Max requests per window per IP. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  /** Seed the counter from KV so new isolates inherit the budget. */
  kvSeed?: boolean;
}

export interface IpRateLimiter {
  /** True when the caller is over budget for this window. */
  (request: Request, env?: any): Promise<boolean>;
  /** The KV key prefix (test/debug introspection). */
  readonly keyPrefix: string;
}

export function createIpRateLimiter(opts: IpRateLimiterOptions): IpRateLimiter {
  const { name, limit, windowMs, kvSeed = false } = opts;
  const counters = new Map<string, number>(); // `${ip}:${bucket}` → count

  const limiter = async (request: Request, env?: any): Promise<boolean> => {
    try {
      const ip = request?.headers?.get?.("cf-connecting-ip") || "unknown";
      const bucket = Math.floor(Date.now() / windowMs);
      const key = `${name}:${ip}:${bucket}`;
      const hit = counters.get(key);
      if (hit !== undefined) {
        if (hit >= limit) return true;
        counters.set(key, hit + 1);
        return false;
      }
      let cur = 0;
      if (kvSeed && env?.KEYS) {
        try {
          cur = Number(await env.KEYS.get(key)) || 0;
        } catch {
          /* KV read failed — isolate-local count from zero */
        }
      }
      counters.set(key, cur + 1);
      if (counters.size > 4096) {
        const oldest = counters.keys().next().value;
        if (oldest !== undefined) counters.delete(oldest);
      }
      if (kvSeed && env?.KEYS) {
        try {
          await env.KEYS.put(key, String(cur + 1), {
            expirationTtl: Math.ceil((windowMs / 1000) * 2) + 10,
          });
        } catch {
          /* KV write error: isolate-local count still better than nothing */
        }
      }
      return cur >= limit;
    } catch {
      return false;
    } // fail-open on internal errors, like the breaker
  };
  return Object.assign(limiter, { keyPrefix: name });
}
