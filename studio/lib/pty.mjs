// PTY abstraction: node-pty primary, util-linux script(1) fallback.
// Both faces expose: write(data), resize(cols, rows), kill(), onData(cb), onExit(cb).

import { spawn } from "node:child_process";
import os from "node:os";

let nodePty = null;
let nodePtyTried = false;

async function loadNodePty() {
  if (nodePtyTried) return nodePty;
  nodePtyTried = true;
  try {
    nodePty = await import("node-pty");
    return nodePty;
  } catch (e) {
    console.warn("[studio] node-pty unavailable, falling back to script(1):", e.message);
    return null;
  }
}

/**
 * Create a terminal session.
 * Returns { id?, write, resize, kill, onData, onExit, backend }.
 */
export async function createPty({ shell = "/bin/bash", args = [], cwd, cols = 80, rows = 24, env = {} }) {
  const pty = await loadNodePty();
  const fullEnv = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "C.UTF-8",
    ...env,
  };
  if (pty) return nodePtySession({ pty, shell, args, cwd, cols, rows, env: fullEnv });
  return scriptSession({ shell, args, cwd, cols, rows, env: fullEnv });
}

function nodePtySession({ pty, shell, args, cwd, cols, rows, env }) {
  const term = pty.spawn(shell, args, { name: "xterm-256color", cwd, env, cols, rows });
  return {
    backend: "node-pty",
    pid: term.pid,
    write: (d) => term.write(d),
    resize: (c, r) => {
      try {
        term.resize(Math.max(2, c | 0), Math.max(2, r | 0));
      } catch {
        /* already dead */
      }
    },
    kill: () => {
      try {
        term.kill();
      } catch {}
    },
    onData: (cb) => term.onData(cb),
    onExit: (cb) => term.onExit(({ exitCode }) => cb(exitCode)),
  };
}

// script(1) fallback: allocates a pty for us; window size is fixed at spawn
// time — resize() compensates via stty inside the session.
function scriptSession({ shell, args, cwd, cols, rows, env }) {
  const child = spawn("script", ["-qfc", [shell, ...args].join(" "), "/dev/null"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let resizePrefix = `stty rows ${rows} cols ${cols}\n`;
  return {
    backend: "script",
    pid: child.pid,
    write: (d) => {
      if (resizePrefix) {
        child.stdin.write(resizePrefix);
        resizePrefix = null;
      }
      child.stdin.write(d);
    },
    resize: (c, r) => {
      if (!resizePrefix) resizePrefix = "";
      child.stdin.write(`stty rows ${Math.max(2, r | 0)} cols ${Math.max(2, c | 0)}\n`);
    },
    kill: () => {
      try {
        process.kill(child.pid, "SIGHUP");
      } catch {}
    },
    onData: (cb) => child.stdout.on("data", (d) => cb(d.toString())),
    onExit: (cb) =>
      child.on("close", (code) => cb(code ?? 0)),
  };
}

export function defaultShell() {
  return process.env.SHELL || "/bin/bash";
}

export function homeDir() {
  return os.homedir();
}
