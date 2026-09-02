#!/usr/bin/env node
/**
 * browser-bridge — interactive remote browser core (round-135, M1).
 * TS source; compiled to bridge.js (CommonJS) by `npm run build` — the
 * compiled artifact is what the agent spawns on the device.
 *
 * Launches chromium via playwright-core with a PERSISTENT profile (login
 * state survives restarts), streams the page as JPEG frames over a minimal
 * dependency-free WebSocket server, and injects mouse/keyboard/navigation
 * events received from the panel.
 *
 * Usage: node bridge.js <port> <token> [userDataDir]
 * Protocol (JSON text frames):
 *   -> {"t":"nav","url":...}          navigate current tab
 *   -> {"t":"m","x":..,"y":..,"k":"move|down|up"}   mouse (CSS px)
 *   -> {"t":"k","key":"a","code":"KeyA","text":"a","down":true}
 *   <- binary frames: JPEG screencast
 */
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import * as http from "http";
import type { Duplex } from "stream";

// round-163: resolve the bundle NEXT TO bridge.js (InstallDir\playwright) —
// the old default hardcoded the RETIRED D:/vale-agent path, so every device
// installed elsewhere (d1 = D:\Vale) failed with MODULE_NOT_FOUND and the
// live browser view never came up. Env override kept for manual runs.
const PW = process.env.BRIDGE_PW_MODULES
  || path.join(__dirname, "playwright", "node_modules");
const { chromium } = require(path.join(PW, "playwright-core")) as typeof import("playwright-core");

// round-143: this process is spawned by vale-agent.exe in the SYSTEM/session-0
// service context, which has no console — the agent bridge never had a visible
// cmd window, BUT any error message from the IIFE catch went nowhere (stderr
// to a discarded session-0 console). bridge.js would die silently and the
// agent's spawn-once-at-boot policy would keep 9224 dead until the device
// reboot — exactly the user-visible "black panel forever" mode. Now we write
// every error to a durable file in the install dir so the next time the
// service is up we have evidence of what failed.
const ERR_LOG = process.env.BRIDGE_ERR_LOG || path.join(
  // Install dir is two parents up from bridge.js's typical staging location
  // (resources/browser-bridge/ → ../../vale-agent/) — but the agent may also
  // be run from a different cwd. Walk up to find the dir that contains
  // `playwright` (the bundle), default to that parent's parent.
  (() => {
    let d = path.dirname(path.resolve(process.argv[1] || __filename));
    for (let i = 0; i < 4; i++) {
      if (fs.existsSync(path.join(d, "playwright"))) return d;
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    return process.env.VALE_AGENT_DIR || "D:/vale-agent";
  })(),
  "bridge-err.log",
);
function logErr(tag: string, err: unknown): void {
  const line = `[${new Date().toISOString()}] ${tag}: ${err && (err as Error).stack || err}\n`;
  try { fs.appendFileSync(ERR_LOG, line); } catch (_) { /* best effort */ }
  // Also surface to stderr in case a parent is watching.
  try { process.stderr.write(line); } catch (_) {}
}

const [, , portArg, tokenArg, dirArg] = process.argv;
const PORT = Number(portArg || 9224);
const TOKEN = tokenArg || "";
const USER_DATA_DIR = dirArg || "C:/Users/Administrator/AppData/Local/vale-browser-profile";
// Headless pages emit no compositor frames while visually idle; a styled
// welcome page guarantees the first screencast frames are non-empty.
const WELCOME = "data:text/html," + encodeURIComponent(
  "<body style=\"margin:0;height:100vh;box-sizing:border-box;background:linear-gradient(135deg,#f59f00,#e8590c);color:#fff;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center\"><div style=\"text-align:center\"><div style=\"font-size:44px;font-weight:200;letter-spacing:2px\">Vale Remote Browser</div><div style=\"margin-top:14px;font-size:16px;opacity:.85\">Ready — type a URL in the address bar above</div></div></body>");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsAccept(key: string): string {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) { head = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

function decodeClientFrames(buf: Buffer, onMessage: (msg: string) => void): Buffer {
  let off = 0;
  while (off + 2 <= buf.length) {
    const fin = buf[off] & 0x80, op = buf[off] & 0x0f;
    let len = buf[off + 1] & 0x7f, mask = !!(buf[off + 1] & 0x80), pos = off + 2;
    if (len === 126) { len = buf.readUInt16BE(pos); pos += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(pos)); pos += 8; }
    if (mask) pos += 4;
    if (pos + len > buf.length) break;
    const data = buf.slice(pos, pos + len);
    if (mask) { const m = buf.slice(pos - 4, pos); for (let i = 0; i < data.length; i++) data[i] ^= m[i % 4]; }
    off = pos + len;
    if (op === 1 && fin) onMessage(data.toString("utf8"));
    // op 8 = close, 9 = ping (client pings are rare; we ignore, rely on TCP)
  }
  return buf.slice(off); // remainder
}

// --- Incoming message shapes (protocol) ---
interface Msg {
  t: string;
  id?: number;
  url?: string;
  x?: number;
  y?: number;
  k?: string;
  dx?: number;
  dy?: number;
  key?: string;
  code?: string;
  text?: string;
  down?: boolean;
  vk?: number;
  i?: number;
  w?: number;  // (resize) viewport width
  h?: number;  // (resize) viewport height
}

(async () => {
  // round-143: launchPersistentContext fails transiently when a previous
  // bridge's chromium is still releasing the profile (SingletonLock), or
  // when the Windows swap script's kill-tree races our spawn. Retry a few
  // times with a short backoff before giving up — each attempt logs to the
  // durable bridge-err.log so the next agent boot has evidence.
  const MAX_LAUNCH_ATTEMPTS = 4;
  let ctx: import("playwright-core").BrowserContext | null = null;
  for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt++) {
    try {
      // ONE-BROWSER FIX (user report: "AI 调用 MCP 后 browser 面板显示不正确"):
      // the panel screencasts THIS browser while playwright-mcp used to launch
      // its OWN headless chromium — AI navigation could never appear. The
      // bridge now exposes its CDP on loopback 9223 and every playwright-mcp
      // spawn attaches here via --cdp-endpoint. Loopback-only + no browser
      // content of value before login ⇒ port is not an external surface.
      ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: true, viewport: { width: 1280, height: 800 },
        args: ["--remote-debugging-port=9223", "--remote-debugging-address=127.0.0.1"],
      });
      break;
    } catch (e) {
      logErr(`launchPersistentContext attempt ${attempt}/${MAX_LAUNCH_ATTEMPTS} failed`, e);
      if (attempt === MAX_LAUNCH_ATTEMPTS) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  let page = ctx!.pages()[0] || await ctx!.newPage();
  // stage-n: the welcome doc is SET (setContent on about:blank) instead of
  // goto(data:) — navigating AWAY from a data: URL races playwright's commit
  // and surfaces as a spurious net::ERR_ABORTED (seen on d1: the first nav
  // from the welcome page "fails" although the page lands fine).
  if (page.url() === "about:blank") {
    const body = WELCOME.slice(WELCOME.indexOf(",") + 1);
    try { await page.setContent(decodeURIComponent(body), { waitUntil: "domcontentloaded" }); }
    catch { await page.goto(WELCOME).catch(() => {}); }
  }
  let cdp = await ctx!.newCDPSession(page);
  // External tab events: pages opened/closed by the site itself (window.open,
  // target=_blank, JS close) and any in-page navigation change the tab list —
  // push instead of waiting for the panel to ask.
  // stage-n (bridge review): an EXTERNAL close (page JS window.close()) of the
  // SELECTED page used to leave selPage dangling — screencast died silently
  // and the panel froze until unrelated input healed it. Repair immediately.
  const onPageClosed = (p: typeof page): void => {
    if (p === selPage || p === page) { pagesList(); void attachSel(); }
    scheduleTabsPush();
  };
  // AI (playwright-mcp over CDP) and window.open create pages: FOLLOW the
  // newest one so the viewport shows what the AI is doing — unless a human
  // selected a tab within the last 30 s (their choice wins).
  ctx!.on("page", (p) => {
    if (Date.now() - lastUserSelAt > 30_000) {
      selPage = p; void attachSel();
    }
    scheduleTabsPush();
    p.on("framenavigated", () => scheduleTabsPush());
    p.on("close", () => onPageClosed(p));
  });
  for (const p of ctx!.pages()) {
    p.on("framenavigated", () => scheduleTabsPush());
    p.on("close", () => onPageClosed(p));
  }
  // Multi-tab (M2): selPage tracked by object identity; refresh() re-syncs
  // after closes and switches the CDP pipe so screencast follows selection.
  let selPage: typeof page | null = page;
  let lastUserSelAt = 0;
  // stage-n: forward-navigation availability — the browser page context
  // exposes no direct can-go-forward, so the bridge tracks it PER PAGE (the
  // old single flag leaked one tab's state onto another after tabsel):
  // nav/reload clears it, a successful back sets it, a successful fwd keeps
  // it (more entries likely), a failed fwd clears it.
  const fwdFlags = new WeakMap<object, boolean>();
  // stage-n: screencast output resolution — follows the PANEL's viewport so
  // the stream is never downscaled (blurry text). Updated via the "resize"
  // command from the SPA (ResizeObserver); capped at the browser's native
  // viewport so we never upscale garbage.
  let streamW = 1280;
  let streamH = 800;
  let lastResizeApplied = 0;
  function pagesList(): Array<typeof page> {
    const ps = ctx!.pages();
    if (!ps.includes(selPage as typeof page)) selPage = ps[0] || null;
    return ps;
  }
  // stage-n (bridge review): attachSel runs on a SERIAL chain. Concurrent
  // tab ops (rapid tabsel / tabsel+tabnew) used to race: both detached the
  // same cdp, both opened a new session, the first leaked a LIVE screencast
  // → viewers saw frames alternating between two tabs and bandwidth doubled.
  let attachChain: Promise<void> = Promise.resolve();
  function attachSel(): Promise<void> {
    const run = async (): Promise<void> => {
      try { await cdp.detach(); } catch {}
      if (!selPage) return;
      const target = selPage;
      const c = await ctx!.newCDPSession(target);
      // Selection may have moved on while the session was opening — drop the
      // late session (the queued attach for the newer selPage owns cdp).
      if (selPage !== target || target.isClosed()) { try { await c.detach(); } catch {} return; }
      cdp = c;
      bindScreencast(c);
    // maxFrameRate exists in newer playwright-core (1.63+); 1.62's types
    // lack it — cast the call to keep the runtime value (device bundle has it).
    // stage-n: quality 60 + resolution follows the panel viewport (streamW/
    // streamH, updated via the resize command) so the stream is never
    // downscaled — the sharpest possible image for the current window.
      await (c.send as (m: string, p?: unknown) => Promise<unknown>)("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1, maxWidth: streamW, maxHeight: streamH, maxFrameRate: 15 }).catch(() => {});
    };
    attachChain = attachChain.then(run, run);
    return attachChain;
  }

  // round-163: push the tab list to viewers when it CHANGES (open/close/
  // select/navigate) — the panel dropped its 1.5s tabs poll for this.
  // stage-n: also report navigation history state (canBack/canFwd) so the
  // panel can disable the back/forward buttons like a real browser.
  let tabsGen = 0;
  async function pushTabs(): Promise<void> {
    const gen = ++tabsGen;
    try {
      if (!ctx) return;
      // stage-n (bridge review): ONE snapshot — the old code read ctx.pages()
      // twice (once for tabs, once for sel); a close during the title awaits
      // shifted indices and the panel highlighted the wrong tab.
      const ps = ctx.pages();
      const target = selPage || page;
      let canBack = false;
      let canFwd = target ? fwdFlags.get(target) === true : false;
      if (target && !target.isClosed()) {
        try {
          const h = await target.evaluate(() => window.history.length);
          // history.length is the TOTAL (including the initial entry), so
          // back is possible when >1; forward state is approximated (the
          // browser exposes no direct can-go-forward in the page context).
          canBack = h > 1;
        } catch { /* closed mid-check */ }
      }
      const f = encodeFrame(1, Buffer.from(JSON.stringify({
        ev: "tabs",
        // stage-n: each tab carries its PAGE TITLE (fallback: the URL) so
        // the panel's tab strip reads like a real browser instead of raw
        // URLs. Titles come from a non-blocking evaluate — a slow page just
        // yields its URL.
        tabs: await Promise.all(ps.map(async (p, i) => {
          let title = "";
          if (!p.isClosed()) {
            try { title = await p.title(); } catch { /* closed mid-check */ }
          }
          return { i, url: p.url(), title: title || p.url().replace(/^https?:\/\//, "") || "blank" };
        })),
        sel: ps.indexOf(selPage as typeof page),
        canBack,
        canFwd,
      })));
      // A newer push started while we awaited titles → ours is stale, drop it
      // (out-of-order pushes used to resurrect old tab lists).
      if (gen !== tabsGen) return;
      broadcast(f);
    } catch (_) {}
  }
  let tabsDebounce: NodeJS.Timeout | null = null;
  function scheduleTabsPush(): void {
    if (tabsDebounce) return;
    tabsDebounce = setTimeout(() => { tabsDebounce = null; pushTabs(); }, 150);
  }

  // round-150: immediate frame on input — if no new screencast frame
  // arrives within 300ms after a mouse/keyboard event (a click/scroll
  // that didn't repaint the page), screenshot and push one frame now to
  // kill the "clicked but nothing happened" feel.
  let fastTimer: NodeJS.Timeout | null = null;
  function scheduleFastFrame(): void {
    if (fastTimer || capturing) return;
    fastTimer = setTimeout(async () => {
      fastTimer = null;
      if (Date.now() - lastAck < 120) return;
      const target = selPage || page;
      if (!target || capturing) return;
      capturing = true;
      try {
        const jpeg = await target.screenshot({ type: "jpeg", quality: 60 });
        if (jpeg.length >= 800) pushFrame(jpeg);
      } catch (_) {}
      finally { capturing = false; }
    }, 300);
  }

  // --- Shared input dispatcher (WS + HTTP) ---
  async function handleInput(m: Msg): Promise<Record<string, unknown> | undefined> {
    try {
      // stage-n (bridge review): sync BEFORE the branches — diag/tabs used to
      // run against a stale `page` (the old tab after a close/switch).
      page = selPage || page;
      if (m.t === "diag") {
        const info = await page.evaluate(() => {
          const a = document.querySelector("a");
          const r = a ? a.getBoundingClientRect() : null;
          return { title: document.title, url: location.href, link: r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (a!.textContent || "").trim() } : null } as { title: string; url: string; link: { x: number; y: number; text: string } | null };
        });
        return info;
      }
      if (m.t === "tabs") {
        pagesList();
        return { tabs: ctx!.pages().map((p, i) => ({ i, url: p.url() })), sel: ctx!.pages().indexOf(selPage as typeof page) };
      }
      if (m.t === "tabnew") {
        lastUserSelAt = Date.now();
        const np = await ctx!.newPage();
        await np.goto(m.url || WELCOME, { waitUntil: "domcontentloaded" }).catch(() => {});
        selPage = np; await attachSel(); scheduleTabsPush();
        return { ok: true };
      }
      if (m.t === "tabclose") {
        pagesList();
        const ps = ctx!.pages();
        const idx = m.i ?? -1;
        const victim = idx >= 0 && idx < ps.length ? ps[idx] : undefined;
        if (!victim) return { ok: false, reason: "bad tab index" };
        if (ps.length <= 1) return { ok: false, reason: "cannot close the last tab" };
        if (victim === selPage) selPage = ps[ps.length - 1] === victim ? ps[0] : ps[ps.length - 1];
        await victim.close().catch(() => {});
        await attachSel(); scheduleTabsPush();
        return { ok: true };
      }
      if (m.t === "tabsel") {
        lastUserSelAt = Date.now(); // human picks — hold the viewport there
        const ps = ctx!.pages(); const p = ps[m.i ?? -1];
        if (p) { selPage = p; page = p; await p.bringToFront().catch(() => {}); await attachSel(); scheduleTabsPush(); }
        return { ok: true, url: selPage?.url() };
      }
      page = selPage || page;
      // stage-n: the SPA reports its viewport size; restart screencast at
      // that resolution (capped at 2560x1600) so the stream matches the
      // panel — sharpest display without wasting bandwidth.
      if (m.t === "resize" && typeof m.w === "number" && typeof m.h === "number") {
        const w = Math.min(Math.max(Math.round(m.w), 320), 2560);
        const h = Math.min(Math.max(Math.round(m.h), 200), 1600);
        // stage-n (bridge review): jitter + rate guard — two viewers of
        // different pane sizes used to thrash the shared viewport (every
        // ResizeObserver tick restarted everyone's screencast). Ignore deltas
        // < 40px (scrollbar/rounding noise) and require >=600ms between
        // applications (first significant sender wins until it settles).
        if (Math.abs(w - streamW) < 40 && Math.abs(h - streamH) < 40) return { ok: true };
        if (Date.now() - lastResizeApplied < 600) return { ok: true };
        lastResizeApplied = Date.now();
        if (w !== streamW || h !== streamH) {
          const c = cdp;
          streamW = w; streamH = h;
          // The PAGE viewport must match too — screencast can only output
          // what the page renders; a 1280x800 page upscaled to a 1920 panel
          // is blurry. Resize the page (and the shared viewport semantics
          // stay: every viewer sees the same stream).
          try { await page.setViewportSize({ width: w, height: h }); } catch { /* page closed */ }
          // A concurrent tabsel replaced the CDP session during the await —
          // attachSel already restarted the screencast with the new streamW/H.
          if (cdp === c) {
            try {
              await c.send("Page.stopScreencast");
              await (c.send as (m: string, p?: unknown) => Promise<unknown>)("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1, maxWidth: streamW, maxHeight: streamH, maxFrameRate: 15 });
            } catch { /* screencast mid-restart — next frame continues */ }
          }
        }
        return { ok: true };
      }
      if (m.t === "nav") {
        fwdFlags.set(page, false);
        try {
          await page.goto(m.url as string, { waitUntil: "domcontentloaded" });
        } catch (e) {
          // playwright can report ERR_ABORTED while the navigation still
          // commits fine (leaving about:/data: docs) — verify the landing
          // before declaring failure, else the panel gets a false error.
          const want = String(m.url || "").trim();
          const got = page.url();
          if (!(got === want || got.startsWith(want) || (want.endsWith("/") && got === want.slice(0, -1)))) throw e;
        }
        scheduleTabsPush();
      }
      // stage-n: real-browser navigation controls — back / forward / reload.
      // canFwd reflects the ACTUAL result (the old code set fwdAvailable
      // before goBack could fail → forward button enabled at the first entry).
      else if (m.t === "back") { const r = await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null); fwdFlags.set(page, r !== null); scheduleTabsPush(); }
      else if (m.t === "fwd") { const r = await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null); fwdFlags.set(page, r !== null); scheduleTabsPush(); }
      else if (m.t === "reload") { fwdFlags.set(page, false); await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {}); scheduleTabsPush(); }
      else if (m.t === "m") {
        const type = m.k === "down" ? "mousePressed" : m.k === "up" ? "mouseReleased" : "mouseMoved";
        const btn = (m.k === "down" || m.k === "up") ? "left" : "none";
        await (cdp.send as (m: string, p?: unknown) => Promise<unknown>)("Input.dispatchMouseEvent", { type, x: m.x ?? 0, y: m.y ?? 0, button: btn, clickCount: btn !== "none" ? 1 : undefined });
      } else if (m.t === "wheel") {
        scheduleFastFrame();
        await (cdp.send as (m: string, p?: unknown) => Promise<unknown>)("Input.dispatchMouseEvent", { type: "mouseWheel", x: m.x ?? 0, y: m.y ?? 0, deltaX: m.dx || 0, deltaY: m.dy || 0 });
      } else if (m.t === "k") {
        scheduleFastFrame();
        const type = m.down ? (m.text ? "keyDown" : "rawKeyDown") : "keyUp";
        const p: Record<string, unknown> = { type, key: m.key, code: m.code, windowsVirtualKeyCode: m.vk || 0 };
        if (m.down && m.text) p.text = m.text;
        await (cdp.send as (m: string, p?: unknown) => Promise<unknown>)("Input.dispatchKeyEvent", p);
      }
      // NOTE (round-146 comment superseded): the resize branch is BACK with
      // guards (jitter <40px, 600ms rate limit, stale-cdp skip). The old
      // removal fought multi-viewer thrash by banning resize outright; the
      // guards keep the sharpest-image win without that regression.
    } catch (e) {
      // stage-n (bridge review): HIGH-frequency input events may swallow
      // transient races; COMMAND failures must surface (a failed nav used to
      // return a bare success receipt → the panel waited forever on a page
      // that never navigated).
      const msg = String((e as Error)?.message || e).slice(0, 200);
      if (m.t === "m" || m.t === "k" || m.t === "wheel") return undefined;
      lastErr = `input:${m.t}:${msg}`;
      return { error: msg };
    }
    return undefined;
  }

  // --- Minimal WebSocket server (no dependencies) ---
  const sockets = new Set<Duplex>();
  let lastCmd: string | null = null, lastErr: string | null = null;
  const isLoop = (rq: http.IncomingMessage): boolean => { const a = (rq.socket && rq.socket.remoteAddress) || ""; return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"; };
  const authed = (u: URL, rq: http.IncomingMessage): boolean => !TOKEN || u.searchParams.get("t") === TOKEN || isLoop(rq);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    if (!authed(u, req)) { res.writeHead(403); res.end(); return; }
    if (u.pathname === "/diag") {
      // round-138 debugging: watch viewer count/last-frame time/page state
      // to locate "viewers but no frames".
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        sockets: sockets.size,
        lastCmd, lastErr,
        sinceLastFrameMs: lastJpeg ? Date.now() - lastAck : -1,
        hasFrame: !!lastJpeg,
        pages: ctx!.pages().length,
        selUrl: (selPage || page)?.url?.() ?? null,
      }));
      return;
    }
    if (u.pathname === "/frame") {
      // Deterministic capture: headless pages emit no compositor frames while
      // idle, so CDP screencast alone yields nothing to poll. Take a real
      // screenshot per request (deduped while one is in flight).
      const serve = (jpeg: Buffer): void => {
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
        res.end(jpeg);
      };
      if (!lastJpeg || Date.now() - lastAck > 400) {
        const target = selPage || page;
        target.screenshot({ type: "jpeg", quality: 55 })
          .then((jpeg) => { lastJpeg = jpeg; lastAck = Date.now(); serve(jpeg); })
          .catch(() => { if (lastJpeg) serve(lastJpeg); else { res.writeHead(204); res.end(); } });
      } else if (lastJpeg) { serve(lastJpeg); }
      return;
    }
    if (u.pathname === "/input") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
        req.on("end", () => { try { handleInput(JSON.parse(body)); } catch {} res.writeHead(204); res.end(); });
      } else {
        // stage-n (bridge review): the sync JSON.parse sat OUTSIDE any handler
        // — one malformed ?d= crashed the whole bridge (uncaughtException →
        // 9224 dark until reboot).
        let m: Msg;
        try { m = JSON.parse(u.searchParams.get("d") || "{}"); }
        catch { res.writeHead(400); res.end(); return; }
        handleInput(m)
          .then((out) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out || {})); })
          .catch(() => { res.writeHead(204); res.end(); });
      }
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><title>vale bridge</title><body style=\"background:#111;color:#eee;font-family:sans-serif\">vale browser bridge running</body></html>");
  });
  srv.on("upgrade", (req, sock: Duplex) => {
    const url = new URL(req.url || "/", "http://x");
    if (TOKEN && url.searchParams.get("t") !== TOKEN) { sock.destroy(); return; }
    const key = req.headers["sec-websocket-key"];
    if (!key) { sock.destroy(); return; }
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n");
    sockets.add(sock);
    let rem: Buffer = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      rem = Buffer.concat([rem, d]);
      // stage-n (bridge review): client frames are tiny JSON commands — a
      // huge declared length used to grow the remainder buffer forever.
      if (rem.length > 2_000_000) { sock.destroy(); return; }
      rem = decodeClientFrames(rem, async (msg) => {
        let m: Msg; try { m = JSON.parse(msg); } catch { return; }
        // round-138: single dispatch — the old code manually re-injected
        // nav/m/k CDP commands after handleInput (a click equaled pressing
        // twice); now everything goes through handleInput.
        lastCmd = JSON.stringify(m).slice(0, 120);
        let out: Record<string, unknown> | undefined;
        let threw = false;
        try { out = await handleInput(m) as Record<string, unknown> | undefined; }
        catch (e) { threw = true; lastErr = String(e && (e as Error).message || e).slice(0, 120); }
        // stage-n (stress run): lastErr is a CURRENT-FAULT gauge, not a
        // history tape — one benign superseded ERR_ABORTED used to stay
        // "visible" all session. Command succeeded → clear; command
        // returned {error} → record it.
        if (!threw) {
          const errField = out && typeof out.error === "string" ? out.error : null;
          lastErr = errField ? `input:${m.t}:${errField}`.slice(0, 120) : null;
        }
        // round-137 Plan C: request receipts carrying an id (the correlation
        // key for queries like tabs/diag), so the panel gets structured
        // answers without side-channel polling.
        // round-138: payload must be a Buffer — passing a raw string makes
        // encodeFrame's Buffer.concat throw ERR_INVALID_ARG_TYPE, silently
        // swallowed by try/catch, and the receipt never goes out (hit on d1
        // direct-connect testing).
        if (typeof m.id !== "undefined" && sock.writable) {
          try { sock.write(encodeFrame(1, Buffer.from(JSON.stringify(Object.assign({ id: m.id }, out || {}))))); } catch {}
        }
      });
    });
    sock.on("close", () => { sockets.delete(sock); slowSockets.delete(sock); });
    sock.on("error", () => { sockets.delete(sock); slowSockets.delete(sock); });
  });

  // --- Screencast: JPEG frames -> all sockets ---
  let lastJpeg: Buffer | null = null;
  let lastAck = 0;
  let capturing = false;

  // stage-n (bridge review): frame writes were fire-and-forget — a stalled
  // viewer (hung tunnel) grew the socket's internal buffer forever at ≤15
  // JPEGs/s. Frames are latest-wins, so dropping for a slow socket until it
  // drains is free correctness (and keeps memory bounded).
  const slowSockets = new Set<Duplex>();
  function broadcast(f: Buffer): void {
    for (const s of sockets) {
      if (slowSockets.has(s)) continue;
      try {
        if (!s.write(f)) {
          slowSockets.add(s);
          s.once("drain", () => slowSockets.delete(s));
        }
      } catch { /* close/error handlers drop the socket */ }
    }
  }

  function pushFrame(jpeg: Buffer): void {
    lastJpeg = jpeg;
    lastAck = Date.now();
    broadcast(encodeFrame(2, jpeg));
  }

  function bindScreencast(c: import("playwright-core").CDPSession): void {
    c.on("Page.screencastFrame", async (ev) => {
      try { await c.send("Page.screencastFrameAck", { sessionId: ev.sessionId }); } catch {}
      const jpeg = Buffer.from(ev.data, "base64");
      if (jpeg.length < 800) return; // skip near-empty frames
      pushFrame(jpeg);
    });
  }

  // round-137 Plan C: idle-frame guarantee. Screencast is change-driven —
  // when a headless page is visually idle the compositor emits no frames,
  // and WS viewers stare at the last stale image. With viewers present and
  // >700ms of silence, fall back to one real screenshot (static page ≤1
  // capture/s vs the old polling path's 7 req/s + ≤2.5 captures/s; active
  // pages are handled by screencast, no stacking).
  setInterval(() => {
    if (sockets.size === 0 || capturing) return;
    if (Date.now() - lastAck < 1500) return; // animation is handled by screencast
    const target = selPage || page;
    if (!target) return;
    capturing = true;
    // round-150: final frame for static pages — high-quality q90 so text on
    // idle pages stays sharp
    target.screenshot({ type: "jpeg", quality: 90 })
      .then((jpeg) => pushFrame(jpeg))
      .catch(() => {})
      .finally(() => { capturing = false; });
  }, 300);

  await new Promise<void>((r) => srv.listen(PORT, "127.0.0.1", () => r()));
  console.log(`bridge listening on 127.0.0.1:${PORT} profile=${USER_DATA_DIR}`);

  // Start streaming + keepalive
  await (cdp.send as (m: string, p?: unknown) => Promise<unknown>)("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1, maxWidth: streamW, maxHeight: streamH, maxFrameRate: 15 });
  setInterval(async () => {
    // Nudge the renderer so idle pages still emit a frame every ~2s.
    try { await page.evaluate(() => void 0); } catch {}
  }, 2000);
})().catch(e => { logErr("IIFE FATAL", e); process.exit(1); });
