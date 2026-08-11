# Vale device control — Vale Gate + browser extension (v2)

> Status: **implemented** (monorepo `gateway/` + `extension/` + `agent/`)
> Date: 2026-08-06 (v2 — browser extension + chrome.debugger replaces the 2026-08-02 design: web panel, remote CDP, panel-only proxy)

## Background & goal

- **Vale Gate** — AI gateway console (login + admin/user roles + invite codes), runs on a Cloudflare Worker
- **Vale Command** — slim headless MCP server on Windows (web panel retired), exposed via Cloudflare Tunnels, one subdomain per machine

**Goal**: bring device control into the Vale Gate console as an admin-only「Devices」module, and give Claude Code one `/mcp` endpoint that operates every device's **browser and terminal**.

## Key architecture conclusions (v2)

1. **Browser control lives in an extension, not a second device server**: the **Vale Browser Control** extension (Chrome/Edge MV3) drives the device's real browser via `chrome.debugger` — internal CDP, no network ports to open. The extension keeps a WebSocket to a per-device **PluginHubDO**; the gateway's `/mcp` routes `browser_*` tool calls through the hub as request/response frames.
2. **Terminal control keeps the device's existing `/api/tools` surface**: the gateway proxies `terminal_*` MCP calls to Vale Command, injecting the device Bearer token server-side (same pattern as the device panel proxy).
3. **No extension account needed**: pairing is code-based — admin generates a one-time code, the extension claims it for a plugin token, and the token trades for a one-time WS ticket. The plugin token also authenticates the extension's terminal page through the reverse proxy, scoped to its own device only.

## Architecture

```
Claude Code ── https://<console>/mcp (admin Bearer token) ──► Vale Gate
   │ terminal_*  → device /api/tools (token injected server-side)
   │ browser_*   → PluginHubDO /call {tool, params, requestId}
   ▼                        │ WS frames {id, type: request|response}
Vale Command (Windows)      Vale Browser Control extension
   /mcp + /api/tools          │ chrome.debugger (internal CDP)
                              ▼
                    device's real Chrome/Edge tab
Extension terminal page ── device reverse proxy (plugin token) ──► /api/events/term + terminal_write
```

## Endpoints (gateway `src/index.js`)

Public (the pairing code / plugin token is the credential — same pattern as registration keys):

- `POST /api/plugins/pair/claim` `{code}` → `{token, device}` — one-time pairing code (10 min TTL, `pair:<code>`); yields the plugin token, stored in the `plugins:v1` links map
- `POST /api/plugins/ws-ticket` (Bearer plugin token) → `{ticket, device}` — one-time WS ticket (60 s TTL, `plg-ticket:<t>`), keeps the long-lived token out of the `/ws` URL
- `GET /api/plugins/ws?device=<d>&ticket=<t>` — ticket-gated WebSocket upgrade to the per-device PluginHubDO (token must match the device)
- `<any> /api/devices/<name>/proxy/<rest>` — device reverse proxy: admin session cookie **or** paired plugin token; the token grants access only to its own device (no admin APIs, no `/api/me`)

Admin (session required):

- `POST /api/plugins/pair` `{device}` → one-time pairing code
- `POST /api/plugins/unpair` `{device}` → drop all plugin links for the device
- `GET /api/plugins/status` → `{devices: {name: {online}}}` per device, via the PluginHubDO

MCP (page host only, admin token):

- `GET|POST /mcp` (`src/mcp.js`) — hand-rolled streamable HTTP MCP (JSON-RPC 2.0, zero deps): `initialize` / `ping` / `tools/list` / `tools/call`; GET returns a keepalive SSE stream (Claude Code probes GET first). Terminal tools call `deviceFetch`; browser tools call the hub; results with an `image` field become MCP image blocks (`src/mcp.js` `formatResult`).

## PluginHubDO (`src/plugin-hub.js`)

One DO per device (`idFromName`), WebSocket Hibernation. Extension pings every 20 s; a storage alarm (65 s after the last message) closes a stale socket. Single-connection semantics — a new socket replaces the old. `/call` resolves via the pending map with a 60 s timeout; `webSocketClose` rejects all in-flight calls with `extension_disconnected` so MCP gets a clear error, never a hang.

## Browser extension (`extension/`)

- **manifest**: MV3, permissions `tabs / debugger / storage / alarms`; background service worker handles pairing, WS lifecycle, and the tool message hub
- **lib/cdp.js** — `chrome.debugger` attach/enable + detach tracking; **lib/elements.js** — in-page interactive-element snapshot (shadow-DOM aware) with refs for click/type; **lib/tools.js** — `browser_*` tools → CDP commands; screenshots return `{image: {data, mimeType}}` (base64 PNG)
- **popup** — pair (paste code → claim → plugin token), open controlled tab (`<console>/api/devices/<d>/proxy/`), terminal page, unpair; **options** — console origin
- **terminal/terminal.html** — full-screen xterm: fetch-read SSE on the device's `/api/events/term` (frames filtered by session_id), keystrokes → `POST /api/tools/terminal_write`, resize → `terminal_resize`; every request carries `Authorization: Bearer <pluginToken>` through the gateway proxy (cross-site page, no console cookie)

## Vale Agent (slimmed, `agent/`)

- Web panel retired → minimal status page (`GET /`); still serves `/mcp` (rmcp streamable HTTP, token-gated), `/api/events` SSE, `/api/status`, `POST /api/tools/{name}`
- **terminal_screen** (`src/plugins/terminal/tools.rs`) — tail-N-lines of a session's output buffer, ANSI-stripped, for AI readability (default 60 lines, reports dropped bytes if the buffer wrapped)
- **terminal_execute** (MCP `terminal_send`) — sends input and waits for a quiet period before returning accumulated screen text
- **vale-tray** — Windows tray: 4 functions — copy MCP config, open console, local terminal, start/stop/restart/quit; status lines (状态/域名/Token)

## Console — Devices UI (`gateway/public/app.js`)

Device list (name / hostname / masked token) with an **online badge** (polled from `/api/plugins/status` every 30 s), **pair** button → modal with the one-time code, open panel via the proxy, copy per-device `vale-command` MCP config, and a ready-made **gateway MCP snippet** (`vale-gate` at `<origin>/mcp`, current user's token).

## MCP tools (12, `src/mcp-tools.js`)

- Terminal: `terminal_open`, `terminal_screen`, `terminal_send`, `terminal_list`, `terminal_close`
- Browser: `browser_open`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_wait`, `browser_close`

## Verification

- ✅ Gateway suite: `cd gateway && node --test` — 98/98 green (MCP handler + browser tools, plugin pairing/ticket, proxy auth + WS, store/cache, reliability)
- ✅ Bundle: `npx wrangler deploy --dry-run` — 20 assets, DO bindings (BreakerDO, PluginHubDO) and migration `v2-plugin-hub` validated
- ⏳ Production E2E pending (needs a real Chrome with the extension + a real device + a deployed worker) — see checklist below

## E2E checklist (run after `wrangler deploy`)

1. Load `extension/` unpacked in Chrome/Edge; set the console origin in Options.
2. Console → Devices → generate a pairing code for the device → paste it in the extension popup → **Pair**. Popup shows the device and WS status (heartbeat every 20 s).
3. Add the gateway MCP server (console shows the ready-made snippet):
   ```bash
   claude mcp add vale-gate --transport http --url https://<console>/mcp --header "Authorization: Bearer <token>"
   ```
4. Run the script — `browser_open` (device panel) → `browser_screenshot` (view image) → `browser_click` (panel element) → `terminal_open` → `terminal_send('ping')` → `terminal_screen` (check text).
5. Verify throughout: extension stays connected (popup status / pong), screenshot renders, click takes effect, terminal screen text is correct, `terminal_screen` after `terminal_send` shows the ping output.

## Future options

- Path wrapper (friendly URLs, still subdomain tunnels underneath)
- Extension auto-update / signing (CRX3) instead of load-unpacked
