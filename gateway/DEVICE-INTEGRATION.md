# Vale Command → Vale Gate integration (device control, admin-only)

> Status: **implemented** (monorepo `gateway/`)
> Date: 2026-08-02

## Background & goal

Two parts of the Vale platform:
- **Vale Gate** — AI gateway console (login + admin/user roles + invite codes), runs on a Cloudflare Worker
- **Vale Command** — device command center (headless MCP server + web panel), runs on Windows machines, exposed via Cloudflare Tunnels, one subdomain per machine

**Goal**: bring Vale Command device control into the Vale Gate console as an **admin-only「Devices」module** — one console, one login to operate every device, no need to paste a Vale Command token.

## Key architecture conclusions

1. **Vale Command cannot run as a code plugin inside Vale Gate**: Vale Gate is a Cloudflare Worker (edge, stateless); Vale Command must run on Windows (serial/terminal/real browser). The "plugin" is a **front-door integration module**, not embedded code.
2. **Token lives on Cloudflare, visible to admin only**: stored in Vale Gate KV (`devices:v1`, per device `{name, hostname, token}`), only `role.admin` can add/edit/delete/view (list masks the token; the MCP-config endpoint returns the full value). **Never auto-dispensed publicly** — no anonymous URL yields a token.
3. **Claude Code (MCP) unaffected**: it uses the Vale Command Bearer token directly (configured once; can be copied from the console), independent of Vale Gate.

## Architecture

```
browser ──login to Vale console──► [admin] Devices module
                                        │ lists d1/d2…
                                        ▼
                                  reverse-proxy to device subdomain (dN)
                                  inject Authorization: Bearer <device token>
                                        ▼
                               Vale Command on Windows (panel/MCP)
Claude Code ──► https://<device-host>/mcp (direct token, not via Vale Gate)
```

## Requirements

### Must
- Vale Gate console gains a **「Devices」** section, `role.admin` only (normal users 403)
- Device list (from storage: name → host → token)
- Reverse proxy to the device panel, Bearer token injected server-side (browser never touches the token)
- Proxy handles: HTTP/HTTPS, SSE/MCP streaming, long-lived connections
- Device token configured in the console by admin (or auto-registered at install)

### Non-goals
- Do not run Vale Command code inside Vale Gate
- Do not replace the Claude Code Vale Command token

## Implemented

- **store.js**: `listDevices / saveDevices / getDevice / upsertDevice / deleteDevice`, KV key `devices:v1`; registration keys `regkey:<code>`.
- **index.js** (`handleConsole`, `role.admin` section):
  - `GET /api/devices` — list (token masked)
  - `POST /api/devices` — add/update `{name, hostname, token}`
  - `POST /api/devices/register-key` — generate a one-time install key
  - `DELETE /api/devices/<name>`
  - `GET /api/devices/<name>/mcp` — ready-made MCP config JSON (the only endpoint returning the full token)
  - `<any> /api/devices/<name>/proxy/<rest>` — reverse proxy: injects `Authorization: Bearer <token>` (server-side), passes `text/event-stream`/octet-stream through without buffering, rewrites panel HTML/JS/CSS absolute paths to the proxy mount so the SPA's `/api/*`, `/app.js` etc. keep working.
  - `POST /api/register` (public, key-gated) — the install script auto-registers a device
  - `POST /api/install/tunnel-token` (public, key-gated) — the install script fetches the Cloudflare tunnel credential
- **public/app.js + index.html + style.css**: admin「Devices」panel (list / add / delete / copy MCP config / open panel / auto-register).
- **vale-command-setup.ps1**: registration-key auto-registration + fetching the tunnel credential from the console (no browser auth needed).

## Verification

- ✅ Normal user cannot see the「Devices」nav; unauthenticated `GET /api/devices` → 401
- ✅ Admin: add/remove/list devices, masked tokens, MCP config retrieval (API tests + path-rewrite unit tests)
- ✅ Reverse proxy end-to-end: proxying a real device panel root → 200 with rewritten HTML; wrong token → device 401 passed through; unreachable device → 502
- ✅ Auto-registration: one-time key, invalid key → 403, device appears in the list after install (verified live)
- ⏳ Manual check pending: operate the panel from the console (serial/terminal/browser), SSE streaming stays smooth, Claude Code direct MCP unaffected

## Future options

- Path wrapper (friendly URLs, still subdomain tunnels underneath)
- Vale Command tray「open panel」carries the token automatically (local browser, no login)
