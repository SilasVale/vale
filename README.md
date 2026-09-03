# Vale

[![CI](https://github.com/SilasVale/vale/actions/workflows/ci.yml/badge.svg)](https://github.com/SilasVale/vale/actions/workflows/ci.yml)

Vale turns a Windows device into an **AI-controllable workspace** — terminal, SSH, serial and browser sessions exposed to AI through MCP, plus an Electron desktop shell and a device-local memory. One repository for the front door, the device agent and the download distribution.

```
Vale Gate (front door, Cloudflare Worker) — console, BYOK AI gateway, /mcp proxy
        │
        ▼
Vale Agent (Windows, Rust) — headless MCP server + /api/tools + panel
  └─ plugin registry: terminal / memory / system / mcp-client / update / design
        │  mcp-client bridges to a local browser MCP server (playwright)
        ▼
Vale Desktop (Electron) — tray + native menu + CDP :9333 for AI-driven UI
Vale Index (Cloudflare Worker) — npm tgz / download distribution
```

## Highlights

- **OSC 633 shell integration** (the VS Code approach): PowerShell prompts and command boundaries arrive as invisible sequences — clean terminal display, accurate exit codes, no wrapper text, no front-end filters.
- **Electron desktop shell** (TypeScript): live agent status in the tray, native menu (sessions + page navigation), CDP :9333 so AI can drive the same window the user watches, browser-window reuse + cap, hide-to-tray with a one-time notification.
- **Memory plugin**: device-local knowledge base shared across AI clients — 6 MCP tools (`memory_save/search/list/update/delete/export`), multi-word AND search, eager tombstone compaction.
- **47 MCP tools** on the device: terminal (26: PTY/SSH/serial open/write/close/execute/read/screen/history/background jobs/saved connections/secrets/env + legacy aliases), memory (6), system (7: file list/read/write/stat, process list/kill, net test), mcp-client (4), playwright (2), update (2), design (1).
- **Health endpoint**: `/api/status` reports version, uptime and live session count — consumed by the tray, the SPA status strip and AI health checks.
- **npm-only distribution**: one-command install/update, WMI-survives-the-kill swap, electron auto-restart on update.

## Quick start (Windows)

```powershell
npm.cmd i -g https://agent.saisi.online/vale-agent/vale-agent-latest.tgz   # or pin an exact version
vale setup                 # pure local install (registry-first, no cloud needed)
vale setup --reg-key <key> # optional: register the device with a Vale Gate console
vale update                # later: one-command update (exe + electron shell)
```

The install dir is registry-first (`HKLM\SOFTWARE\Vale\Agent\InstallDir`); all path resolution goes through `src/paths.rs`. The terminal panel is served by the agent at `/panel` (token entered once in the browser), and the Electron desktop shell loads `/desktop/`.

## Repository layout

| Directory | Project | Runtime | Description |
|---|---|---|---|
| `gateway/` | **Vale Gate** | Cloudflare Worker | console (login/roles), BYOK AI gateway, `/mcp` proxy to devices, device registry |
| `agent/` | **Vale Agent** | Windows (Rust) | headless MCP server + `/api/tools` + panel + Electron desktop shell (`vale-desktop-electron/`) + npm distribution (`vale-agent-npm/`) |
| `index/` | **Vale Index** | Cloudflare Worker | download distribution (`vale-dist`; hosts the npm tgz, see Quick start) |
| `extension/` | **Vale Studio Links** | Chrome/Edge (MV3) | rewrites DSH panel file paths into Vale Studio deep links (unpacked; no build) |
| `docs/` | docs | — | design decisions (`docs/adr/`), agent build guide (`agent/AGENTS.md`) |

## Build & deploy

```bash
# Windows cross-compile of vale-agent (needs cargo-xwin)
./scripts/build.sh agent

# CDN-publish a release (pack + stage + version.json sha256 + last-5 prune
# + deploy; then push + tag vX to get the CI-built GitHub release)
./scripts/publish-release.sh 1.2.N

# Deploy the workers (needs a Cloudflare API token)
./scripts/build.sh gateway
./scripts/build.sh index
```

See `agent/AGENTS.md` (Rust build guide) and `docs/superpowers/specs/2026-08-28-vale-desktop-core-design.md` (desktop/core; `gateway/DEVICE-INTEGRATION.md` is a superseded 2026-08 design).

## Core design

- **Gateway plugin core (DSH-style)**: every `/api/*` route and `/mcp` lives in a plugin (`gateway/src/plugins/`: auth / devices / mcp / translate / admin) on a shared context; `index.ts` is a thin front door.
- **Device control, AI-first**: an AI client connects to `https://<console>/mcp` (gateway) or `https://<device>/mcp` (direct) with a bearer token and gets the device tool surface.
- **Terminal backends**: PTY (ConPTY on Windows, OSC 633 shell integration), SSH (keepalive 5s, bounded writes) and serial (auto-reconnect). Natural shell exits are detected (exit codes surface in `terminal_history`); the reader is pollable so `exit` never hangs the session.
- **Browser control via mcp-client**: the `mcp-client` plugin connects to a local browser MCP server (`playwright-mcp`, default `http://127.0.0.1:9229/mcp`) and forwards its tools; the Rust agent only bridges. The Electron shell also exposes CDP :9333 for driving the desktop UI itself.
- **Memory**: JSONL-backed knowledge base under the install dir, sanitized credentials, LRU caps, soft delete + compaction.
- **Console UI**: React + Vite (`gateway/ui`), built into `gateway/public`, dark mode, hash routing.

## License

MIT — see [LICENSE](LICENSE).
