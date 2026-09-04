> **POST-APPROVAL ARCHITECTURE CHANGES (read before relying on this spec):
> the approved design below is the 2026-08-28 baseline. Since then:
> round-264 (2026-09): the browser stream (`/api/browser/ws-ticket` + WS
> JPEG) was REPLACED by a real embedded browser (Electron
> WebContentsView on CDP 9333, playwright-mcp driven) — the SPA shows
> the live view, no screenshot stream; round-330: the Tauri shell
> (`vale-desktop/`) was DELETED (Electron shell only); round-341/342:
> the gateway browser-extension + PluginHubDO path was removed
> (playwright bridge only). INSTALL: the installer entry points this
> spec describes (NSIS installer, setup.ps1, run-setup.bat) were
> RETIRED to `agent/deploy/retired/` after this spec was written —
> npm is now THE single install/update channel (root `AGENTS.md`).
> `agent/AGENTS.md` is the current
> architecture source of truth; this spec records the approved design
> decisions (UI structure, dependency containment, install layout) that
> still hold.**

# Vale Desktop — Core Architecture & Dependency Containment Design

Date: 2026-08-28
Status: Approved (user confirmed: scope A+B frontend refactor + C1 install layout + B2/C2 dependency
containment; NO self-built CDP, NO cloud replacement; UI in English; dsh visual baseline)

## 1. Background

The "Vale Desktop" UI is NOT the Tauri shell — it is the single React app in
`agent/resources/panel-react`, built to `agent/resources/panel/panel.js`
(git-tracked iife bundle) + hand-written `panel.css` (1782 lines), embedded
into `vale-agent.exe` via `include_str!` in `agent/src/web.rs`, and served on
two same-origin routes:

- `/panel/`   → three-column `AppFrame` (icon rail | session rail | canvas)
- `/desktop/` → single-column `DesktopShell` (icon rail | full canvas)

The Tauri shell (`agent/vale-desktop/`) is a ~70-line Rust window/tray stub
that redirects to `http://127.0.0.1:18080/desktop/`.

### Current pain points (verified by inspection)

| Problem | Root cause |
|---|---|
| `App.tsx` 418-line god component, 30+ `round-NNN` patch comments | connection, dual shells, session list, browser state, drawer, modals all in one file |
| Two shells each re-implement tab bar + browser mount | `/panel/` and `/desktop/` are two copies of the same app |
| `browserActive` floats at App level; BrowserPane double-mounted on desktop terminal + browser pages | no page-navigation model; browser treated as a session row |
| Feature asymmetry: desktop has Memory/Settings pages, panel doesn't; desktop lacks Plugins page + Logs drawer | no unified information architecture |
| BrowserPane: 410 lines of inline styles, mixed zh/en; 4 inconsistent brand marks | no component layer, no design tokens |
| Dead code: `Toolbar.tsx`, `frame-*` CSS, `#toolbar` styles | 30+ incremental fix rounds without a cleanup pass |
| Windows install is "uncontrollable": cloudflared (self-installed service, config in `%USERPROFILE%\.cloudflared`), node.exe + playwright-mcp (40-50MB dep tree) | third-party components install themselves outside Vale's lifecycle |

## 2. Decisions (user-confirmed)

| Decision | Choice |
|---|---|
| Scope | Frontend refactor (A+B) + install layout unification (C1) + dependency containment for Playwright (B2) and cloudflared (C2). NO self-built CDP, NO cloud replacement. |
| UI language | English |
| Visual baseline | dsh style (light, icon rail, capsules, brand `#d9480f` amber) |
| Backend contract | `/api/*`, SSE, `/api/browser/*`, `/api/sessions/{sid}` and `web.rs` whitelist unchanged |
| New frontend deps | ZERO (no router, no state library, no SDKs) |

## 3. Capability model

Vale Desktop = a device console over the agent service's capability domains:

| Domain | Data source (unchanged contract) | Features |
|---|---|---|
| Terminal (session workspace) | `/api/tools/terminal_*`, SSE `/api/events/term`, `/api/sessions/{sid}` | multi-tab PTY/SSH/Serial; per-session view (terminal\|trajectory); Logs command-card drawer; export/rename/archive |
| Browser (remote browser) | `/api/browser/ws-ticket` + WS, `/api/browser/pwshots` | Live interactive JPEG stream (mouse/keyboard/tabs/nav) + Evidence AI screenshot timeline |
| Memory (device memory) | `/api/tools/memory_*` | search/browse/delete/export, shared with AI clients |
| Plugins (tool catalog) | `/api/spec`, `/api/plugins/status`, `/api/plugins/playwright/start\|stop` | plugin inventory + playwright start/stop |
| Settings (device config) | `/api/settings` | session buffer, transport info, memory notes |
| Connection (bootstrap) | boot + `lib/api` | host/token bootstrap, proxy token rules (round-122/124), 401 fallback |

Design rule: one capability domain = one page + one domain hook + one page
component. Pages share NO mutable state except the connection layer and the
session store (the terminal stream is global).

## 4. Information architecture: one shell, two densities

```
Pages (identical across densities): Terminal | Browser | Memory | Plugins | Settings

<Shell density="panel" | "desktop">
  ├─ IconRail      brand mark + 5 page icons + connection dot (same in both)
  ├─ ContextRail   per-page context rail (panel density only):
  │                  Terminal → session list; Plugins → plugin list; others → hidden
  ├─ Canvas        current page (100%)
  └─ StatusBar     connection status text (panel density only)
```

- Density difference is PURELY visibility: desktop hides ContextRail/StatusBar
  (full canvas); panel shows them. NOT two codebases.
- Feature parity both ways: desktop gains Plugins page + Logs drawer; panel
  gains Memory page + Browser page (browser promoted from "session row" to a
  first-class page — `browserActive` state disappears, BrowserPane mounts
  exactly once). Settings becomes a page; the panel modal retires.

## 5. State architecture

```
App (slim: connection + page nav + domain hooks)
 ├─ lib/boot.ts        computeBoot logic verbatim (same-origin/proxy branches,
 │                     token precedence, round-122/124 proxy no-persist, host normalization)
 ├─ page: "terminal" | "browser" | "memory" | "plugins" | "settings"
 ├─ shared hooks (unchanged semantics):
 │    useSessions       3s poll terminal_list; { sessions, activeSid, status }
 │    useSSE            /api/events/term stream → writeCallbacks → xterm;
 │                      5s incremental backfill + 30s heartbeat + exp backoff
 │    usePlugins        /api/spec + /api/plugins/status 5s poll + start/stop
 │    useCommandEvents 2s poll /api/sessions/{sid} for active session → cards
 │    useBrowser (NEW)  extracted from BrowserPane: ws-ticket, WS lifecycle,
 │                      backoff reconnect, JPEG frames/fps, tabs poll, Evidence
 │                      3s poll, hidden-tab socket drop
 └─ page-local state:
      TerminalWorkspace per-session view, drawer open, selected card
      BrowserPage / MemoryPage internal state
```

Data flow unchanged (backend contract): callTool writes → SSE pushes bytes to
xterm via writeCallbacks → polls backfill (sessions 3s, events 2s, evidence 3s).

Removed floating state: `browserActive`, `detailsOpen`, `selectedCmdId` (into
TerminalWorkspace); `view` (sessions|plugins) merged into unified `page`.

## 6. Component tree (target)

```
App
├─ ConnectionGate        (conn form / children; shared by both densities)
├─ Shell density
│  ├─ IconRail           BrandMark + PageNav(5) + StatusDot
│  ├─ ContextRail        SessionsList | PluginsList (per page)
│  ├─ Canvas
│  │  ├─ TerminalWorkspace   TabBar + view switch + TerminalPane/Trajectory + Logs drawer
│  │  ├─ BrowserPage         BrowserPane (single mount point)
│  │  ├─ MemoryPage / PluginsPage / SettingsPage
│  └─ StatusBar(panel density)
└─ ConnModal(SSH/Serial)
```

## 7. Key user journeys (acceptance)

1. First launch without token → conn form → connected → lands on Terminal,
   auto-activates first live session (round-157 behavior kept).
2. New session (+ PTY/SSH/Serial) → new tab active; SSE streams live;
   close/kill → auto-switch to next live session.
3. Watch the AI work: terminal stream, Logs drawer command cards (both
   densities), trajectory raw timeline, Browser/Evidence screenshots.
4. Browser page: Live interactive + Evidence timeline; bridge down → reconnect
   indicator, never blank/crash.
5. Memory: search/browse/delete/export, shared with Claude Code / DSH clients.
6. Plugins: inventory dots + playwright start/stop; Settings: buffer save.
7. Disconnect/401 → conn form; recovery → SSE reconnect with backoff.

## 8. Dependency containment (B2/C2) — "boxed, not self-built"

Containment = third-party stays third-party, but EVERY lifecycle aspect of
"being installed on Windows" is owned by Vale: artifact, version, process,
config, uninstall. Internal code is NOT rewritten.

### Playwright box (node.exe + playwright-mcp + bridge.js → one opaque artifact)

| Aspect | Now | Boxed |
|---|---|---|
| Artifact | node.exe + node_modules scattered in install root | single `vale-playwright.zip` (build chain already produces it) + sha256 manifest, extracted into `InstallDir\plugins\playwright\` |
| Version | follows upstream | follows Vale release; `.new/.bak` safe swap on upgrade |
| Process | agent spawns (PlaywrightManager + watchdog) | unchanged: agent spawns/monitors/restarts (stdio transport, no port) |
| Config | — | — |
| Uninstall | residue | kill tree → delete `plugins\playwright\` dir; no registry, no global npm |
| Optional hardening | — | spike: Node SEA single `playwright-bridge.exe` (absorbs node.exe); if driver-fork incompatible, keep zip box (still Vale-controlled) |

### cloudflared box

| Aspect | Now | Boxed |
|---|---|---|
| Artifact | bare binary in install root | `InstallDir\tools\cloudflared.exe` + sha256 manifest, version locked by Vale release flow |
| Install | installed and resident | NOT installed by default (pure-local mode needs no tunnel); installed only when user opts into "public access" |
| Process | self-installed service/autostart | spawned/monitored/restarted by agent (watchdog); if a service is needed it is Vale-named `ValeTunnel`, Vale creates and deletes it |
| Config | `%USERPROFILE%\.cloudflared\config.yml` (outside Vale) | `DataDir\tunnel.yml` |
| Ops | operators touch the binary | `vale tunnel status|start|stop|update` CLI wrapper only |
| Uninstall | EventLog/service residue | stop tunnel → delete binary → delete service + `EventLog\Cloudflared` source → delete config |

Containment does NOT remove third-party process behavior (bugs, CPU spikes) —
mitigated by restart policy + logs. Truly zero third-party requires self-built
or replacement engines, which the user declined.

## 8b. Install/update channel — npm CLI is THE single channel (2026-08-28)

The NSIS installer (`vale-agent-install.nsi`), `setup.ps1` and `run-setup.bat`
are RETIRED (moved to `agent/deploy/retired/`). Install and update are npm
only:

```
npm i -g https://agent.saisi.online/vale-agent/vale-agent-<ver>.tgz   # install the CLI
vale setup --reg-key <key>          # install the agent (registry, exe, desktop, task, boxed artifacts)
vale tunnel install [hostname]      # OPTIONAL: enable public access (cloudflared)
vale update                         # update (same channel)
vale uninstall [--purge-data]       # remove (data kept unless --purge-data)
```

- `vale setup` is IDEMPOTENT and self-cleaning on re-run: it stops running
  vale processes, removes legacy scheduled tasks (ValeAgentTray,
  ValePlaywright), removes the legacy Cloudflared service + EventLog source,
  clears a stale update-busy marker, refreshes the boxed playwright bundle
  (old tree deleted first), removes legacy install dirs (C:\vale-agent /
  D:\vale-agent) when the registry points elsewhere, then writes the
  registry keys, pre-creates DataDir (sessions/memory/logs), copies exe +
  desktop shell + bridge, stages cloudflared (`tools\`), and registers the
  ValeAgent scheduled task (SYSTEM, hardened: no 72h limit,
  restart-on-failure, 5-min watchdog). A reinstall leaves a PRISTINE install
  — no residue from any previous channel.
- `vale tunnel install` is the ONLY tunnel enablement path (login → tunnel
  create → DNS route → write `tunnel.yml`); `vale tunnel status|start|stop`
  manage it. The agent spawns cloudflared on boot (supervised model).
- `agent_update` (AI-push path) downloads the npm tgz (sha256-verified) and
  swaps the exe via a WMI-survives-the-kill script — no more Setup.exe.
- `build-installer.sh` packs the npm tgz and stages it to the Vercel mirror;
  `index` worker's `/api/version` publishes the tgz URL + sha256; the
  download page shows `npm i -g` + `vale setup` steps.

## 9. Install layout (C1) — registry as single source of truth

```
HKLM\SOFTWARE\Vale\Agent
    InstallDir  (REG_SZ)  ← written by NSIS installer; read by everything
    DataDir     (REG_SZ)

InstallDir default  C:\Program Files\Vale   (vale-agent.exe, vale-desktop.exe,
                                             config.yaml, tools\, plugins\)
DataDir    default  %ProgramData%\Vale      (sessions\, memory\, logs\,
                                             tunnel.yml, vale-agent.hostname/
                                             console/version)
```

- All three entry points (NSIS / setup.ps1 / npm CLI) WRITE the same key;
  agent runtime + CLI + installer + tray READ it (no more `current_exe()` guessing).
- Upgrade: existing old dirs (`C:\vale-agent` / `D:\vale-agent`) are detected,
  kept in place, and the registry points at them (or migrate with prompt);
  never silently move data.
- Uninstall: delete program dir + registry key; keep data dir by default (with
  prompt). No system-level residue.

## 10. Implementation order

| Phase | Content |
|---|---|
| 0 | This design doc (archive of round-NNN decisions; code comments shrink to a pointer) |
| A | styles/{tokens,base,components,layout,desktop}.css + scripts/build-css.mjs (+ var() check) + package.json wiring; ui/Icon.tsx unified icons + BrandMark; BrowserPane styles/English |
| B | lib/boot.ts + hooks/useBrowser.ts; Shell+density; DesktopShell rewrite; Sidebar→ContextRail; App.tsx slimming + single page nav; TerminalWorkspace single impl; 5 pages both densities; delete browserActive |
| 4 | dead code cleanup; index.html lang/favicon check |
| 5 | tests: tokens consistency, Shell two densities, TerminalWorkspace, useBrowser smoke; npm test/tsc/build green; rebuild + commit panel.js/panel.css |
| C1 | registry layout unification across NSIS/setup.ps1/vale.js/main.rs + migration |
| B2 | playwright zip box + uninstall cleanup + SEA spike |
| C2 | cloudflared box: tools\ + sha256 + opt-in install + agent supervision + tunnel CLI + uninstall cleanup |
| V | cargo test/clippy/xwin check green; device smoke checklist |

## 11. Out of scope (later, separate)

Tauri shell enhancement (IPC URL, error page, tray deep links, window state),
i18n bilingual, self-built CDP or cloud replacement, gateway/worker changes,
`vale-desktop.exe` repackaging (shell unchanged; release chain `build.sh agent`
follows agent/CLAUDE.md npm flow).

## 12. Implementation notes (2026-08-28, as built)

- **C1 registry layout is live**: NSIS installer now defaults to
  `$PROGRAMFILES\Vale` and writes `HKLM\SOFTWARE\Vale\Agent\{InstallDir,DataDir}`;
  `setup.ps1` resolves install/data dirs registry-first (param → registry →
  legacy on-disk dirs → default) and pre-creates the DataDir tree
  (sessions/memory/logs); `vale.js` resolves DIR registry-first and writes
  the keys on `vale setup`; the agent reads them via the new
  `src/paths.rs` (`install_dir()` / `data_dir()`) — all four duplicated
  `install_dir()` helpers (main.rs, update/tools.rs, playwright/manager.rs,
  playwright/tools.rs) now delegate to it. Fallback: exe dir (self-contained
  dev builds, non-Windows), then legacy defaults.
- **B2 playwright box**: `vale-playwright.zip` (single opaque artifact, ~31MB,
  version-locked by the release flow) extracts to `InstallDir\playwright\`
  and is spawned only by the agent's PlaywrightManager (stdio transport, no
  port). Uninstall removes the whole dir + kills the bundled node tree.
  Node SEA single-exe was evaluated and REJECTED: playwright-mcp forks child
  processes (Edge driver), which SEA does not support reliably — the zip box
  already gives Vale full artifact/version/lifecycle control without the risk.
- **C2 cloudflared box**: binary staged by NSIS under `InstallDir\tools\`
  (no legacy fallbacks — single location), sha256-verifiable artifact,
  spawned/monitored by the agent (spawn-if-absent on boot) instead of a
  self-installed service. **The legacy `Cloudflared` Windows service model
  is RETIRED**: setup.ps1 no longer installs it (it removes any leftover
  service + EventLog source), fix-tunnel.ps1 repairs only the agent-owned
  `tunnel.yml` (no user/systemprofile config copies), and the agent spawns
  `tools\cloudflared.exe tunnel --config tunnel.yml run` as the single
  supervision path. `vale tunnel status|install|start|stop|update` CLI
  wrapper is the only operator handle; uninstall stops the tunnel + deletes
  the binary + service + EventLog source + config. Not installed by default
  (pure-local mode needs no tunnel).
- **Path convergence (single source of truth)**: ALL path resolution in the
  agent now goes through `src/paths.rs` — `install_dir()` (registry →
  exe dir) and `data_dir()` (registry DataDir → install dir). Every data
  file (sessions/, memory/, vale-known-hosts.json, vale-connections.json,
  vale-secrets.json, mcp_diag.log) and every bundled component (playwright/,
  tools\cloudflared.exe) resolves through it. Zero `current_exe()` guesses
  outside paths.rs, zero legacy-directory probing, zero user/systemprofile
  config copies. setup.ps1 / vale.js / NSIS all resolve the same way
  (param/registry/default, no legacy dir detection).
