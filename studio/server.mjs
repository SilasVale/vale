#!/usr/bin/env node
// vale-studio server: static frontend + workspace file API + PTY terminal streams.
// Listens on loopback only by design; public access rides the cloudflared tunnel.
//
//   node server.mjs [--config ~/.vale-studio/config.json] [--port N]
//
// API surface (all JSON unless noted):
//   GET  /api/boot                 token check + roots + capabilities
//   GET  /api/roots                allowed workspace roots (+git info)
//   GET  /api/tree?dir=<abs>       one-level directory listing
//   GET  /api/file?p=<abs>         read file (content or dataUrl)
//   PUT  /api/file                 atomic write {p,content,baseSha256}
//   POST /api/mkdir                {p}
//   DELETE /api/file?p=<abs>       move into <root>/.vale-studio-trash/
//   GET  /api/search?q=&root=&regex=&case=   ripgrep, JS fallback
//   GET  /api/git/status|log|diff?p=<abs>
//   WS   /api/watch?root=<abs>     {path,event} pushes
//   POST /api/term                 create PTY {cwd?,cols,rows} -> {id}
//   GET  /api/terms                live sessions
//   DELETE /api/term/:id           terminate
//   WS   /api/term/:id             binary stdin/stdout, text control frames

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { WebSocketServer } from "ws";

import {
  ApiError,
  safeResolve,
  owningRoot,
  isSubpath,
  listTree,
  readFileEntry,
  writeFileAtomic,
  makeDir,
  trashFile,
  searchWorkspace,
  gitStatus,
  gitLog,
  gitDiff,
  gitInfo,
} from "./lib/fsapi.mjs";
import { makeAuth } from "./lib/auth.mjs";
import { createWatcherHub } from "./lib/watch.mjs";
import { createTerminalHub, MAX_TERMINALS, resolveAdoptCwd } from "./lib/terminals.mjs";

// ── config ───────────────────────────────────────────────────────────────────

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

// Flag handling runs BEFORE loadConfig: `--help` on a fresh machine must print
// usage without generating a 0600 config (and a fresh bearer token) as a side
// effect. `--link` cannot move up — it prints the token, so config loading is
// its prerequisite (see the listen block below).
if (hasFlag("--help") || hasFlag("-h")) {
  console.log("usage: node server.mjs [--config PATH] [--port N] [--link]");
  process.exit(0);
}

const CONFIG_PATH = arg("--config") || path.join(os.homedir(), ".vale-studio", "config.json");

async function loadConfig() {
  let raw = null;
  try {
    raw = await fsp.readFile(CONFIG_PATH, "utf8");
  } catch {}
  if (!raw) {
    const cfg = {
      port: 7780,
      bind: "127.0.0.1",
      token: crypto.randomBytes(32).toString("hex"),
      readOnly: false,
      corsOrigins: ["https://dsh.saisi.online", "http://localhost:7738"],
      terminal: { enabled: true, shell: process.env.SHELL || "/bin/bash", tmuxWrap: false },
      maxFileSizeMB: 8,
      roots: [path.join(os.homedir(), "vale")],
    };
    await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
    // Mode 0600: the token grants full file/shell access. `mode` applies only
    // on creation, so chmod explicitly too (pre-existing world-readable file).
    // Best-effort: never fail boot on chmod errors (Windows ACLs etc.).
    // Parent dir: mode set only at creation above — existing parent perms are
    // left alone (may be intentionally group-accessible; file mode 0600 alone
    // protects the token since the kernel enforces file perms on open).
    await fsp.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    try {
      await fsp.chmod(CONFIG_PATH, 0o600);
    } catch {}
    console.log(`[studio] wrote default config to ${CONFIG_PATH}`);
    // First boot ever: print the FULL login link exactly once — the operator
    // needs it to get in. Every later boot prints only the last 4 chars
    // (see the listen block below); the full token stays in the config file.
    console.log(`[studio] FIRST BOOT — one-click login link (shown in full only this once):`);
    console.log(`    local:  http://127.0.0.1:${cfg.port}/?token=${cfg.token}`);
    console.log(`    public: https://code.saisi.online/?token=${cfg.token}`);
    return cfg;
  }
  // Harden a config written by an older version (typically 0644): best-effort.
  try {
    await fsp.chmod(CONFIG_PATH, 0o600);
  } catch {}
  const cfg = JSON.parse(raw);
  cfg.port = Number(arg("--port")) || cfg.port || 7780;
  cfg.bind = cfg.bind || "127.0.0.1";
  if (!Array.isArray(cfg.roots)) cfg.roots = [];
  cfg.corsOrigins = Array.isArray(cfg.corsOrigins) ? cfg.corsOrigins : [];
  cfg.readOnly = !!cfg.readOnly;
  cfg.maxFileSizeMB = cfg.maxFileSizeMB || 8;
  cfg.publicHost = cfg.publicHost || "code.saisi.online"; // shown in the login link
  cfg.terminal = { enabled: true, shell: process.env.SHELL || "/bin/bash", ...(cfg.terminal || {}) };
  return cfg;
}

const CONFIG = await loadConfig();
const ROOTS = CONFIG.roots.filter((r) => {
  try {
    return fs.statSync(r).isDirectory();
  } catch {
    console.warn(`[studio] skipping missing root ${r}`);
    return false;
  }
});

// Vendored browser assets (generated by scripts/build.sh studio from
// node_modules — gitignored). Warn at boot when the two entry files are
// missing so a half-built deploy is obvious; the frontend also reports them
// via /api/boot `vendor` for the UI health view.
const VENDOR = {
  monaco: (() => {
    try {
      return fs.statSync(path.join(import.meta.dirname, "vendor", "monaco", "vs", "loader.js")).isFile();
    } catch {
      return false;
    }
  })(),
  xterm: (() => {
    try {
      return fs.statSync(path.join(import.meta.dirname, "vendor", "xterm", "xterm.js")).isFile();
    } catch {
      return false;
    }
  })(),
};
if (!VENDOR.monaco || !VENDOR.xterm) {
  console.warn(
    `[studio] vendor assets missing (monaco=${VENDOR.monaco} xterm=${VENDOR.xterm}) — ` +
      `run ./scripts/build.sh studio to vendor them`,
  );
}

// ── auth ─────────────────────────────────────────────────────────────────────

// Bearer auth + wrong-guess budget live in lib/auth.mjs (token-first ordering
// is documented there). The token reference digest is computed once inside
// makeAuth — loadConfig is awaited at module top level before the server can
// accept a request, so eager init is safe.
const { tokenOk, bearerOf } = makeAuth(CONFIG.token);

// ── helpers ──────────────────────────────────────────────────────────────────

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(data);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new ApiError(413, "too_large", "request body exceeds limit"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limitBytes = 32 << 20) {
  const buf = await readBody(req, limitBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new ApiError(400, "bad_json", "invalid JSON body");
  }
}

// ── static ───────────────────────────────────────────────────────────────────

const PUBLIC_DIR = path.join(import.meta.dirname, "public");
const STATIC_MAP = [
  { prefix: "/vendor/monaco/", dir: path.join(import.meta.dirname, "vendor", "monaco"), cache: "public, max-age=86400" },
  { prefix: "/vendor/xterm/", dir: path.join(import.meta.dirname, "vendor", "xterm"), cache: "public, max-age=86400" },
  { prefix: "/", dir: PUBLIC_DIR, cache: "no-cache" },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

function serveStatic(req, res, pathname) {
  for (const m of STATIC_MAP) {
    if (!pathname.startsWith(m.prefix)) continue;
    const rel = pathname === "/" ? "index.html" : pathname.slice(m.prefix.length);
    let file = path.normalize(path.join(m.dir, rel));
    // Sep-aware confinement: a bare startsWith(m.dir) would also match a
    // sibling like "<dir>-evil" (classic prefix bypass).
    if (!isSubpath(file, m.dir)) {
      send(res, 403, { error: "forbidden" });
      return true;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      // SPA-ish fallback only for the app shell itself.
      if (m.prefix === "/" && !rel.includes(".")) file = path.join(m.dir, "index.html");
      else {
        send(res, 404, { error: "not_found" });
        return true; // response already sent — never fall through
      }
      try {
        stat = fs.statSync(file);
      } catch {
        send(res, 404, { error: "not_found" });
        return true;
      }
    }
    if (stat.isDirectory()) {
      send(res, 404, { error: "not_found" });
      return true;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": m.cache,
      "x-content-type-options": "nosniff",
      // Never framed by foreign origins (clickjacking); no referrer leakage.
      "content-security-policy": "frame-ancestors 'self'",
      "referrer-policy": "no-referrer",
    });
    const stream = fs.createReadStream(file);
    stream.on("error", () => {
      // e.g. vanished mid-send: headers already sent, so just tear down
      if (!res.headersSent) send(res, 404, { error: "not_found" });
      else {
        try {
          res.destroy();
        } catch {}
      }
    });
    stream.pipe(res);
    return true;
  }
  return false;
}

// ── api routing ──────────────────────────────────────────────────────────────

const routes = [];
function route(method, pattern, handler, { auth = true } = {}) {
  // pattern like "/api/file" or "/api/term/:id"
  const keys = [];
  const rx = new RegExp(
    "^" +
      pattern.replace(/:[^/]+/g, (seg) => {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, rx, keys, handler, auth });
}

route("GET", "/api/boot", async () => ({
  ok: true,
  readOnly: CONFIG.readOnly,
  terminalEnabled: !CONFIG.readOnly && CONFIG.terminal.enabled,
  // Vendored-asset health for the UI: false entries mean a half-built
  // deploy (see the boot-time vendor check above + build.sh studio).
  vendor: VENDOR,
  // Shape matches /api/roots ({path, name, ...gitInfo}) — the frontend
  // builds `r.name + " — " + r.path` from boot roots directly.
  roots: ROOTS.map((r) => ({ path: r, name: path.basename(r), ...gitInfo(r) })),
}));

route("GET", "/api/roots", async () => ({
  roots: ROOTS.map((r) => ({ path: r, name: path.basename(r), ...gitInfo(r) })),
}));

route("GET", "/api/tree", async (req, url) => {
  const dir = safeResolve(url.searchParams.get("dir") || ROOTS[0], ROOTS);
  return { dir, entries: await listTree(dir) };
});

route("GET", "/api/file", async (req, url) => {
  const p = safeResolve(url.searchParams.get("p"), ROOTS);
  return readFileEntry(p);
});

route("PUT", "/api/file", async (req) => {
  assertWritable();
  const body = await readJson(req, (CONFIG.maxFileSizeMB + 2) << 20);
  const p = safeResolve(body.p, ROOTS, { mustExist: body.baseSha256 === "new" ? false : true });
  if (body.content == null) throw new ApiError(400, "missing_content", "content required");
  if (Buffer.byteLength(body.content, "utf8") > CONFIG.maxFileSizeMB << 20) {
    throw new ApiError(413, "too_large", `exceeds maxFileSizeMB=${CONFIG.maxFileSizeMB}`);
  }
  const result = await writeFileAtomic(p, body.content, body.baseSha256 ?? null);
  watchers.broadcast(p, "change");
  return result;
});

// Atomic rename/move INSIDE one workspace root. Target must not exist.
route("POST", "/api/rename", async (req) => {
  assertWritable();
  const body = await readJson(req);
  if (typeof body.from !== "string" || typeof body.to !== "string") {
    throw new ApiError(400, "bad_path", "from/to required");
  }
  const from = safeResolve(body.from, ROOTS);
  const to = safeResolve(body.to, ROOTS, { mustExist: false });
  // Sep-aware: a bare startsWith(root + "/") with a hardcoded "/" breaks on
  // Windows and misses the equality/prefix subtleties isSubpath handles.
  const root = owningRoot(from, ROOTS);
  if (!root || !isSubpath(to, root)) {
    throw new ApiError(403, "outside_roots", "rename must stay inside one root");
  }
  let exists = false;
  try {
    await fsp.stat(to);
    exists = true;
  } catch {}
  if (exists) throw new ApiError(409, "exists", "target already exists");
  try {
    await fsp.rename(from, to);
  } catch (e) {
    throw new ApiError(500, "rename_failed", `rename failed: ${e.code}`);
  }
  watchers.broadcast(from, "delete");
  watchers.broadcast(to, "create");
  return { ok: true };
});

route("POST", "/api/mkdir", async (req) => {
  assertWritable();
  const body = await readJson(req);
  const p = safeResolve(body.p, ROOTS, { mustExist: false });
  const out = await makeDir(p);
  watchers.broadcast(p, "create");
  return out;
});

route("DELETE", "/api/file", async (req, url) => {
  assertWritable();
  const p = safeResolve(url.searchParams.get("p"), ROOTS);
  // Equality matters: p may BE a root (a pure prefix check is false then).
  const root = owningRoot(p, ROOTS);
  if (!root) throw new ApiError(403, "outside_roots", "path outside allowed workspace roots");
  const out = await trashFile(p, root);
  watchers.broadcast(p, "delete");
  return out;
});

route("GET", "/api/search", async (req, url) => {
  const root = safeResolve(url.searchParams.get("root") || ROOTS[0], ROOTS);
  const q = url.searchParams.get("q") || "";
  const ip = req.socket.remoteAddress || "?";
  return searchWorkspace({
    root,
    q,
    regex: url.searchParams.get("regex") === "1",
    ignoreCase: url.searchParams.get("case") !== "1",
    // Single-flight scope: same client re-issuing the same query shares one
    // rg process (see lib/fsapi.mjs searchInflight).
    flightKey: ip,
  });
});

route("GET", "/api/git/status", async (req, url) =>
  gitStatus(safeResolve(url.searchParams.get("p"), ROOTS), ROOTS));
route("GET", "/api/git/log", async (req, url) =>
  gitLog(safeResolve(url.searchParams.get("p"), ROOTS), 30, ROOTS));
route("GET", "/api/git/diff", async (req, url) =>
  gitDiff(safeResolve(url.searchParams.get("p"), ROOTS), ROOTS));

// Flat file list for quick-open (Ctrl+P). Skips noise dirs, caps entries.
// FILES_MAX: hard ceiling — client `limit` is clamped into [1, FILES_MAX]
// and overshoot is reported via `truncated` (the frontend shows its notice).
const FILES_MAX = 20000;
route("GET", "/api/files", async (req, url) => {
  const rootParam = url.searchParams.get("root") || ROOTS[0];
  const rootReal = fs.realpathSync(safeResolve(rootParam, ROOTS));
  const { walk } = await import("./lib/walk.mjs");
  const files = [];
  const asked = Number(url.searchParams.get("limit")) || 15000;
  const cap = Math.min(Math.max(asked, 1), FILES_MAX);
  let truncated = false;
  // Walk one past the cap: seeing the (cap+1)-th file is what proves there
  // were more files than returned (walk itself just stops silently).
  for await (const f of walk(rootReal, { maxFiles: cap + 1 })) {
    if (files.length >= cap) {
      truncated = true;
      break;
    }
    files.push(f.path);
  }
  return { root: rootReal, files, truncated };
});

function assertWritable() {
  if (CONFIG.readOnly) throw new ApiError(403, "read_only", "server is in read-only mode");
}

// Lightweight existence probe for the DSH-side link rewriter (CORS-enabled):
// resolves relative paths against candidate roots without transferring content.
route("GET", "/api/stat", async (req, url) => {
  const p = safeResolve(url.searchParams.get("p"), ROOTS, { mustExist: false });
  let stat = null;
  try {
    stat = await fsp.stat(p);
  } catch {}
  return { path: p, exists: !!stat && !stat.isDirectory(), dir: !!stat?.isDirectory() };
});

// ── terminals ────────────────────────────────────────────────────────────────

// Session registry lives in lib/terminals.mjs (ring buffer, viewer broadcast,
// MAX_TERMINALS cap, 60s post-exit reap). The server holds ONE hub instance;
// the WS term handler and DELETE route operate on the same `terminals` map.
const { terminals, createTerminalSession, addViewer } = createTerminalHub();

route("POST", "/api/term", async (req) => {
  if (CONFIG.readOnly || !CONFIG.terminal.enabled) {
    throw new ApiError(403, "terminal_disabled", "terminal is disabled on this server");
  }
  if (terminals.size >= MAX_TERMINALS) {
    throw new ApiError(
      429,
      "too_many_terminals",
      `terminal session limit (${MAX_TERMINALS}) reached — close one first`,
    );
  }
  const body = await readJson(req, 4096);
  let cwd = ROOTS[0];
  if (body.cwd) cwd = safeResolve(String(body.cwd), ROOTS);
  const { id, backend, name } = await createTerminalSession({
    cwd,
    shell: CONFIG.terminal.shell,
    tmuxWrap: !!CONFIG.terminal.tmuxWrap,
    cols: Number(body.cols) || 80,
    rows: Number(body.rows) || 24,
    env: { VSTUDIO_ROOT: cwd },
    displayName: `bash · ${path.basename(cwd)}`,
    exitNotice: true,
  });
  console.log(`[studio] terminal ${id} (${backend}) cwd=${cwd}`);
  return { id, backend, name };
});

route("GET", "/api/terms", async () => ({
  terms: [...terminals.values()].map((t) => ({
    id: t.id,
    name: t.name,
    cwd: t.cwd,
    backend: t.backend,
    exited: t.exitCode != null,
  })),
}));

route("DELETE", "/api/term/:id", async (req, url, params) => {
  const t = terminals.get(params.id);
  if (!t) throw new ApiError(404, "not_found", "no such terminal");
  // explicit close must also remove a wrapped tmux session, not just detach
  if (t.tmuxName) {
    const { execFile } = await import("node:child_process");
    execFile("tmux", ["kill-session", "-t", t.tmuxName], () => {});
  }
  t.session.kill();
  return { ok: true };
});

// ── websockets ───────────────────────────────────────────────────────────────

// Targeted file watching (VS Code-style): the client tells us which files are
// OPEN and only those directories get non-recursive watches (full design note
// in lib/watch.mjs). Max dirs/files one watch client may track: open-file sets
// are small (dozens); this caps inotify watches from a misbehaving client.
const MAX_WATCH_PER_CLIENT = 128;
const watchers = createWatcherHub({ roots: ROOTS, maxPerClient: MAX_WATCH_PER_CLIENT });

const wss = new WebSocketServer({ noServer: true });

function wsAuth(req, url) {
  const ip = req.socket.remoteAddress || "?";
  if (!tokenOk(bearerOf(req, url), ip)) return false;
  return true;
}

// ── server wiring ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    // Inside try: malformed percent-encoding must be a 400, not an
    // unhandled rejection with the socket never answered.
    const url = new URL(req.url, "http://x");
    const pathname = decodeURIComponent(url.pathname);

    // CORS for the DSH-side content script (read-only endpoints).
    const origin = req.headers.origin;
    if (origin && CONFIG.corsOrigins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "GET, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (pathname.startsWith("/api/")) {
      const match = routes.find((r) => r.rx.test(pathname) && (r.method === req.method));
      if (!match) return send(res, 404, { error: "not_found", code: "no_route" });
      const ip = req.socket.remoteAddress || "?";
      if (match.auth && !tokenOk(bearerOf(req, url), ip)) {
        return send(res, 404, { error: "not_found" }); // do not reveal auth shape
      }
      const params = {};
      const m = pathname.match(match.rx);
      match.keys.forEach((k, i) => (params[k] = m[i + 1]));
      const result = await match.handler(req, url, params);
      return send(res, 200, result);
    }
    if (serveStatic(req, res, pathname)) return;
    return send(res, 404, { error: "not_found" });
  } catch (err) {
    if (err instanceof URIError) {
      return send(res, 400, { error: "bad_path", message: "malformed URL encoding" });
    }
    if (err instanceof ApiError) {
      const body = { error: err.code, message: err.message };
      if (err.currentSha256) body.currentSha256 = err.currentSha256;
      return send(res, err.status, body);
    }
    console.error("[studio] handler error:", err);
    return send(res, 500, { error: "internal" });
  }
});

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  const pathname = url.pathname;
  if (!wsAuth(req, url)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (pathname === "/api/watch") {
      watchers.addClient(ws);
      ws.send(JSON.stringify({ hello: "targeted" }));
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (Array.isArray(msg.open)) {
            watchers.setFiles(ws, msg.open);
          }
        } catch {}
      });
      ws.on("close", () => watchers.removeClient(ws, ws._tracked));
      return;
    }
    const m = pathname.match(/^\/api\/term\/([^/]+)$/);
    if (m) {
      const t = terminals.get(m[1]);
      if (!t) {
        ws.close();
        return;
      }
      // Viewer cap (asymmetry guard: MAX_TERMINALS caps creation, this caps
      // fan-out per terminal); a refused viewer gets a clean close.
      if (!addViewer(t, ws)) {
        ws.close();
        return;
      }
      ws.send(t.ring.toString(), { binary: true }); // replay backlog
      if (t.exitCode != null) {
        ws.send(JSON.stringify({ exited: t.exitCode }));
        ws.close();
        return;
      }
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          t.session.write(data.toString());
        } else {
          const s = data.toString();
          try {
            const ctrl = JSON.parse(s);
            if (ctrl.resize) t.session.resize(ctrl.resize.cols, ctrl.resize.rows);
          } catch {
            t.session.write(s); // lenient: text frames that aren't JSON are stdin
          }
        }
      });
      ws.on("close", () => t.viewers.delete(ws));
      return;
    }
    ws.close();
  });
});

// One-click login link: the public URL + token. `--link` prints it and exits.
// Host: config `publicHost` (set by loadConfig for existing configs), falling
// back to the historical literal when unset (e.g. a first-boot config, which
// is generated without the key).
function loginLink(host) {
  return `https://${host}/?token=${CONFIG.token}`;
}

if (hasFlag("--link")) {
  console.log(loginLink(CONFIG.publicHost || "code.saisi.online"));
  process.exit(0);
}

server.listen(CONFIG.port, CONFIG.bind, () => {
  console.log(`[studio] listening on http://${CONFIG.bind}:${CONFIG.port}`);
  console.log(`[studio] roots: ${ROOTS.join(", ") || "(none)"}`);
  console.log(`[studio] readOnly=${CONFIG.readOnly} terminal=${CONFIG.terminal.enabled && !CONFIG.readOnly}`);
  console.log(`[studio] vendor: monaco=${VENDOR.monaco} xterm=${VENDOR.xterm}`);
  // Token hygiene: startup logs carry only the LAST 4 chars (enough to tell
  // configs apart, useless to a log reader). The full login link is printed
  // exactly once — at first config generation above — and on explicit
  // `node server.mjs --link`. Full token always lives in the config file.
  const tail = String(CONFIG.token || "").slice(-4);
  console.log(`[studio] token: ••••${tail} (full token in ${CONFIG_PATH}; use --link to print the login URL)`);
});

// Adopt vs-* tmux sessions left behind by a previous run: they stay alive in
// the tmux server across restarts, so re-register them instead of orphaning.
async function adoptTmuxSessions() {
  if (!CONFIG.terminal.tmuxWrap || CONFIG.readOnly || !CONFIG.terminal.enabled) return;
  const { promisify } = await import("node:util");
  const { execFile: ef } = await import("node:child_process");
  const run = promisify(ef);
  let out;
  try {
    out = (await run("tmux", ["list-sessions", "-F", "#{session_name}"])).stdout;
  } catch {
    return; // no tmux or no sessions
  }
  for (const name of out.trim().split("\n")) {
    if (!name?.startsWith("vs-t")) continue;
    // resolve where the session was last working (falls back to first root).
    // FIX: keep the VALIDATED canonical path from safeResolve — the old
    // `safeResolve(p, ROOTS), (cwd = p)` comma-operator slip discarded the
    // validated return and adopted the raw tmux-reported string instead.
    let p;
    try {
      p = (
        await run("tmux", ["display-message", "-p", "-t", name, "#{pane_current_path}"])
      ).stdout.trim();
    } catch {
      continue; // session vanished between list and query
    }
    const cwd = resolveAdoptCwd(p, ROOTS[0], ROOTS);
    if (!cwd) continue; // reported cwd outside allowed roots
    const { id } = await createTerminalSession({
      cwd,
      shell: CONFIG.terminal.shell,
      tmuxName: name,
      env: {},
      displayName: `bash · ${path.basename(cwd)} (restored)`,
    });
    console.log(`[studio] adopted tmux session ${name} -> terminal ${id}`);
  }
}


adoptTmuxSessions();

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[studio] ${sig}: closing ${terminals.size} terminal(s)`);
    for (const t of terminals.values()) {
      try {
        t.session.kill();
      } catch {}
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
