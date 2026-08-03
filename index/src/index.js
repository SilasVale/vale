// Vale Command — install / download landing page (Cloudflare Worker).
//
// command.saisi.online → this Worker: the download site for vale-command.
// Device management (registry + MCP config + panel proxy) moved to the Vale
// console (ai.saisi.online, admin-only). This page only distributes the
// installer + setup scripts and points users to the console.

const PAGE = `<!doctype html>
<html lang="zh">
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
  footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="topbar"></div>
<div class="wrap">
  <div class="brand">
    <span class="name"><span class="led-head"></span>Vale Command</span>
    <span class="tag">device agent</span>
  </div>
  <p class="lede">Vale Command 是跑在 Windows 机器上的设备命令中心（串口 / 终端 / 浏览器 + MCP）。每台设备经 Cloudflare 隧道暴露到 <code>dN.command.saisi.online</code>，在 <a href="https://ai.saisi.online" style="color:var(--accent)">Vale 控制台</a>（ai.saisi.online，管理员）统一管理设备与 MCP 配置。</p>

  <div class="install">
    <a class="install-btn" href="/vale-command/ValeCommand-Setup.exe" download>下载安装程序 ↓</a>
    <span class="install-note">在接设备的那台 Windows 上，下载后双击安装（可自选目录，装完带托盘图标）。</span>
  </div>

  <div class="steps">
    <div class="step"><div class="n">1</div><div class="body">下载安装程序，在 Windows 上双击安装（需管理员权限）。</div></div>
    <div class="step"><div class="n">2</div><div class="body">安装时自动完成 Cloudflare 授权、创建隧道并注册开机自启，完成后显示面板地址与 token。</div></div>
    <div class="step"><div class="n">3</div><div class="body">登录 <a href="https://ai.saisi.online" style="color:var(--accent)">ai.saisi.online</a> 控制台 →「设备管理」，添加这台设备（名 / 主机 / token），即可复制 MCP 配置或从控制台代理进入面板。</div></div>
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
  async fetch(request) {
    return new Response(PAGE, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
