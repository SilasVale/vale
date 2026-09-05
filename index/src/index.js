// Vale Agent — install / download landing page (Cloudflare Worker).
//
// This Worker is the download site for vale-agent. Device management
// (registry + MCP config + panel proxy) lives in the Vale console
// (admin-only). This page distributes the npm tgz (the SINGLE install/update
// channel — NSIS installer retired 2026-08-28) and points users to the
// console. The console URL is set per-deployment via the CONSOLE_URL var
// (no production domain is hardcoded here).
//
// Design aligned with DeepSeek Harness (DSH) web GUI: dark-first design
// system, --dsw-alias-* tokens, 12px radius cards, layered shadows.

// One-time-download claim serializer (Durable Object, see ./claim.js).
// Re-exported so wrangler binds TEMP_CLAIM to it.
export { TempClaimDO } from "./claim.js";

// Landing page (FAVICON + PAGE template + its URL-whitelist/escape
// helpers) lives in ./page.js — structure refactor, content verbatim.
import { PAGE } from "./page.js";

// P2-9 helper: build a hardened Content-Disposition for an uploaded
// filename. Strips quotes/backslashes/controls (header-split defence),
// returns null when nothing survives (caller answers 400 — an illegal name
// must never reach the R2 put as a forged header); keeps the quoted
// filename parameter pure-ASCII and carries non-ASCII names via filename*
// (RFC 5987) with an ASCII fallback.
function buildContentDisposition(rawName) {
  const cleaned = String(rawName || "").replace(/["\\\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return null;
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "").trim() || "download.bin";
  if (ascii === cleaned) return `attachment; filename="${ascii}"`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`;
}

// P2-5: agent_update refuses unverifiable installs (round-119) — a
// truncated/placeholder sha in version.json must never be served as if it
// were a real manifest. Same shape as assert_want_sha256 in
// scripts/smoke-index.sh (the shared pre-publish guard): 64 hex chars.
const SHA256_RE = /^[0-9a-f]{64}$/i;

// P2-7 (was: stale "In-memory token set / swap to KV later" note):
// claim tokens are one-time nonces created per upload below and consumed by
// TempClaimDO (see ./claim.js), which deletes the R2 key on first claim.
// There is NO token store — the R2 key + 24h customMetadata deadline IS the
// state (the pre-DO in-memory/KV sketch never shipped). Tokens are 22
// chars URL-safe.
const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function genToken(len = 22) {
  // P2-11: rejection sampling — TOKEN_CHARS.length (62) does not divide
  // 256, so buf%62 would overweight the first 256%62 = 8 symbols (A-H).
  // Accept only bytes in [0, 248) (largest multiple of 62 below 256) and
  // discard the rest: uniform over the alphabet at ~3% redraw cost.
  const RANGE = 256 - (256 % TOKEN_CHARS.length); // 248
  let s = "";
  while (s.length < len) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && s.length < len; i++) {
      if (buf[i] < RANGE) s += TOKEN_CHARS[buf[i] % TOKEN_CHARS.length];
    }
  }
  return s;
}

// Constant-time string equality for credential-shaped values (same intent
// as gateway/src/auth.ts safeEq/timingSafeEqual, but hardened: SHA-256 both
// sides to fixed 32-byte digests first, so there is no length early-exit
// to leak on, then fold XOR across every byte without short-circuiting).
async function safeEq(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  const a8 = new Uint8Array(da);
  const b8 = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < a8.length; i++) diff |= a8[i] ^ b8[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Console URL is per-deployment (CONSOLE_URL var, see the header
    // contract above); fall back to this worker's own origin — no
    // production domain is hardcoded.
    const consoleUrl = (env && env.CONSOLE_URL) || url.origin;

    // ── Temporary file hosting ──────────────────────────────────────────
    // Upload: POST /api/upload  ->  { token, url, size, expiresIn }
    // Download: GET /files/<token>  ->  file bytes (one-time, then deleted)
    if (url.pathname === "/api/upload" && request.method === "POST") {
      try {
        // Auth: require a bearer token matching the shared secret (set via
        // `wrangler secret put UPLOAD_KEY`). Compared via safeEq (hash both
        // sides, constant-time fold — a plain !== leaks timing on the key).
        // Without this, anyone can upload 100 MiB files to R2 (abuse + cost).
        const auth = request.headers.get("authorization") || "";
        const expected = `Bearer ${env.UPLOAD_KEY || ""}`;
        if (!env.UPLOAD_KEY || !auth || !(await safeEq(auth, expected))) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        const ct = request.headers.get("content-type") || "";
        if (!ct.includes("multipart/form-data")) {
          return new Response(JSON.stringify({ error: "expected multipart/form-data" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        // Cap at 100 MiB (Cloudflare Workers limit ~10 MiB for free plan,
        // 100 MiB for paid — this 100 MiB cap ASSUMES a paid plan; on free,
        // large uploads fail at the platform edge before reaching here).
        // Screen the declared Content-Length BEFORE formData() materializes
        // the whole body in memory — the multipart framing (boundary + part
        // headers) adds a little on top of the file bytes, hence the
        // margin. The authoritative check is file.size below.
        // P1-4: a missing Content-Length (chunked client) cannot be
        // pre-screened, so require the header (411) instead of buffering an
        // unbounded body and 413ing after the fact.
        const MAX_BYTES = 100 * 1024 * 1024;
        const CL_MARGIN = 64 * 1024;
        const declaredRaw = request.headers.get("content-length");
        if (declaredRaw === null || declaredRaw === "") {
          return new Response(JSON.stringify({ error: "content-length required" }), {
            status: 411,
            headers: { "content-type": "application/json" },
          });
        }
        const declared = Number(declaredRaw);
        if (declared > MAX_BYTES + CL_MARGIN) {
          return new Response(JSON.stringify({ error: `file too large (max ${MAX_BYTES} bytes)` }), {
            status: 413,
            headers: { "content-type": "application/json" },
          });
        }
        // A malformed framing (e.g. a quote-breaking filename) makes
        // formData() throw — answer 400, not the 500 catch-all below.
        let form;
        try {
          form = await request.formData();
        } catch {
          return new Response(JSON.stringify({ error: "invalid multipart body" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const file = form.get("file");
        if (!file || typeof file === "string") {
          return new Response(JSON.stringify({ error: "no file field" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (file.size > MAX_BYTES) {
          return new Response(JSON.stringify({ error: `file too large (max ${MAX_BYTES} bytes)` }), {
            status: 413,
            headers: { "content-type": "application/json" },
          });
        }
        // P2-9: illegal filenames (nothing survives header sanitizing) are
        // rejected 400 here — never forwarded into the R2 put as a forged
        // Content-Disposition header.
        const disposition = buildContentDisposition(file.name);
        if (!disposition) {
          return new Response(JSON.stringify({ error: "invalid filename" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const token = genToken(22);
        const key = `files/${token}`;
        // R2's Workers put() has NO expirationTtl option (that is KV-only;
        // R2PutOptions = httpMetadata/customMetadata/checksums/onlyIf/
        // storageClass). The 24h claim window is recorded in customMetadata
        // and enforced lazily on GET below — abandoned files are deleted on
        // first access after expiry instead of accumulating forever.
        const expiresAt = Date.now() + 24 * 3600 * 1000;
        // Pass the File/Blob itself — R2 put() accepts Blob values, so no
        // second full copy (arrayBuffer()) of the file is needed.
        await env.TEMP_FILES.put(key, file, {
          httpMetadata: {
            contentType: file.type || "application/octet-stream",
            contentDisposition: disposition,
          },
          customMetadata: { expiresAt: String(expiresAt) },
        });
        const downloadUrl = `${url.origin}/files/${token}`;
        return new Response(JSON.stringify({
          token,
          url: downloadUrl,
          size: file.size,
          filename: file.name || "file",
          expiresAt: new Date(expiresAt).toISOString(),
          // Tokens auto-delete on first download; unclaimed files expire
          // 24h after upload (enforced on access).
          note: "one-time download: file is deleted after first access or 24h",
        }), { headers: { "content-type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Download: GET /files/<token>  ->  serialized one-time claim.
    // The claim runs inside TempClaimDO (instance named by the token), not
    // here: an inline R2 get-then-delete is racy — two concurrent GETs can
    // both pass get() before either delete lands, and the "one-time" file
    // downloads twice. The DO runtime delivers one instance's requests
    // strictly one at a time, so the first claim wins (streams the bytes)
    // and losers observe the winner's delete as 404. The DO is short-lived
    // per claim (milliseconds: one R2 get + one delete, no storage, alarms,
    // or sockets — duration billing forbids an always-on shape here).
    const fileMatch = /^\/files\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname);
    if (fileMatch && request.method === "GET") {
      const token = fileMatch[1];
      // P1-1: idFromName/get/fetch cross the DO boundary (network I/O) — a
      // DO/R2 outage must surface as a 503 JSON envelope, never as an
      // uncaught throw (worker 500 HTML / unhandled rejection).
      try {
        const id = env.TEMP_CLAIM.idFromName(`files/${token}`);
        return await env.TEMP_CLAIM.get(id).fetch(request);
      } catch (err) {
        return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Version endpoint for the agent_update MCP tool (and legacy tray
    // check). ROUND-297: this was hard-coded to v1.2.141/1.0.145 and rotted
    // (the 141 tgz was deleted from assets long ago — an update check that
    // ever fired would 404). The manifest is now derived from the version
    // discovery asset (/vale-agent/version.json, written by the release
    // flow) so it tracks every release automatically. The sha256 field is
    // REQUIRED by agent_update (round-119: unverifiable installs refused)
    // and is published into version.json by the release flow.
    if (new URL(request.url).pathname === "/api/version") {
      try {
        const vresp = await env.ASSETS.fetch(
          new Request("https://worker.local/vale-agent/version.json")
        );
        if (vresp.ok) {
          const vj = await vresp.json();
          const ver = vj && vj.version;
          const sha = vj && vj.sha256;
          // P2-5: assert the sha shape (64 hex), not just presence — a
          // truncated/placeholder sha would otherwise ship a manifest that
          // agent_update refuses anyway; fail to the honest 503 instead.
          // P2-1: the tarball filename is LIVE data, not decoration —
          // version.json names the exact file (publish writes the
          // versionless latest alias today, a versioned name tomorrow).
          // Serve exactly that basename after a flat-name validation (no
          // slashes, must end .tgz — a hostile manifest must not escape
          // /vale-agent/). Absent/invalid falls back to the derived
          // versioned name so older manifests keep working; smoke pins
          // the consistent case (tarball field == download basename).
          const tbRaw = vj && vj.tarball;
          const tb =
            typeof tbRaw === "string" && /^vale-agent-[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(tbRaw)
              ? tbRaw
              : `vale-agent-${ver}.tgz`;
          if (ver && typeof sha === "string" && SHA256_RE.test(sha)) {
            const base = new URL(request.url).origin;
            return new Response(
              JSON.stringify({
                version: ver,
                download: `${base}/vale-agent/${tb}`,
                sha256: sha,
              }),
              { headers: { "content-type": "application/json", "cache-control": "no-store" } }
            );
          }
        }
      } catch (e) {
        // fall through to the static fallback below
      }
      // Static fallback (assets unavailable): never serve a fabricated
      // manifest — agent_update refuses invalid sha256 anyway (round-119),
      // so an explicit error is the honest answer.
      return new Response("release manifest unavailable", { status: 503 });
    }
    const pathname = new URL(request.url).pathname;
    // Keep the old installer URL usable for links/bookmarks — the NSIS
    // installer is retired (npm is the single channel); redirect to the
    // console URL (CONSOLE_URL var, or this site's root when unset) so
    // stale links land somewhere useful.
    if (pathname === "/vale-agent/ValeAgent-Setup.exe") {
      return Response.redirect(consoleUrl, 302);
    }
    // npm tgz download path (the documented `npm i -g
    // https://agent.saisi.online/vale-agent/vale-agent-<v>.tgz` command).
    // The versionless latest alias (the landing page's install command)
    // is matched EXACTLY here — the versioned regex is intentionally NOT
    // loosened to cover it (exact-pattern discipline on download paths).
    const tgzMatch = /^\/vale-agent\/vale-agent-[0-9]+\.[0-9]+\.[0-9]+\.tgz$/.exec(pathname);
    if (tgzMatch || pathname === "/vale-agent/vale-agent-latest.tgz") {
      // The tgz (~12MB) fits Workers Assets and is served fast from here.
      return env.ASSETS.fetch(request);
    }
    // cloudflared.exe proxy: the boxed tunnel binary (~54MB) is NOT bundled
    // in the npm package (kept small); devices download it on demand from
    // the official GitHub release. GitHub is often unreachable from devices
    // (GFW etc.), so proxy it through this worker — Cloudflare's network
    // reaches GitHub fast, and the device only talks to agent.saisi.online.
    if (pathname === "/vale-agent/cloudflared.exe") {
      const upstream = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
      const resp = await fetch(upstream, { redirect: "follow" });
      if (!resp.ok) {
        return new Response("cloudflared upstream fetch failed: " + resp.status, { status: 502 });
      }
      // Stream the body through (no buffering — 54MB fits the response path).
      return new Response(resp.body, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="cloudflared.exe"',
          "cache-control": "public, max-age=3600",
        },
      });
    }
    // A missing binary must 404, not return the download PAGE as 200 HTML —
    // devices silently downloaded HTML as ValeAgent-Setup.exe and the agent
    // never started. Only "/" and "/index.html" render the page.
    if (pathname !== "/" && pathname !== "/index.html") {
      return new Response("Not Found", { status: 404 });
    }
    // round-319: the download page's install command pointed at the DELETED
    // 1.2.141 tgz on the Vercel mirror (v.saisi.online/dl/) — every copy-
    // paste install failed. Use the versionless latest alias served by this
    // worker itself (mirrored on every release) so the command always
    // installs the current build. The base is the request's own origin —
    // npm must hit the host that actually serves the tgz, and no production
    // domain is hardcoded.
    const installerUrl = `${url.origin}/vale-agent/vale-agent-latest.tgz`;

    return new Response(PAGE(consoleUrl, installerUrl), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
