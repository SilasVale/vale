# Vale Command — Deployment guide (Windows host + Cloudflare)

Vale Command is a **headless MCP server + web panel** running on a Windows
machine connected to hardware (serial + network), exposed over a Cloudflare
Tunnel to `<download-host>` so Claude Code / any browser can reach it.

This directory only holds the **deployment scripts and samples**; the code
lives at the repo root.

## One-click install (recommended)

On the target Windows machine (admin PowerShell), run one line:

```powershell
irm https://<download-host>/vale-command/vale-command-setup.ps1 | iex
```

The script does everything: download `vale-command.exe` → bootstrap
config+token → install the service → install cloudflared → Cloudflare auth →
create tunnel → route the subdomain → register the cloudflared service → print
the token and Claude Code config.

**Cloudflare auth — pick one:**
- **Interactive** (default): the script opens a browser once — click Authorize.
- **API token** (no popup): set an env var first. The token only needs
  `Tunnel:Edit` + `Zone:DNS:Edit`; used transiently at install, never stored:
  ```powershell
  $env:CLOUDFLARE_API_TOKEN = "cfat_..."
  irm https://<download-host>/vale-command/vale-command-setup.ps1 | iex
  ```

> The script and exe are hosted by the `<download-host>` worker
> (`index/public/vale-command/`). You can also download `vale-command-setup.bat`
> and double-click it (self-elevates, equivalent to the `irm | iex` above).

Multi-device: the script accepts `-Hostname`; pass it via a scriptblock
(`irm | iex` can't take parameters):
```powershell
& ([scriptblock]::Create((irm "https://<download-host>/vale-command/vale-command-setup.ps1"))) -Hostname d2.command.saisi.online
```

## Directory

- `vale-command-setup.bat` — one-click install entry (double-click, self-elevates, fetches and runs `vale-command-setup.ps1`)
- `vale-command-setup.ps1` — full one-click install script (download exe, install service, Cloudflare tunnel, print token)
- `install-service.ps1` — register vale-command as an auto-start Windows service
- `cloudflared-config.example.yml` — Cloudflare tunnel config sample
- `claude-mcp.example.json` — Claude Code MCP config sample
- `build-windows.ps1` — build the headless binary on Windows
- `build-linux-xwin.sh` — cross-compile the Windows headless binary on Linux

## Architecture

```
<download-host> (device list page, optional, see multi-device)
<device-host> ──Cloudflare Tunnel──► vale-command on Windows ──► hardware (serial/network)
Claude Code (anywhere) ──HTTPS/MCP──► https://<device-host>/mcp
Browser (anywhere) ──► https://<device-host> (web panel)
```

---

## Single-machine deploy steps

### 1. Build the headless binary

**On Windows** (recommended):

```powershell
.\deploy\build-windows.ps1
# produces target\release\vale-command.exe
```

**Or cross-compile on Linux** (needs `cargo xwin`):

```bash
./deploy/build-linux-xwin.sh
# produces target/x86_64-pc-windows-msvc/release/vale-command.exe
```

> Features: default `--features terminal,browser` enables serial/SSH/PTY
> terminals and the headless browser (Edge/Chrome). Drop `browser` if you only
> need serial/terminal.

### 2. Install and register the service

Put `vale-command.exe` into `C:\vale-command\`, then:

```powershell
.\deploy\install-service.ps1 -InstallDir "C:\vale-command"
```

The script: bootstraps/updates `config.yaml` (generates a Bearer token on first
run), registers the `ValeCommand` service via `sc create` (auto-start), and
starts it immediately.

Read the token once the service is up:

```powershell
Select-String -Path "C:\vale-command\config.yaml" -Pattern "auth_token"
```

### 3. Expose via Cloudflare Tunnel

```powershell
winget install cloudflared
cloudflared tunnel login          # browser auth (use your Cloudflare account)
cloudflared tunnel create vale-command
cloudflared tunnel route dns vale-command <device-host>
# fill C:\Users\<you>\.cloudflared\config.yml per cloudflared-config.example.yml
cloudflared service install       # register as an auto-start service
```

Verify: open `https://<device-host>` in a browser, enter the token, see the panel.

### 4. Hook up Claude Code

Add an MCP server in your Claude Code config (replace `<TOKEN>` with the one in
config.yaml):

```json
{ "mcpServers": { "vale-command": { "type": "http",
  "url": "https://<device-host>/mcp",
  "headers": { "Authorization": "Bearer <TOKEN>" } } } }
```

> After adding MCP tools, reconnect/restart Claude Code to refresh the tool list.

---

## Multi-device (one instance per machine)

Repeat steps 1–3 on each new machine, changing only the subdomain index
(`d2`, `d3`, …). Each instance has its own token, independent of the others.

Optional aggregate page: a tiny Cloudflare Worker as the `<download-host>`
device list (name → subdomain); clicking through opens each full panel.

---

## Security

- Each instance's token is independent and auto-generated on first run;
  `/api/*` and `/mcp` both require the Bearer token.
- Panel static assets need no token, but data endpoints do; remember the token
  per subdomain in the browser.
- Browser/serial tools work in headless mode; `screenshot_ui`/`evaluate_ui` are
  desktop-only.

## Verification checklist

```powershell
# service status
sc query ValeCommand
# local API
curl.exe -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:18080/api/status
# public API through the tunnel
curl.exe -H "Authorization: Bearer <TOKEN>" https://<device-host>/api/status
# device web page (browser tool drives headless Edge)
curl.exe -H "Authorization: Bearer <TOKEN>" -X POST https://<device-host>/api/tools/browser_navigate -d '{\"url\":\"http://<device-ip>/\"}'
```
