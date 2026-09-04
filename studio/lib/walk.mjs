// Async generator walking a directory tree for the JS search fallback.
// Skips heavy/noise dirs; yields {path, bytes}; bounded by maxFiles/maxBytesTotal.

import fsp from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", ".venv", "venv",
  "__pycache__", ".vale-studio-trash", ".vscode-server", ".nvm",
]);

export async function* walk(root, { maxFiles = Infinity, maxBytesTotal = Infinity } = {}) {
  const queue = [root];
  let files = 0;
  let bytesTotal = 0;
  while (queue.length) {
    const dir = queue.shift();
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name) && !d.name.startsWith(".vale-tmp")) {
          queue.push(full);
        }
        continue;
      }
      if (!d.isFile()) continue;
      if (++files > maxFiles || bytesTotal > maxBytesTotal) return;
      let stat = null;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      bytesTotal += stat.size;
      yield { path: full, bytes: stat.size };
    }
  }
}
