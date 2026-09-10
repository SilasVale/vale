// shared.js guard pins (SOLID Round-24 — the extension's FIRST unit
// tests: CI gated syntax only until now). httpsOrigin is the MITM guard
// for the code-server session cookies: http must never pass, and only a
// bare origin may come out. shared.js stays a classic script (manifest
// load order + isolated-world channel); the module.exports shim at its
// tail is inert in the browser and feeds this file under node.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DEFAULT_STUDIO_ORIGIN, httpsOrigin, resolveDir, studioFolderUrl, extractPathJobs } = require("../shared.js");

test("default origin is the code-server host", () => {
  assert.equal(DEFAULT_STUDIO_ORIGIN, "https://vscode.saisi.online");
  assert.equal(httpsOrigin(DEFAULT_STUDIO_ORIGIN), DEFAULT_STUDIO_ORIGIN, "default passes its own guard");
});

test("https URLs normalize to the bare origin (path/query/port kept correctly)", () => {
  assert.equal(httpsOrigin("https://vscode.saisi.online/a/b?q=1"), "https://vscode.saisi.online");
  assert.equal(httpsOrigin("https://h.example:8443/x"), "https://h.example:8443", "explicit port kept");
  assert.equal(httpsOrigin("HTTPS://UPPER.example/x"), "https://upper.example", "scheme/host normalized");
});

test("http never passes (MITM guard for session cookies)", () => {
  for (const v of ["http://vscode.saisi.online/", "http://localhost:8080/", "http://127.0.0.1/"]) {
    assert.equal(httpsOrigin(v), null, `cleartext rejected: ${v}`);
  }
});

test("non-URLs are null, never throw", () => {
  for (const v of ["", "notaurl", "//protocol-relative", "ftp://h.example/x", null, undefined, 42]) {
    assert.equal(httpsOrigin(v), null, `rejected: ${JSON.stringify(v)}`);
  }
});

// Path→folder resolution (SOLID Round-96 — verbatim core of the content
// script's resolve; the TTL cache stays page-side, this mapping is pure).
test("resolveDir: absolute file → folder, absolute dir kept, slashes trimmed", () => {
  assert.equal(resolveDir("/home/zhengsaisi/vale/gateway/src/index.ts"), "/home/zhengsaisi/vale/gateway/src");
  assert.equal(resolveDir("/home/zhengsaisi/vale/"), "/home/zhengsaisi/vale");
  assert.equal(resolveDir("/"), "/");
  assert.equal(resolveDir("/a/b///"), "/a/b");
});

test("resolveDir: relative joins the base, file part stripped", () => {
  assert.equal(resolveDir("gateway/src/index.ts"), "/home/zhengsaisi/gateway/src");
  assert.equal(resolveDir("notes/"), "/home/zhengsaisi/notes");
  assert.equal(resolveDir("a/b.js", "/base"), "/base/a");
});

test("studioFolderUrl: folder encoded under the origin", () => {
  assert.equal(
    studioFolderUrl("https://vscode.saisi.online", "/home/zhengsaisi/vale"),
    "https://vscode.saisi.online/?folder=%2Fhome%2Fzhengsaisi%2Fvale",
  );
});

// Mention matcher (SOLID Round-96 — verbatim core of the per-node scan).
test("extractPathJobs: absolute + line, relative, bare filename; noise skipped", () => {
  const jobs = extractPathJobs("see /a/b/c.rs:42 and docs/x.md plus README and ab");
  assert.deepEqual(
    jobs.map((j) => [j.raw, j.bare, j.lineNo]),
    [
      ["/a/b/c.rs:42", "/a/b/c.rs", 42],
      ["docs/x.md", "docs/x.md", 0],
    ],
  );
  assert.ok(jobs[0].index < jobs[1].index, "document order with indices");
  // Repeat call: the shared /g regex must reset, not resume mid-stream.
  assert.deepEqual(
    extractPathJobs("see /a/b/c.rs:42").map((j) => j.raw),
    ["/a/b/c.rs:42"],
  );
});

test("extractPathJobs: empty and prose-only yield nothing", () => {
  assert.deepEqual(extractPathJobs(""), []);
  assert.deepEqual(extractPathJobs("just some words here"), []);
});
