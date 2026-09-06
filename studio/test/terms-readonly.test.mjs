// readOnly mode contract tests: a read-only server refuses every mutating
// surface (403 read_only / terminal_disabled), still serves reads, and
// reports its posture through /api/stat. First CI coverage for the readOnly
// flag (previously documented-but-untested).
import test from "node:test";
import assert from "node:assert/strict";
import { startStudio, stopStudio } from "./helpers.mjs";

const PORT = 7802;
const TOKEN = "test-token-abcdef";
let child, api, rootDir;

test.before(async () => {
  ({ child, api, rootDir } = await startStudio({
    port: PORT,
    token: TOKEN,
    readOnly: true,
    files: { "hello.txt": "hello\n" },
  }));
});

test.after(() => stopStudio(child));

test("/api/boot reports the read-only posture", async () => {
  const r = await api("/api/boot");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.readOnly, true);
  assert.equal(j.terminalEnabled, false);
});

test("terminal creation is refused (terminal_disabled), not read_only", async () => {
  const r = await api("/api/term", { method: "POST", body: { cwd: rootDir } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "terminal_disabled");
});

test("file writes are refused (read_only)", async () => {
  const r = await api("/api/file", {
    method: "PUT",
    body: { path: "hello.txt", content: "overwritten", sha: null },
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "read_only");
});

test("reads still work: GET /api/terms answers 200 (empty) in readOnly", async () => {
  const r = await api("/api/terms");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.terms || j, []);
  const stat = await api(`/api/file?p=${encodeURIComponent(rootDir + "/hello.txt")}`);
  assert.equal(stat.status, 200, "reads are untouched by readOnly");
});
