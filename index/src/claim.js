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

const FILE_PATH = /^\/files\/([A-Za-z0-9_-]{16,64})$/;

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
    const key = `files/${m[1]}`;
    // P1-1: R2 get/delete are network I/O — a DO/R2 outage must surface as
    // a 503 JSON envelope (same shape as the upload handler's 500 envelope),
    // never as an uncaught throw (worker 500 HTML / unhandled rejection).
    let obj;
    try {
      obj = await this.env.TEMP_FILES.get(key);
    } catch (err) {
      return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
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
        return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
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
      return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
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
