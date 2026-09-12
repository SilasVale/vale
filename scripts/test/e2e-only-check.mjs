// `--only` MUST NOT BE ABLE TO SELECT NOTHING AND REPORT SUCCESS.
//
// The e2e suite is a CI gate: the workflow runs
//     node scripts/e2e/e2e.js --token "$TOKEN" --base http://127.0.0.1:18811 \
//         --only governance,runs
// and it used to end with `process.exit(failed.length ? 1 : 0)`. A filter naming
// a section that does not exist made `want()` false for everything, so NOTHING
// ran, `failed` was empty, and the suite printed "== 0/0 passed ==" and exited 0.
// Measured before the guard existed:
//     --only governance-typo,nonexistent  ->  == 0/0 passed ==   exit 0
//
// One renamed section — or one typo in the CI step — and the gate would have gone
// on reporting success while testing nothing at all. This is the same disease as
// round 33's "a check that reads nothing must not report success", round 46's
// unmocked request read as an empty page, and round 47's audit skip that exited 0.
//
// The convention, shared with panel-render-audit.mjs:
//     0  the suite RAN and everything passed
//     1  the suite RAN and something failed
//     2  the suite DID NOT RUN
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUITE = path.join(ROOT, "agent", "scripts", "e2e", "e2e.js");
// A closed port: the suite RUNS and fails to connect, which is exactly what makes
// the "it really ran" assertion below meaningful.
const DEAD = "http://127.0.0.1:9";

function run(args) {
  return spawnSync(process.execPath, [SUITE, "--token", "dummy", "--base", DEAD, ...args], {
    encoding: "utf8",
    timeout: 120000,
  });
}

test("an --only section that does not exist exits 2, not 0", () => {
  const r = run(["--only", "governance-typo,nonexistent"]);
  const out = (r.stdout || "") + (r.stderr || "");
  assert.notEqual(r.status, 0, `a filter matching nothing exited 0 — it reported success having run nothing. ${out.slice(0, 200)}`);
  assert.equal(r.status, 2, `expected 2 (DID NOT RUN); got ${r.status}. ${out.slice(0, 200)}`);
  assert.match(out, /unknown --only section/i, "it must name the problem");
  assert.match(out, /known sections:/i, "and list what IS valid, so the fix is obvious");
});

test("an empty --only exits 2", () => {
  const r = run(["--only", ""]);
  assert.equal(r.status, 2, `expected 2; got ${r.status}`);
});

test("a VALID --only actually RUNS — it is not silently empty", () => {
  // The other half of the pin: proving the guard did not simply make everything
  // exit 2. Against a closed port the suite must RUN and FAIL (1), and it must
  // report a non-zero check count — "0/0 passed" is the defect being pinned.
  const r = run(["--only", "governance,runs"]);
  const out = (r.stdout || "") + (r.stderr || "");
  assert.equal(r.status, 1, `expected 1 (RAN and failed to reach the agent); got ${r.status}. ${out.slice(0, 200)}`);
  assert.doesNotMatch(out, /0\/0 passed/, "a filtered run must never report zero checks");
  assert.match(out, /0\/[1-9]/, "at least one check must have executed");
});

test("the section list is declared once and used for validation", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(SUITE, "utf8");
  assert.match(src, /const SECTIONS = \[/, "the valid names must be declared, not implied by want() calls");
  assert.match(src, /did not run|DID NOT RUN/i, "the zero-check guard must say what happened");
});

test("SECTIONS and the want() call sites are the SAME SET, both directions", async () => {
  // The drift that creates a ghost: add a name to SECTIONS and forget the
  // dispatch, and `--only <that name>` passes validation, runs nothing, and is
  // caught only by the zero-check guard — which is a backstop, not a diagnosis.
  // The other direction is worse: a `want('x')` whose name is NOT in SECTIONS can
  // never be selected, so that section is dead and nothing says so.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(SUITE, "utf8");
  const declared = new Set(
    (src.match(/const SECTIONS = \[([^\]]*)\]/)?.[1] || "")
      .split(",")
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean),
  );
  const dispatched = new Set([...src.matchAll(/want\('([a-z]+)'\)/g)].map((m) => m[1]));
  assert.ok(declared.size >= 5, `only ${declared.size} sections declared — the parser read the wrong thing`);
  assert.ok(dispatched.size >= 5, `only ${dispatched.size} want() call sites — the parser read the wrong thing`);

  const declaredButNeverRun = [...declared].filter((x) => !dispatched.has(x));
  const runnableButNotDeclared = [...dispatched].filter((x) => !declared.has(x));
  assert.deepEqual(declaredButNeverRun, [], "declared in SECTIONS but no want() dispatches it — `--only` on it runs nothing");
  assert.deepEqual(runnableButNotDeclared, [], "want() dispatches it but it is not in SECTIONS — it can never be selected");
});
