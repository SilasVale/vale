// vale-studio · bearer-token auth: constant-time token check + wrong-guess
// budget. Extracted verbatim from server.mjs; the reference sha256 digest is
// computed once per process (makeAuth) instead of re-hashing the token on
// every request.

import crypto from "node:crypto";

// Wrong-guess budget: global sliding window. NOTE (auth design): the correct
// token is ALWAYS accepted regardless of limiter state (checked first below).
// Per-IP blocking is wrong here — behind the cloudflared tunnel every remote
// client shares one loopback remoteAddress, so >=10 bad guesses/min from a
// scanner would lock out the legitimate owner. The 256-bit bearer makes online
// guessing infeasible; this budget only bounds log/CPU burn from scanners and
// can never deny the true owner.
const WRONG_BUDGET_MAX = 100; // wrong guesses per window, server-wide
const WRONG_BUDGET_WINDOW_MS = 60_000;

/**
 * Build the auth pair for one process. Call once after loadConfig: the token
 * is boot-constant within a process (config is read once; a token change
 * requires a restart), and loadConfig is awaited at module top level before
 * the server starts listening — so nothing can call tokenOk before the
 * reference digest exists and computing it eagerly here is safe.
 */
export function makeAuth(token) {
  const expected = crypto.createHash("sha256").update(token).digest();
  const wrongBudget = { count: 0, resetAt: Date.now() + WRONG_BUDGET_WINDOW_MS };
  const failLog = new Map(); // ip -> {count, resetAt}: diagnostics only, never blocks

  function tokenOk(candidate, ip) {
    const now = Date.now();
    // 1) Correct token always wins — checked BEFORE any limiter state.
    let ok = false;
    if (typeof candidate === "string" && candidate.length > 0) {
      // constant-time compare over equal-length digests
      ok = crypto.timingSafeEqual(
        crypto.createHash("sha256").update(candidate).digest(),
        expected,
      );
    }
    if (ok) return true;
    // 2) Wrong guess: account it (global budget + per-IP diagnostics).
    if (now >= wrongBudget.resetAt) {
      wrongBudget.count = 0;
      wrongBudget.resetAt = now + WRONG_BUDGET_WINDOW_MS;
    }
    wrongBudget.count++;
    if (wrongBudget.count === WRONG_BUDGET_MAX + 1) {
      console.warn(
        `[studio] auth: wrong-guess budget exceeded (${WRONG_BUDGET_MAX}/${WRONG_BUDGET_WINDOW_MS}ms) — still accepting correct token`,
      );
    }
    const r = failLog.get(ip) || { count: 0, resetAt: now + WRONG_BUDGET_WINDOW_MS };
    if (now >= r.resetAt) {
      r.count = 0;
      r.resetAt = now + WRONG_BUDGET_WINDOW_MS;
    }
    r.count++;
    failLog.set(ip, r);
    return false;
  }

  function bearerOf(req, url) {
    const h = req.headers.authorization || "";
    if (h.startsWith("Bearer ")) return h.slice(7);
    return url.searchParams.get("token");
  }

  return { tokenOk, bearerOf };
}
