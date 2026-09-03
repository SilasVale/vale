# Vale Agent Build Guide

> Mirrors agent/CLAUDE.md (keep in sync). Post-2026-08-28 additions: registry-
> first path resolution (src/paths.rs), npm-only install channel, Gateway
> Settings card + POST /api/gateway/connect.

## Cross-compilation to Windows (MSVC)

Requires `cargo-xwin` for cross-compiling from Linux:

```bash
# Install
cargo install cargo-xwin

# Windows check (fast, run after touching Cargo.toml or feature-gated code)
cargo xwin check -p vale-agent --target x86_64-pc-windows-msvc --features terminal,keyring

# Debug build
cargo clean && cargo xwin build -p vale-agent --target x86_64-pc-windows-msvc --features terminal,keyring

# Release build
cargo clean && cargo xwin build -p vale-agent --target x86_64-pc-windows-msvc --features terminal,keyring --release
```

Output binaries:
- `target/x86_64-pc-windows-msvc/debug/vale-agent.exe` (debug)
- `target/x86_64-pc-windows-msvc/release/vale-agent.exe` (release)

`scripts/build.sh agent` cross-compiles vale-agent (the retired tray/Tauri desktop builds were removed round-330).

## Install / update — npm is THE single channel

- `vale setup` = PURE LOCAL install (no key/tunnel/cloud). `--reg-key <key>`
  and `--tunnel <host>` are OPTIONAL extras; the Settings page Gateway card
  (`POST /api/gateway/connect`) is the GUI way to configure them.
- Install layout is registry-first: `HKLM\SOFTWARE\Vale\Agent\{InstallDir,DataDir}`
  — all path resolution goes through `src/paths.rs` (`install_dir()`/`data_dir()`);
  zero `current_exe()` guesses outside it, zero legacy-directory probing.
- Boxed components: `vale-playwright.zip` → `InstallDir\playwright\`,
  `cloudflared.exe` → `InstallDir\tools\` (agent-supervised, no Windows service).
- The NSIS installer / setup.ps1 / run-setup.bat are RETIRED
  (`deploy/retired/`).

## Device update — npm one-click update (THE ONLY sanctioned rollout path)

**Always ship device updates through the npm flow. Never hand-roll
kill/copy/restart scripts over a terminal PTY** — the PTY is hosted by the
agent itself, so an inline `Stop-Process` kills your own shell before the
restart command runs and leaves the device dark (happened twice on d1).

Release + rollout:

```bash
# 1. Build the exe (panel changes must be built BEFORE this — panel.js is
#    embedded at compile time via include_str!):
cd resources/panel-react && npm run build && npm test && cd ../..
cargo xwin build --target x86_64-pc-windows-msvc --release --features terminal,keyring --bin vale-agent

# 2. Stage artifacts into the npm package and bump its version:
cp target/x86_64-pc-windows-msvc/release/vale-agent.exe vale-agent-npm/vale-agent.exe
# then bump "version" in vale-agent-npm/package.json (1.2.x)
# (bridge.js was removed in round-263 — the npm package ships no bridge)
cd vale-agent-npm && npm pack          # → vale-agent-1.2.N.tgz

# 3. Publish: stage the tgz into the dist worker assets (ALSO the
#    versionless latest alias + the version.json discovery manifest)
#    and deploy them:
cp vale-agent-1.2.N.tgz ../../index/public/vale-agent/
cp vale-agent-1.2.N.tgz ../../index/public/vale-agent/vale-agent-latest.tgz
printf '{"version":"1.2.N","tarball":"vale-agent-latest.tgz","updated":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ../../index/public/vale-agent/version.json
cd ../../index && CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare-token) npx wrangler deploy

# 4. On the device (PowerShell), exactly two commands:
npm i -g https://agent.saisi.online/vale-agent/vale-agent-latest.tgz   (or pin the version)
vale update
```

# 5. GitHub Release = CI (release.yml rewrite): after the version-bump
# commit is pushed, create the tag ON GITHUB VIA THE API — direct git
# push of tags intermittently times out on this network; the API is
# reliable, and the tag-push event triggers the workflow (panel build →
# xwin exe → npm pack → gh release create --verify-tag). package.json
# version MUST equal the tag; mismatch fails fast. keep-latest: delete
# the previous release AND older tag refs manually (API, /git/refs/tags/
# <tag> — the URL needs the full refs path, not just the name).

What `vale update` does (bin/vale.js): stages the exe (and desktop shell
sources) next to the install dir, hands a PS swap script to WMI
Win32_Process.Create (parented by
WmiPrvSE so it survives the CLI AND the agent dying; plain `-NoProfile -File`
only — `-ExecutionPolicy Bypass` / `-EncodedCommand` die silently on d1),
then: stop ValeAgent task → kill agent + bridge node tree → copy with retry →
restart task. The terminal connection DROPS for ~10 s mid-update; reconnect
and verify via `/api/status` → `version`.

Gateway (`gateway/`) deploys separately: `cd gateway && wrangler deploy`.

## Architecture

vale-agent is a pure service — MCP server + terminal backends + SSE endpoints
+ the Electron desktop shell (embedded real browser on CDP 9333). The Tauri
desktop (`vale-desktop/`), the standalone `vale-tray/`, and the NSIS-era
installers are RETIRED; the Electron shell (`vale-desktop-electron/`) and the
gateway device app replaced them. The
web panel (`/panel`, Apple-style terminal) is served by `src/web.rs` — token
entered in the browser, kept in localStorage (no server-side injection since
1.0.5).

- **MCP** (rmcp): served at `/mcp` ON THE MAIN AGENT PORT (default 18080,
  same HTTP surface) — token-gated via `TokenGate` in `src/web.rs` (rmcp has
  no server-side auth hook). There is no separate port 3000 any more.

### Module map

```
src/
  main.rs          server binary (config path as argv[1]); Windows service
                   mode via windows-service when launched by the SCM
  lib.rs           crate root; DEFAULT_CONFIG_YAML embedded (include_str!)
  bootstrap.rs     vale_command::bootstrap::load_or_create(path, fallback) —
                   create-if-missing, load, ensure_token. Single bootstrap site.
  metrics.rs       device vitals for /api/status (CPU delta + memory, kernel32)
  filelog.rs       size-rotating tracing writer -> agent.log next to the exe
  session_log.rs   per-session JSONL audit log (trim-on-close + 30 d retention)
  state.rs         AppState { serial_pool, terminal_mgr, event_bus,
                   plugin_registry, config } — managers are Arc<Manager>,
                   no locks in AppState
  mcp/server.rs    DeviceServer (rmcp ServerHandler), bind() -> (addr, handle)
                   (port 0 = ephemeral, used by tests), serve_with_token
  web.rs           HTTP surface — hand-rolled Tower service (NOT axum route
                   handlers: they break Windows cross-compilation). TokenGate<S>
                   wraps the /mcp route with the bearer check. Routes:
                   GET / (minimal status page), /api/status, /api/spec,
                   /api/events (SSE), /api/events/poll, /api/events/term (SSE),
                   GET/PUT /api/settings (buffer_mb + console_url),
                   POST /api/gateway/connect (Settings-page Gateway card:
                   persist console_url, reg-key → CF token exchange, optional
                   free tunnel via provision_tunnel),
                   POST /api/tools/{name}, GET /api/plugins/status,
                   GET /api/browser/{pwshots,pwshot,actions} (AI evidence —
                   the pwout screenshots/action feed), GET /api/sessions
                   (audit list)
  plugins/         PluginRegistry (tools cached once at register); terminal/
                   mod.rs (plugin struct + shared helpers) + tools.rs (one
                   builder fn per tool)
  tools/           terminal/ (TerminalManager + TermBackend trait; pty.rs,
                   ssh.rs, serial.rs, secrets.rs, stub.rs), serial.rs, ssh.rs
vale-command-core/      Plugin/ToolDef/ToolHandler/NavItem, Config (+ensure_token via
                   getrandom), DeviceError (typed variants), EventBus/AppEventBus
(vale-tray/ and vale-desktop/ Tauri source deleted round-330 — both
 retired; the npm CLI + Electron shell replaced them. Git history has
 the old crates.)

## Conventions

- **Commit style**: conventional commits with stage tags (`fix(stage-g)`,
  `refactor(stage-i)`, `perf(stage-h)`, `feat(stage-k)` …). Each commit must
  leave the workspace green.
- **Verification per change**: `cargo test` → `cargo clippy --all-targets
  -- -D warnings` (round-301: CI promotes EVERY warning — mirror CI exactly;
  grep ^error misses warnings CI fails on) → `cargo xwin check -p vale-agent
  --target x86_64-pc-windows-msvc --features terminal,keyring`. After touching
  feature-gated code, also run `cargo test --features terminal,keyring` and
  `cargo clippy --features terminal,keyring --all-targets -- -D warnings`. Smoke:
  `cargo run --bin vale-agent --features terminal,keyring -- /tmp/ct.yaml`
  then curl `/api/status` and `/api/tools/terminal_list` with the Bearer token
  from `/tmp/ct.yaml`.
- **Feature-gating rule**: real terminal code is gated behind the `terminal`
  feature (PTY/SSH/serial); secrets behind `keyring`. The boundary lives only
  in the `#[cfg]` mod declarations and re-export lines (`pub use desktop_impl::X` /
  `pub use stub_impl::X`). Public paths must stay identical across configs so
  headless tests exercise the full dispatch path against the stubs.
- **Locks**: managers own their locks internally (tokio Mutex on Inner).
  Callers hold `Arc<Manager>` and never `.lock()`. Poison recovery:
  `unwrap_or_else(|p| p.into_inner())` — never silently drop data.
- **Channels**: output bounded with backpressure (blocking_send in reader
  threads); keystrokes try_send drop-on-full.
- **MCP tool additions**: define the tool in `src/plugins/<plugin>/tools.rs`;
  the registry caches it at register time — no other registration site.
  Update the tool-count test in plugins/terminal/mod.rs (26 tools:
  22 terminal_* incl. env/jobs/saved/connect/forget + secret_* legacy aliases)
  if adding/removing terminal tools; the plugin tests in
  plugins/{memory,system,mcp_client}/mod.rs cover their own counts.

## Device memory + desktop shell

- **memory plugin** (`src/plugins/memory/`): device-local knowledge base shared
  across AI clients — 6 MCP tools (`memory_save/search/list/update/delete/
  export`). JSONL + in-memory index at `<install>/memory/memory.jsonl`, soft
  delete, LRU capacity from config `memory: { max_entries, max_bytes,
  retention_days }`, credential sanitizer (`sanitize.rs`). Lives at
  `data_dir()/memory` (registry-first `DataDir`), NOT under InstallDir.
- **stdio transport (no port)**: `mcp_client_connect` defaults to
  `transport=stdio` — the bundled playwright-mcp is spawned over stdin/stdout
  (newline-JSON frames, rmcp `TokioChildProcess`), NO listening port.
  `transport=http` (9229) remains for external servers. Test override:
  `VALE_TEST_STDIO_NODE` / `VALE_TEST_STDIO_ENTRY` (see
  `tests/mcp_stdio_integration.rs`).
- **saisi decouple**: `config.yaml platform.console_url/download_url` are
  OPTIONAL — unset means a purely local install; `agent_update` and
  `page_view` remote pages error explicitly, device self-register skips.
- **desktop shell**: `vale-desktop-electron/` (Electron) loads
  `http://127.0.0.1:18080/desktop/` — the same SPA in desktop mode (terminal/
  browser/memory/plugins/settings rail). Owns CDP 9333 for AI driving, a tray
  with health + vitals, a 60 s AGENT WATCHDOG (`schtasks /run ValeAgent`), and
  a wait page that reappears when the agent dies mid-session. The
  `vale-desktop/` Tauri shell is retired. `/desktop/` reuses `/panel/` assets +
  loopback token injection (web.rs).

## vale-tray / vale-desktop (Tauri) — DELETED (round-330)

Both crates were retired long ago (npm CLI replaced the tray; the
Electron shell replaced the Tauri desktop) but their source + build
steps lingered. Round-330 removed the source trees and their builds
from build.sh (git history retains them). The npm CLI
(`vale` from `vale-agent-npm/bin/vale.js`) is the management surface.

## Windows smoke checklist (manual)

Terminal: open pty (PowerShell), type + resize, ssh + serial sessions, saved
connections + keychain password. MCP: `claude` direct device MCP
(`https://dN.../mcp`) and `/api/tools/terminal_list` with the Bearer token.
Events: `/api/events` SSE + `/api/events/term` stream. Tray: status lines
(running/subdomain/token mask) refresh, start/stop/restart work, copy MCP
config pastes the JSON snippet, console opens, local terminal opens.

## Iteration status (stage-n) — UPDATE THIS ON EVERY ROUND

> Living log for the agentic iteration loop. Any agent resuming work MUST
> read this first, then update it at the end of its round (replace the
> "last updated" line + append to Recent / In progress / Next).

Last updated: 2026-09-04 (round 328 — AGENTS.md compacted under the
  65536-byte workspace budget: bridge-era release history moved to
  agent/RELEASE-HISTORY.md (1.2.232 and earlier) + early iteration
  rounds ROUND-245..272 archived there too; live log keeps ROUND-273+.
  Current release: 1.2.278 on d1; e2e suite 30 checks; all matrices
  green.)
  ROUND-273 (2026-09-04): REPEATABLE E2E SUITE in the repo — the round-
  264..268 device verifications were one-off scripts in D:\Vale\pwout.
  Now agent/scripts/e2e/e2e.js + README: one Node file, sections
  terminal/file/workflow/browser, each check PASS/FAIL, exit 0 = all
  passed. DEVICE-VERIFIED on d1: full run 14/14 (terminal 3, file 3,
  workflow 6, browser 2) incl. browser_run_script driving the embedded
  view + SPA address-bar sync (Electron CDP evaluate quirk after nav
  handled by generous polling).
  ROUND-274 (2026-09-04): DISPLAY REGRESSION FOUND + FIXED (device-caught
  while adding the e2e panel section): every terminal in the Electron SPA
  went blank (xterm rows empty) although the server buffer + SSE were
  fine and a standalone chromium on the same agent rendered fine. Root
  cause: the Electron window was hidden (hide-to-tray / SYSTEM-session
  background) -> SPA visibilityState="hidden" -> Chromium STOPS
  requestAnimationFrame for hidden pages -> xterm's rAF-driven DOM
  renderer never paints (term.write is called, buffer advances, DOM
  never updates). Fix: main.ts webPreferences backgroundThrottling:false
  + app.commandLine switches --disable-renderer-backgrounding and
  --disable-backgrounding-occluded-windows (backgroundThrottling alone
  does NOT restore rAF for hidden pages). DEVICE-VERIFIED: vis went
  hidden->visible, rAF OK 0ms, xterm content returned. ALSO: e2e suite
  gained the panel section (AI marker must appear in the SPA's visible
  xterm; needs the newest session tab activated first) — full suite now
  16/16 on d1 (terminal 3, file 3, workflow 6, panel 2, browser 2).
  ROUND-275 (2026-09-04): doc sync — CLAUDE.md desktop-shell bullet now
  documents the round-274 hidden-window rAF freeze + fix; e2e README
  updated to 16 checks incl. the panel section (was 14, no panel).
  ROUND-276 (2026-09-04): round-274 fix LIVE-UPDATE verification — the
  hidden-window render fix keeps the SPA visibilityState "visible" even
  with the window in the background SYSTEM session (was "hidden" before
  the fix, which froze rAF). Device-verified: AI wrote a marker to a
  fresh session, the tab was activated, and the marker appeared in the
  xterm DOM (live SSE -> render path works end-to-end). Also confirmed
  the electron renderer inherits the disable-renderer-backgrounding
  switches (round-274's appendSwitch calls are in the running main.js).
  ROUND-277 (2026-09-04): e2e evidence section — round-264's manual
  Evidence-drawer check is now repeatable: the AI saves a screenshot into
  pwout via browser_run_script and GET /api/browser/pwshots (the drawer's
  data source) must list it. Full suite now 18/18 on d1 (added evidence 2).
  ROUND-278 (2026-09-04): url-policy.js TRACKING GAP FIXED — the compiled
  security-critical origin-policy file (shipped alongside main.js in the
  npm package + swapped by vale update) was never tracked in git, and the
  CI release flow does NOT run tsc before npm pack — every CI-built tgz
  silently lacked url-policy.js (device kept the stale copy; harmless so
  far, fatal once the policy changes). Committed it (same convention as
  main.js/preload.js). Also removed three stray config files in agent/
  (--test-threads=1, sanitize, plugins::memory::sanitize — cargo-test
  argv spills containing a device_token) that had sat untracked.
  ROUND-279 (2026-09-04): release-chain completeness audit after the
  round-278 url-policy.js gap — verified: every source file in the npm
  package files list (main.js/preload.js/url-policy.js) is git-tracked;
  the vale-desktop-electron/src copies in the npm package are byte-
  identical to the source tree; bin/vale.js is up-to-date with tsc (and
  carries only round-263 removal comments for 9223/bridge, no code); the
  exe binaries are correctly untracked (CI builds them into the pack).
  npm CLI tests 2/2 green. No further gaps found.
  ROUND-280 (2026-09-04): REAL MCP CHANNEL verified on d1 — the path real
  AI clients use (NOT the E2E suite's HTTP /api/tools): mcp_client_connect
  (stdio transport -> bundled playwright-mcp, 24 tools) -> mcp_client_call
  browser_tabs action=select index=1 (the embedded view; playwright-mcp
  DEFAULT-SELECTS TAB 0 = the desktop SPA — the round-258 tripwire
  protects the main window from stray navigation, but AI must select the
  embedded-view tab before driving or the panel never shows it) ->
  browser_navigate https://example.com/mcp-view-test -> SPA address bar
  synced to that URL. NOTE for future rounds: consider auto-selecting the
  embedded-view tab on connect, or documenting the select step for AI
  clients.
  ROUND-281 (2026-09-04, 1.2.271 LIVE on d1): auto-select the embedded-view
  tab on MCP stdio connect. Iteration: (a) initial single list raced the
  playwright-mcp browser attach (connect-internal lists saw only the SPA
  tab while post-connect lists had both — tabpoll probe: embedded view
  appears ~1.5s AFTER connect returns); (b) retry 6x2s still raced it;
  (c) FIX: sleep 3s once (covers the attach) then list + select — VERIFIED:
  connect -> immediate browser_navigate drives the embedded view
  (autoselect-v2 reached) with no manual tab select. Unit tests:
  embedded_view_index (SPA-skip) + extract_tool_text (stdio plain-string
  vs http content-array). Rust 198 / clippy clean. Also released 1.2.268
  (initial) / 269 (retry) / 270 (6x2s) / 271 (3s settle) along the way.
  ROUND-282 (2026-09-04): CI RED -> GREEN + e2e mcp regression. Found the
  main-branch CI failing on EVERY release since 1.2.266: mcp_integration
  list_tools_via_http asserted 46 tools but round-266's system_file_stat
  made system 7 (47 total) — the 46-tool count (427730bd) was never bumped.
  Local `cargo test` had masked it (lib-only tally missed integration
  tests). Fixed 46->47 (200/200 full suite); CI green again (d433f8e8).
  ALSO: e2e suite gained the mcp section (4 checks: stdio connect ->
  immediate browser_navigate drives the embedded view to a marker URL,
  SPA intact — the round-281 auto-select regression). Device-verified
  4/4 + file/workflow/evidence 11/11. GitHub release v1.2.271 CI-built
  (asset 6.4MB tgz); keep-latest: v1.2.267 release+tag deleted.
  ROUND-283 (2026-09-04): CI/release workflow hardening. (1) Verified the
  local feature-gated suite (--features terminal,keyring) matches CI and
  passes 204/204 — no more masked integration failures (round-282 lesson).
  (2) release.yml gained TWO gates it was missing: `npm test` after the
  panel SPA build (built but never tested), and a packed-tgz content gate
  (tar tzf must contain vale-agent.exe + main.js/preload.js/url-policy.js
  + bin/vale.js under package/) — the round-278 url-policy.js gap would
  now FAIL the release instead of silently shipping an incomplete tgz.
  Gate validated against the real 1.2.271 tgz (5/5 files OK).
  ROUND-284 (2026-09-04): full E2E suite 22/22 on d1 against 1.2.271 —
  first complete run since the mcp section landed (round-282). Segmented
  runs (12 + 10) to stay under terminal timeouts: terminal/file/workflow
  12/12; panel/mcp/evidence/browser 10/10 incl. panel xterm marker
  (PANEL-VIS), mcp auto-select driving the embedded view
  (mcp-autoselect URL reached), evidence pwshots, browser SPA-bar sync.
  Evidence test shots cleaned up. All display + drive paths green on the
  current release.
  ROUND-285 (2026-09-04, 1.2.272 LIVE on d1): http-transport connect now
  auto-selects the embedded-view tab too (round-281 covered only stdio).
  connect_http had the same default-tab-0 problem via the legacy 9229
  playwright-mcp. The select runs ONLY when the desktop CDP is up AND the
  connected server exposes browser_tabs (i.e. it IS a playwright-mcp
  driving the desktop) — foreign MCP servers never receive the call.
  DEVICE-VERIFIED on d1: connect transport=http (9229) -> immediate
  browser_navigate reached example.com/http-autoselect-test on the
  embedded view. 204/204 tests.
  ALSO: e2e mcp section extended to cover http transport (8 checks:
  stdio 4 + http 4) — device-verified 8/8; suite is now 26 checks.
  ROUND-286 (2026-09-04): release-CI RED caught by the round-283 gate —
  release 1.2.272 CI failed at "Test panel SPA": vitest forks workers
  crashed with "webidl.util.markAsUncloneable is not a function" (undici
  needs Node >= 22) because release.yml pinned Node 20 while local/panel
  toolchain runs Node 24 (local 82/82 passes). Fix: release.yml node 20
  -> 24. ALSO discovered the panel tests ONLY ran in the release workflow
  — ci.yml gained a dedicated panel (vitest, Node 24) job so every
  main-branch CI run covers them. Tag v1.2.272 rebuilt onto the fix and
  the release is re-running.
  ROUND-287 (2026-09-04): release 1.2.272 CI failed AGAIN after the Node
  24 fix — this time at "Build panel SPA": npm ci EUSAGE "Missing:
  lightningcss-android-arm64 / @rolldown/binding-* from lock file". A
  prior npm-11 install had regenerated the lock with only the LOCAL
  platform's optional deps (3+2 entries); npm ci --include=optional then
  failed everywhere (reproduced locally too). Fix: npm install
  --include=optional restored the full platform set (12+14 entries) —
  npm ci --dry-run clean, 82/82 tests. Tag v1.2.272 rebuilt again onto
  the lock fix.
  ROUND-288 (2026-09-04): release 1.2.272 CI failed a THIRD time — the
  round-283 tgz content gate itself was broken under `set -o pipefail`:
  `tar tzf | grep -q` made grep exit after the first match, SIGPIPE killed
  tar mid-stream ("tar: stdout: write error"), and pipefail turned the
  pipeline into a failure EVEN THOUGH every required file was present.
  Fix: list the tgz to a temp file first, then grep it (SIGPIPE-safe);
  prefix-agnostic basename matching kept. Gate verified locally. The
  round-283/287 gates keep earning their keep — three release-CI defects
  caught before shipping.
  ROUND-289 (2026-09-04): release v1.2.272 GREEN after the SIGPIPE gate
  fix (4th attempt) — GitHub release created by CI with the tgz asset
  (6.4MB); keep-latest: v1.2.271 release+tag deleted, only v1.2.272
  remains. The round-283/287/288 gate chain (panel tests -> lock check ->
  tgz content gate) caught three release-CI defects in a row before any
  shipped. Release pipeline now fully verified end-to-end on CI.
  ROUND-290 (2026-09-04): device 1.2.272 consistency check — npm pkg
  1.2.272, installed exe hash-identical to the pkg exe, mcp e2e 8/8
  (stdio + http auto-select both drive the embedded view). NOTE: binary
  string probes must use CODE strings, not comments (Rust comments never
  reach the exe — "exposes browser_tabs" was a comment and correctly
  absent). Device fully consistent with the CI-built release.
  ROUND-291 (2026-09-04): e2e evidence section hardened x2 (device-caught):
  (1) it never self-cleaned its screenshot (terminal/file sections do) —
  now unlinks after the pwshots check; (2) the embedded WebContentsView
  has ZERO bounds unless the SPA shows the Browser page, so screenshots
  failed with "Cannot take screenshot with 0 width" — the section now
  clicks the Browser rail (SPA CDP eval, shared spaRailClick helper)
  before shooting. Device-verified: evidence 2/2 + leftover 0.
  ROUND-292 (2026-09-04): e2e browser-class sections run IN SEQUENCE
  14/14 on d1 (panel 2 + mcp stdio/http 8 + evidence 2 + browser 2) with
  the round-291 rail activation — page switches between sections (Terminal
  -> embedded nav -> Browser rail -> address bar) do not interfere; the
  evidence screenshot succeeds right after mcp navigation. Combined with
  the earlier terminal/file/workflow 12/12, all 26 checks are verified on
  the current e2e.js. No pwout leftovers.
  ROUND-293 (2026-09-04): device process/session hygiene check after the
  heavy e2e rounds — zero leaks: only 1 node.exe (the external 9229
  playwright-mcp, expected resident); no stray stdio playwright children
  (each disconnect reaps its spawn); /api/sessions 327 records all
  closed (audit log, 30-day retention by design), 0 live zombies.
  ROUND-294 (2026-09-04): e2e workflow section now self-cleans its memory
  entry — every run memory_save'd an "E2E suite marker" and never deleted
  it (memory_search hits grew 7 -> 10 across runs = data-layer litter).
  memory_delete of the saved id added before the section ends. Cleaned 10
  accumulated markers on d1; re-run verified: hits=1 during the run, live
  markers 0 after (delete works). NOTE: memory_list returns
  {result:{results:[...]}} — a cleanup script probing .items/.entries
  misread 0 and found nothing; use .results.
  ROUND-295 (2026-09-04): full test-matrix green check — Rust
  --features terminal,keyring 204/204 + clippy clean (our code), panel
  vitest 82/82 local, and GitHub CI run 923a7785 SUCCESS with the
  round-283 panel (vitest) job actually executing in CI (all 5 jobs:
  agent test/clippy, xwin check, gateway, ui, panel). Matrix verified
  end-to-end after the recent e2e-only rounds.
  ROUND-296 (2026-09-04): local tag hygiene — 10 stale local tags
  (v1.2.230..243, all long-deleted on GitHub by keep-latest) removed;
  local repo had ZERO release tags (they were only ever created via the
  GitHub API). Backed up v1.2.272 locally (-> 2199b327, matches GitHub)
  so a GitHub loss/rebuild can't strand the release chain. Local refs now
  mirror GitHub (only v1.2.272).
  ROUND-297 (2026-09-04): agent_update manifest un-rotted — index
  worker's /api/version was hard-coded to v1.2.141/1.0.145 with the 141
  tgz long deleted from assets (an update check that ever fired would
  404). agent_update is LIVE on d1 (registered tool, download_url set).
  The endpoint now derives the manifest from the version.json discovery
  asset (version + sha256 published by the release flow); assets-down
  fallback = 503 (never a fabricated manifest). version.json gained the
  sha256 field (verified against the CDN tgz). Device-verified: live
  manifest version=1.2.272, download 200, sha256 64-hex. NOTE: agent_update
  compares remote 1.2.x against the LOCAL Cargo 1.0.145 — remote always
  wins, so a real agent_update call performs a tgz swap (device restart);
  the local version it compares is the Cargo crate version, not the npm
  release number.
  ROUND-298 (2026-09-04, 1.2.274 LIVE on d1): agent_update version-gates on
  the INSTALLED release. Cargo version (1.0.145) never changes -> every
  agent_update call looked "newer" and re-downloaded + swapped. Fix: the
  swap script writes <install>/.vale-release = remote version on PROVABLE
  success; subsequent checks read it as local (fallback Cargo). BOTH
  channels write it: agent_update's WMI swap (agent side) AND vale.js
  update (npm side, round-298b). Device-verified end-to-end: vale update
  to 1.2.274 -> agent_update returns up_to_date (current==remote).
  LESSON: "tsc compiled" was a LIE — dist/vale.js timestamp was stale
  (the earlier bin-vs-dist diff compared two OLD files); the first 1.2.274
  tgz shipped a stale bin/vale.js. ALWAYS rm dist output + verify marker
  presence in the packed artifact, not a diff of possibly-stale files.
  ROUND-299 (2026-09-04): release.yml now COMPILES bin/vale.js from
  src/vale.ts before npm pack — the stale-bin failure mode (1.2.274)
  cannot recur: pack installs typescript+@types/node (--force skips the
  os:win32 platform check on Linux runners), runs tsc, syncs bin, and
  fails if the compiled output lacks the round-298 marker. tsconfig
  typeRoots now points at the package's OWN node_modules/@types (was
  hard-coded to the desktop shell's node_modules, which CI never
  installs). CI-compile simulated clean in a scratch dir.
  ROUND-300 (2026-09-04, 1.2.275 LIVE on d1): auto-select regression FOUND
  + FIXED (device-caught by full-suite verification on 1.2.274): mcp e2e
  "drives embedded view" FAILed while manual browser_tabs worked. connect's
  embedded-view auto-select saw EMPTY tab lists (diag: "[select] initial
  tab list text:" blank, 4 retries failed) and left the desktop SPA
  current — the first browser_navigate drove the SPA instead of the
  embedded view. ROOT CAUSE: rmcp 2.x CallToolResult serializes as
  {content:[...]} with NO "result" wrapper; extract_tool_text only parsed
  /result/content (the round-281/285 shape) — a floating rmcp 2.x upgrade
  silently broke auto-select. FIX: parse /content too (same shape
  mcp_client_call handles). +1 test (top-level content). Device-verified:
  connect -> tabs show embedded view (current) -> navigate reaches marker
  URL on BOTH transports; full suite 26/26 on 1.2.275.
  ROUND-301 (2026-09-04): CI RED -> GREEN — 6ff55ab1's agent job failed
  at "Clippy (zero warnings)" while local clippy passed: my local check
  greps ^error but CI promotes EVERY warning (-D warnings). round-298's
  update_from_tgz release_version param was unused in the cfg(not(windows))
  arm. Fixed (let _ = ...); CI 739d4913 green. LESSON: local clippy MUST
  mirror CI exactly (cargo clippy -- -D warnings) — grep ^error misses
  warnings CI fails on.
  ROUND-303 (2026-09-04): GitHub release synced to 1.2.275 — v1.2.272
  was the last CI-built release (round-289); 273/274/275 were CDN-only
  manual publishes. Tag v1.2.275 pushed via API -> release.yml ran GREEN
  (the round-299 tsc-compile-bin step's FIRST real run) -> gh release
  created with the 6.4MB tgz; keep-latest deleted v1.2.272 release+tag.
  Local tags re-synced (v1.2.272 backup dropped, v1.2.275 backed up).
  Lesson: after manual CDN publishes, mirror to GitHub via the tag API so
  the release chain + keep-latest stay current.
  ROUND-304 (2026-09-04, 1.2.276 LIVE on d1): /api/status now reports the
  npm RELEASE version — "version" was the Cargo crate version (1.0.145,
  protocol anchor) and never changed, so consumers saw 1.0.145 forever
  while the device ran 1.2.x. status adds "release" = <install>/.vale-
  release (written by BOTH swap paths, round-298/298b), omitted when
  absent. Device-verified: version=1.0.145 release=1.2.276.
  ROUND-305 (2026-09-04, 1.2.278 LIVE on d1): http auto-select session-
  recycle fix — 1.2.276's mcp e2e was 7/8 (http "drives embedded view"
  FAIL, stdio PASS). Diag ([select] RAW list result: null) showed the
  http arm's browser_tabs returned NULL on a recycled session (round-137
  reap) — auto-select lacked mcp_client_call's heal-first behavior, so
  every retry listed on the DEAD session forever. Fix: empty http list
  result -> heal_and_restore (re-handshake) before the next retry.
  1.2.277 shipped the raw-result diag; 1.2.278 the fix. Device-verified
  mcp 8/8 (http drives embedded view PASS again).
  ROUND-306 (2026-09-04): e2e mcp probes now disconnect BEFORE connect —
  a leftover connection from a previous run made connect return
  already_connected and the check fail spuriously (observed repeatedly on
  long-running devices during round-305). Each probe starts clean
  (disconnect + 1.5s settle). Device-verified: mcp e2e 8/8 TWICE in a row
  (repeated runs no longer accumulate state).
  ROUND-307 (2026-09-04): release-chain housekeeping — v1.2.278 GitHub
  release built GREEN by CI (round-299's tsc-compile step now proven on
  3 real releases: 275/276/278); keep-latest deleted v1.2.275+276
  releases AND tags; GitHub + local now hold ONLY v1.2.278. Full chain
  (CDN manual publish -> GitHub tag API -> CI build -> keep-latest) ran
  end-to-end for a multi-release week.
  ROUND-308 (2026-09-04): full e2e suite 26/26 on 1.2.278 — first
  complete run after the round-305/306 mcp fixes (terminal/file/workflow
  12 + panel/mcp/evidence 12 + browser 2). auto-select drives the
  embedded view on BOTH transports, evidence self-cleans, panel xterm
  shows AI output. All green on the current release.
  ROUND-309 (2026-09-04): CDN asset prune — index/public/vale-agent had
  accumulated 46+ old tgz (229-269 + 274-278; round-230's last-5 policy
  was never enforced on manual publishes — every release only cp'd the
  new file). Deleted 229-273 locally + wrangler deploy synced the CDN:
  old versions now 404, only 274-278 + latest remain. LESSON: run the
  last-5 prune on EVERY release; and shell case patterns for dotted
  versions must be exact (*-274.tgz does NOT match 1.2.274 — dot vs
  hyphen; 274-278 were briefly deleted locally, restored from CDN before
  deploy).
  ROUND-310 (2026-09-04): publish-release.sh — the round-309 prune lesson
  is now FORCED by tooling: scripts/publish-release.sh <ver> wraps the
  whole CDN publish (npm pack -> stage + latest alias -> version.json with
  sha256 -> last-5 prune -> commit -> wrangler deploy) with guards
  (package version match, staged exe). Prune uses a mapfile array — a
  space-padded string match fails on newline-separated items (caught the
  bug in verification before it could delete the wrong files).
  ROUND-311 (2026-09-04): publish-release.sh component-verified (guard
  rejects version mismatch exit 1; pack+stage+version.json update works;
  prune 0 false-deletes) + device consistency: electron main.js on d1
  (sha 4168c9e5, 54143B) byte-identical to the repo npm-package copy —
  no desktop-source drift after the 272->278 release week.
  ROUND-312 (2026-09-04): gateway + device hygiene sweep — gateway
  unchanged since 7f35c95b (no unpushed commits), tests 250/251 (1 skip =
  CF runtime), wrangler dry-run compiles, live /api/health all 20 channels
  ok. Device: 1 node proc only (9229 resident playwright), /api/sessions
  344 records 0 live zombies, agent 1.2.278 stable.
  ROUND-313 (2026-09-04): e2e mcp section now proves AI CLICK interaction
  drives the embedded view — not just navigation: each probe navigates to
  the example.com homepage, snapshots, clicks "Learn more" (browser_click
  {target}=snapshot ref) and verifies the view follows to iana.org. Suite
  26 -> 30 checks (mcp stdio 6 + http 6). Device-verified 12/12. Iteration
  lessons: marker URLs (example.com/<marker>) are 404 pages with no links
  — navigate home first; JSON.stringify double-escapes quotes (match the
  ref after the text, not the quoted literal).
  ROUND-314 (2026-09-04): post-round-313 hygiene — CI cdc25ccc GREEN
  (e2e changes don't affect CI jobs), device clean after the 30-check
  suite (1 node proc, 5 electron, no e2e png leftovers — pwout holds only
  real operation evidence), e2e.js identical across repo/GitHub/device
  (24048B @ a6a2bd84).
  ROUND-315 (2026-09-04): full 30-check e2e suite verified on 1.2.278 —
  terminal/file/workflow 12 + mcp 12 (incl. the round-313 click
  interaction) + panel/evidence/browser 6. All green; the expanded suite
  runs clean end-to-end on the current release.
  ROUND-316 (2026-09-04): gateway browser-click tests — round-138's
  element_ref->target conversion (old callers pass integer refs,
  playwright-mcp wants "eN" snapshot refs) had ZERO test coverage.
  Added 4: click int 7 -> target e7, click "e7" passthrough, click no
  element_ref forwards unchanged, type converts + keeps text. Gateway
  255 tests / 254 pass. (Real AI clients reach the device THROUGH this
  gateway path — the round-313 e2e click checks the direct path.)
  ROUND-317 (2026-09-04): CI 9d096d53 GREEN — round-316's gateway click
  conversion tests pass on CI (all 5 jobs incl. gateway test/typecheck).
  Local tsc --noEmit clean too.
### Current release
- npm **1.2.278 LIVE on d1 (round-308+)** — MCP connect auto-selects the
  embedded-view tab on BOTH transports (stdio 1.2.271 + http 1.2.278:
  desktop-CDP + browser_tabs guard, http arm heals recycled sessions
  round-305); /api/status reports the npm release (round-304). E2E suite
  agent/scripts/e2e/e2e.js 30 checks on d1 (round-315: terminal/file/
  workflow 12, mcp stdio+http 12 incl. click interaction, panel/evidence/
  browser 6). Release chain: publish-release.sh (round-310) + GitHub tag
  API -> CI-built release; CDN pruned to last-5 (round-309).
  ROUND-319 (2026-09-04): index download-page DEAD LINK fixed — the
  landing page's install command pointed at the DELETED 1.2.141 tgz on
  the Vercel mirror; every copy-paste install failed. Now uses the
  versionless latest alias (agent.saisi.online/vale-agent/
  vale-agent-latest.tgz, mirrored on every release). Deployed + verified
  (page shows working command, alias 200). No other dead dl refs remain.
  ROUND-320 (2026-09-04): build-installer.sh RETIRED (round-318 audit
  follow-up) — it always FAILED on the current architecture: required the
  retired Tauri vale-desktop.exe + vale-tray.exe, rewrote index/src/
  index.js (version constant / static sha256 / URL sed — obsolete since
  round-297's version.json manifest), staged to the dead Vercel mirror.
  build.sh deploy now deploys workers only (vercel-proxy kept: its
  /api/git mirror is LIVE; its dead dl/ staging of retired installers
  removed). All doc refs repointed at publish-release.sh; index/README
  rewritten for the npm-only architecture. -261 lines dead code.
  ROUND-321 (2026-09-04): electron src freshness GATE in release.yml —
  main/preload/url-policy .js are COMMITTED tsc artifacts (outDir=dist,
  package ships src/*.js) with NO freshness guard — a .ts edit without
  recompiling silently shipped the old main.js. Pack step now recompiles
  electron TS with the CI-installed tsc (typeRoots -> vale-agent-npm's
  @types) and FAILS if committed src/*.js differ. Verified locally: all
  3 identical (no drift). ALSO dropped the dead "vale-desktop.exe" entry
  from the npm files list (retired Tauri exe never enters CI tgzs);
  vale.ts keeps its existsSync-guarded optional paths. Cleaned 178
  local pack tgz junk.
  ROUND-322 (2026-09-04): round-321 gate cwd FIXED before it ever ran —
  the electron freshness gate invoked ./node_modules/.bin/tsc from
  agent/ (parent dir) where no tsc exists — would have failed every
  release. Now (cd vale-agent-npm && tsc -p ../vale-desktop-electron/
  tsconfig.json --typeRoots ./node_modules/@types) like the bin/vale.js
  compile. Full CI-equivalent simulation (typescript@5 @types/node@22
  installed): tsc exit 0, 3 artifacts IDENTICAL; stale artifact caught.
  ROUND-323 (2026-09-04): release.yml full-chain audit + pack simulation —
  walked every step's cwd assumptions (no further bugs; 85's bare `cd`
  is the only cwd change and everything after is npm-relative). Simulated
  the WHOLE pack chain locally: bin/vale.js compile+marker, electron
  freshness (3 IDENTICAL), npm pack, tgz 5/5 content gate — all PASS.
  Device health: release 1.2.278, cpu 1.3%, mem 67.6%, uptime 3974s.
  CI 9262ae6a GREEN. NOTE: /api/status fields are cpu_pct/mem_pct.
  ROUND-324 (2026-09-04): two build.sh deploy bugs found + fixed —
  (1) the index post-publish smoke grepped static version/sha256
  constants out of index/src/index.js that round-297 removed — EVERY
  build.sh index/deploy failed at the smoke (empty want_sha). Now reads
  index/public/vale-agent/version.json (the served source of truth);
  verified version+sha match live /api/version. (2) the gateway /code/
  source-viewer mirror drifted 17/17 files stale after round-320 deleted
  build-installer.sh (its only sync path). deploy_worker now syncs
  gateway/src into public/code/files/vale-gate before deploy; mirror
  synced to current immediately.
  ROUND-325 (2026-09-04): round-324 fixes DEVICE/DEPLOY-VERIFIED — real
  `build.sh gateway` run: code-viewer sync + wrangler deploy succeeded
  (7.47s, Version c07a2225). Live /code/ viewer on api.saisi.online now
  serves the CURRENT sources — sha256 of live mcp.ts and plugins/admin.ts
  IDENTICAL to the repo files (was 17/17 stale before round-324).
  ROUND-326 (2026-09-04): index deploy smoke VERIFIED live + dead exe
  purge — real `build.sh index` twice: smoke passed both times
  ("v1.2.278, binary sha verified", Versions 700375b1/fd27b0c2).
  ALSO: index/public/vale-agent held 3 dead non-git STAGING exes
  (vale-desktop.exe 8.5MB Tauri + vale-tray.exe 896KB + vale-agent.exe
  16MB — build-installer.sh leftovers, round-320 missed them). Deleted;
  assets now hold only tracked files + release tgzs (last-5 + latest).
  Redeploy synced: all 3 exes now 404 on the CDN.
  ROUND-327 (2026-09-04): product-side health round — panel vitest 82/82
  (16 files, Node 24 = CI panel job version) after the deploy-chain
  rounds; evidence feed healthy on d1 (actions 50 + pwshots 17, latest =
  the round-315 e2e browser_run_script with stdout TITLE=Example Domain);
  CI fc4e24d2 GREEN. No product regressions from the round-318..326
  release-chain cleanup.
  ROUND-329 (2026-09-04): iteration-log ORDER fixed — ROUND-287/288
  (release 1.2.272 CI fixes) sat after ROUND-299 (misplaced by an old
  edit); moved between 286 and 289. Live log now runs 273..317 in exact
  chronological order.
  ROUND-330 (2026-09-04): RETIRED CRATES DELETED — vale-tray/ and
  vale-desktop/ (Tauri) source trees removed (19 tracked files; git
  history retains them) + their 5.7GB of xwin target caches. build.sh
  agent no longer builds either (was minutes of dead work per run; CI
  builds vale-agent only). All four agent-facing docs updated.
  ROUND-331 (2026-09-04): vale.ts Tauri staging dead code removed —
  setup/update still staged vale-desktop.exe (retired Tauri shell) with
  existsSync guards that never fired (npm package stopped shipping it
  round-75; crate deleted round-330). -49 lines; bin/vale.js recompiled
  (round-298 discipline), tsc clean. taskkill lines stay as defensive
  cleanup for stale processes. Workflows verified free of retired refs.
  ROUND-332 (2026-09-04): round-331 verified end-to-end — npm CLI tests
  2/2 (node --test), bin/vale.js loads + syntax OK + exports intact
  (psq/busyIsFresh via require.main guard). Retired-ref scan complete:
  electron main/preload/url-policy clean (40 tray hits = the Electron
  SYSTEM TRAY feature, not vale-tray), workflows/build.sh clean, only
  historical refs remain (deploy/retired/, specs, memory client-id
  strings). Committed bin matches working tree.
  ROUND-333 (2026-09-04): repo hygiene — committed docs/agents/
  dsh-ops-troubleshooting.md (2026-08-27 dsh Web stability record: Node
  22 zstd leak, cloudflared pm2 recovery, CORS, anycast latency) and
  added .gitignore rules (.dsh-tmp-*, .zcode/, cloudflared-run.sh local
  pm2 launcher). Untracked files now ZERO.
  ROUND-334 (2026-09-04): full 30-check e2e suite re-verified on d1 after
  the round-318..333 cleanup marathon (mcp 12 + terminal/file/workflow
  12 + panel/evidence/browser 6 — all PASS, exit 0). Device hygiene:
  1 node + 5 electron, 0 e2e png leftovers (self-cleaning), release
  1.2.278. Repo-side cleanup caused ZERO product regressions.
  ROUND-335 (2026-09-04): stale-doc sweep — agent/README.md DELETED
  (retired Vale Command era: vale-tray build steps for a deleted crate,
  stale module map; no refs, zero unique info). gateway/
  DEVICE-INTEGRATION.md marked SUPERSEDED (2026-08 extension-era v2
  design) with banner → current design is
  docs/superpowers/specs/2026-08-28-vale-desktop-core-design.md; root
  AGENTS.md/CLAUDE.md design-doc refs updated. docs/research/* keep
  their Tauri-era notes (historical research records).
- Release history: bridge-era releases (1.2.232 and earlier) are archived in
  `agent/RELEASE-HISTORY.md` (chronological; entries record the state at
  the time — bridge-era notes included for context). Current + recent
  release state lives in the Current release section above.
- Distribution: `https://agent.saisi.online/vale-agent/vale-agent-<ver>.tgz`
- Git: **GitHub is the TRUE origin** (public face; the v.saisi.online
  proxy auto-mirrors GitHub, verified 2026-09-25). Normal pushes:
  `git push https://x-access-token:<ghp>@github.com/SilasVale/vale.git
  main:main` (HTTP/1.1, reliable); the proxy push also works for small
  increments (its receive-body cap is ~<725MB → 413 on full repushes).
  GitHub releases via the API as before.

### Recent (stage-n)
- Browser panel Chrome-style redesign: two-line toolbar (tab row + address
  row), live viewport dominant, Evidence right-side drawer, bottom status
  bar with AI-runner chip (1.2.180)
- Browser nav buttons (back/fwd/reload) + history-aware disabled
  state — released (1.2.183); resolution-following sharp stream +
  tab titles (1.2.185-186); Chrome-style visual polish (1.2.187);
  expandable AI-action scripts (1.2.188); memory UI editing (1.2.189);
  neutral SPA placeholders (1.2.190)
- AUTO-LAUNCH FIX (1.2.195): the Settings toggle used sync execSync
  schtasks which killed electron; now async spawn (15s timeout) +
  /ru Administrator + inner-quoted /tr. Roundtrip verified on d1.
- /api/status health fields (uptime_secs, live_sessions) consumed by tray
  + SPA status strip
- terminal_history exit codes + limit; memory multi-word AND search +
  compaction; ConPTY natural-exit fix (pollable reader + reaper drop);
  bridge supervisor reclaims stale 9224; vale CLI + bridge converted to TS
- Form controls themed (fix glaring white inputs in dark mode, 1.2.196);
  SPA + bridge + electron fully English UI incl. welcome page (1.2.197-199)
- DEVICE VITALS (1.2.200): /api/status cpu_pct/mem_pct/mem_total_mb via
  kernel32 GetSystemTimes + GlobalMemoryStatusEx (new src/metrics.rs);
  SPA status strip polls 15 s and renders CPU/MEM
- Memory UI CRUD complete: inline edit (1.2.189) + '+ New' create via
  memory_save (1.2.201, end-to-end verified incl. delete cleanup)
- Tray menu/tooltip shows CPU/MEM vitals (1.2.202), mirroring the strip
- Plugins page: per-row MCP tool-count badges from /api/spec (1.2.203-204;
  device live: Terminal 25 / Memory 6 / System 6 / MCP Client 4 /
  Playwright 2 / Update 1 / Design 1 — registry total 45, singular fixed)
- Build hygiene: LNK4099 (xwin CRT PDB noise) silenced via /ignore:4099 —
  Windows release build now warning-free (7c697bea)
- MIT LICENSE + README rewritten (no private host names, no private repos)

### In progress
- (none — 1.2.216 live + device-verified; both audits harvested.)

### Round-70 test-harness lessons (terminal verification via nested HTTP)
- Executing Invoke-RestMethod terminal_execute(TARGET=self session) from
  INSIDE that session DEADLOCKS the busy lock (30 s wait) — always drive
  the target from a DIFFERENT session.
- A COLD pwsh session's first foreground execute eats up to 12 s in the
  stage-l first-prompt gate (633;A scan starts at buffer tail, banner is
  already past it) — WARM the target with one call before timing anything.
- terminal_jobs(job_id) returns {result:{state, exit_code, job_id}} —
  NOT a .jobs array. terminal_* tools wrap under .result.

### 2026-09-25 d1 530 incident (MY REGRESSION — cfg(windows) boot panic)
- 1.2.223's cloudflared supervisor used tokio::spawn INSIDE main()'s
  #[cfg(windows)] boot block — BEFORE the runtime exists. Windows-only:
  cargo test/clippy/xwin-check all pass (elided on Linux, compiles on
  check), the panic only fires when the EXE boots: service dies instantly,
  tunnel never spawns, every remote channel 530s. The device cannot
  self-heal (the update path needs a live agent) — recovery = console
  `npm i -g …/vale-agent-<good>.tgz && vale.cmd update` (WMI swap works
  fine from a dead agent).
- RULE ADDED: any tokio API added to a cfg(windows)-only path MUST be
  assumed untested by the Linux matrix — either build it CONTEXT-PROOF
  (own std::thread + current_thread runtime, as 1.2.224's supervisor
  now is) or gate behind run_server. cargo xwin CHECK compiling ≠ runtime
  correct; the 10s incremental relink fooled me twice — verify on device
  within the same round as shipping any boot-path change.
- 1.2.224 = fix + release; device recovered via console; incident closed.
- RECOVERY AUDIT (1.2.225/226): verifying the boot harden on d1 exposed a
  SECOND, older latent bug — paths::harden_file granted by NAME
  ($env:USERNAME), which under a service context is the MACHINE ACCOUNT
  (DESKTOP-xxx$): icacls cannot map it → WHOLE COMMAND REJECTED → the
  round-80/122 "fail-closed" ACL never actually applied on the service at
  all (config.yaml still had inherited Users:RX!). d1 proof post-226:
  config.yaml now shows exactly Administrators+SYSTEM RW, all inherited
  entries gone. harden_file now grants FIXED SIDs (*S-1-5-18,
  *S-1-5-32-544 — icacls resolves SIDs without name lookup in any context).
  Lesson: security-relevant "best-effort" CLI shims must be verified by
  EFFECT (read back the ACL), never by exit code alone — icacls exited 0 on
  the name-mapping failure path it swallowed… (our status.success() check
  caught it only once we made boot harden VISIBLE via WARN + icacls readback).

### 2026-09-25 d1 DARK incident (my fault — read before restarting tasks)
- I stopped ValeAgent with `schtasks /End` from a browser_run_script that was
  killed before its `schtasks /Run` (the /End also killed the agent-supervised
  cloudflared → the gateway channel died with it → no remote way to /Run).
  Device stays dark until a console login or reboot; the electron wait page
  has a "Start Agent" button for whoever is physically there.
- LESSON: never split End/Run across an interruptible script. Restart the
  agent with ONE atomic command:
  cmd /c "schtasks /End /TN ValeAgent & timeout /t 3 & schtasks /Run /TN ValeAgent"
  — or better, the WMI swap trick used by `vale update`.
- VERIFIED after recovery (round 57): the REAL sessions dir is
  `C:\ProgramData\Vale\sessions` (registry DataDir — NOT D:\Vale\sessions;
  my first test files went to the wrong dir). With files placed correctly:
  stale (-40 d mtime) PRUNED, fresh KEPT, agent.log line
  'session log retention: pruned 1 stale audit file(s)' — and the dir had
  genuinely accumulated 167 audit files, proving the unbounded growth.
- agent.log (new in 1.2.207): runtime tracing now visible on the device.
- SHIPPED FIX (1.2.206): electron now auto-runs `schtasks /run ValeAgent`
  after ≥5 consecutive failed port probes (~60 s), ≥5 min apart — remote
  operators are no longer stranded when the agent (and its tunnel) die.

### History rewrite (2026-09-25 — GitHub contributor graph hygiene)
- User request: remove "Claude" from GitHub developers. Root cause: 402
  commits carried `Co-Authored-By: Claude <noreply@anthropic.com>` (from
  early Claude Code sessions); GitHub counts co-authors in the graph.
- Fix: `git filter-branch --msg-filter` over a mirror → 883 new commits,
  **trees byte-identical** (verified `git diff` = 0 bytes; 402 trailers
  gone), force-pushed.
- PUSH PATH MEASURED: the proxy (v.saisi.online/api/git) rejects ~725MB
  request bodies (HTTP 413) — full-history pushes must go **direct to
  GitHub with the token URL** (`https://x-access-token:ghp_...@github
  .com/SilasVale/vale.git`, HTTP/1.1 + http.postBuffer 2g; first direct
  attempt SUCCEEDED — the old "GitHub push blocked by TLS" belief is
  DISPROVED for this path). The proxy mirrors GitHub automatically
  (origin caught up within ~15 min) — GitHub is now the TRUE origin.
- Old refs kept locally (refs/original backup + rewritten-main branch).
- PREVENT RECURRENCE: future commits never carry co-author trailers
  (all our commits are heredoc -F, clean). If the user runs Claude Code
  on this repo, set `"includeCoAuthoredBy": false` in its settings.
- GitHub contributor GRAPH RECOMPUTES ASYNC — card may take 24-48 h.
  `@claude` shows because Anthropic CLAIMED noreply@anthropic.com as a
  real GitHub account (trailers linked to their avatar). SECOND STEP
  (2026-09-25b): the rewrite alone was not sufficient while OLD TAGS
  (v0.1.0…v1.2.216) still made trailer commits REACHABLE — deleted all
  10 stale tags via API (204s) + locally; the only surviving tag is
  v1.2.218 → 16a01170 (clean chain). EVERY ref on GitHub is now
  trailer-free; the card will drop claude on next recompute.
  RULE: future releases create their tag fresh (keep-latest deletes the
  previous tag ref too, not just the release object).

### Next candidates
- gateway F3: CLIENT_KEY doubles as admin token (billing keys + /mcp RCE
  by every settings.json holder) — DESIGN decision, needs user sign-off
  (breaks existing clients if tightened)
- npm publish (waits on user `npm login`; registry name confirmed free)
- CI now owns the release build. Next manual release: SKIP the curl asset
  upload — just push the tag and let CI attach it; keep-latest stays manual.
  DONE: M1 pair-code atomic (round 63), F5 breaker (round 61), session_log
  clock-jump safety (round 63), preload IPC (round 62), npm CLI (round 62),
  device-fetch SSRF (round 64), body-scan DoS (round 64).

### GitHub ops
- Code: push GitHub too — `git push https://SilasVale@github.com/SilasVale/vale.git main`
  (works since 2026-09-25; fall back to Gitea-only + API if TLS drops return).
- Releases: `curl -X POST -H "Authorization: Bearer $TOKEN" .../releases`
  with the ghp_ token from `~/.git-credentials` (works; tag push times out).
  CURRENT: v1.2.216 is the ONLY release on GitHub (asset = 9.0 MB tgz,
  verified public); older releases deleted per the keep-latest policy.
- npm publish (2026-09-25 update): registry.npmjs.org is REACHABLE from the
  dsh box now (404 on /vale-agent = the name is FREE) but no npm credentials
  on this machine (`npm whoami` → ENEEDAUTH; ~/.npmrc points at npmmirror).
  One-time user action: `npm login` then `npm publish` from agent/vale-agent-npm.
  Until then, URL install works via the versioned tgz or the versionless
  https://agent.saisi.online/vale-agent/vale-agent-latest.tgz alias (mirrored
  on every release; verified end-to-end).

### Electron recovery on d1 (2026-09-02 incident)
- Symptom: electron procs 0 + CDP 9333 down + ValeDesktop task gone.
- Root cause (2026-09-02 update): Windows Defender repeatedly DELETED
  electron.exe AND playwright/node.exe (binaries vanished after every
  restore; only pak/dll/node_modules survived). Defender treats the
  unsigned binaries as threats. FIX: add Defender exclusions (they
  persist):
    Add-MpPreference -ExclusionPath "D:\Vale\vale-desktop-electron\node_modules\electron"
    Add-MpPreference -ExclusionPath "D:\Vale\playwright"
  A Settings auto-launch test also deleted the ValeDesktop task
  (setAutoLaunch(false)) — recreate with /ru (see below).
- Fix: re-download the binary from the npmmirror mirror (fast on d1,
  github/npm direct is slow):
  curl -L -o electron-33.4.11-win32-x64.zip
    "https://npmmirror.com/mirrors/electron/33.4.11/electron-v33.4.11-win32-x64.zip"
  Expand-Archive → xcopy into node_modules/electron/dist → start
  electron (spawn detached, cwd=vale-desktop-electron).
- ValeDesktop task recreate (SYSTEM session needs /ru):
  schtasks /create /tn ValeDesktop /tr "powershell -NoProfile -ExecutionPolicy
  Bypass -File D:\Vale\start-desktop.ps1" /sc onlogon /ru "$env:USERNAME" /f
- Verify: electron procs, CDP /json/version, task State=Ready.

### Dist housekeeping (2026-09-25)
`index/public/vale-agent/` had accumulated 79 tgz (748 MB); pruned to the
latest 5 (1.2.204-208). Update URLs pin explicit versions, so dropped
<204 builds are unreferenced and rebuildable from git. Wrangler deploy
propagated the deletions (verified: 1.2.151 now 404, 1.2.208 200).
tgz files are gitignored — cleanup is deploy-side only, no commit.

### Device facts (d1)
- agent token `abacd520...97`, port 18080, CDP 9333 (Electron desktop view);
  playwright-mcp 9229 (external); bridge/9223/9224 REMOVED (round-262/263)
- pwsh 7.6.5 at `C:\Program Files\PowerShell\7\pwsh.exe`; ValeAgent +
  ValeDesktop scheduled tasks; install dir `D:\Vale`
- npm broken on device → use `node "D:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"`
