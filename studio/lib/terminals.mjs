// vale-studio · terminal session registry: PTY creation, ring replay buffer,
// viewer broadcast, and the 60s post-exit reap. Shared by POST /api/term and
// the tmux adoption path, which used to duplicate the createPty + terminal
// object + onData/onExit wiring verbatim.

import crypto from "node:crypto";
import { createPty } from "./pty.mjs";
import { safeResolve } from "./fsapi.mjs";

const RING_MAX = 64 * 1024;
// Cap live sessions: each spawns a real shell process and ids carry only
// 24-bit entropy, so unbounded creation is a fork bomb via one API call.
// 16 is generous for a single-owner studio (typical use: a handful of
// shells). Shared-token architecture is by design (loopback + tunnel +
// bearer — any token holder IS the owner), so per-user ACLs are out of scope.
export const MAX_TERMINALS = 16;

function ringBuffer(capacity) {
  let buf = Buffer.alloc(0);
  return {
    write(d) {
      buf = buf.length + d.length <= capacity ? Buffer.concat([buf, d]) : Buffer.concat([buf.subarray(Math.max(0, buf.length - capacity + d.length)), d]);
    },
    toString() {
      return buf;
    },
  };
}

function termBroadcast(t, data) {
  t.ring.write(data);
  for (const ws of t.viewers) {
    if (ws.readyState === 1) ws.send(data, { binary: true });
  }
}

export function createTerminalHub() {
  const terminals = new Map(); // id -> {id,name,cwd,backend,ring,viewers:Set,session,exitCode}
  let termSeq = 0;

  /**
   * Create and register a terminal session: PTY + ring buffer + viewer
   * broadcast + 60s post-exit reap. Tmux wrapping:
   *   - `tmuxName` (adopt path): re-attach to an EXISTING vs-* session by
   *     its exact name (the tmux server kept it alive across a restart);
   *   - `tmuxWrap` (POST path): attach-or-create a fresh `vs-${id}` session.
   * `exitNotice` mirrors POST /api/term's exit banner into the ring;
   * adoption stays silent (as it always did).
   * Returns { id, backend, name }.
   */
  async function createTerminalSession({
    cwd,
    shell,
    tmuxName = null,
    tmuxWrap = false,
    cols = 80,
    rows = 24,
    env = {},
    displayName,
    exitNotice = false,
  }) {
    const id = `t${++termSeq}-${crypto.randomBytes(3).toString("hex")}`;
    let ptyShell = shell;
    let ptyArgs = [];
    let tmuxSession = tmuxName;
    if (tmuxSession) {
      ptyShell = "tmux";
      ptyArgs = ["new", "-A", "-s", tmuxSession, shell];
    } else if (tmuxWrap) {
      // tmux persistence: the pty attaches to `tmux new -A` (attach-or-create).
      // If vale-studio restarts, the tmux SERVER keeps the session alive and a
      // recreated terminal with the same name re-attaches with full history.
      tmuxSession = `vs-${id}`;
      ptyShell = "tmux";
      ptyArgs = ["new", "-A", "-s", tmuxSession, shell];
    }
    const session = await createPty({ shell: ptyShell, args: ptyArgs, cwd, cols, rows, env });
    const t = {
      id,
      name: displayName,
      cwd,
      backend: session.backend,
      tmuxName: tmuxSession,
      ring: ringBuffer(RING_MAX),
      viewers: new Set(),
      session,
      exitCode: null,
    };
    terminals.set(id, t);
    session.onData((d) => termBroadcast(t, Buffer.from(d)));
    session.onExit((code) => {
      t.exitCode = code;
      if (exitNotice) {
        termBroadcast(t, Buffer.from(`\r\n\x1b[90m[process exited ${code}]\x1b[0m\r\n`));
      }
      setTimeout(() => terminals.delete(id), 60_000).unref?.();
    });
    return { id, backend: session.backend, name: displayName };
  }

  return { terminals, createTerminalSession };
}

/**
 * Validate the cwd a tmux session reports for adoption. Regression guard for
 * the old `safeResolve(p, ROOTS), (cwd = p)` comma-operator slip that kept the
 * RAW tmux-reported path instead of the validated one — the returned value is
 * the canonical realpath safeResolve validated, never the raw input.
 * Returns null when the report (or the fallback) is outside the roots — the
 * caller then skips the session. An empty report falls back to `fallback`
 * (first root), validated the same way but returned as-is (same
 * non-canonical default as the POST /api/term default cwd).
 */
export function resolveAdoptCwd(rawPath, fallback, roots) {
  try {
    if (rawPath) return safeResolve(rawPath, roots);
    safeResolve(fallback, roots);
    return fallback;
  } catch {
    return null; // outside allowed roots — caller skips the session
  }
}
