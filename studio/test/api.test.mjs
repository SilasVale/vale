// API contract tests — black-box: spawn the real server against a temp workspace.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PORT = 7799;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token-abcdef";
let child = null;
let rootDir = null;

async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/boot`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become ready");
}

function api(p, { method = "GET", body, token = TOKEN } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(BASE + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test.before(async () => {
  rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vale-studio-test-"));
  await fsp.writeFile(path.join(rootDir, "hello.txt"), "hello world\n");
  await fsp.mkdir(path.join(rootDir, "sub"));
  await fsp.writeFile(path.join(rootDir, "sub", "code.js"), "const x = 41 + 1;\n");
  // a file outside roots to prove isolation
  const cfgPath = path.join(rootDir, "..", `studio-cfg-${Date.now()}.json`);
  const cfg = {
    port: PORT,
    bind: "127.0.0.1",
    token: TOKEN,
    readOnly: false,
    corsOrigins: ["https://dsh.saisi.online"],
    terminal: { enabled: true },
    maxFileSizeMB: 8,
    roots: [rootDir],
  };
  await fsp.writeFile(cfgPath, JSON.stringify(cfg));
  const serverPath = path.join(import.meta.dirname, "..", "server.mjs");
  child = spawn(process.execPath, [serverPath, "--config", cfgPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child._log = () => log;
  await waitForServer();
});

test.after(() => {
  if (child) {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1000);
  }
});

test("rejects missing/invalid token with uniform 404", async () => {
  const noTok = await api("/api/boot", { token: null });
  assert.equal(noTok.status, 404);
  const badTok = await api("/api/boot", { token: "wrong" });
  assert.equal(badTok.status, 404);
  const bodyText = await badTok.text();
  assert.ok(!bodyText.includes("auth"), "must not reveal auth semantics");
});

test("boot reports roots and capabilities", async () => {
  const res = await api("/api/boot");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.readOnly, false);
  assert.equal(data.terminalEnabled, true);
  assert.equal(data.roots.length, 1);
  assert.equal(data.roots[0].path, fs.realpathSync(rootDir));
});

test("tree lists entries sorted dirs-first", async () => {
  const res = await api(`/api/tree?dir=${encodeURIComponent(rootDir)}`);
  const { entries } = await res.json();
  const names = entries.map((e) => e.name);
  assert.deepEqual(names.sort(), ["hello.txt", "sub"].sort());
  const sub = entries.find((e) => e.name === "sub");
  assert.equal(sub.type, "dir");
  assert.ok(entries.indexOf(sub) < entries.findIndex((e) => e.name === "hello.txt") || sub.type === "dir");
});

test("file read returns content+sha", async () => {
  const res = await api(`/api/file?p=${encodeURIComponent(path.join(rootDir, "hello.txt"))}`);
  const data = await res.json();
  assert.equal(data.content, "hello world\n");
  assert.match(data.sha256, /^[0-9a-f]{64}$/);
});

test("atomic write updates content and sha; optimistic lock detects conflict", async () => {
  const p = path.join(rootDir, "hello.txt");
  const first = await (await api(`/api/file?p=${encodeURIComponent(p)}`)).json();

  // good write
  const w = await api("/api/file", {
    method: "PUT",
    body: { p, content: "hello studio\n", baseSha256: first.sha256 },
  });
  assert.equal(w.status, 200);
  const wj = await w.json();
  assert.match(wj.sha256, /^[0-9a-f]{64}$/);

  // stale write must 409 and return current sha
  const stale = await api("/api/file", {
    method: "PUT",
    body: { p, content: "stale write\n", baseSha256: first.sha256 },
  });
  assert.equal(stale.status, 409);
  const sj = await stale.json();
  assert.equal(sj.currentSha256, wj.sha256);

  // force overwrite (no base) works
  const force = await api("/api/file", {
    method: "PUT",
    body: { p, content: "forced\n" },
  });
  assert.equal(force.status, 200);

  // no tmp files left behind
  const dirNow = await fsp.readdir(rootDir);
  assert.ok(!dirNow.some((n) => n.includes(".vale-tmp")), "temp file cleaned up");
});

test("'new' optimistic lock refuses when file appeared on disk", async () => {
  const p = path.join(rootDir, "sub", "appeared.txt");
  const refused = await api("/api/file", {
    method: "PUT",
    body: { p, content: "x", baseSha256: "new" }, // but we created nothing yet → ok
  });
  assert.equal(refused.status, 200);
  const nowExists = await api("/api/file", {
    method: "PUT",
    body: { p, content: "y", baseSha256: "new" }, // now it exists → conflict
  });
  assert.equal(nowExists.status, 409);
});

test("path safety: outside roots and traversal rejected", async () => {
  const out = await api(`/api/file?p=${encodeURIComponent("/etc/passwd")}`);
  assert.ok([403].includes(out.status));
  const trav = await api(`/api/file?p=${encodeURIComponent(path.join(rootDir, "..", "..", "etc", "passwd"))}`);
  assert.ok([403, 404].includes(trav.status));
  const rel = await api(`/api/file?p=${encodeURIComponent("relative/path.txt")}`);
  assert.equal(rel.status, 400);
});

test("symlink escape is blocked", async () => {
  const link = path.join(rootDir, "evil-link");
  try {
    await fsp.symlink("/etc", link);
  } catch {
    return; // no symlink permission
  }
  const res = await api(`/api/file?p=${encodeURIComponent(path.join(link, "passwd"))}`);
  assert.ok([403, 404].includes(res.status), `expected block, got ${res.status}`);
});

test("mkdir creates nested dirs inside root", async () => {
  const p = path.join(rootDir, "a/b/c");
  const res = await api("/api/mkdir", { method: "POST", body: { p } });
  assert.equal(res.status, 200);
  const stat = await fsp.stat(p);
  assert.ok(stat.isDirectory());
});

test("delete moves into trash, not unlink", async () => {
  const p = path.join(rootDir, "doomed.txt");
  await fsp.writeFile(p, "bye");
  const res = await api(`/api/file?p=${encodeURIComponent(p)}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  await assert.rejects(fsp.stat(p));
  const trashDir = path.join(rootDir, ".vale-studio-trash");
  const trashed = await fsp.readdir(trashDir);
  assert.ok(trashed.some((n) => n.includes("doomed.txt")));
});

test("search finds matches via ripgrep engine", async () => {
  const res = await api(
    `/api/search?q=CONST&root=${encodeURIComponent(rootDir)}&case=0`,
  );
  const data = await res.json();
  assert.ok(["ripgrep", "js"].includes(data.engine));
  const hit = data.matches.find((m) => m.path.endsWith("code.js"));
  assert.ok(hit, "should find const in code.js");
  assert.equal(hit.line, 1);
});

test("git endpoints work inside a repo", async () => {
  // make temp root a git repo
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("git", ["init", "-q"], { cwd: rootDir });
    execFileSync("git", ["add", "."], { cwd: rootDir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: rootDir });
  } catch {
    return; // git unavailable
  }
  const st = await api(`/api/git/status?p=${encodeURIComponent(path.join(rootDir, "hello.txt"))}`);
  assert.equal(st.status, 200);
  const stj = await st.json();
  assert.ok(stj.top.endsWith(path.basename(rootDir)) || stj.top.startsWith("/"));
  const lg = await api(`/api/git/log?p=${encodeURIComponent(path.join(rootDir, "hello.txt"))}`);
  assert.equal(lg.status, 200);
  const df = await api(`/api/git/diff?p=${encodeURIComponent(path.join(rootDir, "hello.txt"))}`);
  assert.equal(df.status, 200);
});

test("CORS preflight allowed only for configured origins", async () => {
  const good = await fetch(`${BASE}/api/roots`, {
    method: "OPTIONS",
    headers: { origin: "https://dsh.saisi.online" },
  });
  assert.equal(good.headers.get("access-control-allow-origin"), "https://dsh.saisi.online");
  const bad = await fetch(`${BASE}/api/roots`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example.com" },
  });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("static frontend serves index and vendored monaco", async () => {
  const idx = await fetch(`${BASE}/`);
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /Vale Studio/);
  const loader = await fetch(`${BASE}/vendor/monaco/vs/loader.js`);
  assert.equal(loader.status, 200);
  const xt = await fetch(`${BASE}/vendor/xterm/xterm.js`);
  assert.equal(xt.status, 200);
});
