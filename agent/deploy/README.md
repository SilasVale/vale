# Vale Agent deploy

Windows deployment for the vale-agent device agent.

## One-click install

```powershell
irm https://agent.saisi.online/vale-agent/vale-agent-setup.ps1 | iex

# Installer download (the EXE is served from the mirror):
# https://v.saisi.online/dl/ValeAgent-Setup.exe
```

The script (run as Administrator):

1. Downloads `vale-agent.exe` + `vale-tray.exe` + the browser-extension zip
2. Bootstraps `config.yaml` + a fresh auth token
3. Installs cloudflared, authenticates (API token from the Vale console when a
   registration key is set, else interactive browser login)
4. Creates the per-device tunnel `vale-agent-dN` + DNS route
5. Registers the `ValeAgent` boot task (SYSTEM, unlimited) + `ValeAgentTray`
   logon task
6. Installs the `Cloudflared` service

Or use the NSIS installer (`ValeAgent-Setup.exe`, from the console's Devices
page) — it bundles the binaries and runs the same setup script for fresh
installs; silent `/S /D=<dir>` upgrades reuse the existing config.

## Files

- `vale-agent-setup.ps1` — the one-click install script
- `vale-agent-install.nsi` — NSIS installer source
- `run-setup.bat` — self-elevating wrapper for the setup script
- `fix-tunnel.ps1` — repairs a legacy `vale-command-dN` tunnel/ingress to
  `vale-agent-dN` + `*.agent.saisi.online` (idempotent, runs on agent start)
- `vale-browser-control.zip` — the browser extension (load unpacked in
  Chrome/Edge on the device)

## Architecture

```
<device> ──Cloudflare Tunnel (vale-agent-dN)──► vale-agent:18080 ──► MCP / panel
```

The device is reached at `https://dN.agent.saisi.online/` — the status page,
the `/panel/` terminal UI (token auto-injected, host-gated), the `/mcp` MCP
endpoint and the `/api/*` tools API.

## Build

`./scripts/build.sh agent` cross-compiles `vale-agent.exe` + `vale-tray.exe`;
`./scripts/build-installer.sh` bundles the NSIS installer and stages all
download files for the index worker.
