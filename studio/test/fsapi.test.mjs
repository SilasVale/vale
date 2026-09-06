// lib/fsapi.mjs direct unit tests — the two previously untestable seams
// (structure refactor round): the searchJs RIPGREP-LESS fallback engine
// (boxes with rg always took the ripgrep path, so the fallback had zero
// coverage) and the trash quota eviction policy (oldest-first, files + bytes
// caps). Limits are injectable so the caps are exercisable without 200
// files or a 512 MB payload.
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { searchJs, enforceTrashQuota, TRASH_MAX_FILES, TRASH_MAX_BYTES } from "../lib/fsapi.mjs";

async function workspace(files) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "vale-fsapi-"));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(root, name);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
  }
  return root;
}

test("searchJs fallback: literal match with path/line/text shape", async () => {
  const root = await workspace({
    "a.js": "const alpha = 1;\nconst beta = 2;\n",
    "sub/b.txt": "alpha here too\n",
  });
  const r = await searchJs({ root, q: "alpha" });
  assert.equal(r.engine, "js");
  assert.equal(r.matches.length, 2);
  assert.equal(r.matches[0].line, 1);
  assert.match(r.matches[0].text, /const alpha = 1;/);
  assert.equal(r.truncated, false);
});

test("searchJs fallback: regex mode, invalid regex 400, oversize files skipped", async () => {
  const root = await workspace({
    "code.js": "foo(123)\nbar\n",
    "big.log": "foo(999)\n" + "x".repeat(3 * 1024 * 1024), // > the 2MB per-file skip
  });
  const re = await searchJs({ root, q: "foo\\(\\d+\\)", regex: true });
  assert.equal(re.matches.length, 1, "the >2MB file must be skipped");
  await assert.rejects(
    searchJs({ root, q: "([unclosed", regex: true }),
    (e) => e?.type === "bad_regex" || e?.message === "invalid regular expression",
  );
});

test("trash quota: oldest-first eviction under the files cap", async () => {
  const trash = await fsp.mkdtemp(path.join(os.tmpdir(), "vale-trash-"));
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const p = path.join(trash, `t${i}`);
    await fsp.writeFile(p, String(i));
    await fsp.utimes(p, new Date(now - (10 - i) * 1000), new Date(now - (10 - i) * 1000));
  }
  await enforceTrashQuota(trash, { maxFiles: 4, maxBytes: TRASH_MAX_BYTES });
  const left = (await fsp.readdir(trash)).sort();
  // 6 files, cap 4 → the two OLDEST (t0, t1) are evicted.
  assert.deepEqual(left, ["t2", "t3", "t4", "t5"]);
  await fsp.rm(trash, { recursive: true, force: true });
});

test("trash quota: bytes cap evicts until under budget; under-quota is a no-op", async () => {
  const trash = await fsp.mkdtemp(path.join(os.tmpdir(), "vale-trash-"));
  const now = Date.now();
  // Two files, 1000 bytes each (staggered mtimes), cap 1500 bytes → the
  // oldest is evicted, total drops to 1000 ≤ 1500, the second survives.
  await fsp.writeFile(path.join(trash, "old"), "o".repeat(1000));
  await fsp.utimes(path.join(trash, "old"), new Date(now - 5000), new Date(now - 5000));
  await fsp.writeFile(path.join(trash, "new"), "n".repeat(1000));
  await enforceTrashQuota(trash, { maxFiles: TRASH_MAX_FILES, maxBytes: 1500 });
  assert.deepEqual((await fsp.readdir(trash)).sort(), ["new"], "oldest evicted to satisfy the bytes cap");

  const quiet = await fsp.mkdtemp(path.join(os.tmpdir(), "vale-trash2-"));
  await fsp.writeFile(path.join(quiet, "small"), "tiny");
  await enforceTrashQuota(quiet, { maxFiles: 200, maxBytes: TRASH_MAX_BYTES });
  assert.equal((await fsp.readdir(quiet)).length, 1, "under quota → untouched");
  await fsp.rm(quiet, { recursive: true, force: true });
});

test("exported quota constants keep their production values", () => {
  assert.equal(TRASH_MAX_FILES, 200);
  assert.equal(TRASH_MAX_BYTES, 512 * 1024 * 1024);
});
