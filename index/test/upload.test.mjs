// Upload + landing-page + /api/version tests (node:test, no CF runtime).
//
// Covers the round-345 hardening: 411 on missing Content-Length (P1-4),
// filename sanitize incl. RFC 5987 fallback + 400 on illegal names (P2-9),
// JSON content-type on every error envelope (P2-12), landing-page XSS
// whitelist+escape (P2-8), sha256 shape assertion on /api/version (P2-5),
// and the upload token format (P2-11 rejection sampling keeps the 22-char
// URL-safe shape — uniformity itself is a statistical property, pinned here
// by format + uniqueness).
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { makeR2, assertJsonError } from "./helpers.mjs";

const KEY = "test-upload-key";
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function uploadEnv(r2, extra = {}) {
  return {
    UPLOAD_KEY: KEY,
    TEMP_FILES: r2,
    TEMP_CLAIM: {
      idFromName: (name) => ({ __name: name }),
      get: () => ({ fetch: async () => new Response("unused") }),
    },
    ...extra,
  };
}

/** Hand-built multipart body: full control over Content-Length (undici
 *  does not set one for FormData, which is exactly the 411 case). */
function multipart({ filename = "hello.txt", contentType = "text/plain", bytes = "hello", withLength = true }) {
  const boundary = "----valetestboundary";
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const enc = new TextEncoder();
  const hb = enc.encode(head);
  const bb = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  const tb = enc.encode(tail);
  const body = new Uint8Array(hb.length + bb.length + tb.length);
  body.set(hb, 0);
  body.set(bb, hb.length);
  body.set(tb, hb.length + bb.length);
  const headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    authorization: `Bearer ${KEY}`,
  };
  if (withLength) headers["content-length"] = String(body.length);
  return new Request("https://dl.local/api/upload", { method: "POST", headers, body });
}

test("happy path: 200 manifest, 22-char token, R2 stored with disposition", async () => {
  const r2 = makeR2();
  const resp = await worker.fetch(multipart({}), uploadEnv(r2));
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type"), /application\/json/);
  const j = await resp.json();
  assert.match(j.token, /^[A-Za-z0-9]{22}$/);
  assert.match(j.token, TOKEN_RE);
  assert.equal(j.size, 5);
  assert.equal(j.filename, "hello.txt");
  const stored = await r2.get(`files/${j.token}`);
  assert.ok(stored, "R2 key must exist");
  assert.equal(stored.httpMetadata.contentDisposition, 'attachment; filename="hello.txt"');
});

test("tokens are unique across uploads", async () => {
  const r2 = makeR2();
  const env = uploadEnv(r2);
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const j = await (await worker.fetch(multipart({}), env)).json();
    assert.ok(!seen.has(j.token), `duplicate token ${j.token}`);
    seen.add(j.token);
  }
});

test("non-ASCII filename: RFC 5987 filename* + ASCII fallback", async () => {
  const r2 = makeR2();
  // Hand-encoded multipart (filename carries raw UTF-8 bytes).
  const boundary = "----valetestboundary2";
  const enc = new TextEncoder();
  const name = "报告 hello.txt";
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`,
  );
  const bb = enc.encode("data");
  const tb = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bb.length + tb.length);
  body.set(head, 0);
  body.set(bb, head.length);
  body.set(tb, head.length + bb.length);
  const resp = await worker.fetch(
    new Request("https://dl.local/api/upload", {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
        authorization: `Bearer ${KEY}`,
      },
      body,
    }),
    uploadEnv(r2),
  );
  assert.equal(resp.status, 200);
  const j = await resp.json();
  const stored = await r2.get(`files/${j.token}`);
  const disp = stored.httpMetadata.contentDisposition;
  assert.match(disp, /filename\*=UTF-8''/);
  assert.match(disp, /filename="[^"]*"/);
  // Quoted part must stay pure ASCII (header-safe).
  const quoted = disp.match(/filename="([^"]*)"/)[1];
  assert.ok(/^[\x20-\x7e]*$/.test(quoted), `quoted filename must be ASCII: ${quoted}`);
  assert.ok(decodeURIComponent(disp.match(/filename\*=UTF-8''(\S+)/)[1]).includes("报告"));
});

test("illegal filename (nothing survives sanitize) -> 400, not a put()", async () => {
  const r2 = makeR2();
  const env = uploadEnv(r2);
  // All-spaces name parses but sanitizes to empty -> invalid filename.
  await assertJsonError(await worker.fetch(multipart({ filename: "   " }), env), 400, "invalid filename");
  // A quote-breaking name breaks the multipart framing itself -> the
  // formData() parse fails -> 400, never the 500 catch-all.
  await assertJsonError(await worker.fetch(multipart({ filename: '"""' }), env), 400, "invalid multipart body");
  assert.equal(r2.store.size, 0, "rejected uploads must not reach the R2 put");
});

test("missing Content-Length -> 411 (P1-4: no unbounded buffering)", async () => {
  const r2 = makeR2();
  await assertJsonError(
    await worker.fetch(multipart({ withLength: false }), uploadEnv(r2)),
    411,
    "content-length required",
  );
  assert.equal(r2.store.size, 0);
});

test("declared Content-Length over cap -> 413 before buffering", async () => {
  const r2 = makeR2();
  const req = multipart({});
  req.headers.set("content-length", String(100 * 1024 * 1024 + 64 * 1024 + 1));
  await assertJsonError(
    await worker.fetch(req, uploadEnv(r2)),
    413,
    `file too large (max ${100 * 1024 * 1024} bytes)`,
  );
});

test("auth + content-type errors carry the JSON envelope (P2-12)", async () => {
  const r2 = makeR2();
  const env = uploadEnv(r2);
  const noAuth = multipart({});
  noAuth.headers.delete("authorization");
  await assertJsonError(await worker.fetch(noAuth, env), 401, "unauthorized");
  const badCt = multipart({});
  badCt.headers.set("content-type", "application/json");
  await assertJsonError(await worker.fetch(badCt, env), 400, "expected multipart/form-data");
  // Missing file field: valid multipart, wrong part name.
  const boundary = "----valetestboundary3";
  const body = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="nope"\r\n\r\nx\r\n--${boundary}--\r\n`);
  await assertJsonError(
    await worker.fetch(
      new Request("https://dl.local/api/upload", {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(body.length),
          authorization: `Bearer ${KEY}`,
        },
        body,
      }),
      env,
    ),
    400,
    "no file field",
  );
});

// ── Landing page XSS (P2-8) ──────────────────────────────────────────────

test("landing page escapes a hostile CONSOLE_URL (no element/attribute breakout)", async () => {
  const evil = 'https://console.local/"><script>alert(1)</script>';
  const resp = await worker.fetch(new Request("https://dl.local/"), uploadEnv(makeR2(), { CONSOLE_URL: evil }));
  assert.equal(resp.status, 200);
  const html = await resp.text();
  assert.ok(!html.includes('<script>alert(1)</script>'), "raw payload must not appear");
  assert.ok(!html.includes('"><script>'), "attribute breakout must not appear");
  assert.ok(html.includes("&quot;"), "quotes must be HTML-escaped");
});

test("landing page rejects javascript: CONSOLE_URL with the safe fallback", async () => {
  const resp = await worker.fetch(
    new Request("https://dl.local/"),
    uploadEnv(makeR2(), { CONSOLE_URL: "javascript:alert(document.domain)" }),
  );
  const html = await resp.text();
  assert.ok(!html.includes("javascript:"), "javascript: URL must not be rendered");
  assert.ok(html.includes('href="/"'), "fallback href must be used");
});

test("landing page still renders the real installer command for https origins", async () => {
  const resp = await worker.fetch(new Request("https://dl.local/"), uploadEnv(makeR2()));
  const html = await resp.text();
  assert.ok(html.includes("https://dl.local/vale-agent/vale-agent-latest.tgz"), "installer URL must render");
});

// ── /api/version sha shape (P2-5) ────────────────────────────────────────

function versionEnv(versionJson) {
  return {
    ...uploadEnv(makeR2()),
    ASSETS: {
      fetch: async () =>
        new Response(JSON.stringify(versionJson), { headers: { "content-type": "application/json" } }),
    },
  };
}

const GOOD_SHA = "a".repeat(64);

test("/api/version serves the manifest when version + 64-hex sha are present", async () => {
  const resp = await worker.fetch(new Request("https://dl.local/api/version"), versionEnv({ version: "1.2.3", sha256: GOOD_SHA }));
  assert.equal(resp.status, 200);
  const j = await resp.json();
  assert.equal(j.version, "1.2.3");
  assert.equal(j.sha256, GOOD_SHA);
  assert.ok(j.download.endsWith("/vale-agent/vale-agent-1.2.3.tgz"));
});

test("/api/version 503s on truncated / non-hex / missing sha (P2-5)", async () => {
  for (const sha256 of ["abc123", "z".repeat(64), "", null, undefined, GOOD_SHA.slice(0, 63) + "x"]) {
    const resp = await worker.fetch(
      new Request("https://dl.local/api/version"),
      versionEnv({ version: "1.2.3", sha256 }),
    );
    assert.equal(resp.status, 503, `sha ${JSON.stringify(sha256)} must 503`);
    assert.equal(await resp.text(), "release manifest unavailable");
  }
});
