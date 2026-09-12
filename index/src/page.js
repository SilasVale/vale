// page.js — the download landing page (structure refactor: extracted from
// index.js so the routing module isn't 45% HTML/CSS). Pure data + pure
// helpers, no worker bindings — same pattern as ./claim.js.

export const FAVICON =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2248%22%20height%3D%2248%22%20viewBox%3D%220%200%2048%2048%22%3E%0A%20%20%3C%21--%20Vale%20brand%20mark%3A%20the%20vale%20at%20sunrise%20%E2%80%94%20near%20hill%2C%20far%20ridge%2C%20signal%20over%20the%20pass%20--%3E%0A%20%20%3Cdefs%3E%0A%20%20%20%20%3ClinearGradient%20id%3D%22sky%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23f59f00%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23e8590c%22%2F%3E%0A%20%20%20%20%3C%2FlinearGradient%3E%0A%20%20%20%20%3CradialGradient%20id%3D%22glow%22%20cx%3D%22.5%22%20cy%3D%22.5%22%20r%3D%22.5%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23fff8e1%22%20stop-opacity%3D%22.55%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23ffe8a3%22%20stop-opacity%3D%220%22%2F%3E%0A%20%20%20%20%3C%2FradialGradient%3E%0A%20%20%20%20%3ClinearGradient%20id%3D%22sheen%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23ffffff%22%20stop-opacity%3D%22.25%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23ffffff%22%20stop-opacity%3D%220%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%221%22%20stop-color%3D%22%237c2d12%22%20stop-opacity%3D%22.10%22%2F%3E%0A%20%20%20%20%3C%2FlinearGradient%3E%0A%20%20%3C%2Fdefs%3E%0A%0A%20%20%3Crect%20width%3D%2248%22%20height%3D%2248%22%20rx%3D%2211%22%20fill%3D%22url%28%23sky%29%22%2F%3E%0A%0A%20%20%3C%21--%20signal%20rising%20over%20the%20pass%20--%3E%0A%20%20%3Ccircle%20cx%3D%2221%22%20cy%3D%2214%22%20r%3D%227.5%22%20fill%3D%22url%28%23glow%29%22%2F%3E%0A%20%20%3Ccircle%20cx%3D%2221%22%20cy%3D%2214%22%20r%3D%224%22%20fill%3D%22%23fff8e1%22%2F%3E%0A%0A%20%20%3C%21--%20far%20ridge%20%28haze%29%20--%3E%0A%20%20%3Cpath%20fill%3D%22%23ffffff%22%20opacity%3D%22.78%22%20d%3D%22M14%2041Q26%2016%2044%2041Z%22%2F%3E%0A%20%20%3C%21--%20near%20hill%20%28solid%29%20--%3E%0A%20%20%3Cpath%20fill%3D%22%23ffffff%22%20d%3D%22M2%2041Q12%2020%2024%2041Z%22%2F%3E%0A%0A%20%20%3C%21--%20glass%20sheen%20--%3E%0A%20%20%3Crect%20width%3D%2248%22%20height%3D%2248%22%20rx%3D%2211%22%20fill%3D%22url%28%23sheen%29%22%2F%3E%0A%3C%2Fsvg%3E%0A";

export const PAGE = (consoleUrl, installerUrl, setupUrl) => {
  // P2-8: both URLs flow into HTML (href attributes + inline <code> text).
  // They derive from the CONSOLE_URL env var / request origin, so treat them
  // as untrusted: https-only whitelist (http allowed solely for loopback dev)
  // + HTML-escape at the interpolation points. A crafted CONSOLE_URL must
  // never break out of the attribute/element (stored-XSS via env var).
  const safeConsole = escHtml(safePageUrl(consoleUrl, "/"));
  const safeInstaller = escHtml(
    safePageUrl(installerUrl, "/vale-agent/vale-agent-latest.tgz"),
  );
  const safeSetup = escHtml(
    safePageUrl(setupUrl, "/vale-agent/ValeAgent-Setup.exe"),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vale Agent</title>
<link rel="icon" href="${FAVICON}">
<style>
  :root {
    /* THE PRODUCT'S TOKENS, not a third set. This page carried its own
       --dsw-alias-* namespace whose BRAND WAS BLUE (#4d6bfe) and whose primary
       button was near-BLACK (#0f1115) — while the console and the device panel
       are ORANGE (#d9480f) with an accent primary. It was the last holdout of a
       brand the rest of the product had already left: the panel's own dead
       fallbacks still spelled that blue (#4f7cff / #4f6bed) until round 43
       removed them.
       The NAMES below are kept so the rest of this file did not have to be
       rewritten at the same time; the VALUES are the panel's scale, so all three
       surfaces finally resolve to the same colours. */
    --dsw-alias-bg-base: #fafafa;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-bg-layer-2: #f4f4f5;
    --dsw-alias-bg-mask-1: rgba(0,0,0,0.4);
    --dsw-alias-label-primary: #1d1d1f;
    --dsw-alias-label-secondary: #52525b;
    --dsw-alias-label-tertiary: #71717a;
    --dsw-alias-label-dimmed: #a1a1aa;
    --dsw-alias-border-l1: rgba(0,0,0,0.08);
    --dsw-alias-border-l2: rgba(0,0,0,0.12);
    --dsw-alias-border-l3: #d4d4d8;
    --dsw-alias-brand-primary: #d9480f;
    /* WHITE ON --accent measures 4.30 and is under AA; the solid weight clears
       it at 6.05. The panel learned this for .btn-new and .goal-save. */
    --dsw-alias-button-primary-fill: #b03a0a;
    --dsw-alias-button-primary-hover: #9c3a0a;
    --dsw-alias-button-primary-foreground: #ffffff;
    --dsw-alias-state-business-primary: #9c3a0a;
    --dsw-alias-state-success-primary: #1e7a33;
    --dsw-alias-state-error-primary: #a51d1d;
    --dsw-alias-state-warn-primary: #b45309;
    --dsw-alias-interactive-bg-hover: rgba(0,0,0,0.04);
    --dsw-alias-interactive-bg-active: rgba(0,0,0,0.06);
    --dsw-shadow-lv1: 0 1px 2px rgba(0,0,0,0.06);
    --dsw-shadow-lv2: 0 4px 12px rgba(0,0,0,0.08);
    --dsw-shadow-lv3: 0 12px 32px rgba(0,0,0,0.12);
    --ds-font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
    --ds-font-family-code: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";
    --ds-transition-duration: 0.15s;
    --ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  }

  body[data-ds-dark-theme] {
    --dsw-alias-bg-base: #131418;
    --dsw-alias-bg-layer-1: #17181d;
    --dsw-alias-bg-layer-2: #1f2026;
    --dsw-alias-bg-mask-1: rgba(0,0,0,0.6);
    --dsw-alias-label-primary: #ecedef;
    --dsw-alias-label-secondary: #a2a3ac;
    --dsw-alias-label-tertiary: #a2a3ac;
    --dsw-alias-label-dimmed: #6f707a;
    --dsw-alias-border-l1: rgba(255,255,255,0.07);
    --dsw-alias-border-l2: rgba(255,255,255,0.10);
    --dsw-alias-border-l3: rgba(255,255,255,0.14);
    --dsw-alias-brand-primary: #ffa94d;
    /* On the dark surface the accent itself carries dark ink, so the button is
       the accent and the FOREGROUND is what changes. */
    --dsw-alias-button-primary-fill: #ffa94d;
    --dsw-alias-button-primary-hover: #ffc078;
    --dsw-alias-button-primary-foreground: #2b1a09;
    --dsw-alias-state-business-primary: #ffa94d;
    --dsw-alias-interactive-bg-hover: rgba(255,255,255,0.05);
    --dsw-alias-interactive-bg-active: rgba(255,255,255,0.08);
    --dsw-shadow-lv1: 0 1px 2px rgba(0,0,0,0.24);
    --dsw-shadow-lv2: 0 4px 12px rgba(0,0,0,0.32);
    --dsw-shadow-lv3: 0 12px 32px rgba(0,0,0,0.45);
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
  /* A SPLIT PAGE. Measured before: the content column was 440px on a 1440px
     screen — a narrow ribbon in a void, with the install steps as bare text
     rows. The brand and the "what is this" sentence now own the left half and
     the things you actually DO own the right, the same composition the console's
     login page uses, so the two surfaces read as one product. */
  .app { display: flex; flex-direction: column; min-height: 100vh; }
  .main {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: center;
    gap: 56px;
    width: 100%;
    max-width: 1120px;
    margin: 0 auto;
    padding: 56px 40px;
  }
  .aside { display: flex; flex-direction: column; gap: 20px; }
  .card { width: 100%; max-width: 520px; justify-self: end; }

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
  .steps { display: flex; flex-direction: column; gap: 8px; }
  /* A URL is ONE token. Without this the installer URL broke across lines in the
     middle of the path, which is unreadable and unpasteable. */
  code, .cmd { overflow-wrap: anywhere; word-break: break-word; }
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
  @media (max-width: 860px) {
    .main {
      grid-template-columns: minmax(0, 1fr);
      gap: 32px;
      align-items: start;
      padding: 40px 24px;
      max-width: 620px;
    }
    .card { max-width: none; justify-self: stretch; }
  }
  @media (max-width: 480px) {
    .main { padding: 28px 16px; }
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
    <div class="aside">
      <div class="brand">
        <img class="brand-mark" src="${FAVICON}" alt="Vale">
        <div class="brand-text">
          <div class="brand-name">Vale Agent</div>
          <div class="brand-tag">device agent</div>
        </div>
      </div>

      <p class="desc">Vale Agent is a device command center (serial / terminal / browser + MCP) that runs on a Windows machine. Each device is exposed over a Cloudflare Tunnel and managed from the <a href="${safeConsole}">Vale console</a>.</p>
    </div>

    <div class="card">
      <div class="actions">
        <a class="btn-primary" href="${safeSetup}">Download Windows installer</a>
        <span class="hint">Easiest path: one setup.exe (needs admin + internet, no Node.js required). Or the manual channel below.</span>
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
          <div class="step-body">Updates are the same channel — but <b>pass <code>--prefix</code></b>: a plain <code>npm i -g</code> writes npm's default global prefix, while <code>vale</code> lives elsewhere when the agent runs as a service, so <code>vale update</code> then runs the OLD CLI and stages the OLD build. npm reports success and nothing happens. <code>npm i -g --prefix (Split-Path (Get-Command vale).Source) ${safeInstaller}</code> then <code>vale update</code>, and confirm with <code>vale status</code> — not with npm's exit code.</div>
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
export function safePageUrl(u, fallback) {
  try {
    const s = String(u);
    const parsed = new URL(s, "https://placeholder.local");
    if (parsed.protocol === "https:") return s;
    const host = parsed.hostname.toLowerCase();
    // round-449: dropped the `host === "::1"` disjunct — a bare ::1 is not
    // a valid URL host (browsers/node require brackets), so the WHATWG
    // parser never yields it; only "[::1]" can occur. Dead branch removed
    // rather than pinned.
    if (
      parsed.protocol === "http:" &&
      (host === "localhost" || host === "127.0.0.1" || host === "[::1]")
    )
      return s;
    return fallback;
  } catch {
    return fallback;
  }
}

export function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
