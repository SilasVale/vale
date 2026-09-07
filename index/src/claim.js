// One-time file claims, serialized per token by a Durable Object.
//
// RACE this fixes: GET /files/<token> used to R2-get (existence check),
// then stream, then delete. Two concurrent GETs could BOTH pass the get()
// before either delete landed, so the "one-time" file downloaded twice.
// R2 has no compare-and-swap and KV is last-write-wins, so neither can
// close the race. A Durable Object instance named by the token is the
// correct primitive: the runtime delivers one instance's requests strictly
// one at a time, so the first claim wins and losers observe the winner's
// delete.
//
// COST: this DO is SHORT-LIVED per claim (milliseconds). It holds no
// WebSocket, installs no alarm, writes no storage — it runs one R2 get +
// one R2 delete, returns the bytes, and goes idle until evicted. There is
// deliberately no persistent connection here: an always-on DO design was
// previously killed by duration billing, and this fix must not reintroduce
// that shape.

// Pure claim-state decision (no I/O): extracted so the one-time-claim rule
// is unit-testable without a DO runtime (miniflare). Semantics:
//   - missing object            -> "gone"    (404 already-downloaded)
//   - expiresAt past            -> "expired" (410, lazy 24h expiry)
//   - expiresAt missing/empty   -> "serve"   (legacy uploads predate the
//     expiresAt field and carry no deadline — fail open for compat)
//   - expiresAt present but non-numeric -> "expired" (410 + delete; a
//     corrupt/unparseable deadline must not grant an unbounded download —
//     fail closed. NOTE: this tightens the old fail-open rule, which served
//     ANY non-numeric value including garbage; see claim.test.mjs.)
export function decideClaim({ exists, expiresAtRaw, nowMs }) {
  if (!exists) return "gone";
  if (expiresAtRaw === undefined || expiresAtRaw === null || expiresAtRaw === "") return "serve";
  const ts = Number(expiresAtRaw);
  if (!Number.isFinite(ts)) return "expired";
  if (ts < nowMs) return "expired";
  return "serve";
}

/**
 * Upstream-outage 503 envelope. R2 / DO calls are network I/O; an outage
 * must surface as this JSON shape (never an uncaught throw → worker 500
 * HTML). The claim handler and the index worker used to each inline the
 * same Response construction.
 */
export function unavailableResponse() {
  return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

const FILE_PATH = /^\/files\/([A-Za-z0-9_-]{16,64})$/;

// DO external-address compat gate (has-then-verify / absent-then-pass).
//
// TOKEN RANDOMNESS (why compat, not fail-closed, is the correct posture
// here — unlike gateway BreakerDO/RouteDO, which fail closed): claim IDs
// are genToken(22) from index.js — crypto.getRandomValues with rejection
// sampling over a 62-symbol alphabet, i.e. ~22*log2(62) ≈ 131 bits of
// entropy per token. The token IS an unguessable capability: only the
// uploader (who received it from the authenticated POST /api/upload) and
// the party they share the download URL with can address the instance.
// The x-do-auth header below is defense-in-depth for that residual risk
// (DO instances have their own external address even with workers_dev:
// false, so the worker-side upload auth is not the last line — same
// reasoning as gateway BreakerDO/RouteDO). It activates only when DO_AUTH
// is configured, so existing deploys without the secret keep working.
// Deploy hardening: `wrangler secret put DO_AUTH` (worker + DO share env).
function authorized(request, env) {
  const expected = (env && env.DO_AUTH) || "";
  if (!expected) return true;
  const got = request.headers.get("x-do-auth") || "";
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export class TempClaimDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const m = FILE_PATH.exec(url.pathname);
    if (!m || request.method !== "GET") {
      return new Response("Not Found", { status: 404 });
    }
    if (!authorized(request, this.env)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    const key = `files/${m[1]}`;
    // P1-1: R2 get/delete are network I/O — a DO/R2 outage must surface as
    // a 503 JSON envelope (same shape as the upload handler's 500 envelope),
    // never as an uncaught throw (worker 500 HTML / unhandled rejection).
    let obj;
    try {
      obj = await this.env.TEMP_FILES.get(key);
    } catch (err) {
      return unavailableResponse();
    }
    const decision = decideClaim({
      exists: !!obj,
      expiresAtRaw: obj && obj.customMetadata && obj.customMetadata.expiresAt,
      nowMs: Date.now(),
    });
    if (decision === "gone") {
      return new Response(JSON.stringify({ error: "file not found or already downloaded" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (decision === "expired") {
      try {
        await this.env.TEMP_FILES.delete(key);
      } catch (err) {
        return unavailableResponse();
      }
      return new Response(JSON.stringify({ error: "file expired" }), {
        status: 410,
        headers: { "content-type": "application/json" },
      });
    }
    // One-time: the object is deleted BEFORE the body streams, so a retry
    // after a completed download 404s. Concurrent claims cannot both get
    // here — the DO input queue serializes them, and the losers observe
    // this delete as "gone". (obj.body stays readable: get() already
    // fetched the object; deleting the key does not invalidate it.)
    try {
      await this.env.TEMP_FILES.delete(key);
    } catch (err) {
      return unavailableResponse();
    }
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
        "content-disposition": obj.httpMetadata?.contentDisposition || "attachment",
        "cache-control": "no-store",
      },
    });
  }
}
