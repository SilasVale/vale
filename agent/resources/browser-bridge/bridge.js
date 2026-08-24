#!/usr/bin/env node
/**
 * browser-bridge — interactive remote browser core (round-135, M1).
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
const path = require('path');
const PW = process.env.BRIDGE_PW_MODULES || 'D:/vale-agent/playwright/node_modules';
const { chromium } = require(path.join(PW, 'playwright-core'));
const crypto = require('crypto');

const [, , portArg, tokenArg, dirArg] = process.argv;
const PORT = Number(portArg || 9224);
const TOKEN = tokenArg || '';
const USER_DATA_DIR = dirArg || 'C:/Users/Administrator/AppData/Local/vale-browser-profile';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

function decodeClientFrames(buf, onMessage) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const fin = buf[off] & 0x80, op = buf[off] & 0x0f;
    let len = buf[off + 1] & 0x7f, mask = !!(buf[off + 1] & 0x80), pos = off + 2;
    if (len === 126) { len = buf.readUInt16BE(pos); pos += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(pos)); pos += 8; }
    if (mask) pos += 4;
    if (pos + len > buf.length) break;
    let data = buf.slice(pos, pos + len);
    if (mask) { const m = buf.slice(pos - 4, pos); for (let i = 0; i < data.length; i++) data[i] ^= m[i % 4]; }
    off = pos + len;
    if (op === 1 && fin) onMessage(data.toString('utf8'));
    // op 8 = close, 9 = ping (client pings are rare; we ignore, rely on TCP)
  }
  return buf.slice(off); // remainder
}

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true, viewport: { width: 1280, height: 800 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('about:blank').catch(() => {});
  const cdp = await ctx.newCDPSession(page);

  // --- Minimal WebSocket server (no dependencies) ---
  const http = require('http');
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>vale bridge</title><body style="background:#111;color:#eee;font-family:sans-serif">vale browser bridge running</body></html>');
  });
  srv.on('upgrade', (req, sock) => {
    const url = new URL(req.url, 'http://x');
    if (TOKEN && url.searchParams.get('t') !== TOKEN) { sock.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { sock.destroy(); return; }
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
    sockets.add(sock);
    let rem = Buffer.alloc(0);
    sock.on('data', (d) => {
      rem = Buffer.concat([rem, d]);
      rem = decodeClientFrames(rem, async (msg) => {
        let m; try { m = JSON.parse(msg); } catch { return; }
        try {
          if (m.t === 'nav') await page.goto(m.url, { waitUntil: 'domcontentloaded' });
          else if (m.t === 'm') {
            const type = m.k === 'down' ? 'mousePressed' : m.k === 'up' ? 'mouseReleased' : 'mouseMoved';
            const btn = (m.k === 'down' || m.k === 'up') ? 'left' : 'none';
            const clickCount = (m.k === 'down' || m.k === 'up') ? 1 : undefined;
            await cdp.send('Input.dispatchMouseEvent', { type, x: m.x, y: m.y, button: btn, clickCount, buttons: m.k === 'down' ? 1 : 0 });
          } else if (m.t === 'wheel') {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: m.x, y: m.y, deltaX: m.dx || 0, deltaY: m.dy || 0 });
          } else if (m.t === 'k') {
            const type = m.down ? (m.text ? 'keyDown' : 'rawKeyDown') : 'keyUp';
            const p = { type, key: m.key, code: m.code, windowsVirtualKeyCode: m.vk || 0 };
            if (m.down && m.text) p.text = m.text;
            await cdp.send('Input.dispatchKeyEvent', p);
          } else if (m.t === 'resize') {
            await page.setViewportSize({ width: m.w | 0, height: m.h | 0 });
          }
        } catch (e) { /* transient input races are fine */ }
      });
    });
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => sockets.delete(sock));
  });

  // --- Screencast: JPEG frames -> all sockets ---
  let lastAck = 0;
  cdp.on('Page.screencastFrame', async (ev) => {
    try { await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch {}
    const jpeg = Buffer.from(ev.data, 'base64');
    if (jpeg.length < 800) return; // skip near-empty frames
    lastAck = Date.now();
    const frame = encodeFrame(2, jpeg);
    for (const s of sockets) { try { s.write(frame); } catch {} }
  });

  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  console.log(`bridge listening on 127.0.0.1:${PORT} profile=${USER_DATA_DIR}`);

  // Start streaming + keepalive
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, everyNthFrame: 1, maxWidth: 1280, maxHeight: 800 });
  setInterval(async () => {
    // Nudge the renderer so idle pages still emit a frame every ~2s.
    try { await page.evaluate(() => void 0); } catch {}
  }, 2000);
})().catch(e => { console.error('BRIDGE ERR', e.message); process.exit(1); });
