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
  sha256,
} from "./lib/fsapi.mjs";
import { createPty } from "./lib/pty.mjs";

// ── config ───────────────────────────────────────────────────────────────────

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
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
    await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fsp.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    console.log(`[studio] wrote default config to ${CONFIG_PATH}`);
    return cfg;
  }
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

// ── auth ─────────────────────────────────────────────────────────────────────

const TOKEN_HASH = sha256(Buffer.from(CONFIG.token));
const failLog = new Map(); // ip -> {count, resetAt}

function tokenOk(token, ip) {
  const now = Date.now();
  const rec = failLog.get(ip);
  if (rec && rec.count >= 10 && now < rec.resetAt) return false;
  if (rec && now >= rec.resetAt) failLog.delete(ip);
  let ok = false;
  if (typeof token === "string" && token.length > 0) {
    // constant-time compare over equal-length digests
    ok = crypto.timingSafeEqual(
      crypto.createHash("sha256").update(token).digest(),
      crypto.createHash("sha256").update(CONFIG.token).digest(),
    );
  }
  if (!ok) {
    const r = failLog.get(ip) || { count: 0, resetAt: now + 60_000 };
    r.count++;
    failLog.set(ip, r);
  }
  return ok;
}

function bearerOf(req, url) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return url.searchParams.get("token");
}

// ── helpers ──────────────────────────────────────────────────────────────────

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
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
    if (!file.startsWith(m.dir)) {
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
    });
    fs.createReadStream(file).pipe(res);
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
  roots: ROOTS.map((r) => ({ path: r, ...gitInfo(r) })),
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

route("POST", "/api/mkdir", async (req) => {
  assertWritable();
  const body = await readJson(req);
  const p = safeResolve(body.p, ROOTS, { mustExist: false });
  return makeDir(p);
});

route("DELETE", "/api/file", async (req, url) => {
  assertWritable();
  const p = safeResolve(url.searchParams.get("p"), ROOTS);
  const root = ROOTS.map((r) => fs.realpathSync(r)).find((r) => p.startsWith(r.endsWith("/") ? r : r + "/"));
  return trashFile(p, root || ROOTS[0]);
});

route("GET", "/api/search", async (req, url) => {
  const root = safeResolve(url.searchParams.get("root") || ROOTS[0], ROOTS);
  const q = url.searchParams.get("q") || "";
  return searchWorkspace({
    root,
    q,
    regex: url.searchParams.get("regex") === "1",
    ignoreCase: url.searchParams.get("case") !== "1",
  });
});

route("GET", "/api/git/status", async (req, url) =>
  gitStatus(safeResolve(url.searchParams.get("p"), ROOTS)));
route("GET", "/api/git/log", async (req, url) =>
  gitLog(safeResolve(url.searchParams.get("p"), ROOTS)));
route("GET", "/api/git/diff", async (req, url) =>
  gitDiff(safeResolve(url.searchParams.get("p"), ROOTS)));

// Flat file list for quick-open (Ctrl+P). Skips noise dirs, caps entries.
route("GET", "/api/files", async (req, url) => {
  const rootParam = url.searchParams.get("root") || ROOTS[0];
  const rootReal = fs.realpathSync(safeResolve(rootParam, ROOTS));
  const { walk } = await import("./lib/walk.mjs");
  const files = [];
  const cap = Number(url.searchParams.get("limit")) || 15000;
  for await (const f of walk(rootReal, { maxFiles: cap })) {
    files.push(f.path);
    if (files.length >= cap) break;
  }
  return { root: rootReal, files };
});

function assertWritable() {
  if (CONFIG.readOnly) throw new ApiError(403, "read_only", "server is in read-only mode");
}

// ── terminals ────────────────────────────────────────────────────────────────

const RING_MAX = 64 * 1024;
const terminals = new Map(); // id -> {id,name,cwd,backend,ring,viewers:Set,session,exitCode,deadAt}
let termSeq = 0;

function termBroadcast(t, data) {
  t.ring.write(data);
  for (const ws of t.viewers) {
    if (ws.readyState === 1) ws.send(data, { binary: true });
  }
}

route("POST", "/api/term", async (req) => {
  if (CONFIG.readOnly || !CONFIG.terminal.enabled) {
    throw new ApiError(403, "terminal_disabled", "terminal is disabled on this server");
  }
  const body = await readJson(req, 4096);
  let cwd = ROOTS[0];
  if (body.cwd) cwd = safeResolve(String(body.cwd), ROOTS);
  const id = `t${++termSeq}-${crypto.randomBytes(3).toString("hex")}`;
  const session = await createPty({
    shell: CONFIG.terminal.shell,
    cwd,
    cols: Number(body.cols) || 80,
    rows: Number(body.rows) || 24,
    env: { VSTUDIO_ROOT: cwd },
  });
  const t = {
    id,
    name: `bash · ${path.basename(cwd)}`,
    cwd,
    backend: session.backend,
    ring: ringBuffer(RING_MAX),
    viewers: new Set(),
    session,
    exitCode: null,
    deadAt: null,
  };
  terminals.set(id, t);
  session.onData((d) => termBroadcast(t, Buffer.from(d)));
  session.onExit((code) => {
    t.exitCode = code;
    t.deadAt = Date.now();
    termBroadcast(t, Buffer.from(`\r\n\x1b[90m[process exited ${code}]\x1b[0m\r\n`));
    setTimeout(() => terminals.delete(id), 60_000).unref?.();
  });
  console.log(`[studio] terminal ${id} (${t.backend}) cwd=${cwd}`);
  return { id, backend: t.backend, name: t.name };
});

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
  t.session.kill();
  return { ok: true };
});

// ── websockets ───────────────────────────────────────────────────────────────

// Targeted file watching (VS Code-style): instead of recursively watching a
// whole workspace — which exhausts inotify limits on big trees and crashes the
// process — the client tells us which files are OPEN, and we watch only those
// directories non-recursively. Events are filtered back to tracked paths.
const watchers = (() => {
  const clients = new Set();          // watch-WS set
  const tracked = new Map();          // absPath -> refCount
  const dirs = new Map();             // dirReal -> {watcher, timers:Map, errorNotified}
  const debounceMs = 150;

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
      const stillNeeded = [...tracked.keys()].some(
        (f) => fs.realpathSync(path.dirname(f)) === dirReal,
      );
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
        try {
          const real = fs.realpathSync(p);
          ws._tracked.push(real);
          trackFile(real);
        } catch {}
      }
      return { tracked: ws._tracked.length };
    },
    broadcast,
  };
})();

const wss = new WebSocketServer({ noServer: true });

function wsAuth(req, url) {
  const ip = req.socket.remoteAddress || "?";
  if (!tokenOk(bearerOf(req, url), ip)) return false;
  return true;
}

export const __test = { tokenOk, TOKEN_HASH };

// ── server wiring ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
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

  try {
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
      t.viewers.add(ws);
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

if (hasFlag("--help") || hasFlag("-h")) {
  console.log("usage: node server.mjs [--config PATH] [--port N] [--link]");
  process.exit(0);
}

// One-click login link: the public URL + token. `--link` prints it and exits.
function loginLink(host) {
  return `https://${host}/?token=${CONFIG.token}`;
}

if (hasFlag("--link")) {
  console.log(loginLink("code.saisi.online"));
  process.exit(0);
}

server.listen(CONFIG.port, CONFIG.bind, () => {
  console.log(`[studio] listening on http://${CONFIG.bind}:${CONFIG.port}`);
  console.log(`[studio] roots: ${ROOTS.join(", ") || "(none)"}`);
  console.log(`[studio] readOnly=${CONFIG.readOnly} terminal=${CONFIG.terminal.enabled && !CONFIG.readOnly}`);
  console.log(`[studio] login link (one click per device):`);
  console.log(`    local:  http://127.0.0.1:${CONFIG.port}/?token=${CONFIG.token}`);
  if (CONFIG.publicHost) console.log(`    public: ${loginLink(CONFIG.publicHost)}`);
});

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
