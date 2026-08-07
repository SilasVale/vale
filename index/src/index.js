// Vale Command — install / download landing page (Cloudflare Worker).
//
// This Worker is the download site for vale-command. Device management
// (registry + MCP config + panel proxy) lives in the Vale console
// (admin-only). This page only distributes the installer + setup scripts and
// points users to the console. The console URL is set per-deployment via the
// CONSOLE_URL var (no production domain is hardcoded here).

const PAGE = (consoleUrl) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vale Command</title>
<style>
  :root {
    --bg: #ffffff;      /* page background */
    --bg-soft: #f6f7f9; /* subtle header / footer zones */
    --line: #e7e9ee;    /* hairline borders */
    --line-strong: #d7dbe3;
    --txt: #191c22;
    --dim: #68707e;
    --accent: #5b6cf0;  /* matches the vale-command panel accent */
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body { background: var(--bg); color: var(--txt); font: 15px/1.55 var(--sans); min-height: 100vh; }

  /* Thin accent rule across the very top — the one bold stroke on the page. */
  .topbar { height: 3px; background: linear-gradient(90deg, var(--accent), #8a6ff0 60%, transparent); }

  .wrap { max-width: 760px; margin: 0 auto; padding: 44px 24px 44px; }
  .brand { display: flex; align-items: baseline; gap: 12px; }
  .brand .name { font-size: 24px; font-weight: 720; letter-spacing: -0.02em; }
  .brand .tag { font: 12px/1 var(--mono); color: var(--dim); letter-spacing: 0.08em; text-transform: uppercase; }
  .led-head { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); margin-right: 2px; vertical-align: 1px; }
  .lede { color: var(--dim); margin-top: 8px; font-size: 14px; max-width: 640px; }
  .lede a { color: var(--accent); }

  .install { display: flex; align-items: center; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
  .install-btn { display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: #fff;
                 text-decoration: none; font-size: 13px; font-weight: 600; padding: 9px 16px; border-radius: 8px;
                 transition: background .15s ease, transform .15s ease; }
  .install-btn:hover { background: #4a58d6; transform: translateY(-1px); }
  .install-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .install-note { color: var(--dim); font-size: 12px; }

  .steps { margin-top: 26px; display: flex; flex-direction: column; gap: 12px; }
  .step { display: flex; gap: 12px; align-items: flex-start; }
  .step .n { flex: none; width: 22px; height: 22px; border-radius: 50%; background: var(--bg-soft);
             border: 1px solid var(--line-strong); display: flex; align-items: center; justify-content: center;
             font: 12px/1 var(--mono); color: var(--dim); margin-top: 1px; }
  .step .body { color: var(--txt); font-size: 14px; }
  .step code { font: 12px/1.5 var(--mono); background: var(--bg-soft); border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; }

  footer { max-width: 760px; margin: 0 auto; padding: 0 24px 44px; color: var(--dim); font-size: 12px;
           display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
</style>
</head>
<body>
<div class="topbar"></div>
<div class="wrap">
  <div class="brand">
    <span class="name"><span class="led-head"></span>Vale Command</span>
    <span class="tag">device agent</span>
  </div>
  <p class="lede">Vale Command is a device command center (serial / terminal / browser + MCP) that runs on a Windows machine. Each device is exposed over a Cloudflare Tunnel at its own subdomain and is managed from the <a href="${consoleUrl}">Vale console</a> (admin login).</p>

  <div class="install">
    <a class="install-btn" href="/vale-command/ValeCommand-Setup.exe" download>Download installer ↓</a>
    <span class="install-note">On the Windows machine connected to the device, download and run the installer (pick a directory; it installs a tray icon).</span>
  </div>

  <div class="steps">
    <div class="step"><div class="n">1</div><div class="body">Download the installer and double-click it on Windows (admin rights required).</div></div>
    <div class="step"><div class="n">2</div><div class="body">The install automates Cloudflare auth, creates a tunnel and registers auto-start; it finishes by showing the panel URL and token.</div></div>
    <div class="step"><div class="n">3</div><div class="body">Log in to the <a href="${consoleUrl}">Vale console</a> → Devices, add this device (name / host / token) — or use a registration key to auto-register — then copy the MCP config or open the panel through the console.</div></div>
  </div>
</div>
<footer>
  <span>Vale Command — device access for AI agents</span>
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
    // Bump VERSION alongside command/Cargo.toml when a new installer is shipped.
    if (new URL(request.url).pathname === "/api/version") {
      return new Response(
        JSON.stringify({
          version: "0.7.0",
          download: "https://command.saisi.online/vale-command/ValeCommand-Setup.exe",
        }),
        { headers: { "content-type": "application/json" } }
      );
    }
    const consoleUrl = (env && env.CONSOLE_URL) || "https://<console-host>";
    return new Response(PAGE(consoleUrl), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
