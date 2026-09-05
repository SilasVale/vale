// vale-studio · filesystem API: path safety, tree, atomic file ops, search, git.
// Every public entry takes an absolute client-supplied path and returns either
// a validated real path inside one of the configured roots, or throws ApiError.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function isSubpath(child, parent) {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * Validate that `p` resolves (symlinks included) inside one of `roots`
 * (roots are themselves realpath'ed). Returns the resolved real path.
 * `mustExist=false` validates the deepest existing ancestor instead,
 * which allows naming not-yet-created files/dirs inside a live root.
 */
export function safeResolve(p, roots, { mustExist = true } = {}) {
  if (typeof p !== "string" || !path.isAbsolute(p)) {
    throw new ApiError(400, "bad_path", "absolute path required");
  }
  const norm = path.normalize(p);
  const realRoots = roots.map((r) => {
    try {
      return fs.realpathSync(r);
    } catch {
      return null;
    }
  });
  let probe = norm;
  if (!mustExist) {
    // Walk up until an existing component is found.
    for (;;) {
      try {
        fs.statSync(probe);
        break;
      } catch {
        const up = path.dirname(probe);
        if (up === probe) throw new ApiError(404, "not_found", "no existing ancestor");
        probe = up;
      }
    }
  }
  let real;
  try {
    real = fs.realpathSync(probe);
  } catch {
    throw new ApiError(404, "not_found", "path not found");
  }
  if (!isSubpath(real, norm) && mustExist) {
    // symlink walked us somewhere else than requested; re-validate against norm below
  }
  const finalPath = mustExist ? real : path.join(real, path.relative(probe, norm));
  for (const r of realRoots) {
    if (r && isSubpath(finalPath, r)) return finalPath;
  }
  throw new ApiError(403, "outside_roots", "path outside allowed workspace roots");
}

const TRASH_DIR = ".vale-studio-trash";
const IGNORED_IN_TREE = new Set([TRASH_DIR]);

export async function listTree(dir, depth = 1) {
  const dirents = await fsp.readdir(dir, { withFileTypes: true }).catch((e) => {
    // Never echo the absolute path back: error bodies must stay path-free.
    console.warn(`[studio] listTree failed for ${dir}: ${e.code || e.message}`);
    throw new ApiError(404, "not_found", "cannot list directory");
  });
  const out = [];
  for (const d of dirents) {
    if (IGNORED_IN_TREE.has(d.name)) continue;
    const full = path.join(dir, d.name);
    let stat = null;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue; // vanished mid-scan
    }
    out.push({
      name: d.name,
      type: d.isDirectory() ? "dir" : d.isSymbolicLink() ? "link" : "file",
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    });
  }
  out.sort((a, b) =>
    a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
  );
  if (depth > 1) {
    for (const e of out) {
      if (e.type === "dir") e.children = await listTree(path.join(dir, e.name), depth - 1);
    }
  }
  return out;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp"]);
const TEXT_SAMPLE = 8192;
// Image preview ceiling: dataUrls are base64 (+33%) held fully in memory on
// both ends — never embed huge images. Above this the entry stays binary
// with previewTooLarge so the frontend can say so explicitly.
export const IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

function detectBinary(buf) {
  const n = Math.min(buf.length, TEXT_SAMPLE);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function readFileEntry(p) {
  const stat = await fsp.stat(p).catch(() => {
    throw new ApiError(404, "not_found", "file not found");
  });
  if (stat.isDirectory()) throw new ApiError(400, "is_dir", "path is a directory");
  if (stat.size > 64 * 1024 * 1024) {
    throw new ApiError(413, "too_large", "file exceeds hard limit (64MB)");
  }
  const buf = await fsp.readFile(p);
  const ext = path.extname(p).toLowerCase();
  const binary = detectBinary(buf);
  const entry = {
    path: p,
    name: path.basename(p),
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    sha256: sha256(buf),
    binary,
  };
  if (binary && IMAGE_EXT.has(ext)) {
    // ext→subtype: .jpg→jpeg, .ico→x-icon (legacy registered type browsers
    // sniff reliably), everything else 1:1 minus the dot.
    entry.imageMime =
      ext === ".jpg" ? "image/jpeg" : ext === ".ico" ? "image/x-icon" : `image/${ext.slice(1)}`;
    if (stat.size <= IMAGE_PREVIEW_MAX_BYTES) {
      entry.dataUrl = `data:${entry.imageMime};base64,${buf.toString("base64")}`;
    } else {
      // Too big to preview inline: stay binary, flag it (no dataUrl).
      entry.previewTooLarge = true;
      entry.content = null;
      entry.binaryHint = ext.slice(1) || "bin";
    }
  } else if (!binary) {
    entry.content = buf.toString("utf8");
    entry.truncated = false;
  } else {
    entry.content = null;
    entry.binaryHint = ext || "bin";
  }
  return entry;
}

/**
 * Atomic save with optimistic locking.
 * `baseSha256`: sha the client last saw. `null`/undefined skips the check.
 * `"new"` asserts the file did not exist when opened.
 * Returns {sha256, mtimeMs}.
 */
export async function writeFileAtomic(p, content, baseSha256) {
  const buf = Buffer.from(content, "utf8");
  let prevMode = 0o644;
  let prevStat = null;
  try {
    prevStat = await fsp.stat(p);
    prevMode = prevStat.mode & 0o7777;
  } catch {
    /* new file */
  }
  const currentSha = prevStat ? sha256(await fsp.readFile(p)) : null;
  if (baseSha256 === "new" && prevStat) {
    const e = new ApiError(409, "conflict", "file was created on disk after you opened it");
    e.currentSha256 = currentSha;
    throw e;
  }
  if (
    typeof baseSha256 === "string" &&
    baseSha256 !== "new" &&
    currentSha !== baseSha256
  ) {
    const e = new ApiError(409, "conflict", "file changed on disk since you loaded it");
    e.currentSha256 = currentSha;
    throw e;
  }
  const tmp = path.join(
    path.dirname(p),
    `.vale-tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const fh = await fsp.open(tmp, "w", prevMode);
  try {
    await fh.writeFile(buf);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, p);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw new ApiError(500, "write_failed", `rename failed: ${e.code}`);
  }
  const after = await fsp.stat(p);
  return { sha256: sha256(buf), mtimeMs: Math.round(after.mtimeMs) };
}

export async function makeDir(p) {
  await fsp.mkdir(p, { recursive: true }).catch((e) => {
    // e.message embeds the absolute path — keep the code, drop the path.
    throw new ApiError(500, "mkdir_failed", `mkdir failed: ${e.code || "error"}`);
  });
  return { ok: true };
}

/** Move to per-root trash instead of unlinking. */
export async function trashFile(p, root) {
  let stat = await fsp.stat(p).catch(() => null);
  if (!stat) throw new ApiError(404, "not_found", "already gone");
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    throw new ApiError(404, "not_found", "workspace root not found");
  }
  if (p === realRoot) throw new ApiError(400, "is_root", "refusing to trash a workspace root");
  const trashRoot = path.join(realRoot, TRASH_DIR);
  if (p === trashRoot || p.startsWith(trashRoot + path.sep)) {
    throw new ApiError(400, "is_trash", "refusing to trash the trash directory");
  }
  await fsp.mkdir(trashRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.basename(p);
  // Unique-ify: same-stamp same-basename renames must not overwrite each other.
  let dest = null;
  for (let i = 0; i < 10; i++) {
    const suffix = crypto.randomBytes(3).toString("hex") + (i === 0 ? "" : `-${i}`);
    const candidate = path.join(trashRoot, `${stamp}-${base}-${suffix}`);
    try {
      await fsp.stat(candidate);
      continue; // improbable collision — retry
    } catch {
      dest = candidate;
      break;
    }
  }
  if (!dest) throw new ApiError(500, "trash_failed", "could not allocate trash name");
  try {
    await fsp.rename(p, dest);
  } catch (e) {
    // e.message embeds absolute paths — keep the code, drop the path.
    throw new ApiError(500, "trash_failed", `trash rename failed: ${e.code || "error"}`);
  }
  await enforceTrashQuota(trashRoot);
  return { trashedTo: dest };
}

// Trash quota: the trash dir is operator-disk, never client-unbounded.
// Evict oldest-first down to the caps (best-effort; never fail the trash op).
const TRASH_MAX_FILES = 200;
const TRASH_MAX_BYTES = 512 * 1024 * 1024;

async function enforceTrashQuota(trashRoot) {
  try {
    const names = await fsp.readdir(trashRoot);
    if (!names.length) return;
    const stats = [];
    let total = 0;
    for (const n of names) {
      try {
        const st = await fsp.stat(path.join(trashRoot, n));
        stats.push({ name: n, size: st.size, mtimeMs: st.mtimeMs });
        total += st.size;
      } catch {
        /* vanished mid-scan */
      }
    }
    if (stats.length <= TRASH_MAX_FILES && total <= TRASH_MAX_BYTES) return;
    stats.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    let remaining = stats.length;
    for (const s of stats) {
      if (remaining <= TRASH_MAX_FILES && total <= TRASH_MAX_BYTES) break;
      try {
        await fsp.rm(path.join(trashRoot, s.name), { recursive: true, force: true });
        total -= s.size;
        remaining -= 1;
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort: quota never breaks trash */
  }
}

// ── search ───────────────────────────────────────────────────────────────────

const RG_LIMIT = 500;
// Query ceiling: bounds rg argv + ReDoS-ish regex cost on the shared server.
const SEARCH_Q_MAX = 200;
// ripgrep wall-clock budget: slow trees resolve with what they have.
const RG_TIMEOUT_MS = 15_000;

// Single-flight: identical concurrent searches (scanner fan-out, double
// submit) share one rg process instead of forking N. Keyed by the full
// query shape; entries are deleted on settle (no leak, no stale cache).
const searchInflight = new Map();

export function searchWorkspace({ root, q, regex = false, ignoreCase = true, flightKey = "" }) {
  if (!q) return Promise.resolve({ matches: [], truncated: false, engine: "none" });
  const query = String(q).slice(0, SEARCH_Q_MAX);
  const key = `${flightKey}::${root}::${regex ? "re" : "lit"}::${ignoreCase ? "i" : "s"}::${query}`;
  const dupe = searchInflight.get(key);
  if (dupe) return dupe;
  const hasRg = (() => {
    try {
      execFileSync("rg", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const run = hasRg
    ? searchRipgrep({ root, q: query, regex, ignoreCase })
    : searchJs({ root, q: query, regex, ignoreCase });
  const shared = run.finally(() => {
    if (searchInflight.get(key) === shared) searchInflight.delete(key);
  });
  searchInflight.set(key, shared);
  return shared;
}

function searchRipgrep({ root, q, regex, ignoreCase }) {
  return new Promise((resolve) => {
    const args = [
      "--json",
      "--max-count",
      "50",
      "--no-messages",
      "--no-require-git",
      "-g", "!node_modules/**",
      "-g", "!.git/**",
      "-g", "!dist/**",
      "-g", "!target/**",
      regex ? "-e" : "-F",
      q,
      ...(ignoreCase ? ["-i"] : []),
      root,
    ];
    const child = spawn("rg", args);
    const matches = [];
    let truncated = false;
    let buf = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      truncated = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, RG_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (matches.length >= RG_LIMIT) {
          truncated = true;
          child.kill();
          return;
        }
        try {
          const ev = JSON.parse(line);
          if (ev.type === "match") {
            const { path: fp, line_number, lines } = ev.data;
            matches.push({
              path: fp.text,
              line: line_number,
              text: (lines.text || "").trimEnd().slice(0, 300),
            });
          }
        } catch {
          /* non-json line */
        }
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ matches, truncated: truncated || timedOut, engine: "ripgrep" });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(searchJs({ root, q, regex, ignoreCase }));
    });
  });
}

async function searchJs({ root, q, regex, ignoreCase }) {
  const { walk } = await import("./walk.mjs");
  const needle = regex ? null : q.toLowerCase();
  let re = null;
  try {
    re = regex ? new RegExp(q, ignoreCase ? "i" : "") : null;
  } catch {
    throw new ApiError(400, "bad_regex", "invalid regular expression");
  }
  const matches = [];
  let truncated = false;
  const hit = (line) =>
    needle != null ? line.toLowerCase().includes(needle) : re.test(line);
  outer: for await (const file of walk(root, { maxFiles: 20000, maxBytesTotal: 512e6 })) {
    if (file.bytes > 2 * 1024 * 1024) continue;
    const text = await fsp.readFile(file.path, "utf8").catch(() => "");
    const ls = text.split("\n");
    for (let i = 0; i < ls.length; i++) {
      if (hit(ls[i])) {
        matches.push({ path: file.path, line: i + 1, text: ls[i].trimEnd().slice(0, 300) });
        if (matches.length >= RG_LIMIT) {
          truncated = true;
          break outer;
        }
      }
    }
  }
  return { matches, truncated, engine: "js" };
}

// ── git ──────────────────────────────────────────────────────────────────────

// Resolve the enclosing git toplevel for `fileOrDir`. When `roots` is given,
// the discovered toplevel must itself sit inside one of the workspace roots
// (realpath-compared): otherwise the caller would run `git status/log/diff`
// with cwd OUTSIDE the allowed tree and leak whole-repo state belonging to
// directories the client is not allowed to see. Returns null (= no_git)
// when there is no repo or the toplevel escapes the roots.
export function gitTop(fileOrDir, roots = null) {
  let start;
  try {
    start = fs.statSync(fileOrDir).isDirectory() ? fileOrDir : path.dirname(fileOrDir);
  } catch {
    // Raced deletion between safeResolve and here — report 404, not 500.
    throw new ApiError(404, "not_found", "path not found");
  }
  let top;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
  if (roots) {
    let topReal;
    try {
      topReal = fs.realpathSync(top);
    } catch {
      return null;
    }
    const inside = roots.some((r) => {
      try {
        return isSubpath(topReal, fs.realpathSync(r));
      } catch {
        return false;
      }
    });
    if (!inside) return null;
  }
  return top;
}

export function gitStatus(p, roots = null) {
  const top = gitTop(p, roots);
  if (!top) throw new ApiError(404, "no_git", "not inside a git repository");
  const status = execFileSync("git", ["status", "--porcelain", "-b"], {
    cwd: top,
    encoding: "utf8",
    maxBuffer: 4 << 20,
  });
  return { top, status };
}

export function gitLog(p, n = 30, roots = null) {
  const top = gitTop(p, roots);
  if (!top) throw new ApiError(404, "no_git", "not inside a git repository");
  const rel = path.relative(top, p) || ".";
  const log = execFileSync(
    "git",
    ["log", "--oneline", "--decorate", `-n`, String(n), "--", rel],
    { cwd: top, encoding: "utf8", maxBuffer: 4 << 20 },
  );
  return { top, log };
}

export function gitDiff(p, roots = null) {
  const top = gitTop(p, roots);
  if (!top) throw new ApiError(404, "no_git", "not inside a git repository");
  const rel = path.relative(top, p) || ".";
  const diff = execFileSync("git", ["diff", "HEAD", "--", rel], {
    cwd: top,
    encoding: "utf8",
    maxBuffer: 16 << 20,
  });
  return { top, diff };
}

export function gitInfo(root) {
  try {
    const top = gitTop(root, [root]);
    if (!top) return { git: false };
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: top,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: top,
      encoding: "utf8",
    }).split("\n").filter(Boolean).length;
    return { git: true, branch, dirty };
  } catch {
    return { git: false };
  }
}
