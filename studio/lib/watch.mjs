// vale-studio · targeted file watching (VS Code-style): instead of recursively
// watching a whole workspace — which exhausts inotify limits on big trees and
// crashes the process — the client tells us which files are OPEN, and we watch
// only those directories non-recursively. Events are filtered back to tracked
// paths.
//
// Pure move from server.mjs: the server holds ONE hub instance and its two
// contact points — safeResolve confinement in setFiles (paths never trusted,
// same ROOTS as the file APIs) and broadcast() from the write routes.

import fs from "node:fs";
import path from "node:path";
import { safeResolve } from "./fsapi.mjs";

export function createWatcherHub({ roots, maxPerClient, debounceMs = 150 }) {
  const clients = new Set();          // watch-WS set
  const tracked = new Map();          // absPath -> refCount
  const dirs = new Map();             // dirReal -> {watcher, timers:Map, errorNotified}

  function broadcast(p, event) {
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ path: p, event }));
    }
  }

  function onDirEvent(dirReal, event, filename) {
    if (!filename) return;
    const p = path.join(dirReal, filename);
    if (!tracked.has(p)) return;
    let s = dirs.get(dirReal);
    const prev = s.timers.get(p);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      s.timers.delete(p);
      broadcast(p, event);
    }, debounceMs);
    t.unref?.();
    s.timers.set(p, t);
  }

  function trackDir(dirReal) {
    if (dirs.has(dirReal)) return true;
    try {
      const w = fs.watch(dirReal, (event, filename) => onDirEvent(dirReal, event, filename));
      w.on("error", (e) => {
        // inotify exhaustion etc. — degrade to no-op, never crash
        console.warn(`[studio] watcher error ${dirReal}: ${e.code || e.message}`);
      });
      dirs.set(dirReal, { watcher: w, timers: new Map() });
      return true;
    } catch (e) {
      console.warn(`[studio] cannot watch ${dirReal}: ${e.code || e.message}`);
      return false;
    }
  }

  function trackFile(p) {
    const n = tracked.get(p) || 0;
    tracked.set(p, n + 1);
    if (n === 0) {
      let dirReal = null;
      try {
        dirReal = fs.realpathSync(path.dirname(p));
      } catch {
        return;
      }
      trackDir(dirReal);
    }
  }

  function untrackAllFor(wsPaths) {
    for (const p of wsPaths) {
      const n = (tracked.get(p) || 0) - 1;
      if (n <= 0) tracked.delete(p);
      else tracked.set(p, n);
    }
    // GC dirs with no remaining tracked files
    for (const [dirReal, s] of dirs) {
      const stillNeeded = [...tracked.keys()].some((f) => {
        try {
          return fs.realpathSync(path.dirname(f)) === dirReal;
        } catch {
          return false; // dir deleted mid-iteration (WS close path) — not pinning
        }
      });
      if (!stillNeeded) {
        try { s.watcher.close(); } catch {}
        dirs.delete(dirReal);
      }
    }
  }

  return {
    addClient(ws) {
      clients.add(ws);
    },
    removeClient(ws, openPaths) {
      clients.delete(ws);
      if (openPaths && openPaths.length) untrackAllFor(openPaths);
    },
    setFiles(ws, paths) {
      // full reconcile from this client
      if (ws._tracked) untrackAllFor(ws._tracked);
      ws._tracked = [];
      for (const p of paths || []) {
        // Bound per-client watches: open-file sets are small; this caps
        // inotify usage from a compromised/malicious client.
        if (ws._tracked.length >= maxPerClient) break;
        try {
          // Same confinement as the file APIs — never trust client paths.
          const real = safeResolve(p, roots);
          ws._tracked.push(real);
          trackFile(real);
        } catch {}
      }
      return { tracked: ws._tracked.length };
    },
    broadcast,
  };
}
