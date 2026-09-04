> **SUPERSEDED (2026-09-04, round-343)** — this extension-based design
> (browser extension + chrome.debugger + PluginHubDO) was fully retired:
> the browser extension was deleted round-262 and the last of its
> gateway surface (pairing endpoints, PluginHubDO, console UI) was
> removed round-339..342. Browser control today = playwright-mcp driving
> the Electron embedded view on CDP 9333. See `agent/AGENTS.md` and
> `docs/superpowers/specs/2026-08-28-vale-desktop-core-design.md`.

# Device Operations Redesign v2: Browser Extension + AI-First MCP

Date: 2026-08-06
Status: Approved (plan approved after the user confirmed the extension approach + environment-constraint adjustments)

## Context

The current device management terminal/browser approaches don't work well, and remote CDP (headless Chrome port 19623) on Windows is unreachable and broken. After several rounds of clarification, the root causes:

1. **browser**: Windows headless Chrome screenshots → 2s-per-frame PNG SSE → an `<img>` observation window, not interactive; the remote CDP port is unreachable across networks
2. **terminal**: xterm.js + SSE downlink + one HTTP POST per keystroke uplink (browser → gateway → cloudflared → Windows), with noticeable WAN latency
3. **MCP tool surface**: coordinate-based `browser_click` and a byte-stream terminal are awkward for AI (Claude Code)
4. **vale-command**: poor experience with the web panel, Tauri desktop, and browser automation

**Core shift**: Claude Code is the "brain" (knows what changed and what to test), **the browser extension is the "hands and eyes"**. The MCP tool surface changes from coordinates/byte-streams to **AI-first: vision + semantics**.

**Environment constraint (key)**: the dev machine (running Claude Code) is a headless server with no browser; the machine that daily uses a browser is the Windows device itself. So the extension is installed in the **Windows device's Chrome/Edge**, and the dev machine only needs HTTPS to the gateway.

## Architecture

```
Claude Code (dev machine, headless)
  → MCP (HTTPS) → https://<console>/mcp   (Bearer user token, admin)
  → gateway Worker vale-gate
      ├─ terminal tools → deviceFetch → https://dN.command.saisi.online (Bearer injected)
      └─ browser tools → PluginHubDO(idFromName(device)) → WebSocket
  → browser extension (Windows device Chrome/Edge)
      ├─ chrome.debugger (in-process, no ports) → a controlled real tab
      │    URL = https://<console>/api/devices/<d>/proxy/ (panel embedded, zero extra components)
      └─ terminal page: xterm ← EventSource proxied SSE; keystrokes POST
```

**Key mechanisms**:
- The extension makes outbound connections to the gateway WS (reuses 443, no new ports), same pattern as the cloudflared tunnel; the gateway routes commands per device
- `chrome.debugger` is an internal Chrome mechanism that controls local tabs — **no network ports** — permanently fixing "remote CDP unreachable"
- Tab form = **panel-embedded** (the reverse-proxied device panel, embedding the device web page for viewing)
- Session persistence: ordinary cookies; the console needs to be logged in once in the controlled tab first

**Tool pipeline** (using `browser_click` as an example):
Claude Code → /mcp → mcp.js auth (admin) → PluginHubDO `/call` registers a pending (60s) → ws.send → extension SW → CDP controller (Runtime.evaluate resolves the CSS path → Input.dispatchMouseEvent) → snapshot → back the same way. Screenshots return an MCP image content block (PNG base64; Claude Code views the image directly).

**Terminal tool pipeline** (`terminal_send`): Claude Code → /mcp → deviceFetch passes through to `/api/tools/terminal_execute` (write command → quiet detection → return accumulated text). **Does not go through the extension WS** (the terminal physically depends on the device; one fewer hop).

## Extension (new directory `extension/`)

- **manifest**: MV3, permissions `["tabs","debugger","storage","alarms"]`, host_permissions covering the console domain + a device subdomain wildcard; **no content script** (all in-page operations go through CDP Runtime.evaluate, zero intrusion)
- **SW lifecycle**: WS 20s bidirectional ping (Chrome 116+ messages reset the idle timer) + a `chrome.alarms` 4-minute fallback; state in `chrome.storage.session` for rehydration; Chrome 118+ keeps the SW alive with an active debugger session
- **attach strategy**: one controlled tab per device (`tabs.create`), attached on demand and kept; attach failures return actionable errors (DevTools conflict / non-attachable page); a WS disconnect **never detaches**
- **CDP domains**: Page (navigate/captureScreenshot/loadEventFired), Runtime (element tree/focus/scrollIntoView), Input (dispatchMouseEvent clicks, insertText input — real events)
- **element tree**: injected JS pierces open shadow roots, collects interactive elements (a/button/input/select/textarea/[role=button], etc.), filters out invisible ones, capped at 120; each element `{ref, tag, role, text, name, type, value (masked for passwords), href, rect, visible}` + page `{url, title, readyState}`; refs bind to a **unique CSS selector path**, re-resolved on click/type; if the DOM changed, re-shoot the snapshot automatically and notify
- **WS client**: first `POST /api/plugins/ws-ticket` (Bearer plugin token) for a one-time short-lived ticket → `wss://<console>/api/plugins/ws?device=<d>&ticket=<t>`; frame protocol `{id, type:"request|response|ping|pong|hello", tool, params, ok, result, error}`; exponential backoff reconnect 1s→30s with jitter
- **terminal page**: full-screen xterm + multi-session tabs; downlink EventSource proxies the SSE (gateway injects the Bearer), uplink fetch proxies the POSTs
- **popup**: connection status / device / controlled tab / buttons (open panel / open terminal / pair / options)
- **Install method (decided)**: A. an "Install extension" button + instructions in the console's Devices panel (download zip + unzip + load unpacked extension at chrome://extensions); B. a Windows-side install script (PowerShell downloads/unzips/prints instructions, merged into vale-command-setup.ps1 or standalone). No Chrome Web Store listing (high review cost, deferred).

## Gateway changes (`gateway/`)

### 1. Fix the WS reverse proxy (phase 1, root-cause fix)

`index.js:720-725` currently constructs a `status:101` Response without a `webSocket` property → **always throws RangeError → 500** (the root cause of WS always breaking through the proxy). Change to:

```js
if (resp.status === 101) {
  if (resp.webSocket) {
    try { return new Response(null, { status: 101, webSocket: resp.webSocket }); }
    catch { return resp; }          // workerd #3047 fallback: if re-wrapping throws, pass through directly
  }
  return new Response(resp.body || null, { status: 101, headers: outHeaders });
}
```

The SSE/octet-stream branches stay; the 101 branch is split out.

### 2. PluginHubDO (new `src/plugin-hub.js`)

- One DO instance per device (`idFromName(deviceName)`); **DO + WebSocket Hibernation is required** (bare Worker WS dies with isolate eviction)
- `/ws`: `state.acceptWebSocket` (hibernation), records the device; a second connection for the same device closes the old one (single instance)
- `/call`: no WS → `503 {error:"extension_offline"}`; otherwise register as pending (60s timeout) → ws.send → webSocketMessage resolves by id
- `/status`: `getWebSockets().length>0` or storage lastSeen
- **liveness** (hibernation timers don't run): `setAlarm(+65s)` on webSocketMessage; when the alarm fires with no live WS → close the connection. The extension's 20s ping naturally resets the alarm

### 3. Plugin pairing and tickets (`src/store.js` + `index.js` routes)

New KV entries:
- `plugins:v1`: `pluginToken → {device, createdAt}`, helpers `addPluginLink/removePluginLink/getPluginByToken`
- One-time ticket `plg-ticket:<rand> → device` (TTL 60s), pairing code `pair:<code> → device` (TTL 600s), reusing `randomHex`

Routes (admin section):
- `POST /api/plugins/pair` (admin session) `{device}` → pairing code
- `POST /api/plugins/pair/claim` (public, the code is the credential, modeled on `/api/register`) → validate/consume/issue pluginToken
- `POST /api/plugins/ws-ticket` (Bearer pluginToken) → one-time WS ticket
- `POST /api/plugins/unpair` (admin) `{device}`
- `GET /api/plugins/status` (admin) → per-device `{online}`

In `wrangler.jsonc`: DO binding `PLUGIN_HUB → PluginHubDO` + migration `v2-plugin-hub` (`new_sqlite_classes`, following the BreakerDO precedent).

### 4. MCP server endpoint (new `src/mcp.js` + `src/mcp-tools.js`)

- **Hand-rolled JSON-RPC 2.0** (not @modelcontextprotocol/sdk: the gateway is zero-dependency; the sdk's streamable HTTP on Workers needs a fetch-to-node bridge, cost outweighs benefit; the protocol subset is ~200 lines, with the risk hedged by wiring up real Claude Code in stage 1)
- Routing: `isPageHost && path === "/mcp"` (after console API checks, before static pages)
- Auth: `Authorization: Bearer <token>` → `findUserByToken` → `role.admin`
- **GET /mcp must return a keep-open SSE stream** (Claude Code v2.1.84+ does GET before POST; a 405 means failure) + a keepalive comment every 15s; POST returns application/json; stateless
- `initialize`: echo protocolVersion, `capabilities:{tools:{listChanged:false}}`, `serverInfo:{name:"vale-gate"}`

Tool registry (all tools take a `device` parameter, validated against KV):

| Tool | Route | Description |
|---|---|---|
| `browser_open(device,url)` | DO→extension | open/navigate the controlled tab, wait for load (30s), return snapshot |
| `browser_snapshot(device)` | DO→extension | interactive element tree JSON |
| `browser_screenshot(device,full_page?)` | DO→extension | **image content block** (PNG base64) |
| `browser_click(device,element_ref)` | DO→extension | click, then return snapshot |
| `browser_type(device,element_ref,text)` | DO→extension | focus + insertText, return snapshot |
| `browser_wait(device,condition,timeout_s?)` | DO→extension | poll the condition (selector/text), return snapshot |
| `browser_close(device)` | DO→extension | close the controlled tab |
| `terminal_open(device,kind,target,rows?,cols?)` | deviceFetch | pass through to `/api/tools/terminal_open` |
| `terminal_screen(device,session_id,lines?)` | deviceFetch | **new device tool**, last N lines of screen text |
| `terminal_send(device,session_id,input,quiet_ms?)` | deviceFetch | pass through `terminal_execute` session mode (quiet detection on the device side) |
| `terminal_list(device)` | deviceFetch | pass through |
| `terminal_close(device,session_id)` | deviceFetch | pass through |

- **Extract `deviceFetch(env, device, path, body)`**: pull a shared function out of `proxyDevice` (Bearer injection, host/cookie sanitization, 502 wrapping) with zero behavior change
- Timeout discipline: in-tool timeout < 90s (Worker subrequest 100s cap); terminal quiet defaults to 400ms

### 5. Small console SPA changes

In the Devices section, add: a per-device "online" column (polling /api/plugins/status), a "Generate extension pairing code" button, and a "Gateway MCP config" copy button (`https://<console>/mcp` + the current user's token).

## Device-side changes (`command/`)

### A. New `terminal_screen` (AI screen buffer)

1. **Add `terminal_screen`** (in `src/plugins/terminal/tools.rs`, modeled on the `tool_read` structure):
   - schema `{session_id: string, lines?: integer, default 60}`
   - Implementation: get the SessionBuf from OutputBuf → scan back from the tail for N `\n` start points → `clean_terminal_output` → `{screen, dropped, total_bytes}`. The screen buffer already lives in OutputBuf (1MB ring clipping), so no new backend is needed
   - Register via `build()`; update the tool-count tests 12→13 and the CLAUDE.md count
2. **"Wait for output to stabilize" unchanged**: already in the device-side `tool_execute` session mode
3. **Terminal display stays SSE+POST**: a new device-side WS endpoint conflicts with the Windows cross-compilation constraints (web.rs:1-19), and the benefit (mostly human viewing) isn't worth it; it can be added anytime once the WS reverse proxy is fixed

### B. Slimming down (retiring the web panel / Tauri / browser automation)

- **Delete**: `src/ui/`, `src-tauri/`, `plugins/browser/`, `src/tools/browser.rs` (the desktop_impl part), `browser_headless.rs`, `cdp.rs`, `desktop_api.rs`, the `browser` feature, the `tauri` feature, the `vale-command-desktop` member
- **Keep**: `/mcp` (TokenGate + rmcp), `/api/tools/{name}`, the SSE endpoints, the terminal backend, `web.rs` auth logic
- **New**: a small tray app (native Windows, no window; reuse the `vale-tray` crate or a new crate; functions as described above)
- **Cargo.toml**: clean up the `tauri`/`browser` features and related optional deps (tokio-tungstenite, reqwest, url, tauri); keep `terminal`, `keyring`, `windows-service`
- **Verify**: `cargo test` + `cargo clippy --all-targets` + `cargo xwin check -p vale-command --target x86_64-pc-windows-msvc` (no webkit2gtk needed once desktop is gone); Windows smoke tests (direct MCP, /api/tools, tray)

## vale-command slimming (included this round; user confirmed retiring the desktop app)

User confirmed: retire the web panel, the Tauri desktop window/WebView, and browser automation; keep the hardened terminal backend + MCP server; keep the tray separately.

**Retired**:
- `src/ui/` SPA static pages (panel UI — replaced by the extension's terminal page/controlled tabs)
- `src-tauri/` (Tauri desktop window + WebView + `tauri` feature + `desktop_api.rs` + `src-tauri/src/`)
- `src/tools/browser.rs` desktop_impl, `browser_headless.rs`, `cdp.rs`, the `browser` feature of `tools/browser.rs`, and plugins/browser/ (browser automation — replaced by the extension's chrome.debugger)
- `vale-command-desktop` workspace member

**Kept (vale-command becomes a pure service, no UI)**:
- `src/mcp/server.rs` (rmcp MCP server, `/mcp` + TokenGate) — backward compatible with Claude Code connecting directly to the device MCP
- `src/tools/terminal/` (PTY/SSH/serial backends) — physical capabilities must stay
- **`/api/tools/{name}` tool dispatch + SSE stream endpoints** in `src/web.rs` (reused by the extension's terminal page through the reverse proxy; the gateway's terminal tools also go through it)
- cloudflared tunnel, device registration, `bootstrap.rs`/`config.yaml`
- Windows services (vale-command + cloudflared)

**The tray becomes a standalone small app** (new, native Windows tray, no window):
- Start/stop/restart the vale-command service, show running status/subdomain/token mask
- Copy MCP config, open the console device page
- Local terminal entry (opens a local terminal window for logs/tests, no extension needed)

**Kept/demoted (everything else)**:
- Device registration/list/token, reverse-proxy path rewriting, login/admin: **all untouched**
- Claude Code connecting directly to the device MCP (`https://dN.../mcp`): **kept for backward compatibility**
- Old headless browser tools (plugins/browser/): retired together with browser automation (the device MCP for direct Claude Code connections no longer has browser tools — all browser capability goes through the gateway MCP + extension)

## Risks and mitigations

1. **chrome.debugger MV3**: attach fails for chrome:// etc., DevTools conflicts, canceled_by_user, in-flight requests lost on SW restart → self-opened tabs, explicit errors, retry on target_closed, storage.session rehydration, triple keepalive (debugger keepalive + heartbeat + alarms)
2. **Worker WS lifecycle**: non-DO WS is unreliable → use the DO; hibernation timers don't run → alarm-based liveness; the 101 re-wrap RangeError → minimal branch + pass-through fallback
3. **MCP streamable HTTP**: the GET stream must be implemented (v2.1.84+); protocol edge cases → validated with real Claude Code in stage 1; the 100s subrequest cap → tool timeouts <90s
4. **console session dependency**: the controlled tab needs to be logged into the console to use the reverse proxy → after browser_open, the snapshot detects a login page and prompts
5. **Concurrent calls**: the DO correlates by requestId concurrently; the extension serializes per tab (mutex inside the SW)
6. **Pairing security**: the plugin token grants control of the device's browser → issued only by admin/revocable/isolated per device; the claim consumes once like the registration code

## Verification

Split into 6 phases (see the implementation order table in the plan file), each phase ending with a baseline:
- gateway: `node --test` + `wrangler deploy`
- command: `cargo test` → `cargo clippy --all-targets` → `cargo xwin check -p vale-command-desktop`

End-to-end script: Claude Code connects to the gateway MCP and runs "edit code → open panel → screenshot → click → run tests in the terminal".

## Implementation files

- `extension/` (new): manifest.json, background.js, lib/{ws,cdp,elements,tools,state}.js, popup/, options/, terminal/, vendor/, icons/
- `gateway/src/plugin-hub.js` (new), `src/mcp.js` (new), `src/mcp-tools.js` (new)
- `gateway/src/index.js`: the 101 branch fix, deviceFetch extraction, /mcp + /api/plugins/* routes
- `gateway/src/store.js`: plugins:v1, pairing-code/ticket helpers
- `gateway/wrangler.jsonc`: PLUGIN_HUB DO binding + the v2 migration
- `gateway/public/app.js|index.html|style.css`: online column / pairing UI / MCP config copy
- `command/src/plugins/terminal/tools.rs`: terminal_screen
- `command/`: retire src/ui, src-tauri, plugins/browser, the browser feature; add the small tray app
- `command/Cargo.toml`: clean up the tauri/browser features and related deps
- Plan file: /home/zhengsaisi/.claude/plans/terminal-browser-rustling-hopcroft.md

## Implementation order (adjusted, includes slimming)

Core paths first, slimming later (functionality first, to avoid one giant change):

| Phase | Contents |
|---|---|
| 0 | Fix the gateway WS reverse-proxy 101 branch (root-cause fix, minimal change) |
| 1 | Gateway MCP endpoint + terminal tools (deviceFetch extraction; terminal_open/screen/send/list/close) |
| 2 | Minimal viable extension (skeleton + popup pairing + CDP controller + ws.js; browser_open/snapshot/screenshot/click) |
| 3 | Complete the extension WS channel (PluginHubDO + ticket/status + heartbeat/alarm) |
| 4 | Terminal AI tools (device terminal_screen + the gateway's 5 terminal tools) |
| 5 | Terminal display in the extension (terminal page xterm + SSE/POST via the proxy) |
| 6 | vale-command slimming (retire panel/Tauri/browser automation + small tray app) |
| 7 | Wrap-up: console SPA online column/pairing UI; install guide; README; wrangler deploy |