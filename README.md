# Vale

Vale is a unified device-control + AI-gateway platform: **one repository** for the front door, the device agent, and the download distribution — one "Vale" brand.

```
Vale Gate (front door) ── one login for AI + devices
     │ reverse proxy (server-side token injection)
Vale Command (device agent, Windows) ── one subdomain per machine
     │ Claude Code connects straight to /mcp (Bearer token)
     └ serial / terminal / browser control
Vale Index ── installer / script distribution
```

## Layout

| Directory | Project | Runtime | Description |
|---|---|---|---|
| `gateway/` | **Vale Gate** | Cloudflare Worker | Vale console (login/roles) + AI gateway (BYOK routing) + device management (MCP config / panel proxy) |
| `command/` | **Vale Command** | Windows (Rust) | headless MCP server + web panel + system tray |
| `index/` | **Vale Index** | Cloudflare Worker | installer / script download distribution |
| `docs/` | docs | — | platform & device-integration design |

## Build & deploy

```bash
# Build command (Windows cross-compile; needs cargo-xwin)
./scripts/build.sh command

# Build the NSIS installer and stage the downloads into index/public/vale-command/
# (*.exe is gitignored — run this before deploying index, else downloads 404)
./scripts/build-installer.sh

# Deploy workers (needs a Cloudflare API token)
./scripts/build.sh gateway
./scripts/build.sh index

# Everything: build + deploy
./scripts/build.sh deploy
```

See `command/CLAUDE.md` (Rust build guide) and `gateway/DEVICE-INTEGRATION.md` (device integration).

## Core design

- **Vale Command**: runs on each Windows machine — headless MCP server (`/mcp`, token-gated) + web panel (`/`), exposed over a Cloudflare Tunnel, one subdomain + token per machine.
- **Token**: generated at install, kept in `config.yaml`; MCP uses `Authorization: Bearer <token>` directly. The console can copy a ready-made MCP config per device.
- **Claude Code direct**: `{ "mcpServers": { "vale-command": { "type": "http", "url": "https://<device-host>/mcp", "headers": { "Authorization": "Bearer <token>" } } } }`
