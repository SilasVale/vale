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

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230f1115'/%3E%3Cpath d='M20 16 L32 48 L44 16' fill='none' stroke='%23f9fafb' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

const PAGE = (consoleUrl, installerUrl) => `<!doctype html>
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
    display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 40px; border-radius: 10px;
    background: var(--dsw-alias-button-primary-fill);
    color: var(--dsw-alias-button-primary-foreground);
    font: 600 18px/1 var(--ds-font-family);
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
        <span class="brand-mark">V</span>
        <div class="brand-text">
          <div class="brand-name">Vale Agent</div>
          <div class="brand-tag">device agent</div>
        </div>
      </div>

      <p class="desc">Vale Agent is a device command center (serial / terminal / browser + MCP) that runs on a Windows machine. Each device is exposed over a Cloudflare Tunnel and managed from the <a href="${consoleUrl}">Vale console</a>.</p>

      <div class="actions">
        <code class="cmd">npm i -g ${installerUrl}</code>
        <span class="hint">Run on the Windows machine connected to the device. Requires Node.js + admin rights.</span>
      </div>

      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-body">Install the package: <code>npm i -g ${installerUrl}</code> — then run <code>vale setup --reg-key &lt;key&gt;</code> (get a key from the <a href="${consoleUrl}">Vale console</a> → Devices).</div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-body">The setup installs the agent service, auto-registers the device, and prints the panel URL + token. Copy them for the next step.</div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-body">Updates are the same channel: <code>npm i -g ${installerUrl} && vale update</code>.</div>
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

export default {
  async fetch(request, env) {
    // Version endpoint for the vale-tray "check for updates" menu item.
    // Bump VERSION alongside agent/Cargo.toml when a new installer is shipped.
    // sha256: the agent's agent_update tool verifies the downloaded installer
    // against this hash before spawning it (integrity anchor for an
    // AI-triggerable RCE path). Re-generated automatically by
    // scripts/build-installer.sh — do not edit by hand.
    if (new URL(request.url).pathname === "/api/version") {
      // The npm tgz (~40MB — embeds the playwright bundle, over the Workers
      // Assets 25MiB per-file cap), so it lives outside this worker: the
      // Vercel static hosting mirror (v.saisi.online/dl/), staged by
      // scripts/build-installer.sh. Device code consumes `download` as-is
      // (npm i -g <download>, vale update).
      // The npm tgz (~12MB — agent + desktop + playwright node_modules, no
      // bundled node/cloudflared) fits the Workers Assets 25MiB cap and is
      // served fast from this worker; the Vercel mirror stays as fallback.
      const download = `https://v.saisi.online/dl/vale-agent-1.2.119.tgz`;
      return new Response(
        JSON.stringify({
          version: "1.0.123",
          download,
          sha256: "9c79164dcd34bfa4337cf9efbc3bf488e5d65edfcbcbede5f6460f747c31526f",
        }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } }
      );
    }
    const pathname = new URL(request.url).pathname;
    // Keep the old installer URL usable for links/bookmarks — the NSIS
    // installer is retired (npm is the single channel); redirect to the
    // download page so stale links land somewhere useful.
    if (pathname === "/vale-agent/ValeAgent-Setup.exe") {
      return Response.redirect(`https://agent.saisi.online/`, 302);
    }
    // npm tgz download path (the documented `npm i -g
    // https://agent.saisi.online/vale-agent/vale-agent-<v>.tgz` command).
    const tgzMatch = /^\/vale-agent\/vale-agent-[0-9]+\.[0-9]+\.[0-9]+\.tgz$/.exec(pathname);
    if (tgzMatch) {
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
    const consoleUrl = (env && env.CONSOLE_URL) || "https://api.saisi.online";
    const installerUrl = `https://v.saisi.online/dl/vale-agent-1.2.119.tgz`;

    return new Response(PAGE(consoleUrl, installerUrl), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
