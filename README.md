# Vale

Vale is a unified device-control + AI-gateway platform: **one repository** for the front door, the device agent, the browser extension, and the download distribution — one "Vale" brand.

```
Vale Gate (front door, Cloudflare Worker)
  ├─ console — login/roles, BYOK AI gateway, Devices (online status, pairing)
  ├─ /mcp — AI-first device tools: terminal_* (proxied to the device)
  │         + browser_* (routed to the browser extension via PluginHubDO)
  └─ PluginHubDO — per-device WebSocket hub
        │  request/response frames (chrome.debugger, internal CDP)
        ▼
Vale Browser Control (Chrome/Edge extension) ── drives the device's real browser
Vale Agent (Windows, slim) ── headless MCP server + /api/tools + system tray
Vale Index ── installer / script distribution
```

## Layout

| Directory | Project | Runtime | Description |
|---|---|---|---|
| `gateway/` | **Vale Gate** | Cloudflare Worker | Vale console (login/roles) + AI gateway (BYOK routing) + `/mcp` (AI-first device tools) + PluginHubDO (extension hub) + device reverse proxy |
| `extension/` | **Vale Browser Control** | Chrome/Edge (MV3) | pairs with the console, drives the device's real browser via `chrome.debugger` (no network ports), keeps a WS to PluginHubDO, full-screen terminal page |
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

## Core design

- **Device control, AI-first**: Claude Code connects to `https://<console>/mcp` with the admin Bearer token and gets 12 tools. `terminal_open / terminal_screen / terminal_send / terminal_list / terminal_close` proxy to the device's `/api/tools` (token injected server-side); `browser_open / browser_snapshot / browser_screenshot / browser_click / browser_type / browser_wait / browser_close` route via PluginHubDO → the browser extension → `chrome.debugger`. Screenshots come back as MCP image blocks; `terminal_screen` returns the ANSI-stripped tail of a session's output buffer.
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

## Tokens 体系(3 个边界 → 3 个 token)

| Token | 名字 | 在哪 | 认证什么 | 谁持有 |
|---|---|---|---|---|
| **设备访问令牌** | `device_token`(旧名 `auth_token`,0.8.5 兼容) | `C:\vale-agent\config.yaml` | 设备 API(`/api/*`)+ MCP(`/mcp`)+ 终端面板 | 设备(Windows) |
| **控制台令牌** | `console_token`(user token / x-api-key) | 用户 settings.json / 控制台设置 | 网关管理 + AI 路由 | 你(Claude 配置) |
| **浏览器令牌** | `browser_token`(plugin token) | 扩展 `chrome.storage`(配对自动存) | 插件 WS / browser 驱动 | 浏览器扩展 |

**获取方式**:
- `device_token`:装好 vale-agent 后读 `C:\vale-agent\config.yaml` 的 `device_token:` 行(自动生成)。**终端面板用这个**:打开 `https://<device-host>/panel/` 填一次,浏览器记住。
- `console_token`:控制台登录后,设置/设备页复制 MCP 配置(带 token)。
- `browser_token`:不用手动获取——控制台设备页生成配对码,扩展配对时自动存。

**原则**:一个信任边界一个 token,不再重复。`device.token`(网关注册时填的)与 `device_token` 是同一份——注册设备时填 config.yaml 里的值即可。
