// helpers.mjs — the shared test foundation (structure refactor: extracted
// from api.test.mjs so the terminal/readOnly contract files spawn servers
// the same way). Black-box: spawn the real server.mjs against a temp
// workspace with a written config; every test file gets an isolated
// instance (own port/roots) so parallel node --test processes never share
// state.
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SERVER_PATH = path.join(import.meta.dirname, "..", "server.mjs");

/**
 * Write a studio config + spawn the server. Returns everything a test needs:
 *   { child, BASE, api(p, opts), cfgPath, rootDir, log() }
 * opts: { port, token, readOnly, roots?, files?: Record<name, content>,
 *         extraCfg?: object }
 * The caller MUST call stop(child) in test.after.
 */
export async function startStudio({
  port,
  token = "test-token-abcdef",
  readOnly = false,
  files = { "hello.txt": "hello world\n" },
  extraCfg = {},
} = {}) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vale-studio-test-"));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(rootDir, name);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
  }
  const cfgPath = path.join(rootDir, "..", `studio-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const cfg = {
    port,
    bind: "127.0.0.1",
    token,
    readOnly,
    corsOrigins: ["https://dsh.saisi.online"],
    terminal: { enabled: true },
    maxFileSizeMB: 8,
    roots: [rootDir],
    ...extraCfg,
  };
  await fsp.writeFile(cfgPath, JSON.stringify(cfg));
  const child = spawn(process.execPath, [SERVER_PATH, "--config", cfgPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child._log = () => log;

  const BASE = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/boot`, { headers: { authorization: `Bearer ${token}` } });
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
  }

  const api = (p, { method = "GET", body, token: tok = token } = {}) => {
    const headers = {};
    if (tok) headers.authorization = `Bearer ${tok}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(BASE + p, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };
  return { child, BASE, api, cfgPath, rootDir, log: () => log };
}

export function stopStudio(child) {
  if (child) {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1000);
  }
}
