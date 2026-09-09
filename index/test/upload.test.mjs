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
  await assertJsonError(
    await worker.fetch(badCt, env),
    400,
    "expected multipart/form-data (POST) or a raw body (PUT)",
  );
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
  assert.equal(j.installer, undefined, "tgz-only manifest carries no installer fields");
});

test("/api/version passes installer fields through when the manifest carries them", async () => {
  const resp = await worker.fetch(
    new Request("https://dl.local/api/version"),
    versionEnv({
      version: "1.2.3",
      sha256: GOOD_SHA,
      tarball: "vale-agent-latest.tgz",
      installer: "ValeAgent-Setup-1.2.3.exe",
      installer_sha256: "b".repeat(64),
    }),
  );
  assert.equal(resp.status, 200);
  const j = await resp.json();
  assert.equal(j.installer, "https://dl.local/vale-agent/ValeAgent-Setup-1.2.3.exe");
  assert.equal(j.installer_sha256, "b".repeat(64));
});

test("/api/version drops hostile/mismatched installer fields (additive, never 503)", async () => {
  for (const extra of [
    { installer: "../evil.exe", installer_sha256: "b".repeat(64) },
    { installer: "ValeAgent-Setup-1.2.3.exe", installer_sha256: "xyz" },
    { installer: "ValeAgent-Setup.exe", installer_sha256: "b".repeat(64) },
    { installer: "ValeAgent-Setup-1.2.3.exe" },
  ]) {
    const resp = await worker.fetch(
      new Request("https://dl.local/api/version"),
      versionEnv({ version: "1.2.3", sha256: GOOD_SHA, ...extra }),
    );
    assert.equal(resp.status, 200, `${JSON.stringify(extra)} must stay 200 (tgz manifest intact)`);
    const j = await resp.json();
    assert.equal(j.installer, undefined, `${JSON.stringify(extra)} must not surface installer fields`);
  }
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

// ── Raw-stream upload (PUT /api/upload, round-554) ───────────────────────
// The multipart path above calls request.formData(), which materializes the
// whole body inside the 128 MB isolate — the reason the gateway kept a 25 MB
// pre-screen. PUT streams the body straight into R2, so the same one-time
// relay works for full firmware images. These pin that the STREAM lands
// byte-identical and that every guard the multipart path has still fires.

function rawPut({
  bytes = new TextEncoder().encode("hello"),
  name = "fw.bin",
  nameIn = "query",
  withLength = true,
  auth = true,
  contentType = null,
} = {}) {
  const headers = { authorization: `Bearer ${KEY}` };
  if (!auth) delete headers.authorization;
  const target = new URL("https://dl.local/api/upload");
  if (name !== null) {
    if (nameIn === "query") target.searchParams.set("name", name);
    else headers["x-filename"] = name;
  }
  if (contentType) headers["x-content-type"] = contentType;
  if (withLength) headers["content-length"] = String(bytes.length);
  return new Request(target.toString(), { method: "PUT", headers, body: bytes });
}

test("raw PUT: streams the body into R2 byte-identical + manifest shape", async () => {
  const r2 = makeR2();
  const payload = new Uint8Array(300000).map((_, i) => i % 251);
  const resp = await worker.fetch(rawPut({ bytes: payload, name: "big_fw.bin" }), uploadEnv(r2));
  assert.equal(resp.status, 200);
  const j = await resp.json();
  assert.match(j.token, /^[A-Za-z0-9]{22}$/);
  assert.equal(j.size, payload.length, "size must come from the stored object");
  assert.equal(j.filename, "big_fw.bin");
  assert.equal(j.url, `https://dl.local/files/${j.token}`);
  assert.match(j.note, /one-time download/);
  const stored = r2.store.get(`files/${j.token}`);
  assert.ok(stored, "R2 key must exist");
  assert.deepEqual(Array.from(stored.bytes), Array.from(payload), "streamed bytes must be verbatim");
  assert.equal(stored.httpMetadata.contentDisposition, 'attachment; filename="big_fw.bin"');
  assert.match(stored.customMetadata.expiresAt, /^\d+$/, "24h lazy-expiry deadline must be recorded");
});

test("raw PUT: filename from X-Filename when no ?name= is present", async () => {
  const r2 = makeR2();
  const resp = await worker.fetch(rawPut({ name: "header.bin", nameIn: "header" }), uploadEnv(r2));
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).filename, "header.bin");
});

test("raw PUT: a client path is reduced to its basename (no disposition shaping)", async () => {
  const r2 = makeR2();
  const resp = await worker.fetch(
    rawPut({ name: "C:\\Users\\me\\Downloads\\fw.bin" }),
    uploadEnv(r2),
  );
  const j = await resp.json();
  assert.equal(j.filename, "fw.bin");
  assert.equal(
    r2.store.get(`files/${j.token}`).httpMetadata.contentDisposition,
    'attachment; filename="fw.bin"',
  );
});

test("raw PUT: non-ASCII name keeps the RFC 5987 filename* form", async () => {
  const r2 = makeR2();
  const resp = await worker.fetch(rawPut({ name: "固件.bin" }), uploadEnv(r2));
  assert.equal(resp.status, 200);
  const disp = r2.store.get(`files/${(await resp.json()).token}`).httpMetadata.contentDisposition;
  assert.ok(/^[\x20-\x7e]*$/.test(disp.match(/filename="([^"]*)"/)[1]), "quoted part stays ASCII");
  assert.match(disp, /filename\*=UTF-8''/);
});

test("raw PUT: guards — 401 auth, 411 missing length, 413 over cap, 400 illegal name", async () => {
  const r2 = makeR2();
  const env = uploadEnv(r2);
  await assertJsonError(await worker.fetch(rawPut({ auth: false }), env), 401, "unauthorized");
  await assertJsonError(
    await worker.fetch(rawPut({ withLength: false }), env),
    411,
    "content-length required",
  );
  const over = rawPut({});
  over.headers.set("content-length", String(100 * 1024 * 1024 + 1));
  await assertJsonError(
    await worker.fetch(over, env),
    413,
    `file too large (max ${100 * 1024 * 1024} bytes)`,
  );
  await assertJsonError(await worker.fetch(rawPut({ name: "   " }), env), 400, "invalid filename");
  assert.equal(r2.store.size, 0, "no rejected upload may reach the R2 put");
});

test("raw PUT: ?name= wins over X-Filename, and the default name is 'file'", async () => {
  const r2 = makeR2();
  const both = rawPut({ name: "query.bin" });
  both.headers.set("x-filename", "header.bin");
  assert.equal((await (await worker.fetch(both, uploadEnv(r2))).json()).filename, "query.bin");
  const nameless = await worker.fetch(rawPut({ name: null }), uploadEnv(makeR2()));
  assert.equal((await nameless.json()).filename, "file");
});

test("raw PUT: an R2 put failure answers 502 JSON, never the 500 catch-all", async () => {
  const r2 = makeR2();
  r2.put = async () => {
    throw new Error("r2 down");
  };
  await assertJsonError(
    await worker.fetch(rawPut({}), uploadEnv(r2)),
    502,
    "r2 put failed: Error: r2 down",
  );
});

test("raw PUT and multipart share the claim path (one-time download after either)", async () => {
  const r2 = makeR2();
  const env = uploadEnv(r2);
  const j = await (await worker.fetch(rawPut({ name: "shared.bin" }), env)).json();
  const obj = r2.store.get(`files/${j.token}`);
  assert.equal(new TextDecoder().decode(obj.bytes), "hello");
  // Same key shape seedFile writes for the claim tests -> the DO serves it.
  assert.ok(obj.customMetadata.expiresAt, "claim path reads expiresAt from customMetadata");
});
