# Vale

Vale is a unified device-control + AI-gateway platform: **one repository** for the front door, the device agent, the browser extension, and the download distribution — one "Vale" brand.

```
Vale Gate (front door, Cloudflare Worker)
  ├─ console — login/roles, BYOK AI gateway, Devices (online status, pairing)
  ├─ /mcp — AI-first device tools: terminal_* (proxied to the device)
  └─ PluginHubDO — per-device WebSocket hub (browser extension, chrome.debugger)
        │
        ▼
Vale Agent (Windows, slim) — headless MCP server + /api/tools + system tray
  └─ plugin registry: terminal / update / mcp-client / design
        │  mcp-client plugin bridges to a local browser MCP server
        ▼
browser MCP server (Node: playwright-mcp / chrome-devtools-mcp) ── drives the browser
Vale Browser Control (Chrome/Edge extension) ── legacy browser drive (chrome.debugger)
Vale Index ── installer / script distribution
```

## Layout

| Directory | Project | Runtime | Description |
|---|---|---|---|
| `gateway/` | **Vale Gate** | Cloudflare Worker | Vale console (login/roles) + AI gateway (BYOK routing) + `/mcp` (AI-first device tools) + PluginHubDO (extension hub) + device reverse proxy |
| `extension/` | **Vale Browser Control** | Chrome/Edge (MV3) | legacy browser drive via `chrome.debugger` (no network ports), keeps a WS to PluginHubDO, full-screen terminal page — superseded by the mcp-client plugin + local browser MCP server |
| `agent/` | **Vale Agent** | Windows (Rust) | slim headless MCP server (`/mcp`, token-gated) + `/api/tools/{name}` + system tray; terminal panel (`/panel`) |
| `index/` | **Vale Index** | Cloudflare Worker | installer / script download distribution |
| `docs/` | docs | — | platform & device-integration design |

## Build & deploy

```bash
# Build command (Windows cross-compile; needs cargo-xwin)
./scripts/build.sh command

# Build the NSIS installer and stage the downloads into index/public/vale-agent/
# (*.exe is gitignored — run this before deploying index, else downloads 404)
./scripts/build-installer.sh

# Deploy workers (needs a Cloudflare API token)
./scripts/build.sh gateway
./scripts/build.sh index

# Everything: build + deploy
./scripts/build.sh deploy
```

See `agent/CLAUDE.md` (Rust build guide) and `gateway/DEVICE-INTEGRATION.md` (device integration).

### Gateway deploy (manual)

```bash
# Pre-deploy gate: the worker test suite must stay green
cd gateway && node --test

# Validate the bundle without publishing (no API token needed)
npx wrangler deploy --dry-run

# Real deploy (needs CLOUDFLARE_API_TOKEN set in the shell; DO migration
# v2-plugin-hub is applied automatically on first deploy)
npx wrangler deploy
```

The post-deploy E2E script (pair → browser_open → screenshot → click → terminal) is in `gateway/DEVICE-INTEGRATION.md`.

## Ecosystem（三个仓库，各司其职）

| 仓库 | 角色 | 说明 |
|---|---|---|
| **vale**（本仓库） | 平台运行时 | gateway / agent / index / extension / proxies |
| `SilasVale/vale-forge` | 开发者工具链 MCP | OpenWrt 编译控制、板子 SSH、TAPD —— 与设备 MCP 并行注册于 Claude Code |
| `SilasVale/vale-deploy` | 运维凭证与重建手册 | CF/GitHub/Vercel 凭证、worker 清单、bootstrap 一键重建（私密） |

合并评估详见 `docs/adr/0003-repo-topology-and-brand.md`（结论：保持分离，
按受众分工；整合发生在客户端层——两路 MCP 同时注册）。

## 设备安装 / 升级（npm 一键流）

```powershell
npm.cmd i -g https://agent.saisi.online/vale-agent/vale-agent-npm.tgz
$env:VALE_AGENT_DIR='D:\vale-agent'
vale.cmd setup --reg-key <注册码>    # 全新设备
vale.cmd update                      # 已装设备：停止→换 exe→重启任务
```

NSIS 安装器（ValeAgent-Setup.exe）保留为无 Node 设备的备用通道。
详见 `SilasVale/vale-deploy` README §0.5。

## Core design

- **Gateway plugin core (DSH-style)**: every `/api/*` route, `/mcp` and `/v1/*` lives in a plugin (`gateway/src/plugins/`: auth / devices / mcp / translate / admin) registered on a shared context; `index.ts` is a thin front door (host split, assets, `/v1` dispatch). Cross-cutting concerns have single implementations: `src/session.ts` (session auth), `src/upstream.ts` (channel route table), `src/http.ts`, `src/reliability.ts`. See `docs/adr/0001-plugin-core-single-dispatch.md`.
- **Device control, AI-first**: Claude Code connects to `https://<console>/mcp` with the admin Bearer token and gets the device tool surface. The Vale Agent plugin registry (`agent/src/plugins/`) exposes 24 tools: the `terminal` plugin (18: PTY/SSH/serial open/write/close/execute/read/screen + secrets + saved connections), `update` (agent_update), `mcp-client` (4: connect/list/call/disconnect — bridge to a local browser MCP server, DSH-style), and `design` (page_view). `terminal_*` proxy to the device's `/api/tools` (token injected server-side); `terminal_screen` returns the ANSI-stripped tail of a session's output buffer.
- **Browser control via mcp-client (playwright)**: the `mcp-client` plugin connects to a local browser MCP server on the device (`playwright-mcp` / `chrome-devtools-mcp`, default `http://127.0.0.1:9229/mcp`) over Streamable HTTP, and forwards its tools (`browser_navigate`, `browser_snapshot`, `browser_click`, …) through the Vale tool surface — same wiring as DeepSeek Harness's `mcp-client` plugin. The browser MCP server (Node process on the device) does the actual browser work; the Rust agent only bridges.
- **Console UI**: React + Vite (`gateway/ui`), built into `gateway/public`. One design-system vocabulary (tokens/components in `ui/src/styles/globals.css` + `components/ui.tsx`), dark mode, hash routing (#/keys etc. — no history-API fallback needed behind Workers Assets).
- **Extension pairing (no account)**: the console generates a one-time pairing code (10 min); the extension claims it for a plugin token, trades the token for a one-time WS ticket, and opens the per-device hub socket. The same plugin token authenticates the extension's terminal page through the device reverse proxy (token scoped to its own device only).
- **Vale Agent (slim)**: headless MCP server + `/api/tools`; `GET /` is a minimal status page, `/panel` is the terminal panel (token entered in the browser, saved to localStorage). The tray app (vale-tray) offers four functions: copy MCP config, open console, local terminal, start/stop/restart/quit.
- **Claude Code direct** (per device, without the gateway):
  ```json
  { "mcpServers": { "vale-agent": { "type": "http", "url": "https://<device-host>/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
  ```
- **Claude Code via the gateway** (all devices, one endpoint):
  ```json
  { "mcpServers": { "vale-gate": { "type": "http", "url": "https://<console>/mcp", "headers": { "Authorization": "Bearer <admin-token>" } } } }
  ```
  The console's Devices panel shows a ready-made `vale-gate` snippet (with the current user's token) and a per-device `vale-agent` snippet.

## Tokens (3 trust boundaries → 3 tokens)

| Token | Name | Where | Authenticates | Held by |
|---|---|---|---|---|
| **Device access token** | `device_token` (legacy `auth_token`, 0.8.5-compatible) | `C:\vale-agent\config.yaml` | Device API (`/api/*`) + MCP (`/mcp`) + terminal panel | the device (Windows) |
| **Console token** | `console_token` (user token / x-api-key) | user settings.json / console settings | gateway admin + AI routing | you (Claude config) |
| **Browser token** | `browser_token` (plugin token) | extension `chrome.storage` (auto-saved on pairing) | plugin WS / browser drive | the browser extension |

**How to obtain**:
- `device_token`: after installing vale-agent, read the `device_token:` line in `C:\vale-agent\config.yaml` (auto-generated). **The terminal panel uses this**: open `https://<device-host>/panel/`, enter it once, the browser remembers it.
- `console_token`: after logging into the console, copy the MCP config (with token) from the settings/devices page.
- `browser_token`: no manual step — the console's devices page generates a pairing code; the extension stores it automatically when pairing.

**Principle**: one token per trust boundary, no duplication. `device.token` (entered when registering the device on the gateway) is the same value as `device_token` — fill in the value from config.yaml when registering a device.
