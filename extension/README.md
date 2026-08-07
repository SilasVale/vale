# Vale Browser Control (extension)

AI-first device browser control: pairs with a Vale console, opens a controlled
tab (`/api/devices/<d>/proxy/`) on the device's Chrome/Edge, and drives it via
`chrome.debugger` (internal CDP — no network ports). A service worker keeps a
WebSocket to the gateway's PluginHubDO so Claude Code MCP can run
`browser_*` tools against the device's real browser.

Pure vanilla JS, no build step — load the folder as an unpacked extension.

## Install

1. Chrome/Edge → `chrome://extensions` → enable Developer mode → **Load
   unpacked** → select this `extension/` folder.
2. Open the extension's **Options** page (right-click the toolbar icon →
   Options) and set **Console origin** to your Vale console, e.g.
   `https://ai.saisi.online` → Save.
3. On the console's Devices panel, generate a **pairing code** for the device.
4. Click the toolbar icon → paste the code → **Pair**. The popup shows the
   paired device and the WS connection status.

## Use

- **Open tab** — opens the controlled tab
  (`https://<console>/api/devices/<d>/proxy/`) in a new browser tab. Claude
  Code MCP can then run `browser_open / browser_snapshot / browser_click /
  browser_type / browser_wait / browser_close / browser_screenshot` against
  it. Close DevTools on the controlled tab while using it — `chrome.debugger`
  can't attach twice.
- **Terminal** — opens the terminal page (built in a later task).
- **Unpair** — drops the pairing; the gateway revokes the plugin token.

## Layout

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest (tabs, debugger, storage, alarms) |
| `background.js` | Service worker (module): pairing, WS lifecycle, message hub |
| `lib/state.js` | `chrome.storage.local`-backed state mirror |
| `lib/ws.js` | Gateway WS client: ticket auth, heartbeat, backoff reconnect |
| `lib/cdp.js` | `chrome.debugger` attach/enable, detach tracking |
| `lib/elements.js` | In-page DOM snapshot script (interactive elements + CSS paths) |
| `lib/tools.js` | `browser_*` tools → CDP commands |
| `popup/` | Pair / status / open tab / terminal / unpair / options |
| `options/` | Console origin setting |

## Protocol

- `POST /api/plugins/pair/claim` `{code}` → `{token, device}` (pairing code is
  the credential; the console Devices panel generates it)
- `POST /api/plugins/ws-ticket` with `Authorization: Bearer <token>` →
  `{ticket}` (one-time)
- `wss://<console>/api/plugins/ws?device=<d>&ticket=<t>` → per-device hub
  socket; the hub sends `{id, type:"request", tool, params}` frames, the
  extension answers `{id, type:"response", ok, result|error}`; ping every 20s
  keeps the hub's idle alarm (65s) from closing the socket.
