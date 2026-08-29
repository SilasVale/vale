// Mock vale-agent server: serves the built panel (resources/panel) and mocks
// every API the panel calls, per the audited endpoint inventory. Lets the
// redesign iterate against real screenshots without a Windows device.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

import { fileURLToPath } from "node:url";
const PANEL_DIR = new URL("../../panel/", import.meta.url).pathname;
const PORT = 18811;

const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" };

const memEntries = [
  { id: "m1", title: "d1 tunnel recovery", content: "cloudflared on d1 drops when the device sleeps; agent restarts it via fix-tunnel.ps1. If 530 persists, check cloudflared service.", tags: ["d1", "tunnel"], namespace: "ops", source: "claude-code", created_at: 1756300000, updated_at: 1756400000 },
  { id: "m2", title: "panel token injection", content: "The gateway injects the panel Bearer token ONLY for requests carrying X-Vale-Auth (proxy_secret). Direct curl cannot read it.", tags: ["security", "gateway"], namespace: "dev", source: "dsh", created_at: 1756200000, updated_at: 1756350000 },
  { id: "m3", title: "PSReadLine fragments", content: "PowerShell ConPTY echo fragments when PSReadLine redraws; the agent unloads PSReadLine on PTY open.", tags: ["terminal"], namespace: "dev", source: "claude-code", created_at: 1756100000, updated_at: 1756250000 },
];
let memId = 4;
const shots = [
  { name: "pw-20260829-101301.png", mtime_ms: Date.now() - 40000 },
  { name: "pw-20260829-101244.png", mtime_ms: Date.now() - 96000 },
];
const shotBody = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mNkYPjPwMDAwMgABXAGACwBA/+8kUOnAAAAAElFTkSuQmCC",
  "base64",
);

function json(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // ---- tool envelope ----
  if (p.startsWith("/api/tools/")) {
    const name = p.slice("/api/tools/".length);
    if (name === "terminal_list") return json(res, { ok: true, result: [
      { id: "term-a1", label: "shell", kind: "pty" },
      { id: "term-b2", label: "build-box", kind: "ssh" },
    ] });
    if (name === "terminal_open") return json(res, { ok: true, result: `term-${Math.random().toString(16).slice(2, 6)}` });
    if (name === "terminal_read") return json(res, { ok: true, start: 0, text: "d1 shell ready\r\n$ " });
    if (name === "terminal_saved_connections") return json(res, { ok: true, result: { connections: [
      { id: "ssh:root@192.168.1.1:22", kind: "ssh", target: "root@192.168.1.1:22", label: "router" },
    ] } });
    if (name === "memory_list" || name === "memory_search") return json(res, { ok: true, result: { results: memEntries } });
    if (name === "memory_delete") { memEntries.splice(0, 1); return json(res, { ok: true }); }
    if (name === "memory_export") return json(res, { ok: true, export: memEntries.map((m) => JSON.stringify(m)).join("\n") });
    if (name === "terminal_env") return json(res, { ok: false, error: "terminal_env requires an active pty session" });
    if (name === "terminal_diag_read") return json(res, { ok: false, error: "no diag file" });
    return json(res, { ok: true, result: {} });
  }

  // ---- SSE term events ----
  if (p === "/api/events/term") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write(": ping\n\n");
    const iv = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => clearInterval(iv));
    return;
  }

  // ---- per-session command events (cards + trajectory) ----
  if (p.startsWith("/api/sessions/")) {
    const now = Math.floor(Date.now() / 1000);
    return json(res, { ok: true, events: [
      { seq: 1, ts: now - 120, kind: "command/start", command: "cargo build --release" },
      { seq: 2, ts: now - 118, kind: "output", text: "Compiling vale-agent v1.0.109" },
      { seq: 3, ts: now - 60, kind: "output", text: "Finished release profile in 58s" },
      { seq: 4, ts: now - 59, kind: "command/end", exit_code: 0, duration_ms: 61000 },
      { seq: 5, ts: now - 30, kind: "command/start", command: "git status" },
      { seq: 6, ts: now - 29, kind: "command/end", exit_code: 0, duration_ms: 400 },
    ] });
  }

  // ---- browser evidence ----
  if (p === "/api/browser/pwshots") return json(res, { shots });
  if (p === "/api/browser/pwshot") { res.writeHead(200, { "content-type": "image/png" }); return res.end(shotBody); }
  if (p === "/api/browser/ws-ticket") return json(res, { ticket: "mock" });

  // ---- plugins / settings / memory page misc ----
  if (p === "/api/spec") return json(res, { plugins: [
    { name: "terminal", displayName: "Terminal", description: "PTY/SSH/serial sessions" },
    { name: "memory", displayName: "Memory", description: "Shared memory store for AI clients" },
    { name: "playwright", displayName: "Playwright", description: "Bundled browser automation runtime" },
    { name: "design", displayName: "Design", description: "HTTP surface for design tokens" },
  ] });
  if (p === "/api/plugins/status") return json(res, { playwright: { running: true, port: 9229, started_at: Date.now() - 3600000, healthy: true } });
  if (p.startsWith("/api/plugins/playwright/")) return json(res, { ok: true, status: "started" });
  if (p === "/api/settings" && req.method === "GET") return json(res, { buffer_mb: 8, console_url: "https://ai.saisi.online", tunnel_configured: true, tunnel_running: true });
  if (p === "/api/settings" && req.method === "PUT") return json(res, { ok: true });
  if (p === "/api/gateway/connect") return json(res, { ok: true, registered: true, tunnel: "running" });
  if (p === "/api/status") return json(res, { ok: true, version: "1.0.110", serial_ports: [] });

  // ---- static panel ----
  let file = p === "/" || p === "/panel" || p === "/panel/" || p === "/desktop" || p === "/desktop/" ? "/index.html" : p;
  // strip the mount prefix for static assets (/panel/panel.js → panel.js)
  file = file.replace(/^\/(panel|desktop)/, "") || "/index.html";
  const fp = join(PANEL_DIR, file);
  if (existsSync(fp) && !fp.includes("..")) {
    res.writeHead(200, { "content-type": MIME[extname(fp)] || "application/octet-stream" });
    return res.end(readFileSync(fp));
  }
  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log(`mock agent on http://127.0.0.1:${PORT} (panel: /panel/ | desktop: /desktop/)`));
