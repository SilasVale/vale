// A SKIP MUST NOT LOOK LIKE A PASS.
//
// `panel-render-audit.mjs` needs a Playwright runtime (`VALE_BROWSER_HELPER`). Where
// there is none it still emits its harness — deliberately, because a check that can
// only run in one environment quietly stops running — but it used to exit 0, and its
// own message admitted the consequence: "a caller watching only the exit code reads
// this skip as a pass".
//
// That is the same defect this repo fixed twice already: round 33's "a check that
// reads nothing must not report success", and round 46's harness that could not tell
// an unmocked request from an empty page. Here the only channel a caller is
// guaranteed to read is the exit code, so the convention is pinned:
//
//   0  the audit RAN and found nothing
//   1  the audit RAN and found failures
//   2  the audit DID NOT RUN
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "agent", "scripts", "panel-render-audit.mjs");

function run(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60000,
  });
}

test("with no Playwright runtime the audit exits 2, not 0", () => {
  const env = { ...process.env };
  delete env.VALE_BROWSER_HELPER;
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env, timeout: 60000 });
  assert.equal(
    r.status,
    2,
    `expected exit 2 (DID NOT RUN); got ${r.status}. A skip that exits 0 is read as a pass ` +
      `by anything watching only the exit code. stdout: ${r.stdout?.slice(0, 200)}`,
  );
});

test("the skip SAYS it did not run, in words", () => {
  const env = { ...process.env };
  delete env.VALE_BROWSER_HELPER;
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env, timeout: 60000 });
  const out = (r.stdout || "") + (r.stderr || "");
  assert.match(out, /DID NOT RUN/i, "the skip must say so in words, not only in the exit code");
  assert.match(out, /SKIP, not a pass/i, "and must name the distinction explicitly");
});

test("the three exit codes are distinct and documented in the script", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(SCRIPT, "utf8");
  // The convention has to be WRITTEN WHERE THE CODES ARE SET, or the next person to
  // add an exit path has nothing to follow.
  assert.match(src, /2\s+the audit DID NOT RUN|audit DID NOT RUN/, "exit 2 is not documented");
  assert.match(src, /exit\(2\)/, "nothing actually exits 2");
  void run;
});
