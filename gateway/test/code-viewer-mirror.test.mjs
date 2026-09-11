// ── the Source Viewer must serve what the worker RUNS ───────────────────────
//
// `gateway/public/code/files/vale-gate/` is a TRACKED mirror of `gateway/src`,
// served as worker assets (`wrangler.jsonc`: assets.directory "./public") at
// https://api.saisi.online/code/files/vale-gate/src/… . It is refreshed ONLY by
// `scripts/build.sh` at deploy time (through `scripts/sync-code-viewer.sh`).
//
// Nothing compared the two. Observed 2026-09-12: the mirror was **13 commits
// behind** and 10 files differed, so the console was serving a `terminal_read`
// description containing the sentence round 21 DISPROVED on the device ("`offset:
// 0` re-reads from the beginning") — and serving it verbatim to anyone who read
// the source viewer. Round 24 fixed `src/` and its test asserted the fix, which
// is why the round-24 claim "the console stops serving a disproven claim" was
// FALSE for the copy the console actually serves.
//
// The test's premise was wrong in a way worth naming: it asserted a property of
// `src/` while the claim was about the CONSOLE. A test on the source cannot see a
// stale copy of the source.
//
// This is the direct-`wrangler deploy` hazard too: that path refreshes the worker
// but NOT the mirror, and nothing in the repo could tell those two states apart.
// Byte equality on the committed artifact is what makes them distinguishable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const MIRROR = join(ROOT, "public", "code", "files", "vale-gate", "src");

/** Every file under `dir`, relative to it, sorted. */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

/** The redactions the sync script applies, READ FROM THE SCRIPT.
 *
 *  The mirror is deliberately NOT byte-identical: three files have the
 *  production host replaced before being published. So the invariant is "the
 *  mirror is what the current src would produce", and the rules for producing it
 *  live in exactly ONE place — the script. Parsing them here rather than
 *  restating them means a rule that changes cannot silently leave this test
 *  checking the wrong thing; it fails, and the message says where to look. */
function redactionsFromSyncScript() {
  const script = readFileSync(join(ROOT, "scripts", "sync-code-viewer.sh"), "utf8");
  const rules = [];
  for (const line of script.split("\n")) {
    // redact "src/auth.ts" '<ere>' '<sed-expr>' <n>
    const m = /^redact\s+"([^"]+)"\s+'[^']*'\s+'([^']+)'\s+(\d+)\s*$/.exec(line.trim());
    if (!m) continue;
    // The sed expression is always s<delim>from<delim>to<delim>g — delimiters
    // vary (/ and | today) so read the delimiter from the expression itself.
    const sm = /^s(.)(.*?)\1(.*?)\1g$/.exec(m[2]);
    assert.ok(sm, `cannot parse the redaction in sync-code-viewer.sh: ${m[2]}`);
    rules.push({
      file: m[1].replace(/^src\//, ""),
      from: new RegExp(sm[2], "g"),
      to: sm[3],
      expect: Number(m[3]),
    });
  }
  assert.ok(rules.length > 0, "no redaction rules parsed — did sync-code-viewer.sh change shape?");
  return rules;
}

/** `src/<rel>` exactly as the sync script would publish it. */
function published(rel, rules) {
  let text = readFileSync(join(SRC, rel), "utf8");
  for (const r of rules) if (r.file === rel) text = text.replace(r.from, r.to);
  return text;
}

test("code viewer: the tracked mirror matches what src/ would publish", () => {
  const rules = redactionsFromSyncScript();
  const srcFiles = walk(SRC);
  const mirrorFiles = walk(MIRROR);

  const missing = srcFiles.filter((f) => !mirrorFiles.includes(f));
  const extra = mirrorFiles.filter((f) => !srcFiles.includes(f));
  const differing = srcFiles
    .filter((f) => mirrorFiles.includes(f))
    .filter((f) => published(f, rules) !== readFileSync(join(MIRROR, f), "utf8"));

  assert.deepEqual(
    { missing, extra, differing },
    { missing: [], extra: [], differing: [] },
    "gateway/public/code/files/vale-gate/src is out of date, so the Source Viewer " +
      "serves code the worker does not run — including descriptions that may state " +
      "facts the device has since disproved. Re-sync with " +
      "`bash gateway/scripts/sync-code-viewer.sh` and commit the mirror. " +
      `missing=${missing.join(",")} extra=${extra.join(",")} differing=${differing.join(",")}`,
  );
});
