// Vale Agent — install / download landing page (Cloudflare Worker).
//
// This Worker is the download site for vale-agent. Device management
// (registry + MCP config + panel proxy) lives in the Vale console
// (admin-only). This page only distributes the installer + setup scripts and
// points users to the console. The console URL is set per-deployment via the
// CONSOLE_URL var (no production domain is hardcoded here).

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231d1d1f'/%3E%3Cpath d='M20 16 L32 48 L44 16' fill='none' stroke='%23ffffff' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

const PAGE = (consoleUrl) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vale Agent</title>
<link rel="icon" href="${FAVICON}">
<style>
  :root {
    /* Canonical Vale tokens (match panel.css / console style.css — the
       previous block renamed --accent-ink→--accent-hover, --font→--sans,
       --font-mono→--mono and held the shadow-lg value under --shadow, so
       cross-surface token diffs misled designers). */
    --bg: #f5f5f7;
    --surface: #ffffff;
    --surface-glass: rgba(255,255,255,0.72);
    --line: rgba(0,0,0,0.08);
    --line-strong: rgba(0,0,0,0.14);
    --ink: #1d1d1f;
    --muted: #6e6e73;
    --faint: #86868b;
    --accent: #0e9384;
    --accent-ink: #0b7a6e;
    --accent-soft: #e7f5f2;
    --danger: #dc2626;
    --radius: 14px;
    --radius-sm: 10px;
    --radius-lg: 20px;
    --shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
    --shadow-lg: 0 12px 32px rgba(0,0,0,0.12);
    --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --font: -apple-system, "SF Pro Text", "PingFang SC", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--font); min-height: 100vh; }

  .wrap { max-width: 760px; margin: 0 auto; padding: 56px 24px 44px; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .brand .mark { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px;
                 border-radius: var(--radius-sm); background: #1d1d1f; color: #fff; font-size: 24px; font-weight: 700; }
  .brand .name { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
  .brand .tag { font: 12px/1 var(--font-mono); color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }
  .lede { color: var(--muted); margin-top: 12px; font-size: 14px; max-width: 640px; }
  .lede a { color: var(--accent); }

  .install { display: flex; align-items: center; gap: 10px; margin-top: 24px; flex-wrap: wrap; }
  .install-btn { display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: #fff;
                 text-decoration: none; font-size: 14px; font-weight: 600; padding: 10px 18px; border-radius: var(--radius-sm);
                 transition: background .15s ease, transform .15s ease; }
  .install-btn:hover { background: var(--accent-ink); transform: translateY(-1px); }
  .install-btn:focus-visible { box-shadow: 0 0 0 3px rgba(14, 147, 132, 0.14); outline: none; } /* unified .14 focus ring */
  .install-note { color: var(--faint); font-size: 12px; }

  .steps { margin-top: 32px; display: flex; flex-direction: column; gap: 12px; }
  .step { display: flex; gap: 14px; align-items: flex-start; background: var(--surface-glass);
          backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px);
          border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 14px 16px; }
  .step .n { flex: none; width: 24px; height: 24px; border-radius: 50%; background: var(--accent);
             color: #fff; display: flex; align-items: center; justify-content: center;
             font: 700 13px/1 var(--font); margin-top: 1px; }
  .step .body { color: var(--ink); font-size: 14px; }
  .step code { font: 12px/1.5 var(--font-mono); background: var(--surface); border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; }

  .mono { font-family: var(--font-mono); }

  footer { max-width: 760px; margin: 0 auto; padding: 0 24px 44px; color: var(--faint); font-size: 12px;
           display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <span class="mark">V</span>
    <div>
      <div class="name">Vale Agent</div>
      <div class="tag">device agent</div>
    </div>
  </div>
  <p class="lede">Vale Agent is a device command center (serial / terminal / browser + MCP) that runs on a Windows machine. Each device is exposed over a Cloudflare Tunnel at its own subdomain and is managed from the <a href="${consoleUrl}">Vale console</a> (admin login).</p>

  <div class="install">
    <a class="install-btn" href="/vale-agent/ValeAgent-Setup.exe" download>Download installer ↓</a>
    <span class="install-note">On the Windows machine connected to the device, download and run the installer (pick a directory; it installs a tray icon).</span>
  </div>

  <div class="steps">
    <div class="step"><div class="n">1</div><div class="body">Download the installer and double-click it on Windows (admin rights required).</div></div>
    <div class="step"><div class="n">2</div><div class="body">The install automates Cloudflare auth, creates a tunnel and registers auto-start; it finishes by showing the panel URL and token.</div></div>
    <div class="step"><div class="n">3</div><div class="body">Log in to the <a href="${consoleUrl}">Vale console</a> → Devices, add this device (name / host / token) — or use a registration key to auto-register — then copy the MCP config or open the panel through the console.</div></div>
  </div>
</div>
<footer>
  <span>Vale Agent — device access for AI agents</span>
  <span class="mono" id="foot-time"></span>
</footer>
<script>
document.getElementById('foot-time').textContent = new Date().toISOString().replace('T',' ').slice(0,19) + ' UTC';
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    // Version endpoint for the vale-tray "check for updates" menu item.
    // Bump VERSION alongside agent/Cargo.toml when a new installer is shipped.
    if (new URL(request.url).pathname === "/api/version") {
      return new Response(
        JSON.stringify({
          version: "1.0.43",
          download: "https://agent.saisi.online/vale-agent/ValeAgent-Setup.exe",
        }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } }
      );
    }
    const pathname = new URL(request.url).pathname;
    // A missing binary must 404, not return the download PAGE as 200 HTML —
    // devices silently downloaded HTML as ValeAgent-Setup.exe and the agent
    // never started. Only "/" and "/index.html" render the page.
    if (pathname !== "/" && pathname !== "/index.html") {
      return new Response("Not Found", { status: 404 });
    }
    const consoleUrl = (env && env.CONSOLE_URL) || "https://api.saisi.online";
    return new Response(PAGE(consoleUrl), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
