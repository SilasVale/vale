// Vale Agent — install / download landing page (Cloudflare Worker).
//
// This Worker is the download site for vale-agent. Device management
// (registry + MCP config + panel proxy) lives in the Vale console
// (admin-only). This page distributes the npm tgz (the SINGLE install/update
// channel — NSIS installer retired 2026-08-28) and points users to the
// console. The console URL is set per-deployment via the CONSOLE_URL var
// (no production domain is hardcoded here).
//
// Design aligned with DeepSeek Harness (DSH) web GUI: dark-first design
// system, --dsw-alias-* tokens, 12px radius cards, layered shadows.

// One-time-download claim serializer (Durable Object, see ./claim.js).
// Re-exported so wrangler binds TEMP_CLAIM to it.
export { TempClaimDO } from "./claim.js";

const FAVICON = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2248%22%20height%3D%2248%22%20viewBox%3D%220%200%2048%2048%22%3E%0A%20%20%3C%21--%20Vale%20brand%20mark%3A%20the%20vale%20at%20sunrise%20%E2%80%94%20near%20hill%2C%20far%20ridge%2C%20signal%20over%20the%20pass%20--%3E%0A%20%20%3Cdefs%3E%0A%20%20%20%20%3ClinearGradient%20id%3D%22sky%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23f59f00%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23e8590c%22%2F%3E%0A%20%20%20%20%3C%2FlinearGradient%3E%0A%20%20%20%20%3CradialGradient%20id%3D%22glow%22%20cx%3D%22.5%22%20cy%3D%22.5%22%20r%3D%22.5%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23fff8e1%22%20stop-opacity%3D%22.55%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23ffe8a3%22%20stop-opacity%3D%220%22%2F%3E%0A%20%20%20%20%3C%2FradialGradient%3E%0A%20%20%20%20%3ClinearGradient%20id%3D%22sheen%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23ffffff%22%20stop-opacity%3D%22.25%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23ffffff%22%20stop-opacity%3D%220%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%221%22%20stop-color%3D%22%237c2d12%22%20stop-opacity%3D%22.10%22%2F%3E%0A%20%20%20%20%3C%2FlinearGradient%3E%0A%20%20%3C%2Fdefs%3E%0A%0A%20%20%3Crect%20width%3D%2248%22%20height%3D%2248%22%20rx%3D%2211%22%20fill%3D%22url%28%23sky%29%22%2F%3E%0A%0A%20%20%3C%21--%20signal%20rising%20over%20the%20pass%20--%3E%0A%20%20%3Ccircle%20cx%3D%2221%22%20cy%3D%2214%22%20r%3D%227.5%22%20fill%3D%22url%28%23glow%29%22%2F%3E%0A%20%20%3Ccircle%20cx%3D%2221%22%20cy%3D%2214%22%20r%3D%224%22%20fill%3D%22%23fff8e1%22%2F%3E%0A%0A%20%20%3C%21--%20far%20ridge%20%28haze%29%20--%3E%0A%20%20%3Cpath%20fill%3D%22%23ffffff%22%20opacity%3D%22.78%22%20d%3D%22M14%2041Q26%2016%2044%2041Z%22%2F%3E%0A%20%20%3C%21--%20near%20hill%20%28solid%29%20--%3E%0A%20%20%3Cpath%20fill%3D%22%23ffffff%22%20d%3D%22M2%2041Q12%2020%2024%2041Z%22%2F%3E%0A%0A%20%20%3C%21--%20glass%20sheen%20--%3E%0A%20%20%3Crect%20width%3D%2248%22%20height%3D%2248%22%20rx%3D%2211%22%20fill%3D%22url%28%23sheen%29%22%2F%3E%0A%3C%2Fsvg%3E%0A";

const PAGE = (consoleUrl, installerUrl) => {
// P2-8: both URLs flow into HTML (href attributes + inline <code> text).
// They derive from the CONSOLE_URL env var / request origin, so treat them
// as untrusted: https-only whitelist (http allowed solely for loopback dev)
// + HTML-escape at the interpolation points. A crafted CONSOLE_URL must
// never break out of the attribute/element (stored-XSS via env var).
const safeConsole = escHtml(safePageUrl(consoleUrl, "/"));
const safeInstaller = escHtml(safePageUrl(installerUrl, "/vale-agent/vale-agent-latest.tgz"));
return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vale Agent</title>
<link rel="icon" href="${FAVICON}">
<style>
  :root {
    /* DSH-aligned design tokens — light theme */
    --dsw-alias-bg-base: #ffffff;
    --dsw-alias-bg-layer-1: #f7f8f9;
    --dsw-alias-bg-layer-2: #f0f1f3;
    --dsw-alias-bg-mask-1: rgba(0,0,0,0.4);
    --dsw-alias-label-primary: #0f1115;
    --dsw-alias-label-secondary: #5f666b;
    --dsw-alias-label-tertiary: #81858c;
    --dsw-alias-label-dimmed: #b0b4ba;
    --dsw-alias-border-l1: rgba(0,0,0,0.06);
    --dsw-alias-border-l2: rgba(0,0,0,0.10);
    --dsw-alias-border-l3: rgba(0,0,0,0.14);
    --dsw-alias-brand-primary: #4d6bfe;
    --dsw-alias-button-primary-fill: #0f1115;
    --dsw-alias-button-primary-hover: #2a2d33;
    --dsw-alias-button-primary-foreground: #ffffff;
    --dsw-alias-state-business-primary: #4d6bfe;
    --dsw-alias-state-success-primary: #22c55e;
    --dsw-alias-state-error-primary: #ef4444;
    --dsw-alias-state-warn-primary: #f59e0b;
    --dsw-alias-interactive-bg-hover: rgba(0,0,0,0.04);
    --dsw-alias-interactive-bg-active: rgba(0,0,0,0.06);
    --dsw-shadow-lv1: 0 1px 2px rgba(0,0,0,0.06);
    --dsw-shadow-lv2: 0 4px 12px rgba(0,0,0,0.08);
    --dsw-shadow-lv3: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06);
    --ds-font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
    --ds-font-family-code: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";
    --ds-transition-duration: 0.15s;
    --ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  }

  body[data-ds-dark-theme] {
    --dsw-alias-bg-base: #151517;
    --dsw-alias-bg-layer-1: #1c1c1f;
    --dsw-alias-bg-layer-2: #232326;
    --dsw-alias-bg-mask-1: rgba(0,0,0,0.6);
    --dsw-alias-label-primary: #f9fafb;
    --dsw-alias-label-secondary: #cfd3d6;
    --dsw-alias-label-tertiary: #adb2b8;
    --dsw-alias-label-dimmed: #6b7078;
    --dsw-alias-border-l1: rgba(255,255,255,0.06);
    --dsw-alias-border-l2: rgba(255,255,255,0.10);
    --dsw-alias-border-l3: rgba(255,255,255,0.14);
    --dsw-alias-brand-primary: #6b8aff;
    --dsw-alias-button-primary-fill: #f9fafb;
    --dsw-alias-button-primary-hover: #e5e7eb;
    --dsw-alias-button-primary-foreground: #0f1115;
    --dsw-alias-state-business-primary: #6b8aff;
    --dsw-alias-interactive-bg-hover: rgba(255,255,255,0.06);
    --dsw-alias-interactive-bg-active: rgba(255,255,255,0.10);
    --dsw-shadow-lv1: 0 1px 2px rgba(0,0,0,0.24);
    --dsw-shadow-lv2: 0 4px 12px rgba(0,0,0,0.32);
    --dsw-shadow-lv3: 0 8px 24px rgba(0,0,0,0.40), 0 2px 6px rgba(0,0,0,0.24);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
    font: 14px/1.5 var(--ds-font-family);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    transition: background var(--ds-transition-duration) var(--ds-ease-in-out),
                color var(--ds-transition-duration) var(--ds-ease-in-out);
  }

  /* ── Layout ─────────────────────────────────────── */
  .app { display: flex; flex-direction: column; min-height: 100vh; }
  .main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 40px 24px; }
  .card { width: 100%; max-width: 440px; }

  /* ── Brand ──────────────────────────────────────── */
  .brand { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
  .brand-mark {
    display: block;
    width: 40px; height: 40px; border-radius: 10px;
    box-shadow: var(--dsw-shadow-lv1);
  }
  .brand-text { display: flex; flex-direction: column; gap: 2px; }
  .brand-name { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; color: var(--dsw-alias-label-primary); }
  .brand-tag {
    font: 11px/1 var(--ds-font-family-code);
    color: var(--dsw-alias-label-tertiary);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* ── Description ────────────────────────────────── */
  .desc {
    color: var(--dsw-alias-label-secondary);
    font-size: 14px;
    line-height: 1.6;
    margin-bottom: 24px;
  }
  .desc a {
    color: var(--dsw-alias-state-business-primary);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: border-color var(--ds-transition-duration) var(--ds-ease-in-out);
  }
  .desc a:hover { border-bottom-color: var(--dsw-alias-state-business-primary); }

  /* ── Primary action ─────────────────────────────── */
  .actions { display: flex; flex-direction: column; gap: 12px; margin-bottom: 28px; }
  .btn-primary {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    height: 40px; padding: 0 20px;
    background: var(--dsw-alias-button-primary-fill);
    color: var(--dsw-alias-button-primary-foreground);
    border: none; border-radius: 20px;
    font: 500 14px/1 var(--ds-font-family);
    cursor: pointer; text-decoration: none;
    transition: background var(--ds-transition-duration) var(--ds-ease-in-out),
                transform var(--ds-transition-duration) var(--ds-ease-in-out),
                box-shadow var(--ds-transition-duration) var(--ds-ease-in-out);
    box-shadow: var(--dsw-shadow-lv1);
  }
  .btn-primary:hover {
    background: var(--dsw-alias-button-primary-hover);
    transform: translateY(-1px);
    box-shadow: var(--dsw-shadow-lv2);
  }
  .btn-primary:active { transform: translateY(0); }
  .btn-primary:focus-visible {
    outline: 2px solid var(--dsw-alias-state-business-primary);
    outline-offset: 2px;
  }
  .btn-primary svg { width: 16px; height: 16px; flex: none; }
  .hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); line-height: 1.5; }

  /* ── Steps ──────────────────────────────────────── */
  .steps { display: flex; flex-direction: column; gap: 2px; }
  .step {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 12px 14px;
    border-radius: 12px;
    transition: background var(--ds-transition-duration) var(--ds-ease-in-out);
  }
  .step:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .step-num {
    flex: none; width: 22px; height: 22px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 50%;
    background: var(--dsw-alias-bg-layer-2);
    color: var(--dsw-alias-label-secondary);
    font: 500 12px/1 var(--ds-font-family);
    border: 1px solid var(--dsw-alias-border-l2);
    margin-top: 1px;
  }
  .step-body { font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
  .step-body a {
    color: var(--dsw-alias-state-business-primary);
    text-decoration: none;
  }
  .step-body a:hover { text-decoration: underline; }
  .step-body code {
    font: 12px/1.4 var(--ds-font-family-code);
    background: var(--dsw-alias-bg-layer-1);
    border: 1px solid var(--dsw-alias-border-l1);
    border-radius: 5px;
    padding: 1px 5px;
    color: var(--dsw-alias-label-primary);
  }

  /* ── Footer ─────────────────────────────────────── */
  footer {
    padding: 16px 24px;
    display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
    border-top: 1px solid var(--dsw-alias-border-l1);
    font-size: 12px; color: var(--dsw-alias-label-tertiary);
  }
  footer .mono { font-family: var(--ds-font-family-code); }

  /* ── Theme toggle ───────────────────────────────── */
  .theme-toggle {
    position: fixed; top: 16px; right: 16px; z-index: 10;
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px;
    background: var(--dsw-alias-bg-layer-1);
    border: 1px solid var(--dsw-alias-border-l2);
    border-radius: 8px;
    color: var(--dsw-alias-label-secondary);
    cursor: pointer;
    transition: background var(--ds-transition-duration) var(--ds-ease-in-out),
                color var(--ds-transition-duration) var(--ds-ease-in-out);
  }
  .theme-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
  .theme-toggle svg { width: 16px; height: 16px; }
  .theme-toggle .icon-sun { display: none; }
  body[data-ds-dark-theme] .theme-toggle .icon-moon { display: none; }
  body[data-ds-dark-theme] .theme-toggle .icon-sun { display: block; }

  /* ── Responsive ─────────────────────────────────── */
  @media (max-width: 480px) {
    .main { padding: 32px 16px; }
    footer { padding: 12px 16px; }
  }
</style>
</head>
<body>
<script>
// DSH-style theme init: respect system preference, allow manual toggle
(function() {
  var stored = localStorage.getItem('vale-theme');
  var systemDark = stored === null
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches;
  var dark = stored === 'dark' || (stored === null && systemDark);
  if (dark) document.body.setAttribute('data-ds-dark-theme', '');
})();
</script>

<div class="app">
  <button class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle theme">
    <svg class="icon-moon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.36 10.06A6 6 0 0 1 5.94 2.64 6 6 0 1 0 13.36 10.06Z"/></svg>
    <svg class="icon-sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/></svg>
  </button>

  <main class="main">
    <div class="card">
      <div class="brand">
        <img class="brand-mark" src="${FAVICON}" alt="Vale">
        <div class="brand-text">
          <div class="brand-name">Vale Agent</div>
          <div class="brand-tag">device agent</div>
        </div>
      </div>

      <p class="desc">Vale Agent is a device command center (serial / terminal / browser + MCP) that runs on a Windows machine. Each device is exposed over a Cloudflare Tunnel and managed from the <a href="${safeConsole}">Vale console</a>.</p>

      <div class="actions">
        <code class="cmd">npm i -g ${safeInstaller}</code>
        <span class="hint">Run on the Windows machine connected to the device. Requires Node.js + admin rights.</span>
      </div>

      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-body">Install the package: <code>npm i -g ${safeInstaller}</code> — then run <code>vale setup --reg-key &lt;key&gt;</code> (get a key from the <a href="${safeConsole}">Vale console</a> → Devices).</div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-body">The setup installs the agent service, auto-registers the device, and prints the panel URL + token. Copy them for the next step.</div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-body">Updates are the same channel: <code>npm i -g ${safeInstaller} && vale update</code>.</div>
        </div>
      </div>
    </div>
  </main>

  <footer>
    <span>Vale Agent — device access for AI agents</span>
    <span class="mono" id="foot-time"></span>
  </footer>
</div>

<script>
document.getElementById('foot-time').textContent = new Date().toISOString().replace('T',' ').slice(0,19) + ' UTC';

function toggleTheme() {
  var isDark = document.body.hasAttribute('data-ds-dark-theme');
  if (isDark) {
    document.body.removeAttribute('data-ds-dark-theme');
    localStorage.setItem('vale-theme', 'light');
  } else {
    document.body.setAttribute('data-ds-dark-theme', '');
    localStorage.setItem('vale-theme', 'dark');
  }
}
</script>
</body>
</html>`;
};

// P2-8 helpers: https-only URL whitelist (http allowed solely for loopback
// dev) + HTML escaping for the landing-page interpolations above.
function safePageUrl(u, fallback) {
  try {
    const s = String(u);
    const parsed = new URL(s, "https://placeholder.local");
    if (parsed.protocol === "https:") return s;
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1")) return s;
    return fallback;
  } catch {
    return fallback;
  }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// P2-9 helper: build a hardened Content-Disposition for an uploaded
// filename. Strips quotes/backslashes/controls (header-split defence),
// returns null when nothing survives (caller answers 400 — an illegal name
// must never reach the R2 put as a forged header); keeps the quoted
// filename parameter pure-ASCII and carries non-ASCII names via filename*
// (RFC 5987) with an ASCII fallback.
function buildContentDisposition(rawName) {
  const cleaned = String(rawName || "").replace(/["\\\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return null;
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "").trim() || "download.bin";
  if (ascii === cleaned) return `attachment; filename="${ascii}"`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`;
}

// P2-5: agent_update refuses unverifiable installs (round-119) — a
// truncated/placeholder sha in version.json must never be served as if it
// were a real manifest. Same shape as assert_want_sha256 in
// scripts/smoke-index.sh (the shared pre-publish guard): 64 hex chars.
const SHA256_RE = /^[0-9a-f]{64}$/i;

// P2-7 (was: stale "In-memory token set / swap to KV later" note):
// claim tokens are one-time nonces created per upload below and consumed by
// TempClaimDO (see ./claim.js), which deletes the R2 key on first claim.
// There is NO token store — the R2 key + 24h customMetadata deadline IS the
// state (the pre-DO in-memory/KV sketch never shipped). Tokens are 22
// chars URL-safe.
const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function genToken(len = 22) {
  // P2-11: rejection sampling — TOKEN_CHARS.length (62) does not divide
  // 256, so buf%62 would overweight the first 256%62 = 8 symbols (A-H).
  // Accept only bytes in [0, 248) (largest multiple of 62 below 256) and
  // discard the rest: uniform over the alphabet at ~3% redraw cost.
  const RANGE = 256 - (256 % TOKEN_CHARS.length); // 248
  let s = "";
  while (s.length < len) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && s.length < len; i++) {
      if (buf[i] < RANGE) s += TOKEN_CHARS[buf[i] % TOKEN_CHARS.length];
    }
  }
  return s;
}

// Constant-time string equality for credential-shaped values (same intent
// as gateway/src/auth.ts safeEq/timingSafeEqual, but hardened: SHA-256 both
// sides to fixed 32-byte digests first, so there is no length early-exit
// to leak on, then fold XOR across every byte without short-circuiting).
async function safeEq(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  const a8 = new Uint8Array(da);
  const b8 = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < a8.length; i++) diff |= a8[i] ^ b8[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Console URL is per-deployment (CONSOLE_URL var, see the header
    // contract above); fall back to this worker's own origin — no
    // production domain is hardcoded.
    const consoleUrl = (env && env.CONSOLE_URL) || url.origin;

    // ── Temporary file hosting ──────────────────────────────────────────
    // Upload: POST /api/upload  ->  { token, url, size, expiresIn }
    // Download: GET /files/<token>  ->  file bytes (one-time, then deleted)
    if (url.pathname === "/api/upload" && request.method === "POST") {
      try {
        // Auth: require a bearer token matching the shared secret (set via
        // `wrangler secret put UPLOAD_KEY`). Compared via safeEq (hash both
        // sides, constant-time fold — a plain !== leaks timing on the key).
        // Without this, anyone can upload 100 MiB files to R2 (abuse + cost).
        const auth = request.headers.get("authorization") || "";
        const expected = `Bearer ${env.UPLOAD_KEY || ""}`;
        if (!env.UPLOAD_KEY || !auth || !(await safeEq(auth, expected))) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        const ct = request.headers.get("content-type") || "";
        if (!ct.includes("multipart/form-data")) {
          return new Response(JSON.stringify({ error: "expected multipart/form-data" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        // Cap at 100 MiB (Cloudflare Workers limit ~10 MiB for free plan,
        // 100 MiB for paid — this 100 MiB cap ASSUMES a paid plan; on free,
        // large uploads fail at the platform edge before reaching here).
        // Screen the declared Content-Length BEFORE formData() materializes
        // the whole body in memory — the multipart framing (boundary + part
        // headers) adds a little on top of the file bytes, hence the
        // margin. The authoritative check is file.size below.
        // P1-4: a missing Content-Length (chunked client) cannot be
        // pre-screened, so require the header (411) instead of buffering an
        // unbounded body and 413ing after the fact.
        const MAX_BYTES = 100 * 1024 * 1024;
        const CL_MARGIN = 64 * 1024;
        const declaredRaw = request.headers.get("content-length");
        if (declaredRaw === null || declaredRaw === "") {
          return new Response(JSON.stringify({ error: "content-length required" }), {
            status: 411,
            headers: { "content-type": "application/json" },
          });
        }
        const declared = Number(declaredRaw);
        if (declared > MAX_BYTES + CL_MARGIN) {
          return new Response(JSON.stringify({ error: `file too large (max ${MAX_BYTES} bytes)` }), {
            status: 413,
            headers: { "content-type": "application/json" },
          });
        }
        // A malformed framing (e.g. a quote-breaking filename) makes
        // formData() throw — answer 400, not the 500 catch-all below.
        let form;
        try {
          form = await request.formData();
        } catch {
          return new Response(JSON.stringify({ error: "invalid multipart body" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const file = form.get("file");
        if (!file || typeof file === "string") {
          return new Response(JSON.stringify({ error: "no file field" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (file.size > MAX_BYTES) {
          return new Response(JSON.stringify({ error: `file too large (max ${MAX_BYTES} bytes)` }), {
            status: 413,
            headers: { "content-type": "application/json" },
          });
        }
        // P2-9: illegal filenames (nothing survives header sanitizing) are
        // rejected 400 here — never forwarded into the R2 put as a forged
        // Content-Disposition header.
        const disposition = buildContentDisposition(file.name);
        if (!disposition) {
          return new Response(JSON.stringify({ error: "invalid filename" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const token = genToken(22);
        const key = `files/${token}`;
        // R2's Workers put() has NO expirationTtl option (that is KV-only;
        // R2PutOptions = httpMetadata/customMetadata/checksums/onlyIf/
        // storageClass). The 24h claim window is recorded in customMetadata
        // and enforced lazily on GET below — abandoned files are deleted on
        // first access after expiry instead of accumulating forever.
        const expiresAt = Date.now() + 24 * 3600 * 1000;
        // Pass the File/Blob itself — R2 put() accepts Blob values, so no
        // second full copy (arrayBuffer()) of the file is needed.
        await env.TEMP_FILES.put(key, file, {
          httpMetadata: {
            contentType: file.type || "application/octet-stream",
            contentDisposition: disposition,
          },
          customMetadata: { expiresAt: String(expiresAt) },
        });
        const downloadUrl = `${url.origin}/files/${token}`;
        return new Response(JSON.stringify({
          token,
          url: downloadUrl,
          size: file.size,
          filename: file.name || "file",
          expiresAt: new Date(expiresAt).toISOString(),
          // Tokens auto-delete on first download; unclaimed files expire
          // 24h after upload (enforced on access).
          note: "one-time download: file is deleted after first access or 24h",
        }), { headers: { "content-type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Download: GET /files/<token>  ->  serialized one-time claim.
    // The claim runs inside TempClaimDO (instance named by the token), not
    // here: an inline R2 get-then-delete is racy — two concurrent GETs can
    // both pass get() before either delete lands, and the "one-time" file
    // downloads twice. The DO runtime delivers one instance's requests
    // strictly one at a time, so the first claim wins (streams the bytes)
    // and losers observe the winner's delete as 404. The DO is short-lived
    // per claim (milliseconds: one R2 get + one delete, no storage, alarms,
    // or sockets — duration billing forbids an always-on shape here).
    const fileMatch = /^\/files\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname);
    if (fileMatch && request.method === "GET") {
      const token = fileMatch[1];
      // P1-1: idFromName/get/fetch cross the DO boundary (network I/O) — a
      // DO/R2 outage must surface as a 503 JSON envelope, never as an
      // uncaught throw (worker 500 HTML / unhandled rejection).
      try {
        const id = env.TEMP_CLAIM.idFromName(`files/${token}`);
        return await env.TEMP_CLAIM.get(id).fetch(request);
      } catch (err) {
        return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Version endpoint for the agent_update MCP tool (and legacy tray
    // check). ROUND-297: this was hard-coded to v1.2.141/1.0.145 and rotted
    // (the 141 tgz was deleted from assets long ago — an update check that
    // ever fired would 404). The manifest is now derived from the version
    // discovery asset (/vale-agent/version.json, written by the release
    // flow) so it tracks every release automatically. The sha256 field is
    // REQUIRED by agent_update (round-119: unverifiable installs refused)
    // and is published into version.json by the release flow.
    if (new URL(request.url).pathname === "/api/version") {
      try {
        const vresp = await env.ASSETS.fetch(
          new Request("https://worker.local/vale-agent/version.json")
        );
        if (vresp.ok) {
          const vj = await vresp.json();
          const ver = vj && vj.version;
          const sha = vj && vj.sha256;
          // P2-5: assert the sha shape (64 hex), not just presence — a
          // truncated/placeholder sha would otherwise ship a manifest that
          // agent_update refuses anyway; fail to the honest 503 instead.
          // P2-1: the tarball filename is LIVE data, not decoration —
          // version.json names the exact file (publish writes the
          // versionless latest alias today, a versioned name tomorrow).
          // Serve exactly that basename after a flat-name validation (no
          // slashes, must end .tgz — a hostile manifest must not escape
          // /vale-agent/). Absent/invalid falls back to the derived
          // versioned name so older manifests keep working; smoke pins
          // the consistent case (tarball field == download basename).
          const tbRaw = vj && vj.tarball;
          const tb =
            typeof tbRaw === "string" && /^vale-agent-[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(tbRaw)
              ? tbRaw
              : `vale-agent-${ver}.tgz`;
          if (ver && typeof sha === "string" && SHA256_RE.test(sha)) {
            const base = new URL(request.url).origin;
            return new Response(
              JSON.stringify({
                version: ver,
                download: `${base}/vale-agent/${tb}`,
                sha256: sha,
              }),
              { headers: { "content-type": "application/json", "cache-control": "no-store" } }
            );
          }
        }
      } catch (e) {
        // fall through to the static fallback below
      }
      // Static fallback (assets unavailable): never serve a fabricated
      // manifest — agent_update refuses invalid sha256 anyway (round-119),
      // so an explicit error is the honest answer.
      return new Response("release manifest unavailable", { status: 503 });
    }
    const pathname = new URL(request.url).pathname;
    // Keep the old installer URL usable for links/bookmarks — the NSIS
    // installer is retired (npm is the single channel); redirect to the
    // console URL (CONSOLE_URL var, or this site's root when unset) so
    // stale links land somewhere useful.
    if (pathname === "/vale-agent/ValeAgent-Setup.exe") {
      return Response.redirect(consoleUrl, 302);
    }
    // npm tgz download path (the documented `npm i -g
    // https://agent.saisi.online/vale-agent/vale-agent-<v>.tgz` command).
    // The versionless latest alias (the landing page's install command)
    // is matched EXACTLY here — the versioned regex is intentionally NOT
    // loosened to cover it (exact-pattern discipline on download paths).
    const tgzMatch = /^\/vale-agent\/vale-agent-[0-9]+\.[0-9]+\.[0-9]+\.tgz$/.exec(pathname);
    if (tgzMatch || pathname === "/vale-agent/vale-agent-latest.tgz") {
      // The tgz (~12MB) fits Workers Assets and is served fast from here.
      return env.ASSETS.fetch(request);
    }
    // cloudflared.exe proxy: the boxed tunnel binary (~54MB) is NOT bundled
    // in the npm package (kept small); devices download it on demand from
    // the official GitHub release. GitHub is often unreachable from devices
    // (GFW etc.), so proxy it through this worker — Cloudflare's network
    // reaches GitHub fast, and the device only talks to agent.saisi.online.
    if (pathname === "/vale-agent/cloudflared.exe") {
      const upstream = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
      const resp = await fetch(upstream, { redirect: "follow" });
      if (!resp.ok) {
        return new Response("cloudflared upstream fetch failed: " + resp.status, { status: 502 });
      }
      // Stream the body through (no buffering — 54MB fits the response path).
      return new Response(resp.body, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="cloudflared.exe"',
          "cache-control": "public, max-age=3600",
        },
      });
    }
    // A missing binary must 404, not return the download PAGE as 200 HTML —
    // devices silently downloaded HTML as ValeAgent-Setup.exe and the agent
    // never started. Only "/" and "/index.html" render the page.
    if (pathname !== "/" && pathname !== "/index.html") {
      return new Response("Not Found", { status: 404 });
    }
    // round-319: the download page's install command pointed at the DELETED
    // 1.2.141 tgz on the Vercel mirror (v.saisi.online/dl/) — every copy-
    // paste install failed. Use the versionless latest alias served by this
    // worker itself (mirrored on every release) so the command always
    // installs the current build. The base is the request's own origin —
    // npm must hit the host that actually serves the tgz, and no production
    // domain is hardcoded.
    const installerUrl = `${url.origin}/vale-agent/vale-agent-latest.tgz`;

    return new Response(PAGE(consoleUrl, installerUrl), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
