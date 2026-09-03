# Vale Agent deploy

Windows deployment notes for the vale-agent device agent. The install and
update channel is **npm-only** (the NSIS installer and setup.ps1 are retired
in `deploy/retired/`).

## Install / update

```powershell
npm i -g vale-agent          # or: npm i -g <your tgz URL>
vale setup                   # pure local install (registry-first)
vale setup --reg-key <key>   # optional: register with a Vale Gate console
vale update                  # one-command update
```

- Install dir: registry-first (`HKLM\SOFTWARE\Vale\Agent\InstallDir`); all
  path resolution goes through `src/paths.rs`.
- The `ValeAgent` boot task runs the agent as SYSTEM (no execution-time
  limit, restart-on-failure ×8, 5-min repetition watchdog).
- Optional public access: a Cloudflare Tunnel (`cloudflared`) exposes the
  device at `<device-host>` — the status page, `/panel/` terminal UI, `/mcp`
  endpoint and `/api/*` tools.

## Files

- `fix-tunnel.ps1` — repairs a legacy `vale-command-<device>` tunnel/ingress
  to `vale-agent-<device>` (idempotent, runs on agent start)
- `cloudflared-config.example.yml` — example tunnel ingress config
- `claude-mcp.example.json` — example Claude Code MCP registration
- `retired/` — NSIS installer + setup.ps1 (superseded by npm)

## Architecture

```
<device> ──Cloudflare Tunnel──► vale-agent:18080 ──► MCP / panel / desktop
```

## Build / release

`./scripts/build.sh agent` cross-compiles `vale-agent.exe`;
`./scripts/publish-release.sh 1.2.N` (from the repo root) does the CDN
release (pack + stage + version.json sha256 + last-5 prune + deploy).
