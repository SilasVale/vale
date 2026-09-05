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
// is unit-testable without a DO runtime (miniflare). Mirrors the previous
// inline semantics exactly:
//   - missing object            -> "gone"    (404 already-downloaded)
//   - expiresAt past            -> "expired" (410, lazy 24h expiry)
//   - otherwise (incl. uploads predating the expiresAt field, which carry
//     no deadline)              -> "serve"
export function decideClaim({ exists, expiresAtRaw, nowMs }) {
  if (!exists) return "gone";
  if (expiresAtRaw && Number(expiresAtRaw) < nowMs) return "expired";
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
    const obj = await this.env.TEMP_FILES.get(key);
    const decision = decideClaim({
      exists: !!obj,
      expiresAtRaw: obj && obj.customMetadata && obj.customMetadata.expiresAt,
      nowMs: Date.now(),
    });
    if (decision === "gone") {
      return new Response(JSON.stringify({ error: "file not found or already downloaded" }), { status: 404 });
    }
    if (decision === "expired") {
      await this.env.TEMP_FILES.delete(key);
      return new Response(JSON.stringify({ error: "file expired" }), { status: 410 });
    }
    // One-time: the object is deleted BEFORE the body streams, so a retry
    // after a completed download 404s. Concurrent claims cannot both get
    // here — the DO input queue serializes them, and the losers observe
    // this delete as "gone". (obj.body stays readable: get() already
    // fetched the object; deleting the key does not invalidate it.)
    await this.env.TEMP_FILES.delete(key);
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
        "content-disposition": obj.httpMetadata?.contentDisposition || "attachment",
        "cache-control": "no-store",
      },
    });
  }
}
