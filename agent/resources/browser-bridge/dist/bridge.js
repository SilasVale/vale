#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
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
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
const http = __importStar(require("http"));
// round-163: resolve the bundle NEXT TO bridge.js (InstallDir\playwright) —
// the old default hardcoded the RETIRED D:/vale-agent path, so every device
// installed elsewhere (d1 = D:\Vale) failed with MODULE_NOT_FOUND and the
// live browser view never came up. Env override kept for manual runs.
const PW = process.env.BRIDGE_PW_MODULES
    || path.join(__dirname, "playwright", "node_modules");
const { chromium } = require(path.join(PW, "playwright-core"));
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
        if (fs.existsSync(path.join(d, "playwright")))
            return d;
        const parent = path.dirname(d);
        if (parent === d)
            break;
        d = parent;
    }
    return process.env.VALE_AGENT_DIR || "D:/vale-agent";
})(), "bridge-err.log");
function logErr(tag, err) {
    const line = `[${new Date().toISOString()}] ${tag}: ${err && err.stack || err}\n`;
    try {
        fs.appendFileSync(ERR_LOG, line);
    }
    catch (_) { /* best effort */ }
    // Also surface to stderr in case a parent is watching.
    try {
        process.stderr.write(line);
    }
    catch (_) { }
}
const [, , portArg, tokenArg, dirArg] = process.argv;
const PORT = Number(portArg || 9224);
const TOKEN = tokenArg || "";
const USER_DATA_DIR = dirArg || "C:/Users/Administrator/AppData/Local/vale-browser-profile";
// Headless pages emit no compositor frames while visually idle; a styled
// welcome page guarantees the first screencast frames are non-empty.
const WELCOME = "data:text/html," + encodeURIComponent("<body style=\"margin:0;background:linear-gradient(135deg,#f59f00,#e8590c);color:#fff;font-family:sans-serif;padding:48px;font-size:30px\">Vale 远程浏览器已就绪<br><span style=\"font-size:16px;opacity:.8\">在上方地址栏输入网址开始</span></body>");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function wsAccept(key) {
    return crypto.createHash("sha1").update(key + GUID).digest("base64");
}
function encodeFrame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) {
        head = Buffer.from([0x80 | opcode, len]);
    }
    else if (len < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x80 | opcode;
        head[1] = 126;
        head.writeUInt16BE(len, 2);
    }
    else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | opcode;
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([head, payload]);
}
function decodeClientFrames(buf, onMessage) {
    let off = 0;
    while (off + 2 <= buf.length) {
        const fin = buf[off] & 0x80, op = buf[off] & 0x0f;
        let len = buf[off + 1] & 0x7f, mask = !!(buf[off + 1] & 0x80), pos = off + 2;
        if (len === 126) {
            len = buf.readUInt16BE(pos);
            pos += 2;
        }
        else if (len === 127) {
            len = Number(buf.readBigUInt64BE(pos));
            pos += 8;
        }
        if (mask)
            pos += 4;
        if (pos + len > buf.length)
            break;
        const data = buf.slice(pos, pos + len);
        if (mask) {
            const m = buf.slice(pos - 4, pos);
            for (let i = 0; i < data.length; i++)
                data[i] ^= m[i % 4];
        }
        off = pos + len;
        if (op === 1 && fin)
            onMessage(data.toString("utf8"));
        // op 8 = close, 9 = ping (client pings are rare; we ignore, rely on TCP)
    }
    return buf.slice(off); // remainder
}
(async () => {
    // round-143: launchPersistentContext fails transiently when a previous
    // bridge's chromium is still releasing the profile (SingletonLock), or
    // when the Windows swap script's kill-tree races our spawn. Retry a few
    // times with a short backoff before giving up — each attempt logs to the
    // durable bridge-err.log so the next agent boot has evidence.
    const MAX_LAUNCH_ATTEMPTS = 4;
    let ctx = null;
    for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt++) {
        try {
            ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
                headless: true, viewport: { width: 1280, height: 800 },
            });
            break;
        }
        catch (e) {
            logErr(`launchPersistentContext attempt ${attempt}/${MAX_LAUNCH_ATTEMPTS} failed`, e);
            if (attempt === MAX_LAUNCH_ATTEMPTS)
                throw e;
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    let page = ctx.pages()[0] || await ctx.newPage();
    if (page.url() === "about:blank")
        await page.goto(WELCOME).catch(() => { });
    let cdp = await ctx.newCDPSession(page);
    // External tab events: pages opened/closed by the site itself (window.open,
    // target=_blank, JS close) and any in-page navigation change the tab list —
    // push instead of waiting for the panel to ask.
    ctx.on("page", (p) => {
        scheduleTabsPush();
        p.on("framenavigated", () => scheduleTabsPush());
        p.on("close", () => scheduleTabsPush());
    });
    for (const p of ctx.pages()) {
        p.on("framenavigated", () => scheduleTabsPush());
        p.on("close", () => scheduleTabsPush());
    }
    // Multi-tab (M2): selPage tracked by object identity; refresh() re-syncs
    // after closes and switches the CDP pipe so screencast follows selection.
    let selPage = page;
    function pagesList() {
        const ps = ctx.pages();
        if (!ps.includes(selPage))
            selPage = ps[0] || null;
        return ps;
    }
    async function attachSel() {
        try {
            await cdp.detach();
        }
        catch { }
        if (!selPage)
            return;
        cdp = await ctx.newCDPSession(selPage);
        bindScreencast(cdp);
        // maxFrameRate exists in newer playwright-core (1.63+); 1.62's types
        // lack it — cast the call to keep the runtime value (device bundle has it).
        await cdp.send("Page.startScreencast", { format: "jpeg", quality: 45, everyNthFrame: 1, maxWidth: 1280, maxHeight: 800, maxFrameRate: 15 }).catch(() => { });
    }
    // round-163: push the tab list to viewers when it CHANGES (open/close/
    // select/navigate) — the panel dropped its 1.5s tabs poll for this.
    function pushTabs() {
        try {
            if (!ctx)
                return;
            const f = encodeFrame(1, Buffer.from(JSON.stringify({
                ev: "tabs",
                tabs: ctx.pages().map((p, i) => ({ i, url: p.url() })),
                sel: ctx.pages().indexOf(selPage),
            })));
            for (const s of sockets) {
                try {
                    s.write(f);
                }
                catch { }
            }
        }
        catch (_) { }
    }
    let tabsDebounce = null;
    function scheduleTabsPush() {
        if (tabsDebounce)
            return;
        tabsDebounce = setTimeout(() => { tabsDebounce = null; pushTabs(); }, 150);
    }
    // round-150: immediate frame on input — if no new screencast frame
    // arrives within 300ms after a mouse/keyboard event (a click/scroll
    // that didn't repaint the page), screenshot and push one frame now to
    // kill the "clicked but nothing happened" feel.
    let fastTimer = null;
    function scheduleFastFrame() {
        if (fastTimer || capturing)
            return;
        fastTimer = setTimeout(async () => {
            fastTimer = null;
            if (Date.now() - lastAck < 120)
                return;
            const target = selPage || page;
            if (!target || capturing)
                return;
            capturing = true;
            try {
                const jpeg = await target.screenshot({ type: "jpeg", quality: 60 });
                if (jpeg.length >= 800)
                    pushFrame(jpeg);
            }
            catch (_) { }
            finally {
                capturing = false;
            }
        }, 300);
    }
    // --- Shared input dispatcher (WS + HTTP) ---
    async function handleInput(m) {
        try {
            if (m.t === "diag") {
                const info = await page.evaluate(() => {
                    const a = document.querySelector("a");
                    const r = a ? a.getBoundingClientRect() : null;
                    return { title: document.title, url: location.href, link: r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (a.textContent || "").trim() } : null };
                });
                return info;
            }
            if (m.t === "tabs") {
                pagesList();
                return { tabs: ctx.pages().map((p, i) => ({ i, url: p.url() })), sel: ctx.pages().indexOf(selPage) };
            }
            if (m.t === "tabnew") {
                const np = await ctx.newPage();
                await np.goto(m.url || WELCOME, { waitUntil: "domcontentloaded" }).catch(() => { });
                selPage = np;
                await attachSel();
                scheduleTabsPush();
                return { ok: true };
            }
            if (m.t === "tabclose") {
                pagesList();
                const ps = ctx.pages();
                const victim = ps[m.i ?? -1];
                if (victim && ps.length > 1) {
                    if (victim === selPage)
                        selPage = ps[ps.length - 1] === victim ? ps[0] : ps[ps.length - 1];
                    await victim.close();
                    await attachSel();
                    scheduleTabsPush();
                }
                return { ok: true };
            }
            if (m.t === "tabsel") {
                const ps = ctx.pages();
                const p = ps[m.i ?? -1];
                if (p) {
                    selPage = p;
                    page = p;
                    await p.bringToFront().catch(() => { });
                    await attachSel();
                    scheduleTabsPush();
                }
                return { ok: true, url: selPage?.url() };
            }
            page = selPage || page;
            if (m.t === "nav") {
                await page.goto(m.url, { waitUntil: "domcontentloaded" });
                scheduleTabsPush();
            }
            // stage-n: real-browser navigation controls — back / forward / reload.
            else if (m.t === "back") {
                await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => { });
                scheduleTabsPush();
            }
            else if (m.t === "fwd") {
                await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => { });
                scheduleTabsPush();
            }
            else if (m.t === "reload") {
                await page.reload({ waitUntil: "domcontentloaded" }).catch(() => { });
                scheduleTabsPush();
            }
            else if (m.t === "m") {
                const type = m.k === "down" ? "mousePressed" : m.k === "up" ? "mouseReleased" : "mouseMoved";
                const btn = (m.k === "down" || m.k === "up") ? "left" : "none";
                await cdp.send("Input.dispatchMouseEvent", { type, x: m.x ?? 0, y: m.y ?? 0, button: btn, clickCount: btn !== "none" ? 1 : undefined });
            }
            else if (m.t === "wheel") {
                scheduleFastFrame();
                await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: m.x ?? 0, y: m.y ?? 0, deltaX: m.dx || 0, deltaY: m.dy || 0 });
            }
            else if (m.t === "k") {
                scheduleFastFrame();
                const type = m.down ? (m.text ? "keyDown" : "rawKeyDown") : "keyUp";
                const p = { type, key: m.key, code: m.code, windowsVirtualKeyCode: m.vk || 0 };
                if (m.down && m.text)
                    p.text = m.text;
                await cdp.send("Input.dispatchKeyEvent", p);
            }
            // round-146: the {t:"resize"} branch is GONE. The bridge viewport is
            // FIXED at 1280x800 — the panel renders that feed with object-fit:cover
            // per pane, so no client (old or new) may resize the shared viewport.
            // round-144's resize sync had several live panels fighting over ONE
            // global viewport; the last sender won and everyone else letterboxed.
        }
        catch (e) { /* transient races fine */ }
        return undefined;
    }
    // --- Minimal WebSocket server (no dependencies) ---
    const sockets = new Set();
    let lastCmd = null, lastErr = null;
    const isLoop = (rq) => { const a = (rq.socket && rq.socket.remoteAddress) || ""; return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"; };
    const authed = (u, rq) => !TOKEN || u.searchParams.get("t") === TOKEN || isLoop(rq);
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url || "/", "http://x");
        if (!authed(u, req)) {
            res.writeHead(403);
            res.end();
            return;
        }
        if (u.pathname === "/diag") {
            // round-138 debugging: watch viewer count/last-frame time/page state
            // to locate "viewers but no frames".
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify({
                sockets: sockets.size,
                lastCmd, lastErr,
                sinceLastFrameMs: lastJpeg ? Date.now() - lastAck : -1,
                hasFrame: !!lastJpeg,
                pages: ctx.pages().length,
                selUrl: (selPage || page)?.url?.() ?? null,
            }));
            return;
        }
        if (u.pathname === "/frame") {
            // Deterministic capture: headless pages emit no compositor frames while
            // idle, so CDP screencast alone yields nothing to poll. Take a real
            // screenshot per request (deduped while one is in flight).
            const serve = (jpeg) => {
                res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
                res.end(jpeg);
            };
            if (!lastJpeg || Date.now() - lastAck > 400) {
                const target = selPage || page;
                target.screenshot({ type: "jpeg", quality: 55 })
                    .then((jpeg) => { lastJpeg = jpeg; lastAck = Date.now(); serve(jpeg); })
                    .catch(() => { if (lastJpeg)
                    serve(lastJpeg);
                else {
                    res.writeHead(204);
                    res.end();
                } });
            }
            else if (lastJpeg) {
                serve(lastJpeg);
            }
            return;
        }
        if (u.pathname === "/input") {
            if (req.method === "POST") {
                let body = "";
                req.on("data", (c) => { body += c; if (body.length > 4096)
                    req.destroy(); });
                req.on("end", () => { try {
                    handleInput(JSON.parse(body));
                }
                catch { } res.writeHead(204); res.end(); });
            }
            else {
                handleInput(JSON.parse(u.searchParams.get("d") || "{}"))
                    .then((out) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out || {})); })
                    .catch(() => { res.writeHead(204); res.end(); });
            }
            return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><title>vale bridge</title><body style=\"background:#111;color:#eee;font-family:sans-serif\">vale browser bridge running</body></html>");
    });
    srv.on("upgrade", (req, sock) => {
        const url = new URL(req.url || "/", "http://x");
        if (TOKEN && url.searchParams.get("t") !== TOKEN) {
            sock.destroy();
            return;
        }
        const key = req.headers["sec-websocket-key"];
        if (!key) {
            sock.destroy();
            return;
        }
        sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n");
        sockets.add(sock);
        let rem = Buffer.alloc(0);
        sock.on("data", (d) => {
            rem = Buffer.concat([rem, d]);
            rem = decodeClientFrames(rem, async (msg) => {
                let m;
                try {
                    m = JSON.parse(msg);
                }
                catch {
                    return;
                }
                // round-138: single dispatch — the old code manually re-injected
                // nav/m/k CDP commands after handleInput (a click equaled pressing
                // twice); now everything goes through handleInput.
                lastCmd = JSON.stringify(m).slice(0, 120);
                let out;
                try {
                    out = await handleInput(m);
                }
                catch (e) {
                    lastErr = String(e && e.message || e).slice(0, 120);
                }
                // round-137 Plan C: request receipts carrying an id (the correlation
                // key for queries like tabs/diag), so the panel gets structured
                // answers without side-channel polling.
                // round-138: payload must be a Buffer — passing a raw string makes
                // encodeFrame's Buffer.concat throw ERR_INVALID_ARG_TYPE, silently
                // swallowed by try/catch, and the receipt never goes out (hit on d1
                // direct-connect testing).
                if (typeof m.id !== "undefined" && sock.writable) {
                    try {
                        sock.write(encodeFrame(1, Buffer.from(JSON.stringify(Object.assign({ id: m.id }, out || {})))));
                    }
                    catch { }
                }
            });
        });
        sock.on("close", () => sockets.delete(sock));
        sock.on("error", () => sockets.delete(sock));
    });
    // --- Screencast: JPEG frames -> all sockets ---
    let lastJpeg = null;
    let lastAck = 0;
    let capturing = false;
    function pushFrame(jpeg) {
        lastJpeg = jpeg;
        lastAck = Date.now();
        const frame = encodeFrame(2, jpeg);
        for (const s of sockets) {
            try {
                s.write(frame);
            }
            catch { }
        }
    }
    function bindScreencast(c) {
        c.on("Page.screencastFrame", async (ev) => {
            try {
                await c.send("Page.screencastFrameAck", { sessionId: ev.sessionId });
            }
            catch { }
            const jpeg = Buffer.from(ev.data, "base64");
            if (jpeg.length < 800)
                return; // skip near-empty frames
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
        if (sockets.size === 0 || capturing)
            return;
        if (Date.now() - lastAck < 1500)
            return; // animation is handled by screencast
        const target = selPage || page;
        if (!target)
            return;
        capturing = true;
        // round-150: final frame for static pages — high-quality q90 so text on
        // idle pages stays sharp
        target.screenshot({ type: "jpeg", quality: 90 })
            .then((jpeg) => pushFrame(jpeg))
            .catch(() => { })
            .finally(() => { capturing = false; });
    }, 300);
    await new Promise((r) => srv.listen(PORT, "127.0.0.1", () => r()));
    console.log(`bridge listening on 127.0.0.1:${PORT} profile=${USER_DATA_DIR}`);
    // Start streaming + keepalive
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 45, everyNthFrame: 1, maxWidth: 1280, maxHeight: 800, maxFrameRate: 15 });
    setInterval(async () => {
        // Nudge the renderer so idle pages still emit a frame every ~2s.
        try {
            await page.evaluate(() => void 0);
        }
        catch { }
    }, 2000);
})().catch(e => { logErr("IIFE FATAL", e); process.exit(1); });
