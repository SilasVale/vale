# Vale Agent Admin UI — Modeled on the DeepSeek Harness Design (v2, review revision)

## Background & goals

The vale agent currently only has a terminal panel (`/panel`) + a status card (`/`). This models the full admin UI of dsh (127.0.0.1:3080).

**Scope correction after review**: dsh's AI-session architecture (session persistence, LLM trajectories, context assembly) maps in Vale to terminal command audit trails — **the trajectory = the terminal audit log** (fully provided by `/api/sessions/{sid}`), not an AI trajectory. The UI is **terminal session management**, not LLM session management.

## Architecture decisions (v2)

| Decision | Choice | Rationale |
|---|---|---|
| UI location | Device-local (**127.0.0.2:18080**) + cloud entry (reuse the existing proxy) | viewable when the device is offline (while the agent is alive) |
| Tech stack | React + Vite **single iife bundle** (no code-split) + one global CSS | matches the existing vite config + web.rs asset whitelist |
| playwright management | **bundle node.exe + playwright-mcp, using the Edge channel** (`--browser msedge`), started/stopped on demand | Edge is always present on the device, avoiding a 150MB Chromium; on-demand avoids a resident SYSTEM browser |
| Data flow | local calls hit the agent API directly; from the cloud it goes through the `/api/devices/<n>/proxy` proxy (already exists) | zero new links |
| Trajectory | **terminal audit logs** (reuse `/api/sessions/{sid}`), **no new `/api/sessions/detail`** | the existing endpoint serves it fully |

## UI structure (v2, corrected mapping)

| dsh view | Vale UI (corrected) |
|---|---|
| AppFrame (resizable three columns: sidebar/middle/details) | App root: sidebar (session list) + main area (session) + right column (details, resizable/closeable) |
| ChatView + ToolCallTree (tool cards) | **command card stream**: one card per command (command/live output/exit code/duration/expand-copy), clicking a card → the details column |
| DetailsPanel (single-call inspector) | **details column**: clicking a command card shows that call's params (JSON) + output + exit code |
| TrajectoryView (session trajectory tab) | **trajectory tab** (within a session): `/api/sessions/{sid}` events grouped, round grouping, search, collapse, load older |
| ConfigurablePluginsTab | **plugin status page** (read-only catalog: status dots/enabled tags) + **playwright start/stop area** (Vale-specific) |
| JobListAction (background jobs) | plugin start/stop/update progress bars (session header popover) |
| TodoPanel / ApprovalPanel / ContextMeter | **not in v1** (review: their semantics are LLM-agent-specific, and would drag in undefined agent APIs) |

**Session persistence**: reuse the existing `/api/sessions` (list) + `/api/sessions/{sid}` (audit JSONL). Sidebar session rows: title / relative time / rename / archive.

## New APIs (agent side, slimmed in v2)

```
GET  /api/plugins/status          # playwright running state/version (everything else uses /api/spec)
POST /api/plugins/playwright/start  # start on demand: spawn node.exe playwright-mcp --port 9229 --browser msedge
POST /api/plugins/playwright/stop   # stop (disconnect the mcp_client connection first, then taskkill /T)
```

- **No new** `/api/sessions/detail` (there is already `/api/sessions/{sid}`)
- Everything goes through **check_auth** (web.rs:252 already covers all /api/*, not TokenGate — TokenGate only wraps /mcp)
- Routing changes: add 2 exact arms + 1 guard arm to handle_request's match (web.rs:426-537)
- Plugin process state: put it in **AppState's `Arc<PlaywrightManager>`** (holds Child + state), read by web.rs; not stuffed into PluginRegistry

## Security (v2, strengthened after review)

1. **playwright explicitly binds 127.0.0.1 + a per-launch secret** (passed via argv/env; tools are only handed out after mcp_client_connect validates it) — defends against DNS rebinding + port squatting
2. **Poll health after start** (127.0.0.1:9229/mcp) before reporting success; stop disconnects mcp_client first, then taskkill
3. **UI XSS discipline**: trajectory/command output is **always rendered text-only** (no innerHTML), tightened CSP, the localStorage token is never injected into the DOM
4. **Corrected address**: 127.0.0.2:18080 (default bind); web.rs's Host gate adds 127.0.0.2 to the loopback set
5. **Declaration**: playwright is a second trust domain on the device (9229), mitigated via the Edge channel + a restricted SYSTEM account; if the device has no human browsing, the rebinding surface is small (explicit assumption)

## Packaging (v2, corrected)

- Bundle only **node.exe (LTS 20+) + playwright-mcp node_modules** (~40-50MB installer), **no bundled Chromium** (uses the device's Edge)
- NSIS: the silent-upgrade branch adds playwright bundle extraction; the Uninstall section adds the bundle directory
- Start/stop on demand (no boot-spawn) — avoids a resident SYSTEM browser

## Implementation order (v2, scoped down per review)

1. **Phase 1 (core)**: thin agent APIs (only playwright status/start/stop, reusing /api/spec + /api/sessions) + the local React UI (sidebar, plugin page, session details column, trajectory tab)
2. **Phase 2**: a cloud "open panel" button (reuse the existing proxy + the extension popup)
3. **Phase 3**: packaging (msedge channel first)

**Explicit**: the new UI **replaces** the existing `/panel` (not co-existing); this is **a single implementation plan**, not a roadmap.

## Visual design (dsh feel × Vale teal theme)

**dsh visual language** (thoroughly studied, source-referenced):
- **Geometry**: capsule buttons (radius 18, h36), highly rounded cards, exact Figma specs
- **token system**: `--dsw-static-neutral-*` (50-1000 gray scale), `--dsw-static-deepseek-*` (brand blue), `--dsw-static-amber-*` (warning)
- **Motion**: `--ds-ease-in-out: cubic-bezier(0.4,0,0.2,1)`, `--ds-transition-duration` 0.2s / fast 0.1s / slow 0.3s, `prefers-reduced-motion` respected
- **Component feel**: StateDot (status dot), Pill, Toast, HoverCard, JsonTree, TerminalBlock, custom scrollbars

**Vale application** (dsh feel + Vale brand):
- **Colors**: keep dsh's neutral gray-scale system; the brand color uses Vale's `--accent #0b7a6e` (teal) in place of dsh's deepseek blue; warnings use the same amber as dsh
- **token naming**: `--ds-ease-in-out` and `--ds-transition-duration*` adopted as-is; Vale adds a `--vale-accent` alias
- **Geometry/motion/components**: follow dsh's capsule buttons, 3-column draggable grid, StateDot, JsonTree, TerminalBlock, hover/tooltip, custom scrollbars
- **Fonts**: SF Pro (Apple) + PingFang SC (Chinese), same as Vale's current stack

## Verification

- Local: start → 9229 listening → mcp_client_connect connects (with the secret) → the trajectory tab shows `/api/sessions/{sid}` events grouped
- Security: 9229 access without the token is rejected; command output renders in the UI without XSS
- Packaging: Setup.exe installs on a clean Windows (no Node) → the UI works, and playwright starts/stops using Edge