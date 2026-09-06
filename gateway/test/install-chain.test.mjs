// Install-chain contract tests — the REAL user path was never exercised:
// unit tests spawned public/vale directly, but users run the installer
// script (`curl ... | sh`) which base64-decodes the CLI and drops it on
// disk. Pins the whole chain end to end:
//   GET /api/vale-cli  → the repo artifact, byte for byte (drift gate)
//   sh installer       → binary installed executable at $VALE_BIN
//   node installed     → the decoded copy actually runs
//   no node on PATH    → clean failure with the Node.js-required guard
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import worker from "../src/index.ts";
import { encodeBase64Utf8, posixInstaller, psInstaller } from "../src/index.ts";
import { makeEnv as makeBaseEnv } from "./helpers.mjs";
import { __clearCaches } from "../src/store.ts";

// The real shipped CLI artifact — what the ASSETS binding serves in prod.
const REAL_CLI = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "vale"), "utf8");

/** Worker env whose ASSETS serves the REAL public/vale (plus /api/health). */
function env() {
  __clearCaches();
  const base = makeBaseEnv({});
  return {
    ...base,
    ASSETS: {
      async fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/vale") {
          return new Response(REAL_CLI, { status: 200, headers: { "content-type": "text/plain" } });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

test("GET /api/vale-cli serves the repo artifact byte-for-byte (payload drift gate)", async () => {
  const r = await worker.fetch(new Request("https://x/api/vale-cli"), env());
  assert.equal(r.status, 200);
  assert.equal(await r.text(), REAL_CLI, "served payload must equal public/vale on disk");
});

test("posix installer executes and installs a working, byte-identical CLI", async () => {
  const cli = await (
    await worker.fetch(new Request("https://x/api/vale-cli"), env())
  ).text();
  const installer = path.join(
    await fsp.mkdtemp(path.join(os.tmpdir(), "vale-inst-")),
    "install.sh",
  );
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), "vale-bin-"));
  await fsp.writeFile(installer, posixInstaller(encodeBase64Utf8(cli)));
  // The script honours VALE_BIN for the destination (no $HOME writes).
  execFileSync("/bin/sh", [installer], {
    env: { ...process.env, VALE_BIN: dest },
    stdio: "pipe",
  });
  const installed = path.join(dest, "vale");
  const stat = fs.statSync(installed);
  assert.equal(stat.mode & 0o111, 0o111, "installed binary must be executable");
  assert.equal(fs.readFileSync(installed, "utf8"), cli, "decoded payload is byte-identical");
  // The decoded copy RUNS: a check against a refused gateway exits non-zero
  // with the health error (proves execution, not just presence on disk).
  // Isolate from the ambient ~/.claude/settings.json: vale check reads
  // settings FIRST (VALE_SETTINGS, else ~/.claude/settings.json) and exits
  // before the health probe when the file is missing — on machines without
  // that file (CI runners) this assertion saw the settings error instead
  // of the health error. A temp VALE_SETTINGS makes it deterministic.
  const settings = path.join(dest, "settings.json");
  await fsp.writeFile(settings, JSON.stringify({ env: {} }));
  let code = 0;
  let out = "";
  try {
    execFileSync(process.execPath, [installed, "check"], {
      env: {
        ...process.env,
        VALE_GATEWAY: "http://127.0.0.1:1",
        VALE_SETTINGS: settings,
      },
      stdio: "pipe",
    });
  } catch (e) {
    code = e.status;
    out = String(e.stdout || "") + String(e.stderr || "");
  }
  assert.notEqual(code, 0, "check against a dead gateway must exit non-zero");
  assert.match(out, /无法获取渠道健康/);
  await fsp.rm(dest, { recursive: true, force: true });
});

test("install script fails cleanly without node on PATH", async () => {
  const cli = REAL_CLI;
  const installer = path.join(
    await fsp.mkdtemp(path.join(os.tmpdir(), "vale-inst-")),
    "install.sh",
  );
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), "vale-bin-"));
  await fsp.writeFile(installer, posixInstaller(encodeBase64Utf8(cli)));
  // Absolute /bin/sh so the spawn itself works; the script's own
  // `command -v node` sees the stripped PATH and must exit 1.
  let code = 0;
  let out = "";
  try {
    execFileSync("/bin/sh", [installer], {
      env: { ...process.env, PATH: "/nonexistent", VALE_BIN: dest },
      stdio: "pipe",
    });
  } catch (e) {
    code = e.status;
    out = String(e.stdout || "") + String(e.stderr || "");
  }
  assert.notEqual(code, 0);
  assert.match(out, /Node\.js required/);
  assert.equal(fs.existsSync(path.join(dest, "vale")), false, "no binary without node");
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.rm(path.dirname(installer), { recursive: true, force: true });
});

test("PowerShell installer embeds the same payload (structure check — Windows-only runtime)", async () => {
  const cli = await (
    await worker.fetch(new Request("https://x/api/vale-cli"), env())
  ).text();
  const ps = psInstaller(encodeBase64Utf8(cli));
  assert.match(ps, /vale\.cmd/, "the .cmd wrapper is part of the contract");
  assert.match(ps, /FromBase64String\(/, "decodes the embedded payload");
  void spawn; // node:child_process import kept for symmetry with the exec tests
});
