// Terminal lifecycle contract tests (CI-safe): the script(1) PTY fallback
// needs no node-pty build, so the full HTTP surface — create / list /
// confinement / cap / delete — is exercisable in CI against a real server.
// The WS data path stays live-only (see README test tiering).
import test from "node:test";
import assert from "node:assert/strict";
import { startStudio, stopStudio } from "./helpers.mjs";

const PORT = 7801;
const TOKEN = "test-token-abcdef";
let child, api, rootDir;

test.before(async () => {
  ({ child, api, rootDir } = await startStudio({
    port: PORT,
    token: TOKEN,
    files: { "hello.txt": "hello\n" },
  }));
});

test.after(() => stopStudio(child));

test("POST /api/term creates a session inside roots and lists it", async () => {
  const r = await api("/api/term", { method: "POST", body: { cwd: rootDir, cols: 100, rows: 30 } });
  assert.equal(r.status, 200);
  const { id, backend } = await r.json();
  assert.ok(id, "session id returned");
  assert.ok(["script", "node-pty"].includes(backend), `backend=${backend}`);

  const list = await (await api("/api/terms")).json();
  const entry = (list.terms || list).find?.((t) => t.id === id) ??
    (Array.isArray(list) ? list : []).find((t) => t.id === id);
  assert.ok(entry, "created session appears in GET /api/terms");
  assert.equal(entry.exited, false);

  // Cleanup: explicit close resolves 200; the entry STAYS listed with
  // exited: true until the 60s post-exit reap (createTerminalSession's
  // onExit contract — the list is the history view, not a live-only view).
  const del = await api(`/api/term/${id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const exited = async () => {
    const j = await (await api("/api/terms")).json();
    const arr = Array.isArray(j) ? j : j.terms || [];
    return arr.find((t) => t.id === id)?.exited === true;
  };
  const deadline = Date.now() + 8000;
  while (!(await exited()) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(await exited(), "deleted session flips to exited:true");
});

test("DELETE /api/term for an unknown id is a clean 404", async () => {
  const r = await api("/api/term/nope", { method: "DELETE" });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "not_found");
});

test("terminal cwd is confined to roots (outside cwd 403s)", async () => {
  const r = await api("/api/term", { method: "POST", body: { cwd: "/etc" } });
  assert.equal(r.status, 403);
});

test("terminal session cap: 429 too_many_terminals at the cap, deletes report exited", async () => {
  const { MAX_TERMINALS } = await import("../lib/terminals.mjs");
  // The cap counts hub entries incl. the 60s post-exit reap window, so the
  // deterministic shape is "create until the first 429" — robust against any
  // sessions left alive by earlier tests on the same server instance.
  const pre = await (await api("/api/terms")).json();
  // Every LISTED entry occupies a hub slot — reap is 60s after exit, so a
  // deleted-but-not-yet-reaped session from an earlier test still counts.
  const preCount = (Array.isArray(pre) ? pre : pre.terms || []).length;
  const ids = [];
  let capped = null;
  for (let i = 0; i < MAX_TERMINALS + 1 && !capped; i++) {
    const r = await api("/api/term", { method: "POST", body: { cwd: rootDir, cols: 20, rows: 5 } });
    if (r.status === 429) {
      capped = r;
    } else {
      assert.equal(r.status, 200, `session ${i + 1}`);
      ids.push((await r.json()).id);
    }
  }
  assert.ok(capped, "the cap eventually answers 429");
  assert.equal((await capped.json()).error, "too_many_terminals");
  // The cap counts hub entries incl. deleted-but-not-yet-reaped ones, so the
  // invariant is: pre-existing listed + created === MAX_TERMINALS.
  assert.equal(preCount + ids.length, MAX_TERMINALS, "exactly MAX_TERMINALS sessions fit");
  for (const id of ids) await api(`/api/term/${id}`, { method: "DELETE" });
  const j = await (await api("/api/terms")).json();
  const arr = Array.isArray(j) ? j : j.terms || [];
  const alive = arr.filter((t) => ids.includes(t.id) && !t.exited);
  assert.equal(alive.length, 0, "every deleted session reports exited");
});
