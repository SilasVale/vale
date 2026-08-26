# Vale Command: One-Click Gateway Channel Switching (Design)

Date: 2026-08-04
Status: Approved (user confirmed node implementation)

## Context

Users access the multiple channels (ds/qw/og/or) of the vale-gate gateway (api.saisi.online) through `~/.claude/settings.json`. Current state:
- When a channel fails (e.g. the og/ upstream zen/go only fails after 45s), the config stays on the broken channel; the user must manually `cp` profile files to switch — no health info, no verification, no rollback.
- Adding a new channel (qw/) also requires manually maintaining profile templates.

Goal: a cross-platform `vale` command + public gateway endpoints + a web installation entry, delivering "one-click switching, automatic verification, rollback, and visible health".

Out-of-scope decisions (explicitly not doing):
- Startup auto-hooks / scheduled polling (user vetoed; imperative mode preferred)
- Server-side degradation on the gateway (user vetoed; billing is opaque)
- Making channel priority a configurable JSON (YAGNI; built-in constants suffice)

## Architecture

```
Web console model routing section → "Vale Command" panel (install command + usage)

Gateway vale-gate (new public endpoints, no auth, no sensitive info)
  ├─ GET /api/health          → channel status + recommendation
  ├─ GET /api/vale-cli        → the vale script itself (text/plain)
  ├─ GET /api/vale-install    → POSIX one-click installer (embeds the script as base64)
  └─ GET /api/vale-install.ps1→ Windows PowerShell one-click installer

Local vale command (~/.local/bin/vale, dependency-free node, cross-platform)
  ├─ vale check               → fetch health + show currently configured channel
  ├─ vale use <ds|qw|og|or>   → probe → backup → rewrite env → atomic write → prompt restart
  ├─ vale use auto            → pick a healthy channel by priority qw > ds > og > or
  └─ vale restore             → roll back the most recent backup
```

## Gateway endpoints

### GET /api/health (public, available on all domains)

Response:
```json
{
  "channels": [
    { "id": "ds", "ok": true,  "model": "ds/deepseek-v4-flash" },
    { "id": "qw", "ok": true,  "model": "qw/qwen3.8-max-preview" },
    { "id": "og", "ok": false, "model": "og/deepseek-v4-flash", "reason": "circuit open" },
    { "id": "or", "ok": true,  "model": "or/openai/gpt-5.6-luna:floor[1m]" }
  ],
  "recommended": { "channel": "qw", "model": "qw/qwen3.8-max-preview" }
}
```

- Health determination: `og` uses the breaker state (`isChannelDegraded`); other channels have no breaker and are marked `ok: true` (real availability is backed by the probe the vale command runs before switching).
- `recommended`: the first `ok` channel by the priority constant `qw > ds > og > or`.
- Placement: handled in the main fetch before hostname-based routing (`path === "/api/health"`), so it is also reachable on the ai/api domains.

### GET /api/vale-cli

Returns the vale script itself (`Content-Type: text/plain`). The script content is embedded in the gateway as a string constant (packed by reading `scripts/vale-cli.js` at build time, or imported as a standalone module — the approach taken: a standalone file `gateway/src/vale-cli.js` exports the string, and index.js references it).

### GET /api/vale-install (POSIX)

Returns a sh installer:
```sh
#!/bin/sh
set -e
command -v node >/dev/null 2>&1 || { echo "error: Node.js required"; exit 1; }
DEST="${VALE_BIN:-$HOME/.local/bin}"
mkdir -p "$DEST"
echo "<vale script base64>" | base64 -d > "$DEST/vale"
chmod +x "$DEST/vale"
echo "installed: $DEST/vale"
echo "usage: vale check | vale use <ds|qw|og|or> | vale use auto | vale restore"
```

### GET /api/vale-install.ps1 (Windows)

```powershell
$ErrorActionPreference = "Stop"
try { node --version | Out-Null } catch { Write-Error "Node.js required"; exit 1 }
$dest = Join-Path $HOME ".local\bin"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("<base64>"))
Set-Content -Path (Join-Path $dest "vale") -Value $script -Encoding UTF8 -NoNewline
Set-Content -Path (Join-Path $dest "vale.cmd") -Value '@echo off\r\nnode "%~dp0vale" %*' -Encoding ASCII
Write-Host "installed: $dest\vale  (command: vale)"
```

### Console panel

Add a "Vale Command" block to the model routing section of `gateway/public/`: install commands for both platforms + usage (`vale check` / `vale use` / `vale restore`). The implementation depends on the public/ frontend structure (see the implementation plan).

## The vale command (scripts/vale-cli.js → packed as a string)

A node implementation, zero dependencies, cross-platform (locates config via `os.homedir()`).

**Model mapping (built-in constants)**:
```js
const CHANNELS = {
  ds: { model: "ds/deepseek-v4-flash" },
  qw: { model: "qw/qwen3.8-max-preview" },
  og: { model: "og/deepseek-v4-flash" },
  or: { model: "or/openai/gpt-5.6-luna:floor[1m]" },
};
const PRIORITY = ["qw", "ds", "og", "or"];
```

**Command flows:**

`vale check`:
1. Read the env in `~/.claude/settings.json` to extract the current model/channel
2. `GET https://api.saisi.online/api/health` (base URL read from ANTHROPIC_BASE_URL in settings.json, with a default if absent)
3. Print the channel status table + current config + recommendation

`vale use <channel>`:
1. Validate the channel is in the mapping
2. Probe: POST `<base>/v1/messages` (max_tokens=1, using ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN from settings.json) → refuse to switch on non-200
3. Backup: `settings.json` → `settings.json.bak-vale-<timestamp>`
4. Rewrite env: `ANTHROPIC_BASE_URL` (kept, or set to api.saisi.online if missing), model fields (ANTHROPIC_MODEL + DEFAULT_* + SUBAGENT + SMALL_FAST all set to the channel's model name), keep the token fields
5. Atomic write (temp file + rename)
6. Print "Switched to qw/qwen3.8-max-preview; restart Claude Code for it to take effect"

`vale use auto`: fetch health → take the first ok by PRIORITY → run the use flow; if all are down, error out and suggest checking the network.

`vale restore`: find the most recent `settings.json.bak-vale-*` → restore atomically → prompt restart.

**Security**:
- The script never displays or stores tokens (read-only use)
- Auto-backup before every use/restore (keeps the most recent 5, deletes older)
- Atomic writes prevent half-written files on interruption
- No switch if the probe fails

## Testing

- `gateway/test/vale-cli.test.mjs`: the vale script's core logic is extracted into a testable module — model mapping, config rewriting (read a mock settings.json → assert env fields), backup naming/cleanup, priority selection. Network calls are mocked.
- Gateway endpoint tests: the health generation function (channels/recommended logic, breaker mocked).

## Verification

1. `npm test` all green (new vale tests)
2. After `wrangler dev` / deploy:
   - `curl https://api.saisi.online/api/health` → channel status + recommendation
   - `curl https://api.saisi.online/api/vale-install | sh` → installs vale (local ~/.local/bin)
   - `vale check` → shows status
   - `vale use qw` → backup + switch + prompt
   - `vale use og` → probe fails, switch refused (zen is down; behavior verification)
   - `vale restore` → rollback
3. The web console model routing section shows the install panel

## Implementation files

- `gateway/src/index.js`: the 4 public endpoints + the health generation function + console panel data
- `gateway/src/vale-cli.js`: the vale script source file (exports the string + testable core functions)
- `gateway/scripts/` or inline: installer templates (sh/ps1)
- `gateway/public/`: the model routing section panel
- `gateway/test/vale-cli.test.mjs`: tests