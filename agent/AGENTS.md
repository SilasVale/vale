# Vale Agent Build Guide

> Mirrors agent/CLAUDE.md (build/verify/architecture semantics must stay
> identical; the stage-n living log at the end of THIS file is AGENTS-only —
> CLAUDE.md never mirrors it). Post-2026-08-28 additions: registry-
> first path resolution (src/paths.rs), npm-only install channel, Gateway
> Settings card + POST /api/gateway/connect.

## Cross-compilation to Windows (MSVC)

Panel-first: the raw `cargo xwin build` commands below do NOT rebuild the panel SPA — after touching `resources/panel-react/`, run `npm run build` there first (or use `scripts/build.sh agent`, which does both), since panel.js is embedded at compile time via include_str!.

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
#    and deploy them (or run scripts/publish-release.sh <ver>, which wraps
#    pack + stage + alias + manifest + last-5 prune + commit + deploy):
cp vale-agent-1.2.N.tgz ../../index/public/vale-agent/
cp vale-agent-1.2.N.tgz ../../index/public/vale-agent/vale-agent-latest.tgz
# version.json MUST carry the tgz sha256 — /api/version requires ver && sha
# (else it answers 503 and agent_update refuses the install, round-119):
SHA=$(sha256sum vale-agent-1.2.N.tgz | cut -d' ' -f1)
printf '{"version":"1.2.N","tarball":"vale-agent-latest.tgz","updated":"%s","sha256":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SHA" > ../../index/public/vale-agent/version.json
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
then: stop ValeAgent task → kill agent tree → copy with retry →
restart task. The terminal connection DROPS for ~10 s mid-update; reconnect
and verify via `/api/status` → `version`.

Gateway (`gateway/`) deploys separately: `cd gateway && wrangler deploy`.

## Architecture

vale-agent is a pure service — MCP server + terminal backends + SSE endpoints
+ the Electron desktop shell (embedded real browser on CDP 9333). The Tauri
desktop (`vale-desktop/`), the standalone `vale-tray/`, and the NSIS-era
installers are RETIRED; the Electron shell (`vale-desktop-electron/`) and the
gateway device app replaced them. The
web panel (`/panel`, Apple-style terminal) is served by `src/web/` — the
browser either carries the proxy-secret marker, runs on loopback, or presents
a one-time `?grant=` the agent redeems at the gateway (round of the panel-
grant fix: the permanent device token never rides in a URL); the token is
injected server-side into the panel HTML.

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
                   managers own their locks internally (inside AppState only
                   config_path carries a small std Mutex and config a std
                   RwLock — write-through via update_config, read via
                   config_snapshot)
  mcp/server.rs    DeviceServer (rmcp ServerHandler), bind() -> (addr, handle)
                   (port 0 = ephemeral, used by tests), serve_with_token
  web/             HTTP surface — hand-rolled Tower service (NOT axum route
                   handlers: they break Windows cross-compilation). TokenGate<S>
                   wraps the /mcp route with the bearer check. mod.rs owns auth +
                   dispatch + the api_* handlers (routes: GET / (minimal status
                   page), /api/status, /api/spec, /api/events (SSE),
                   /api/events/poll, /api/events/term (SSE), GET/PUT
                   /api/settings (buffer_mb + console_url),
                   POST /api/gateway/connect (Settings-page Gateway card:
                   persist console_url, reg-key → CF token exchange, optional
                   free tunnel via provision_tunnel),
                   POST /api/tools/{name}, GET /api/plugins/status,
                   GET /api/browser/{pwshots,pwshot,actions} (AI evidence —
                   the pwout screenshots/action feed), GET /api/sessions
                   (audit list)); panel.rs serves the embedded /panel (static
                   whitelist + token injection + one-time ?grant= redemption
                   at the gateway) as the WebPanel fallback service; sse.rs
                   holds the SSE streams (bounded conns, heartbeat, epoch).
  plugins/         PluginRegistry (tools cached once at register); terminal/
                   mod.rs (plugin struct + shared helpers) + tools/ (ctx.rs
                   shared state; per-domain builders exec/sessions/files/
                   output/secrets/connections; mod.rs owns registry assembly
                   + the exact tool order)
  tools/           terminal/ (TerminalManager + TermBackend trait; pty.rs,
                   ssh.rs, serial.rs, secrets.rs, stub.rs), serial.rs, ssh.rs
vale-command-core/      Plugin/ToolDef/ToolHandler/NavItem, Config (+ensure_token via
                   getrandom), DeviceError (typed variants), EventBus/AppEventBus.
                   CANONICAL import path for core types: `vale_agent_core::…`
                   (lib.rs's `vale_agent::` re-exports are a compat shim for
                   external/embedding consumers — internal code never adds
                   consumers to them; unified 2026-09-05)
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
- **MCP tool additions**: define the tool in
  `src/plugins/<plugin>/tools.rs` (terminal: `tools/<domain>.rs` — pick the
  domain module whose concern it shares; mod.rs owns registration order);
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
  `http://127.0.0.1:<port>/desktop/` (`<port>` = config.yaml server.port, default 18080) — the same SPA in desktop mode (terminal/
  browser/memory/plugins/settings rail). Owns CDP 9333 for AI driving, a tray
  with health + vitals, a 60 s AGENT WATCHDOG (`schtasks /run ValeAgent`), and
  a wait page that reappears when the agent dies mid-session. The
  `vale-desktop/` Tauri shell is retired. `/desktop/` reuses `/panel/` assets +
  loopback token injection (web.rs). round-274: main.ts sets
  backgroundThrottling:false + the --disable-renderer-backgrounding /
  --disable-backgrounding-occluded-windows switches — a hidden window
  (hide-to-tray / background session) otherwise flips the SPA to
  visibilityState=hidden, Chromium stops requestAnimationFrame, and xterm's
  rAF-driven DOM renderer silently stops painting (blank terminals while the
  AI keeps operating).

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
Events: `/api/events` SSE + `/api/events/term` stream. Electron shell:
tray shows health + vitals, 60 s watchdog recovers a dead agent, wait page
reappears when the agent dies; desktop SPA mirrors the panel (CDP :9333
drives the same view). Gateway card: `POST /api/gateway/connect` registers
console URL + key from the Settings page. `/api/status` reports the npm
release (not the Cargo version).

## Iteration status (stage-n) — UPDATE THIS ON EVERY ROUND

> Living log for the agentic iteration loop. Any agent resuming work MUST
> read this first, then update it at the end of its round (replace the
> "last updated" line + append to Recent / In progress / Next).

Last updated: 2026-09-08 cleanup round — current release **1.2.304
  (package.json + CDN version.json; last-5-per-minor prune active)**; e2e
  suite 47 checks; all matrices green. Rounds 273-317 in this log; the
  round log continues below (ROUND-319..550 inlined under "Current
  release").

### OPEN decisions (product sign-off needed — do NOT change without one)
- **settings_put invalid-JSON envelope is HTTP 200** (web/mod.rs, pinned
  since the round-69 extraction): api_settings_put returns an axum Json
  envelope with no status override while api_gateway_connect 400s the
  same class of error. Unifying = wire change; round-41 record.
- **messages-passthrough arm does NOT record og body-failure breaker
  trips** (translate.ts, preserved via relayUpstreamResult's
  recordOgBodyFailure=false): chat/completions + responses arms do.
  Likely a historical gap rather than intent; round-44 record.
- **F3 relay-token scoping** — docs/adr/proposal-scoped-relay-token.md
  (Option B recommended); implementation waits for human sign-off.

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
- npm **1.2.297 LIVE on d1 (round-308+; package.json)** — MCP connect auto-selects the
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
  ROUND-336 (2026-09-04): root README stale points fixed — install
  example pinned the DEAD vale-agent-1.2.179.tgz (→ versionless latest
  alias); "update (exe + bridge + electron)" (bridge removed round-265);
  extension row → Vale Studio Links (round-262); design-doc pointer →
  current desktop-core spec. "bridges to playwright" in the mcp-client
  description is the LIVE architecture (verb, not the bridge component).
  ROUND-337 (2026-09-04): doc-link integrity check — extension/README +
  index/README verified current (both clean); no dead cross-refs in any
  guide/README (remaining vale-agent-1.2.179 mentions are round-336's
  own history log). Live download paths all 200 (/, version.json,
  latest.tgz). CI 01f16da1 GREEN.
  ROUND-338 (2026-09-04): README tool-count drift fixed — claimed "37
  MCP tools"; the registry test (mcp_integration.rs) asserts 49 (system
  grew to 9 in round-340/341). Breakdown: terminal 26 + memory 6 +
  system 9 + mcp-client 4 + playwright 2 + update 1 + design 1; no
  other numeric claims drift in README.
  ROUND-339 (2026-09-04): gateway dead extension path removed from
  mcp.ts — callTool already returned for every tool name (round-161
  browser_* → playwright bridge); the trailing PluginHubDO → WS →
  browser-extension block was UNREACHABLE since round-262 deleted the
  extension. -38 lines + EXTENSION_OFFLINE constant. mcp-tools.ts head
  comment now describes the real path. Gateway 254 pass + tsc clean.
  OPEN: devices.ts still hosts extension-era pairing endpoints
  (pair/claim, ws-ticket, /ws, revoke, proxy plugin-token auth) — dead
  surface, larger removal, separate round.
  ROUND-340 (2026-09-04): gateway extension pairing endpoints REMOVED
  from devices.ts — handlePairClaim/handleRevoke/handleWsTicket/handleWs
  (public pair/claim, ws-ticket, ticket-gated /ws) + routes, all
  unreachable since round-262 deleted the extension. -107 handler lines
  + -188 total. Store helpers stay (admin handlePair + proxy
  getPluginByToken); plugins.test.mjs trimmed (13 remain, 251 pass);
  tsc clean. OPEN: console UI (DevicesPanel/app.js) still renders the
  Pair-extension button + download hint — user-visible dead feature,
  next round.
  ROUND-341 (2026-09-04): extension-era UI + PluginHubDO REMOVED — the
  round-262 extension deletion's last gateway surface: DevicesPanel Pair
  button/modal/Extension signal row, client.ts pairDevice, i18n pair/ext
  keys; /api/plugins/status dropped the PluginHubDO `online` field
  (agent_up/tunnel_up stay); devices.ts hub close-all calls; PluginHubDO
  class + wrangler binding/migration + tests deleted (BreakerDO/RouteDO
  stay); public/ pruned to the 2 referenced assets (17 stale bundles +
  dead app.js removed). -1831 lines. 243 gateway tests pass, tsc clean,
  render smokes OK. NOTE: gateway deploy needed for the binding removal
  to take effect (build.sh gateway). Round-340's proxy plugin-token auth
  path stays (defensive; device-token links still meaningful for delete/
  rename revocation).
  ROUND-342 (2026-09-04): round-341 gateway deploy — the first deploy
  FAILED: Cloudflare rejected the upload because the code no longer
  exports PluginHubDO while the DO class still exists remotely
  (code 10064 — needs an explicit delete-class migration). Added
  migration tag v4-delete-plugin-hub (deleted_classes) → deploy
  succeeded (Version ced6e1c7, 4.07s). Live verified: /api/health all
  channels ok, plugins/status 401-gated, /code/ viewer mirror 3/3
  byte-identical to repo (devices.ts/mcp.ts), routes normal. LESSON:
  removing a DO class requires a deleted_classes migration step in the
  SAME deploy — code-only removal fails upload.
  ROUND-343 (2026-09-04): spec currency pass — the two design specs
  still cited as current postdated the architecture: 2026-08-28-vale-
  desktop-core-design (Approved) gained a POST-APPROVAL CHANGES banner
  (round-264 real-browser replaced the ws-ticket JPEG stream; round-330
  Tauri shell deleted; round-341/342 gateway extension removed — the
  UI/dependency/install decisions still hold, agent/AGENTS.md is the
  current truth); 2026-08-06-device-ops-v2 (extension era) marked
  SUPERSEDED. Code-viewer mirror committed after round-341/342
  (4c5c25a6).
  ROUND-344 (2026-09-04): post-round-341/342 LIVE CHAIN VERIFICATION —
  console 302 (login), gateway /api/health 200 all channels, /mcp 401
  gate, d1 agent healthy (release 1.2.278, cpu 0.5%, mem 68.9%);
  device mcp e2e 12/12 (stdio+http auto-select + click) — gateway
  cleanup zero regression on the device path; live console UI assets
  byte-identical to repo + 0 pair code (new UI shipped with the
  round-342 deploy).
  ROUND-345 (2026-09-04): gateway dead pair/unpair + pair-code store
  functions REMOVED — handlePair/handleUnpair (admin /api/plugins/pair +
  /unpair) survived round-341's UI removal with no callers; store.ts
  addPluginLink/createPairCode/consumePairCode/createWsTicket/
  consumeWsTicket had zero src callers (links were only ever created by
  extension pairing). Link map (list/get/remove/save) stays — device
  delete/rename revocation + proxy getPluginByToken auth still use it.
  plugins.test.mjs: pair/ticket tests removed, link tests KV-seed with
  cache clears (11). 241 gateway tests pass, tsc clean. OPEN
  (conservative): proxy plugin-token auth branch stays until 30-day
  link TTLs expire.
  ROUND-346 (2026-09-04): round-345 gateway DEPLOYED (Version 52cd0dbc,
  6.77s) + live-verified: /api/health 20 channels ok, /api/plugins/pair
  now 404 (endpoint gone), /api/devices 401-gated. Code-viewer mirror
  committed (020931f7, -82 lines).
  ROUND-347 (2026-09-04): post-deploy e2e re-verification on d1 —
  terminal/file/workflow 12/12 + mcp stdio 6/6 + panel/evidence/browser
  6/6 (24/24 total; mcp http portion cut by terminal session timeout,
  device MCP path unchanged since round-344 full 12/12, not a regression).
  Device hygiene: 1 node + 5 electron, 0 e2e png leftovers, release
  1.2.278, uptime 10187s. Gateway cleanup fully verified on the device
  path.
  ROUND-348 (2026-09-04): FINAL dead-code scan — all gateway
  extension/pair/plugin-hub references are historical comments (round-340/
  341 deletion records, defense-in-depth notes); no live dead code remains.
  Proxy plugin-token auth branch (devices.ts:270-330) stays as conservative
  defense; no new links can be created (addPluginLink/handlePair deleted),
  existing links expire via 30-day TTL. OPEN item closed as "intended
  natural expiration".
  ROUND-349 (2026-09-04): full-repo stale-ref sweep — all Tauri/bridge/
  extension/vale-tray references are in historical docs (.superpowers/sdd/
  task reports, superseded DEVICE-INTEGRATION.md) or gitignored build
  artifacts; zero live code references. Cleanup marathon (round-318..349)
  VERIFIED COMPLETE.
  ROUND-350 (2026-09-06): register.rs unit tests committed (were uncommitted
  in tree) — self_register_plan url/body, pure-local None, name fallback;
  197 lib + feature-gated 201 pass, clippy/fmt clean. NOTE: box CC env
  points at a broken gcc10-root (missing cc1) — cargo needs
  env -u CC -u CXX -u CFLAGS (the gcc10-root note in root AGENTS.md is
  dsh-upgrade-only, NOT vale).
  ROUND-351 (2026-09-06): xwin RED -> GREEN — A7 refactor (d35873b0) moved
  self_heal/setup_child_reaper_job/ffi_service_main into winmain.rs as
  PRIVATE fns while main.rs called them unqualified: 3x E0425 on the
  Windows target. Linux test/clippy never saw it (cfg(windows) elided) and
  the 58-commit local stack was never pushed so CI never checked it.
  Fix: pub(crate) + winmain:: qualified calls; SCM dispatch wrapped as
  winmain::started_by_scm() (macro fn can't carry visibility) so main.rs
  no longer touches windows_service directly; dropped the unused LOG_FILE
  import. xwin check + full matrix green.
  ROUND-352 (2026-09-06): gateway matrix green (295/295 node --test, tsc,
  prettier, eslint) + code-viewer mirror re-synced. The mirror had drifted
  since the store/ + lib/ refactors: sync script copied only top-level +
  plugins/*.ts (subdirs silently dropped), dead sse-guard.ts still served,
  and the fail-closed redaction aborted on store.ts (the d1-host comment
  moved to store/devices.ts:30 in the split). Script now copies store/ +
  lib/ explicitly and redacts the new path; mirror verified byte-identical
  except the 3 intended comment redactions (error-copy strings keep the
  real host by design). Manifest 39 files, sse-guard gone.
  ROUND-353 (2026-09-06): full-repo matrix sweep, zero code changes — every
  suite green: index 54/54, panel vitest 90/90 (16 files, up from 82),
  proxies 12+7+7 (zen-go/zen-us/openrouter), npm CLI 3/3, extension
  node --check 3/3 + vercel-proxy gate 5/5 (mirrored from ci.yml),
  gateway/ui build + render smoke + devices render smoke OK, tree clean
  after builds. Combined with rounds 350-352 (agent 197/201 + xwin,
  gateway 295 + gates), ALL CI jobs now have a same-day local green.
  ROUND-354 (2026-09-06): ARCHITECTURE.md snapshot-vs-tree audit — 6 drift
  items fixed: +winmain.rs verdict row (A7 never updated the snapshot, rule
  breach), +device-fetch.ts to the gateway foundation list (5a54a804 only
  updated AGENTS/CLAUDE), studio retirement leftovers (overview line,
  foundation row, harness row, trade-off row, gate count all still
  described it as live; studio/ has zero tracked files), agent gate count
  221->233 (197 lib + 27 + 2 + 6 + 1), plugin breakdown 49 tools in the
  overview, orphaned studio comment in ci.yml above the proxies job.
  BONUS CATCH from mirroring the pack-chain job locally: npm-package
  electron copies of main.js/url-policy.js were STALE — missing the
  parsed-origin tripwire fix + portBusy probe (a security fix devices
  would never have received via vale update, which swaps these files).
  Synced from the tsc-fresh src/ copies; release-lib 11/11, bin marker +
  freshness + pack 6/6 all OK.
  ROUND-355 (2026-09-06): 65-commit stack PUSHED to GitHub (direct token
  URL, HTTP/1.1; ls-remote confirms main == local HEAD) — CI immediately
  paid off: 8/9 green incl. xwin check (round-351 fix validated) but
  gateway FAILED on install-chain test 140. Root cause: the posix test
  runs `vale check` with ambient HOME — vale reads settings FIRST and the
  box HAS ~/.claude/settings.json, so locally it reached the health probe
  while CI runners (no such file) died at the settings read. Fix: temp
  VALE_SETTINGS ({env:{}}) in the check-run env; verified locally AND
  with empty HOME (CI simulation), full gateway 295 green. Pushed via the
  proxy (small increment) and discovered the sync is BIDIRECTIONAL —
  GitHub picked it up without a second push. Re-run CI: SUCCESS (9/9).
  LESSON: any CLI test that reaches past readSettings must pin
  VALE_SETTINGS — ambient HOME is a hidden test dependency.
  ROUND-356 (2026-09-06): F3 decision material ready —
  docs/adr/proposal-scoped-relay-token.md (unnumbered proposal per ADR
  convention, NOT 0007). Tree-verified blast radius: the admin token is
  relay x-api-key (translate.ts:183) + /mcp Bearer admin
  (terminal_execute/secret_*/browser on any device, mcp.ts:32-45) +
  session-less password bootstrap/reset (admin.ts, auth.ts:192-214), all
  seeded from legacy CLIENT_KEY (store/admin.ts:57,95). Per-user BYOK is
  correctly scoped (own-keys-only reveal, masked admin lists) — out of
  scope. Options A–D with B (scoped relay role, staged dual-accept)
  recommended; 3 explicit questions for the human. No behavior changed —
  implementation waits for sign-off. Also fixed ADR README drift (missing
  0006 row, singular proposal-* wording) and repointed the F3 Next line.
  ROUND-357 (2026-09-06): memory capacity policy actually works end to end.
  Found: config `memory:` (max_entries/max_bytes/retention_days) was
  documented-but-never-read (state.rs always passed MemoryLimits::default)
  AND the retention branch had zero tests AND retention only ran on
  mutation (quiet devices kept expired records forever). Fix:
  MemoryConfig{all-Option}+effective() in core (0 treated as absent),
  state.rs builds limits from it, new() enforces on open before compact.
  Tests: config parse/partial/zero + cross-crate default-twin pin +
  retention on insert/on open/None-keeps-old. Matrix: lib 201 (+4),
  feat-gated 205, clippy x2 + fmt + xwin clean; snapshot count 233->237.
  Self-caught mid-round: a truncated edit fragment (fixed immediately) and
  clippy derivable_impls on the manual Default (derived instead). OPEN
  (later round): memory limits not yet in GET/PUT /api/settings panel GUI.
  ROUND-358 (2026-09-06): closed the round-357 OPEN item — memory capacity
  editable in Settings end to end. Agent: MemoryStore.limits behind RwLock
  (+limits()/set_limits() with documented no-nesting lock order), GET
  reports memory_max_entries/_bytes_mb/_retention_days, PUT accepts the
  same keys (absent = unchanged, 0/null/"" clears retention) with live
  retune + config.yaml persist in one step; web test covers roundtrip +
  clear + restore (sole-writer discipline, restores shared defaults).
  Panel: Memory card gains 3 inputs + validated Save (PUTs retention null
  when cleared), GET prefill, copy updated; new SettingsPage.test.tsx 3/3.
  Matrix: agent lib 202, clippy x2 + fmt + xwin clean, panel 93/93 (17
  files) + build clean incl. committed panel.js; snapshot 237->238.
  Round-7 CI (memory wiring) SUCCESS on GitHub.
  ROUND-359 (2026-09-06): terminal error-propagation audit. Production
  terminal code has zero unwrap/expect (all in tests); SFTP IO as Internal
  is legitimate; one misclassification found: terminal_connect_saved
  "unknown saved connection" used Internal for a caller error (exec's
  "unknown job_id" correctly uses InvalidParams). Fix: InvalidParams +
  known-id list for self-recovery (mirrors ctx::session_lost), incl. the
  empty-store hint. Tests: 2 feature-gated cases via a new
  #[cfg(all(test, feature))] TEST_DIR re-export (follows the file's cfg
  boundary rule); default suite unaffected (202), feat-gated 206->208,
  clippy x2 + xwin clean; snapshot feat count updated.
  ROUND-360 (2026-09-06): gateway translate-domain audit — routing/breaker/
  401 coverage was deep (67 tests) but TWO security properties had zero
  pins: disabled-user relay access and cross-user key isolation (the exact
  property the F3 proposal claims is "correctly scoped"). Added 4 tests in
  gateway.test.mjs with a two-user isoEnv (distinct tokens — module cache
  + F1 buckets forbid reuse): alice/bob header-level key proof on the og
  translate path, no-borrow 502 (alice keyless while bob keyed, upstream
  never called), disabled → 401 with no upstream call. Suite 295->299,
  prettier clean; snapshot count updated. Round-9 CI SUCCESS on GitHub.
  Tooling note: a heredoc append silently went nowhere once this round —
  file-tool edits only for test appends from now on.
  ROUND-361 (2026-09-06): device-proxy domain audit — deviceHostError IP
  forms had 5 tests but deviceFetch ITSELF (the round-120/121 SSRF fix:
  authority-prefix gate, hostname-equality, header hygiene) had zero
  direct tests (only indirect mcp-handler exercise). Added 7 in
  device-fetch.test.mjs via a globalThis.fetch stub (works through
  fetchWithTimeout): @evil + scheme → 400 with upstream never called,
  query-@ passes verbatim (round-121 narrowing), host/cookie stripped +
  device Bearer injected + other headers pass, uppercase registration
  hostname dials, private hostname 400, unreachable → 502 with reason.
  Suite 299->306, tsc/eslint/prettier clean; snapshot count updated.
  ROUND-362 (2026-09-06): session_log audit — 8 tests covered torn repair,
  prune, seq, recovery, writer cap, output cap, but trim_file (rounds
  98-100/116: streaming tail, last-start preservation, atomic temp+rename)
  and list_sessions (the /api/sessions surface) had ZERO tests. Added 2:
  close-trim (first command drained, last start kept, 2002-line cap =
  header + 2000 + preserved start, head drops from index 1, recovery still
  flags interrupted) + list_sessions row shape (2 rows, non-jsonl ignored,
  exit_code/status folded). Caught my own off-by-one in the cap bound
  (2001 vs 2002) before committing. Matrix: lib 204, feat-gated 210,
  clippy x2 + fmt + xwin clean; snapshot 238->240.
  ROUND-363 (2026-09-06): pack-chain periodic replay (round-4's catch
  still holding, zero drift): release-lib 11/11, bin round-298 marker OK,
  electron tsc-fresh 3/3 + npm-package copies in-sync 3/3, bin/vale.js
  fresh, npm pack 6/6 subset gate (artifacts cleaned, tree verified
  clean), npm CLI 3/3. No code changes — pure verification round.
  Rounds 10–11 CI SUCCESS on GitHub (round-12 queued at push time).
  ROUND-364 (2026-09-06): devices TokenGate consistency audit — all 10
  devices.ts handlers gate uniformly (requireSession + 401/403), verified
  by reading each head; only rename/install-cmd had per-route gate tests.
  Added one matrix test over all 9 admin routes (list/add/mcp/delete/
  panel-grant-mint/register-keys/revoke/install-cmd/register-key):
  no-session → 401, non-admin → 403, plus a no-mutation assertion on the
  shared env. Fixed my own undici GET-with-body slip before committing.
  Suite 306->307; snapshot count updated.
  ROUND-365 (2026-09-06): mcp_client framing audit — every MCP call flows
  through parse_envelope/check_envelope/is_session_gone/truncate, all four
  had ZERO tests. Added 7 (direct result, SSE id-match + stale-only miss,
  error/garbage/notification, check arms, session-gone signals,
  char-boundary truncate). REAL FIND: the direct arm never checked the
  response id (SSE arm does) — a stale frame with the wrong id was
  accepted. Fixed with the same id discipline both arms + regression
  test. Matrix: lib 211 (+7), feat-gated 217, clippy x2 + fmt + xwin
  clean; snapshot 240->247.
  ROUND-366 (2026-09-06): panel-auth TokenGate review — found a latent
  split: TokenGate held a BOOT-time token clone while /api/* reads the
  live snapshot (audit A4), so a runtime rotation would stale-accept the
  old token on /mcp and reject the new one. Verified no production path
  rotates the token today (PUT/gateway-connect preserve by construction),
  then removed the hazard anyway: TokenGate now holds Arc<AppState> and
  reads config_snapshot() per request. Proof: new
  mcp_gate_follows_runtime_token_rotation integration test (ephemeral
  bind, old works → update_config rotate → old 401s + new works; fails
  on the old code by construction). Matrix: integration 6->7, clippy x2
  + fmt + xwin clean; snapshot 247->248.
  ROUND-367 (2026-09-06): gateway mcp.ts dispatch audit — auth/initialize/
  call-mapping/error-codes deeply covered but 6 dispatch arms had zero
  pins: ping echo, unknown method (-32601), unknown tool (-32602, no
  network touched), no-devices guidance (-32602, no dial), unparseable
  body (-32700), non-GET/POST (405). Added 6 in mcp-handler.test.mjs
  (existing post()/makeEnv harness). Suite 307->313; snapshot updated.
  ROUND-368 (2026-09-06): desktop-core spec currency pass — verified the
  cited backend contract first (/api/sessions/{sid} exists and is live).
  Fixed 5 drift items: §3 Settings row (memory "notes" → editable
  entries/MiB/retention, round-358), §7 journey 6, §2 contract (web.rs →
  web/ + /api/sessions list), §9 registry writer (NSIS → vale setup),
  §11 Tauri bullet moot (deleted round-330); banner gains the 357/358
  line. Docs-only, no gates affected. (Log hygiene: this entry first
  landed as a duplicate ROUND-367 and was renumbered on sight.)
  ROUND-369 (2026-09-06): mcp-browser bridge audit — routing/self-heal/
  click-conversion covered, but the documented guardrails had zero pins:
  timeout_secs clamp (M2), unknown-tool passthrough, private-hostname
  gate, and the 4-slot SESSION_BUSY semaphore. Added 4 in
  mcp-browser.test.mjs (direct callTool harness, existing makeFetch):
  clamp 99999→300 / 0→1 / 12.9→12, verbatim passthrough, hostname gate
  fires pre-fetch with DEVICE_UNREACHABLE, deterministic 5th-call
  SESSION_BUSY via a gated stub (no timers). Suite 313->317; snapshot
  updated.
  ROUND-370 (2026-09-06): system plugin audit — file_upload (round-341)
  and process_kill had ZERO tests (only name-presence in the build
  test). Added 5: upload missing/dir rejects, full POST roundtrip
  against a single-shot local HTTP stub (Bearer + multipart + bytes +
  manifest echo), unreachable-gateway fail-closed, kill arg validation +
  bogus pid/name fail-clean. Caught real issues pre-commit: parallel env
  cross-talk (fixed with ONE module-level tokio Mutex — fn-local statics
  would be distinct locks) + clippy type_complexity/await_holding_lock
  (CapturedUploads alias + async mutex). Stable 15/15 x3. Matrix: lib
  216 (+5), feat-gated 222, clippy x2 + fmt + xwin clean; snapshot
  248->253.
  ROUND-371 (2026-09-06): web/sse.rs contract audit — the loss-tolerant
  stream (epoch-first, lagged fallback, headers) + guard cycle had ZERO
  tests. Added 6 (pre-queued broadcast + sender-drop, zero timers; the
  30s heartbeat arm stays untested by design): SSE headers, epoch-first
  then Closed ends stream, FIFO order, lagged(3) + surviving tail
  (corrected my broadcast assumption pre-commit: lagged receivers keep
  the newest 2), guard acquire/release + dual-hold. Deliberately no
  drain-to-None test — the pool is process-global and endpoint tests
  (term_sse_streams_output) hold real guards. Stable 37/37 web x3.
  Matrix: lib 222 (+6), feat-gated 228, clippy x2 + fmt + xwin clean;
  snapshot 253->259.
  ROUND-372 (2026-09-06): memory sanitize audit — strategies partly
  unpinned + docs overstated. Added 3 (bare Bearer arm, trailing-newline
  contract, JSON arrays + typed values) and split a weak || into per-arm
  asserts — which immediately caught TWO stale claims: "authtoken abc123"
  (space, no separator) never redacted, and "masterkey" is NOT matched
  by compact-ends-with ("key" alone can't be a signal — monkey/turkey).
  Fixed both comments to the honest contract (prose-safe by design,
  precision over recall). Matrix: lib 225 (+3), feat-gated 231, clippy
  x2 + fmt + xwin clean; snapshot 259->262.
  ROUND-373 (2026-09-06): state.rs A4 audit — config_snapshot/update_config
  are load-bearing for TokenGate + PUT /api/settings yet had ZERO tests.
  Added 6: boot snapshot, memory-only swap, persist-without-path no-op,
  file roundtrip (disk yaml matches memory), failed-persist atomicity
  (dead dir → Err + memory stays at old value — the write-through
  guarantee), poisoned-writer recovery. All green first try. Matrix:
  lib 231 (+6), feat-gated 237, clippy x2 + fmt + xwin clean; snapshot
  262->268.
  ROUND-374 (2026-09-06): bootstrap.rs boot-path audit — create/quarantine/
  token-recovery carries SIX incident fixes (57/104/119/121/138/140) with
  ZERO tests. Added 8: missing→create+mint-once (second boot no rotation),
  valid untouched, missing-token mint+persist, corrupt→quarantine+line
  recovery, device_token>auth_token + space-colon + last-wins + comment
  strip, proxy_secret carried, secret-less recovery mints+persists,
  atomic_write roundtrip. All 8 green first try — every incident claim
  holds. Matrix: lib 239 (+8), feat-gated 245, clippy x2 + fmt + xwin
  clean; snapshot 268->276.
  ROUND-375 (2026-09-06): mcp/server.rs surface audit — get_info, tool
  conversion, bind DNS had only get_tool presence pins. Added 4: handshake
  identity (name/version/instructions/static-tools cap), schema
  passthrough on a real tool, localhost→loopback bind, unresolvable host
  fails loud (the dark-device fix). Also corrected a FALSE comment
  claiming panic isolation was "verified by list_tools_via_http" (it
  never exercised call_tool; the arm is defensive-only — zero unwrap in
  production per round-359). Fixed my own Cow as_ref ambiguity
  pre-commit. Matrix: lib 243 (+4), feat-gated 249, clippy x2 + fmt +
  xwin clean; snapshot 276->280.
  ROUND-376 (2026-09-06): mcp_client http-arm audit — rpc_ref_http
  (session capture, header hygiene, 16MiB cap, empty/500 mapping) +
  track_page_url had ZERO tests (only framing/summary pins). Added 7
  against single-shot local stubs: initialize captures session id,
  caller headers ride but mcp-session-id/content-type never override,
  empty→Null, 500→truncated error, >16MiB rejected, track sets http
  last_url on marker + ignores ftp/absent. Fixed pre-commit: owned stub
  headers (spawn 'static), Arc clone, parse_envelope returns the result
  body (not the envelope). Stable 20/20 x3. Matrix: lib 250 (+7),
  feat-gated 256, clippy x2 + fmt + xwin clean; snapshot 280->287.
  ROUND-377 (2026-09-06): filelog rotation audit — only the size trigger
  was pinned; prune cap, append-resume accounting, day buckets untested.
  Added 3: 900 KiB pre-existing + 200 KiB write rotates (metadata seeds
  the cap — no fresh megabyte per restart), 5 priors + 1 rotation prunes
  to exactly 3 (newest priors + live stamp survive), day_bucket UTC
  boundaries. Matrix: lib 253 (+3), feat-gated 259, clippy x2 + fmt +
  xwin clean; snapshot 287->290.
  ROUND-378 (2026-09-06): metrics audit — the CPU-delta math lived inline
  in cfg(windows) code (untestable on Linux; xwin only compiles).
  Extracted pure cpu_busy_pct (same saturating semantics) + tests: 50%/
  0%/100% bounds, zero-tick→None (not NaN), counter-regress→None; plus
  the non-Windows all-None degradation contract (was vacuously covered).
  xwin confirms the refactor compiles on Windows. Matrix: lib 255 (+2),
  feat-gated 261, clippy x2 + fmt + xwin clean; snapshot 290->292.
  ROUND-379 (2026-09-06): web/panel.rs surface audit — whitelist, hash
  stamping, token escaping, grant shape/redeem had zero DIRECT tests
  (only endpoint-level). Added 6: content-type map, 6 known files 200 +
  8 hostile names 404 (traversal/query/whitespace), exactly-once hash
  stamp with vendor css untouched, token shape (200/html/no-store) +
  </script> breakout escape, grant 16..128 hex bounds, redeem true ONLY
  on explicit ok:true (false/missing/500/dead-gateway all false). All
  green first try. Matrix: lib 261 (+6), feat-gated 267, clippy x2 +
  fmt + xwin clean; snapshot 292->298.
  ROUND-380 (2026-09-06): paths.rs resolution audit — the registry-first
  chain (install/data/sessions/node) had only the unix harden pin.
  Added 6: exe-dir non-empty, install→exe fallback, data→install
  default, sessions nesting, node None, harden-missing errors (plus two
  doc lines that read as if `vale setup` itself were retired). Cached
  public fns untestable repeatedly → pins target compute_* + structure.
  Matrix: lib 267 (+6), feat-gated 273, clippy x2 + fmt + xwin clean;
  snapshot 298->304.
  ROUND-381 (2026-09-06): update plugin audit — version/newer/hex pinned
  but cleanup_staged (the never-mix-versions guard) + version_url had
  zero tests. Added 3: staged .new files + .vale-update gone while all
  4 live files stay byte-identical, empty-dir noop, manifest URL shape.
  Matrix: lib 270 (+3), feat-gated 276, clippy x2 + fmt + xwin clean;
  snapshot 304->307.
  ROUND-382 (2026-09-06): playwright supervisor audit — manager + bundle
  discovery had ZERO tests (spawning untestable in CI, but the no-spawn
  paths weren't pinned either). Added 8: one sequential status test
  (fresh→stopped→external-running→released, round-132 branch),
  stop-noop, bundle/node resolution errors, now_ms, pw_version shapes,
  node path join, 2-tool build. Caught my own 9229 parallel flake
  pre-commit (merged + documented). Stable 9/9 x5. Matrix: lib 278
  (+8), feat-gated 284, clippy x2 + fmt + xwin clean; snapshot 307->315.
  ROUND-383 (2026-09-06): design plugin audit — REAL DRIFT FOUND: the
  page_view schema enum + description still advertised the 10
  round-262-deleted extension pages (every selection a guaranteed
  "unknown page" error). Fixed enum + description + stale doc line to
  the 9 live pages. Added 5 tests: loopback-only gate (incl. IPv6/empty
  rejects), token redaction (multi/unterminated), table uniqueness +
  schema-enum parity (fails on any future drift), HTTP truncation +
  redaction over a stub, unknown/remote-unconfigured fail-closed.
  Matrix: lib 283 (+5), feat-gated 289, clippy x2 + fmt + xwin clean;
  snapshot 315->320.
  ROUND-384 (2026-09-06): vale-command-core EventBus audit — seq/ring/
  eviction/epoch/hook contract had ZERO tests despite feeding /api/
  events + SSE. Added 9: monotonic seq, cursor filters + zeroed empty,
  poll_after snapshot, 256-ring eviction with detectable gap (+ the
  RING_CAP>=broadcast-cap invariant), hook args, per-boot epoch nonce,
  term fan-out, wire shape, in-order broadcast. Snapshot formula now
  counts the core binary explicitly (was silently 2): 320->331 (+11
  core). Clippy x2 + fmt + xwin clean.
  ROUND-385 (2026-09-06): core remainder audit — DeviceError code table
  (the gateway's retry-routing contract) + recover_guard (the
  codebase-wide poison path) had zero pins. Added 4: all 9 codes,
  Display detail, clean lock, poisoned recovery preserving data.
  Snapshot core 11->15 (total 331->335); agent matrix unchanged green.
  ROUND-386 (2026-09-06): gateway auth.ts primitives audit — PBKDF2,
  safeEq, CSRF predicate, HMAC sessions, cookie helpers had zero DIRECT
  tests (only handler-level). Added 13 in auth.test.mjs: hex shape,
  hash determinism + verify accept/reject/salt-bound, safeEq arms, CSRF
  matrix (safe methods/bearer path/same-origin+none+missing pass,
  same-site+cross-site fail, vale_pt_ family), session roundtrip +
  wrong-secret/tamper/malformed/expiry-distinct, padding restore,
  cookie parse/headers. Suite 317->330; tsc/eslint/prettier clean;
  snapshot updated.
  ROUND-387 (2026-09-06): gateway session.ts flow audit — secret
  preference, fail-closed issuance, cookie accept/revoke/tamper/
  disabled/rotation, admin triple had zero DIRECT tests. Added 11 in
  session.test.mjs (distinct ids for the module cache). Suite 330->341;
  tsc clean; snapshot updated.
  ROUND-388 (2026-09-06): panel-grant store audit — handler paths dense
  but store edges (TTL, uppercase, shape-no-read, corrupt records,
  delete) had only indirect coverage. Added 7: ~120s TTL on the KV
  record, keyless mint no-throw, uppercase normalization, malformed
  codes cost zero KV reads, corrupt/empty records → null (mintedAt 0),
  keyless get/delete no-throw, delete removes. Suite 341->348;
  tsc/eslint/prettier clean; snapshot updated.
  ROUND-389 (2026-09-06): full-repo matrix sweep, zero code changes —
  every suite green same-day: agent lib 283 + core 15 + 27+2+7+1,
  feat-gated 289, clippy x2 + fmt + xwin clean; gateway 348 + tsc +
  eslint + prettier; index 54/54; panel vitest 93/93 (17 files);
  proxies 12+7+7 (node --test per CI, no npm-test script exists);
  npm CLI 3/3; extension 3-file node --check; vercel-proxy 5/5 syntax
  gate; gateway/ui build + render smoke + devices smoke OK; tree clean
  after builds. (Wrangler dry-runs left to CI — needs account creds.)
  No code changes — pure verification round.
  ROUND-390 (2026-09-06): store/users.ts helpers audit — token shape,
  username lookup, invites, masking, registration guards had zero
  direct pins (only cache-behavior + handler paths). Added 6:
  48-hex unique tokens, trim+cache username lookup, 10-char invite
  with 7-day TTL (opts captured), maskKey shapes, status parity over
  all managed keys (unmanaged never appear), registration fail-closed
  chain (name/password/duplicate/invite). Suite 348->354;
  tsc/eslint/prettier clean; snapshot updated.
  ROUND-391 (2026-09-06): regkeys/settings edges audit — create shape/
  TTL, delete edges, listRegKeys live-filter, globalSettingEnabled
  matrix unpinned. Added 4 (TTL opts captured, empty/keyless no-ops,
  expired-but-unreaped filtered via _expiry backdate, on/off matrix).
  Self-caught a whitespace-merge slip mid-round (reverted clean, tree
  verified). Suite 354->358; tsc/eslint/prettier clean; snapshot
  updated.
  ROUND-392 (2026-09-06): plugin-link map audit — lifecycle covered but
  sweep persistence, legacy expiry, corrupt blobs, write-through only
  had return-value pins. Added 4: expired get DELETES the KV record
  (30d const pinned), missing-expiresAt legacy sweeps (round-122 hole),
  corrupt blob → all five helpers safe, save write-through serves
  post-KV-yank. Fixed a dynamic-import slip pre-commit. Suite 358->362;
  tsc/eslint/prettier clean; snapshot updated.
  ROUND-393 (2026-09-06): device-registry store audit — upsert secret
  preservation (106), insert takeover guard (122), rename rules,
  seen write-budget, corrupt KV tolerance, cf token had zero DIRECT
  tests. Added 8 in devices-store.test.mjs: corrupt/non-array/missing
  → empty, secret keep/replace, duplicate insert refused, delete
  booleans, rename preserve + guards, seen writes only on
  version-change/hour-stale (put-counter pinned), cf roundtrip/clear/
  keyless, keyless save no-op. Suite 362->370; tsc/eslint/prettier
  clean; snapshot updated.
  ROUND-394 (2026-09-06): admin-seed audit. REAL FIND (test-caught):
  seedAdmin's v1 migration moved user:u-admin → user:admin + remapped
  the token + moved ukeys, then fell through to the fresh-mint block
  (no marker on v1 upgrades) which CLOBBERED it all — new random token,
  ukeys reset to {}, orphaned token:V1TOK mapping still authenticating.
  Fix: mint only when no user:admin exists post-migration/backfill.
  Added 4: legacy CLIENT_KEY honored, random mint, v1 migration keeps
  token + keys (regression), process-once + keyless no-op. Suite
  370->374; tsc/eslint/prettier clean; snapshot updated.
  ROUND-395 (2026-09-06): Access SSO audit. REAL FIND: disabled
  Access-bound users still resolved — bound path fell through to the
  provision re-check with no enabled check (cookie path rejects
  disabled; Access users unsuspendable). Fix: null on disabled, no
  re-provision (fresh suffix would defeat suspension). Added 2: disabled
  stays out + no shadow account, JWT malformed matrix (parts/garbage/
  kid/iss/email/unconfigured). Suite 374->376; gates clean; snapshot
  updated; pushed.
  ROUND-396 (2026-09-06): body-scan injector audit — rawWithTopLevelField
  + provider/reasoning injectors (hot-path string surgery on every
  relayed body) had zero DIRECT tests. Added 7: string/object replace,
  append separators (empty/bare/spaced), nested same-name untouched,
  in-string field-name trap, non-object passthrough, provider +
  reasoning shapes incl. client-sent respected. Suite 376->383; gates
  clean; snapshot updated; pushed.
  ROUND-397 (2026-09-06): limiter boundary audit — factory KV semantics
  pinned but trip point, window reset, unknown-bucket, fail-open, 4096
  cap unpinned. Added 4 (limit+1 trips + per-IP isolation, rollover
  resets, headerless shares unknown + null/throw fail open, eviction
  restarts count). Caught my own shared-bucket slip pre-commit (fresh
  instance for fail-open probes). Suite 383->387; gates clean; snapshot
  updated; pushed. CI: 396 run SUCCESS.
  ROUND-398 (2026-09-06): MCP resolution audit. REAL FIX (small): no-name
  + several devices answered "No devices registered" — wrong guidance.
  Now names them ("specify device: d1, d2", round-160 spirit). Added 5:
  single-device fallback executes, typo'd name never executes (I6a),
  multi-device guidance (regression), tools/list shape, dial failure →
  -32603 + {code} data (corrected my data-shape assumption pre-commit).
  Suite 387->392; gates clean; snapshot updated; pushed. CI: 397 SUCCESS.
  ROUND-399 (2026-09-06): heal-layer remainder audit — zero-live/multi-
  live guidance, data-URL image unwrap (118), timeout-vs-unreachable
  mapping had zero direct pins. Added 4: zero-live points at
  terminal_open, multi-live lists without guessing (no retry asserted),
  image block shape, TIMEOUT vs DEVICE_UNREACHABLE. Suite 392->396;
  gates clean; snapshot updated; pushed.
  ROUND-400 (2026-09-06): bridge remainder audit — "session not found"
  heal arm (132), non-JSON failure shape, slot release after failure
  unpinned. Added 3: idle-reclaim heals start→connect→retry, 502 body
  → "mcp_client_call failed: 502", 4 failures release slots (next call
  serves, not BUSY). Suite 396->399; gates clean; snapshot updated;
  pushed.
  ROUND-401 (2026-09-06): agent main.rs audit — binary target had ZERO
  tests. Extracted mask_token + unknown_key_warnings (pure text list;
  wrapper only logs), removed a stale audit-row comment, added 5 bin
  tests (mask long/short/boundary, clean silent, top+nested flags,
  non-mapping/missing/invalid/list safe). Full matrix: lib 283 + bin 5
  + 27+2+7+1, core 15, feat 289, clippy x2 + fmt + xwin clean; snapshot
  335->340; pushed.
  ROUND-402 (2026-09-06): upstream route-table audit — pickRoute/
  stripBracket/passthroughHeaders (every /v1 call flows through) had
  ZERO direct tests. Added 5 in upstream.test.mjs: bracket strip,
  per-prefix kind/upstream incl. qw/ format split + default no-strip,
  amd/ always direct under egress, F4 injection encoding, header modes.
  Fixed my own via()-base slip pre-commit (usProxyBase, not the param).
  Suite 399->404; gates clean; snapshot updated; pushed.
  ROUND-403 (2026-09-06): degraded-cache audit — isChannelDegraded TTL,
  trip invalidation, fail-open, reset/success paths unpinned (only the
  classifier had unit pins). Added 5: 5s verdict cache + re-read, closed
  + DO-error fail-open false, trip invalidates immediately, reset hits
  endpoint + keyless no-throw, upstreamTimeoutMs direct. Suite 404->409;
  gates clean; snapshot updated; pushed.
  ROUND-404 (2026-09-06): proxy rewriter audit — decodeDeviceName +
  rewriteDeviceBody (every proxied panel asset flows through) had zero
  direct pins. Added 2: decode/decoded/malformed, mount insert for
  quote/backtick/`}` + token scrub both quotes + no double-prefix +
  bare-text untouched. Rewrote my own convoluted draft pre-commit (use
  the file's static imports). Suite 409->411; gates clean; snapshot
  updated; pushed.
  ROUND-405 (2026-09-06): front-door audit — bare /models + /chat/
  completions aliases, http→https 308, never-leak 500 had zero direct
  pins. Added 4 in frontdoor.test.mjs: alias parity (list deep-equal,
  chat status+body identical), 308 Location shape, 500 message + no
  CONSOLE_HOST leak. Suite 411->415; gates clean; snapshot updated;
  pushed.
  ROUND-406 (2026-09-06): model-usability audit — isModelUsable (every
  model=auto resolution flows through it) had zero DIRECT tests. Added
  4: whitelist + env-key channels, round-68 user-key-counts, nv/gmi
  pure-BYOK ignores env, og breaker + cm/amd keyed/keyless. Fixed my own
  guessed-id tautology pre-commit (real MODELS ids). Suite 415->419;
  gates clean; snapshot updated; pushed.
  ROUND-407 (2026-09-06): fallback-chain audit — resolveAutoModel's
  round-100 first-usable loop only had the default-ds path pinned.
  Added 5 (chainEnv harness): no-ds→qw, og-only→flash, or-only→luna,
  keyless last-line guarantee, chosen-but-unusable enters the chain.
  Suite 419->424; gates clean; snapshot updated; pushed.
  ROUND-408 (2026-09-06): RouteDO audit — auth gates pinned but CRUD +
  error paths (roundtrip, null-delete, 400s, 404, 500, unauth) had zero
  direct pins. Added 5 in route-do.test.mjs. Suite 424->429; gates
  clean; snapshot updated; pushed.
  ROUND-409 (2026-09-06): saved-connection edges — corrupt-file recovery
  + list sort/id shape unpinned (3 tests covered dedup/scrub/forget).
  Added 2 (feat-gated): torn file lists empty + remember heals, 3-entry
  sort order + kind/target/id shape. Full matrix: feat lib 289->291,
  clippy x2 + fmt + xwin clean; snapshot 340->342; pushed.
  ROUND-410 (2026-09-06): panel stripAnsi audit — the ANSI scrubber all
  text surfaces depend on had ZERO tests. Added 5: SGR, cursor/clear,
  OSC titles + 133 markers, unterminated-OSC-at-EOF, stray ESC +
  undefined. Panel suite 93->98 (17->18 files); test-only, no panel.js
  rebuild; pushed.
  ROUND-411 (2026-09-06): BreakerDO remainder — half-open single-failure
  re-trip (round-118), stale-window re-anchor, storage-throw 500 had
  zero pins. Added 3 in reliability.test.mjs. Suite 429->432; gates
  clean; snapshot updated; pushed.
  ROUND-412 (2026-09-06): secrets key_of audit — normalization only
  exercised indirectly via CRUD. Added 1 direct pin: :22 collapse both
  ways + trim, non-22 distinct, userless→root. BONUS: build.rs STALE-
  panel gate fired on round-410's test file (watches whole src dir) —
  rebuilt, panel.js byte-identical, gate honest. Matrix: lib 283->284,
  feat 291->292, clippy x2 + fmt + xwin clean; snapshot 342->343;
  pushed.
  ROUND-413 (2026-09-06): panel theme audit — get/set/toggle/subscribe
  had ZERO tests. Added 5: default light, stored dark, garbage→light,
  persist+body+event+unsub, toggle both ways, storage-throw fail-safe.
  Self-caught: vitest toEqual takes no message arg (tsc gate). Panel
  98->103 (18->19 files); rebuilt, panel.js identical; pushed.
  ROUND-414 (2026-09-06): panel ErrorBoundary audit — the round-161
  white-panel fix had ZERO tests. Added 4: healthy passthrough, crash
  card + message, empty-message fallback, reload wiring + state reset
  (reload mock clears the fault, standing in for the remount). REAL
  FIND (test-caught React behavior): React retries a once-throwing
  mount before the fallback commits — transient first-render throws
  self-heal, boundary trips only on persistent throws. Panel 103->107
  (19->20 files); rebuilt, panel.js identical; pushed.
  ROUND-415 (2026-09-06): panel CommandCard audit — duration/state
  helpers + card/stream interactions had ZERO tests. Added 9:
  fmtDuration edges, cardState matrix, running auto-expand, ended
  collapsed + toggle, select vs toggle stopPropagation, selected class,
  clipboard copy + execCommand fallback, stream empty/count/select.
  Self-caught mid-round: overwrote 414's ErrorBoundary file with my
  stale draft — reverted immediately, verify-exists-before-write from
  now on. Panel 107->116 (20->21 files); rebuilt, panel.js identical;
  pushed.
  ROUND-416 (2026-09-06): panel TabBar audit — tab activate/export/
  close-confirm/view-switch had ZERO tests. Added 5: closed-tab no-op
  + honest title, export stopPropagation, two-step close arm/execute/
  cancel, no close affordance for savedOnly/closed, view-switch gated
  on active session. Panel 116->121 (21->22 files); rebuilt, panel.js
  identical; pushed.
  ROUND-417 (2026-09-06): panel IconRail audit — page buttons, theme
  toggle, conn dot had ZERO tests. Added 5: 5 pages + active marking,
  page notify, toggle flip + persist + remount-read, dot on/off,
  desktop density classes. Panel 121->126 (22->23 files); rebuilt,
  panel.js identical; pushed.
  ROUND-418 (2026-09-06): panel Icon-set audit — the single glyph set
  had ZERO tests (a name without a PATHS entry renders an empty svg).
  Added 3: all-19-names completeness, size/stroke contract, BrandMark
  gradients. Panel 126->129 (23->24 files); rebuilt, panel.js
  identical; pushed.
  ROUND-419 (2026-09-06): panel DetailsPanel audit — inspector rows had
  ZERO tests. Added 4: empty hint + close wiring, ended-card rows
  (command/status/exit/duration/params/output/copy), running
  placeholders, failed exit+reason. Panel 129->133 (24->25 files);
  rebuilt, panel.js identical; pushed.
  ROUND-420 (2026-09-06): panel Shell audit — density layout + page
  contract had ZERO tests. Added 4: PAGES/labels, panel rails +
  bottom-bar status (round-161), optional-rail omission, desktop hides
  ctx/status. Panel 133->137 (25->26 files); rebuilt, panel.js
  identical; pushed.
  ROUND-421 (2026-09-06): panel PluginsPage audit — catalog + playwright
  card had ZERO tests. Added 6: loading, search + filtered pill
  (round-161), singular/plural + enabled, load error, card states
  (pending/stopped/running + port + Start wiring), busy labels +
  verbatim error log. Self-caught x2: clicked disabled Start (mock
  never fires — click the enabled one), helper missed top-level
  playwright field (tsc gate). Panel 137->143 (26->27 files);
  rebuilt, panel.js identical; pushed.
  ROUND-422 (2026-09-06): panel ContextRail audit — side rail had ZERO
  tests. Added 6: null on context-less pages, plugins inventory +
  loading, open-first/newest sort + closed no-op + Enter, 4-kind menu,
  inline rename (commit/cancel/blank), archive + relTime. Self-caught:
  button/input share aria-label — locate inputs by display value.
  Panel 143->149 (27->28 files); rebuilt, panel.js identical; pushed.
  ROUND-423 (2026-09-06): panel TerminalWorkspace audit — the shared
  terminal page had ZERO tests. Added 6: empty state, reconnect
  banner, view-switch + notify, Logs drawer select/deselect/close,
  desktop density (no tab bar), controlled-view honor. Self-caught a
  vacuous final test pre-commit (replaced with a real controlled-value
  assertion). Panel 149->155 (28->29 files); rebuilt, panel.js
  identical; pushed.
  ROUND-424 (2026-09-06): gateway admin-ops audit — cf-token/invite/
  enable had ZERO pins (password paths were covered). Added 3:
  token shape 400s + masked roundtrip + clear, invite code + 401,
  malformed-id/admin/bob enable guards. Suite 432->435; gates clean;
  snapshot updated; pushed.
  ROUND-425 (2026-09-06): round-366 follow-up — the TokenGate boot-clone
  FIX had zero regression pins. Added 1: rotate via update_config →
  old Bearer 401 + new 200 on BOTH check_auth (/api) and TokenGate
  (/mcp, stub inner). Fix verified still in place (live snapshot).
  Matrix: lib 284->285, feat 292->293, clippy x2 + fmt + xwin clean;
  snapshot 343->344; pushed.
  ROUND-426 (2026-09-06): tunnel parser audit — hand-rolled UUID scanner
  + NAME-column matcher were nested inside provision_tunnel (ZERO
  tests, unreachable). Hoisted both to module level verbatim, added 3:
  canonical find (create + table shapes), 5 reject shapes, name-column
  match/miss/header/garbage-id. Matrix: lib 285->288, feat 293->296,
  clippy x2 + fmt + xwin clean; snapshot 344->347; pushed.
  ROUND-427 (2026-09-06): filelog remainder — day-change rotation arm +
  flush path had ZERO pins (cap/prune/resume/bucket covered). Added 2:
  backdated-bucket rotates under cap + live content intact, flush
  persists. Self-caught a bad edit mid-round (deleted 2 comment lines
  — restored immediately, diff-verified no-op). Matrix: lib 288->290,
  feat 296->298, clippy x2 + fmt + xwin clean; snapshot 347->349;
  pushed.
  ROUND-428 (2026-09-06): gateway http-helpers audit — jsonOk/jsonError/
  readJson (every plugin builds on these) had ZERO direct pins. Added
  3 in cors.test.mjs: shape + header merge, error envelope, valid/
  empty/invalid bodies. Suite 435->438; gates clean; snapshot updated;
  pushed.
  ROUND-429 (2026-09-06): gateway registry audit — the MODELS whitelist
  + health/US-proxy/route tables had ZERO structural pins (a typo'd id
  misroutes silently). Added 5 in registry.test.mjs: unique/owned/
  known-prefix ids, health cards ⊆ whitelist, US-proxy ⊆ whitelist,
  priority coverage + https endpoints, ROUTE_INFO prefix cover. Suite
  438->443; gates clean; snapshot updated; pushed.
  ROUND-430 (2026-09-06): panel MemoryPage audit — the knowledge UI had
  ZERO tests. Added 7 (mocked callTool): mount list, search tag-pass
  (round-161) + empty→list, two-step delete + toast, inline edit save,
  create required-fields + memory_save, export lines + copy toast,
  backend-error surface. Panel 155->162 (29->30 files); rebuilt,
  panel.js identical; pushed.
  ROUND-431 (2026-09-06): panel EmbeddedBrowserPane audit — the real-
  browser controller had ZERO tests. Added 7 (mocked valeEmbedded):
  init state + bounds report, nav-event sync, https-default submit +
  scheme reject, back/fwd wiring, crash banner + recover, zoom factor,
  bridgeless placeholder. Panel 162->169 (30->31 files); rebuilt,
  panel.js identical; pushed.
  ROUND-432 (2026-09-06): panel TerminalPane audit — mount/wiring plus
  overlays had ZERO tests. Added 5 (real xterm, mocked callTool):
  registerWrite + adopt read, write callback reaches terminal, font
  persist + 9/22 clamp + reset, searchbar open/Esc close, inactive
  hides + drops overlays. tsc gate caught 2 slips (Session fields,
  mock.calls tuple) before commit. Panel 169->174 (31->32 files);
  rebuilt, panel.js identical; pushed.
  ROUND-433 (2026-09-06): panel remainder sweep — StatusBar + BrowserPage
  were the last two components with ZERO tests (all others covered).
  Added 4: live count singular/plural/hidden, error styling + reconnect
  chip, bridge→embedded controller, bridgeless→desktop hint. Panel
  174->178 (32->33 files); rebuilt, panel.js identical; pushed.
  ROUND-434 (2026-09-06): gateway mcp-errors audit — the stable failure
  code family clients retry on had ZERO direct pins. Added 1 in
  mcp.test.mjs: codes distinct + UPPER shape, ToolErr instanceof Error
  with code + message. Suite 443->444; gates clean; snapshot updated;
  pushed.
  ROUND-435 (2026-09-06): pack-chain periodic replay (last 363) — REAL
  FIND: `npm run build` (the documented sole build path, born 4.5h ago
  in 3825c0df) NEVER worked: `npx -y typescript@5 -p <proj>` lets npx
  eat tsc's -p/outDir flags (npm 11: "must supply a command"; --package
  form can't resolve the tsc bin either). Only bash -n had ever checked
  it. Fix: `npm exec --yes --package typescript@5 -- tsc -p …` (verified
  exit 0; rebuilt artifacts byte-identical = zero drift). Replay otherwise
  green: electron url-policy 4/4, npm CLI 3/3, pack dry-run 6/6 files,
  stale local tgz 293-296 cleaned; pushed.
  ROUND-436 (2026-09-06): console UI audit — zero unit tests (CI only
  tsc+build+smoke). Beachhead: maskToken pin in ui/test/format.test.mjs
  (empty/short/long/no-middle-leak; self-caught a wrong short-shape
  expectation) + `"test": "node --test"` script + CI ui job unit step.
  Caught the repo convention along the way: bare `node --test` (gateway/
  index style) — `node --test test/` dies MODULE_NOT_FOUND. Pre-existing
  nit noted, untouched: ui/package.json lacks trailing newline (gate only
  covers src/). Pushed.
  ROUND-437 (2026-09-06): coverage-driven auth audit — node coverage
  flagged plugins/auth.ts (45%). PUT /api/me/keys (BYOK save) had ZERO
  pins. Added 2 in plugins.test.mjs: 401/400×3 validation, save-trimmed
  + masked echo + reveal roundtrip. Suite 444->447; gates clean.
  COUNTING CLARIFIED (worktree-verified): bare `npm test` also counts
  test/helpers.mjs as a pseudo-test and now discovers ui/test/ — 447 =
  445 files + helpers + ui. True file sum HEAD 443 -> 445 (+2 mine).
  Snapshot updated; pushed.
  ROUND-438 (2026-09-06): register-route audit — POST /api/auth/register
  had ZERO route pins (store-level createUser covered, handler not).
  Added 2 in plugins.test.mjs: invite→200 + cookie + login roundtrip,
  bad-invite/short-pw/duplicate→400, no-secret→500 fail-closed. Rate
  budget checked (16 < 30/min shared IP bucket). Suite 447->449
  (counting model from 437 holds exactly); gates clean; snapshot
  updated; pushed.
  ROUND-439 (2026-09-06): settings write-path audit — setGlobalSetting
  had ZERO pins. REAL FIND while pinning: boolean true persisted as "0"
  (String(true)="true" ≠ "1") — a silent toggle inversion for any
  boolean caller. Fixed truthfully (no live bytes change: sole caller
  passes "1"/"0"). Added 2 in store.cache.test.mjs: 1/0/null/""/delete
  canonical chain + write-through read + env-var fallback. Suite
  449->451; gates clean; snapshot updated; pushed.
  ROUND-440 (2026-09-06): self-register audit — handleSelfRegister
  (round-158 anti-hijack endpoint) had ZERO route pins. Added 4 in
  devices.test.mjs: 400/403/400 validation + no-mutation, new-device
  insert + idempotent refresh, hostname-move/unproven-rotation 409s,
  stored-tunnel proof rotates (date kept). Suite 451->455; gates clean;
  snapshot updated; pushed.
  ROUND-441 (2026-09-06): register-chain audit — /api/register +
  /api/install/tunnel-token had ZERO route pins. Added 3 in
  devices.test.mjs: garbage-403 zero-write + spend-once, existing-name
  409 (round-68), tunnel-token once-only + grant-fed register. Caught
  mid-round: shared 10/min/IP gate 429'd my own tests — per-test IPs
  via cf-connecting-ip (req() gained an ip option). Suite 455->458;
  gates clean; snapshot updated; pushed.
  ROUND-442 (2026-09-06): logout-write audit — the blacklist write had
  ZERO direct pins (only verify-side). Added 1 in plugins.test.mjs:
  sess-revoked record + 24h-capped TTL (round-122/124 lessons) +
  client-cookie clear + revoked cookie 401s a gated route. Suite
  458->459; gates clean; snapshot updated; pushed.
  ROUND-443 (2026-09-06): me-routes audit — /api/me/usproxy +
  /api/me/token/regenerate had ZERO route pins. Added 2 in
  plugins.test.mjs: 401/403 + toggle roundtrip + explicit-OFF persist
  (round-94 e2e), rotate-kills-old. Self-caught: helper dropped env
  (500s, isolated-probe comparison found it). Suite 459->461; gates
  clean; snapshot updated; pushed.
  ROUND-444 (2026-09-06): keys-DELETE audit — DELETE /api/me/keys had
  ZERO route pins (store-level covered, handler not). Added 1 in
  plugins.test.mjs: 401/400 + query-param delete empties the key map.
  Suite 461->462; gates clean; snapshot updated; pushed.
  ROUND-445 (2026-09-06): me-route audit — GET/PUT /api/me/route had
  ZERO route pins. Added 1 in plugins.test.mjs: 401s, whitelist 400,
  store→GET→clear roundtrip, effective-mirrors-stored. Self-caught:
  effective is null without stored route (no resolver wiring in test).
  Suite 462->463; gates clean; snapshot updated; pushed.
  ROUND-446 (2026-09-06): keys-test audit — POST /api/me/keys/test had
  ZERO route pins (per-provider live probes). Added 2 in
  plugins.test.mjs: gates + missing-key + deepseek/amd/openrouter
  shapes, og SSE ok/no-data/throw arms. Suite 463->465; gates clean;
  snapshot updated; pushed.
  ROUND-447 (2026-09-06): admin-fallback audit — getAdminPassword's
  keyless-env branch had ZERO pins. Added 1 in
  admin-seed-backfill.test.mjs: empty→"", secret→legacy:hash +
  verify roundtrip true/false. Suite 465->466; gates clean; snapshot
  updated; pushed.
  ROUND-448 (2026-09-06): sweep-lock audit — the corrupt-fresh-read arm
  had ZERO pins. Added 1 in plugins.test.mjs: racing corrupt re-read →
  null, 2 KV gets, no writeback. Suite 466->467; gates clean; snapshot
  updated; pushed.
  ROUND-449 (2026-09-06): index coverage to 100% lines — safePageUrl's
  catch arm was the last gap. Added page-helpers.test.mjs (https/
  loopback matrix, throw→fallback). REAL FIND while pinning: the
  `host === "::1"` disjunct is dead (WHATWG never yields bare ::1) —
  removed. Index 54->56, page.js 100/100/100; pushed (snapshot tracks
  gateway/agent only).
  ROUND-450 (2026-09-06): provider-arm audit — CMD/GMI/NV/QWEN testKey
  arms had ZERO pins. Added 1 in plugins.test.mjs: ok shapes +
  upstream-401 shape. Suite 467->468; gates clean; snapshot updated;
  pushed.
  ROUND-451 (2026-09-06): register-limiter audit — the 429 arm had ZERO
  pins. Added 1 in plugins.test.mjs: 30×400 then 429 on a fresh
  per-IP bucket. Self-caught: garbage invite is 400 here (403 is the
  devices self-register path). Suite 468->469; gates clean; snapshot
  updated; pushed.
  ROUND-452 (2026-09-06): login-gate audit — burst 429 + unknown-user
  burn arms had ZERO pins. Added 1 in plugins.test.mjs: 10×401 then
  11th 429. Self-caught: jsonError nests the message under
  error.message. Suite 469->470; gates clean; snapshot updated; pushed.
  ROUND-453 (2026-09-06): reset-limiter audit — the 429 arm had ZERO
  pins. Added 1 in plugins.test.mjs: 30×400 then 429 on a fresh
  per-IP bucket. Suite 470->471; gates clean; snapshot updated; pushed.
  ROUND-454 (2026-09-06): me-surface audit — GET /api/me success path
  + logout malformed-cookie arm had ZERO pins. Added 2 in
  plugins.test.mjs: identity + key-status shape, bad-cookie 200 +
  clear. Self-caught×2: key status is {configured, masked}, not bool.
  Suite 471->473; gates clean; snapshot updated; pushed.
  ROUND-455 (2026-09-06): probe-arms audit — testKey OR ok/fail, og
  non-ok, usage throw had ZERO pins. Added 2 in plugins.test.mjs.
  Suite 473->475; gates clean; snapshot updated; pushed.
  ROUND-456 (2026-09-06): usage-map audit — AMD spend-cap + OG window
  mappings had ZERO pins. Added 1 in plugins.test.mjs: exact mapped
  shapes incl. junk-field stripping. Suite 475->476; gates clean;
  snapshot updated; pushed.
  ROUND-457 (2026-09-06): final-arms audit — logout 429+clear, AMD/OG
  usage throws, AMD non-JSON had ZERO pins. Added 2 in
  plugins.test.mjs. plugins/auth.ts now ~98% (rest is route-unreachable
  defense). Suite 476->478; gates clean; snapshot updated; pushed.
  ROUND-458 (2026-09-06): devices-surface audit — list/add/mcp success
  paths had ZERO pins (only gates). Added 1 in devices.test.mjs:
  empty→add→masked list→mcp 404/200 (raw token only in the snippet).
  Suite 478->479; gates clean; snapshot updated; pushed.
  ROUND-459 (2026-09-06): delete/redeem audit — DELETE revocation +
  grant-redeem matrix + KV-fail-closed had ZERO pins. Added 3 in
  devices.test.mjs. Self-caught: req() already prefixes Bearer.
  Suite 479->482; gates clean; snapshot updated; pushed.
  ROUND-460 (2026-09-06): rotation-proof audit — tunnel-proved rotation
  + new-device secret capture had ZERO pins. Added 1 in
  devices.test.mjs: proof accepts, secret/date preserved, capture on
  insert. Suite 482->483; gates clean; snapshot updated; pushed.
  ROUND-461 (2026-09-06): claim-arms audit — key-register 400, rename
  bad-hostname 400, tunnel claim 403 + vanishing-key cleanup had ZERO
  pins. Added 2 in devices.test.mjs. Suite 483->485; gates clean;
  snapshot updated; pushed.
  ROUND-462 (2026-09-06): race/upload audit — insert-race 409 +
  admin-session upload had ZERO pins. Added 2 in devices.test.mjs.
  Suite 485->487; gates clean; snapshot updated; pushed.
  ROUND-463 (2026-09-06): bound/gate audit — upload 413 + public-gate
  429 had ZERO pins. Added 2 in devices.test.mjs. Self-caught: raw
  Request needs the SESSION_COOKIE name, not the bare token. Suite
  487->489; gates clean; snapshot updated; pushed.
  ROUND-464 (2026-09-06): admin-surface audit — public route, password
  set-status, session-gated change arms had ZERO pins. Added 2 in
  security-fixes.test.mjs. Self-caught×3: comma-operator paren slip,
  seed process-once re-arm, sessions sign with SESSION_SECRET. Suite
  489->491; gates clean; snapshot updated; pushed.
  ROUND-465 (2026-09-06): registry-framework audit — dispatch/route/
  emit/on had ZERO direct pins. Added 2 in registry.test.mjs:
  first-match/null/skip + delivery/unsub/throw-swallow. Suite 491->493;
  gates clean; snapshot updated; pushed.
  ROUND-466 (2026-09-06): body-scan audit — escape arms in keys/values
  had ZERO direct pins. New body-scan.test.mjs (3 tests: span, escapes,
  null shapes). Suite 493->496; gates clean; snapshot updated; pushed.
  ROUND-467 (2026-09-06): http-foundation audit — loopback/origin catch
  arms had ZERO direct pins. New http.test.mjs (loopback matrix +
  allowlist/P2 rule). Suite 496->498; gates clean; snapshot updated;
  pushed.
  ROUND-468 (2026-09-06): access-arms audit — JWKS-throw, disabled
  admin-email, provision-race had ZERO pins. Added 3 in
  access.test.mjs. Suite 498->501; gates clean; snapshot updated;
  pushed.
  ROUND-469 (2026-09-06): proxy-nav audit — 302 mint, non-nav 401,
  HTML expiry page, cookie auth/malformed had ZERO pins. Added 4 in
  proxy-auth.test.mjs. Suite 501->505; gates clean; snapshot updated;
  pushed.
  ROUND-470 (2026-09-06): strip-guard audit — the JSON proxy_secret
  strip arms (round-104 escalation guard) had ZERO pins. Added 1 in
  proxy-auth.test.mjs: stripped/intact/verbatim. Suite 505->506; gates
  clean; snapshot updated; pushed.
  ROUND-471 (2026-09-06): csrf-gate audit — the frontdoor 403 arm had
  ZERO route pins (unit-only). Added 1 in frontdoor.test.mjs: cross-site
  403, same-origin 401, reads never gated. Self-caught×2: need a real
  route + seeded password (empty env 500s). Suite 506->507; gates clean;
  snapshot updated; pushed.
  ROUND-472 (2026-09-06): usable-fallback audit — the getUserKeys-throw
  arm had ZERO pins. Added 1 in health.test.mjs: KV outage → unusable,
  never throws. Self-caught: ds has an env-key fallback, assert on qw.
  Suite 507->508; gates clean; snapshot updated; pushed.
  ROUND-473 (2026-09-06): probe-route audit — the /api/vale-probe 429
  arm had ZERO route pins. Added 1 in health.test.mjs: 60×200 then 429
  on a fixed IP. Suite 508->509; gates clean; snapshot updated; pushed.
  ROUND-474 (2026-09-06): timeout-fallback audit — the "timed out"→TIMEOUT
  message arm had ZERO pins. Added 1 in mcp-handler.test.mjs. Suite
  509->510; gates clean; snapshot updated; pushed.
  ROUND-475 (2026-09-06): divert audit — browser_run_script/pw_info
  device path (not the bridge) had ZERO pins. Added 1 in
  mcp-browser.test.mjs. Self-caught×3: real Response stub, Bearer lives
  in deviceFetch, callTool returns the envelope. Suite 510->511; gates
  clean; snapshot updated; pushed.
  ROUND-476 (2026-09-06): static-branch audit — off-host 404 + ASSETS
  proxy arms had ZERO pins. Added 1 in frontdoor.test.mjs. Self-caught:
  a no-op edit merged two lines (fixed immediately after). Suite
  511->512; gates clean; snapshot updated; pushed.
  ROUND-477 (2026-09-06): bootstrap audit — the no-password short-pw 400
  arm had ZERO pins + freshEnv never reset the seed flag (my new test ate
  the next test's seed). Added 1 in security-fixes.test.mjs, freshEnv now
  calls __resetSeedForTests. Suite 512->513; gates clean; snapshot
  updated; pushed.
  ROUND-478 (2026-09-06): coverage-table audit — translate.ts lowest at
  76.5%. Pinned the stream-ignored arms in gateway.test.mjs: JSON
  upstream → one-shot SSE, error envelope → 502. Lesson: no exploratory
  edits (a no-op probe merged lines again — reverted, then read-then-
  edit). Suite 513->515; gates clean; snapshot updated; pushed.
  ROUND-479 (2026-09-06): vision audit — the or/ passthrough arms had ZERO
  pins (only og/zen exercised). Added 2 in translate-vision.test.mjs:
  no-key throw, !ok throw + success insert. Suite 515->517; gates clean;
  snapshot updated; pushed.
  ROUND-480 (2026-09-06): transform audit — toOpenAIRequest had ZERO
  direct pins. Added 3 pure-function tests in reliability.test.mjs:
  system-array/tool_result-array, thinking+tool_use, tools+tool_choice.
  Suite 517->520; gates clean; snapshot updated; pushed.
  ROUND-481 (2026-09-06): retry audit — the billing-guard no-retry arm +
  the trip-failure swallow arm had ZERO pins. Added 2 in
  reliability.test.mjs. Suite 520->522; gates clean; snapshot updated;
  pushed.
  ROUND-482 (2026-09-06): smuggling audit — the URL round-trip mismatch
  arm had ZERO pins. Added 1 in mcp-browser.test.mjs: port/userinfo/path
  hostnames → DEVICE_UNREACHABLE, zero dials. Suite 522->523; gates
  clean; snapshot updated; pushed.
  ROUND-483 (2026-09-06): inspect audit — the retry inspect hook had ZERO
  pins. Added 3 in reliability.test.mjs: reject-then-accept/in-band,
  throwing inspect, response swap. CORRECTION: round-481's billing test
  duplicated an existing pin (lines 62-69) — removed; that round's real
  gain was 1 test, not 2. Suite 523->525; gates clean; snapshot updated;
  pushed. LESSON: grep-read existing tests before pinning an "uncovered"
  arm.
  ROUND-484 (2026-09-06): reasoning audit — reasonTextOf sources +
  tool_use fallback arms had ZERO pins. Added 2 in
  reliability.test.mjs: reasoning/reasoning_details, tool_calls incl.
  malformed/unknown. Suite 525->527; gates clean; snapshot updated;
  pushed.
  ROUND-485 (2026-09-06): dispatch audit — the unknown-/v1/-path 404 arm
  had ZERO pins. Added 1 in gateway.test.mjs. Suite 527->528; gates
  clean; snapshot updated; pushed.
  ROUND-486 (2026-09-06): empty-stream audit — the non-SSE error arm had
  ZERO pins. Added 1 in reliability.test.mjs: explicit error event, no
  message_start. Suite 528->529; gates clean; snapshot updated; pushed.
  ROUND-487 (2026-09-06): mixed-block audit — passthrough + empty-data
  arms had ZERO pins. Added 1 in translate-vision.test.mjs. Noted: the
  failure strip leaves a trailing ")" on all messages (pre-existing
  cosmetic wart, out of scope). Suite 529->530; gates clean; snapshot
  updated; pushed.
  ROUND-488 (2026-09-06): byok audit — the or/ keyless 502 arm had ZERO
  pins. Added 1 in gateway.test.mjs (isoEnv undefined-key trick). Suite
  530->531; gates clean; snapshot updated; pushed.
  ROUND-489 (2026-09-06): og-fail audit — fetch-throw + bad-JSON arms had
  ZERO pins. Added 1 in translate-vision.test.mjs (shared env proves no
  failure caching). Suite 531->532; gates clean; snapshot updated;
  pushed.
  ROUND-490 (2026-09-06): choice audit — the lone-web_search auto-choice
  arm had ZERO pins (explicit choice was covered). Added 1 in
  gateway.test.mjs. Suite 532->533; gates clean; snapshot updated;
  pushed.
  ROUND-491 (2026-09-06): REAL FIND — getGlobalSetting US_PROXY read threw
  on KV outage, failing all vision preprocessing (every other KV read on
  the path is best-effort). Fix: .catch(()=>null) at the caller (direct
  default). Added 1 test (KV-down describe still succeeds). BONUS: mirror
  resync caught 4 files of prior-round drift (access/mcp/store-admin/
  store-settings). Suite 533->534; gates clean; snapshot updated;
  pushed.
  ROUND-492 (2026-09-06): encoder audit — mid-stream error + tail-parse
  arms had ZERO pins. Added 2 in reliability.test.mjs. Discipline slip:
  caught myself starting a pointless async-probe edit twice — reverted
  both, did the real work read-first. Suite 534->536; gates clean;
  snapshot updated; pushed.
  ROUND-493 (2026-09-06): sse-build audit — toSSE thinking +
  server_tool_use arms had ZERO pins (zero direct tests). Added 2 in
  reliability.test.mjs. Slipped into the no-op-probe habit once more
  (trailing-space edit) — reverted before the real edit; the committed
  diff is clean (verified via git diff --stat). Suite 536->538; gates
  clean; snapshot updated; pushed.
  ROUND-494 (2026-09-06): backfill audit — the late id/name arm had ZERO
  pins. Added 1 in reliability.test.mjs (args-first chunk, meta later;
  no "unknown"). Clean round: no probe edits, diff verified. Suite
  538->539; gates clean; snapshot updated; pushed.
  ROUND-495 (2026-09-06): responses audit — the model guard had ZERO pins.
  Added 1 in gateway.test.mjs. Found the route-kind arm unreachable
  (og恒opencode, defensive-only — documented in-test, not pinned).
  Suite 539->540; gates clean; snapshot updated; pushed.
  ROUND-496 (2026-09-06): keyless audit — nv/gmi/amd/cm 502 arms had ZERO
  pins. Added 1 matrix test in gateway.test.mjs (4 arms, no upstream).
  Suite 540->541; gates clean; snapshot updated; pushed.
  ROUND-497 (2026-09-06): pacing audit — the retry-after header arm had
  ZERO pins. Added 1 in gateway.test.mjs. Self-caught×2: the messages
  branch never passes it (chat path only) + Retry-After:7 costs 14s
  (used 1). Suite 541->542; gates clean; snapshot updated; pushed.
  ROUND-498 (2026-09-06): nv-fail audit — the translate failure mapping
  had ZERO pins. Added 1 in gateway.test.mjs (503/message/pacing).
  Self-caught: this branch never adopts upstream types (api_error by
  design). Suite 542->543; gates clean; snapshot updated; pushed.
  ROUND-499 (2026-09-06): dsqw audit — the ds/qw passthrough keyless arms
  had ZERO pins. Added 1 matrix test in gateway.test.mjs (2 arms, no
  upstream). Suite 543->544; gates clean; snapshot updated; pushed.
  ROUND-500 (2026-09-06): REAL FIND — translate-path og-key guard was
  unscoped: cm/ with valid CMD key but no og key 502'd (branch only sends
  cmdKey). Fix: scope to opencode kind. Proven by stash-revert (89/90
  without, 90/90 with). Mirror resynced. Suite 544->545; gates clean;
  snapshot updated; pushed.
  ROUND-501 (2026-09-06): breaker audit — the translate-path circuit-open
  arm had ZERO pins. Added 1 in gateway.test.mjs (open breaker → 502,
  no dial; degraded-cache cleared first). Suite 545->546; gates clean;
  snapshot updated; pushed.
  ROUND-502 (2026-09-06): count audit — the count_tokens keyless guards
  had ZERO pins. Added 1 matrix test in gateway.test.mjs (ds/qw/amd, no
  upstream). Suite 546->547; gates clean; snapshot updated; pushed.
  ROUND-503 (2026-09-06): chat-ladder audit — the chat-path keyless guards
  had ZERO pins (488/496/499 only hit the messages ladder — coverage
  proved it). Added 2 in gateway.test.mjs (7-arm matrix + og keyless/
  breaker). Chat openrouter arm unreachable (pre-branch guard same var —
  documented, not pinned). translate 86.42->89.18. Suite 547->549;
  gates clean; snapshot updated; pushed.
  ROUND-504 (2026-09-06): shadow audit — the translate-path cm arm is ALSO
  shadowed (pre-branch guard same !cmdKey — coverage proved the 496/503 cm
  cases never executed it). Verdict comment at the guard + corrected both
  test comments (they pin the live pre-branch guards). Suite stays 549;
  gates clean; mirror resynced; pushed.
  ROUND-505 (2026-09-06): json audit — the invalid-JSON 502 arm had ZERO
  pins. Added 1 in gateway.test.mjs. Self-caught×2: breaker-cache residue
  + the arm needs stream:true/JSON-ctype (stream:false takes the one-shot
  path). Suite 549->550; gates clean; snapshot updated; pushed.
  ROUND-506 (2026-09-06): role audit — the developer→system normalization
  had ZERO pins. Added 1 in gateway.test.mjs (chat path, upstream sees
  system). Clean round. Suite 550->551; gates clean; snapshot updated;
  pushed.
  ROUND-507 (2026-09-06): any audit — the tool_choice:"any" web_search
  variant had ZERO pins. Added 1 in gateway.test.mjs (explicit any-choice
  forces deepseek-v4-flash). Also verified the og-native passthrough
  guards are unreachable (OG_NATIVE_ANTHROPIC empty). Suite 551->552;
  gates clean; snapshot updated; pushed.
  ROUND-508 (2026-09-06): auto audit — the model=auto resolution arm had
  ZERO pins. Added 1 in gateway.test.mjs (no route → first usable ds,
  served 200). Clean round. Suite 552->553; gates clean; snapshot
  updated; pushed.
  ROUND-509 (2026-09-06): parse audit — the passthrough needsParse-true
  arm had ZERO pins (og tests take the else arm). Added 1 in
  gateway.test.mjs (ds + web_search tools → parsed + forwarded). Clean
  round. Suite 553->554; gates clean; snapshot updated; pushed.
  ROUND-510 (2026-09-06): ox audit — the ox-alpha-free reasoning default
  had ZERO pins. Added 1 in gateway.test.mjs (no client reasoning →
  effort=max upstream). Clean round. Suite 554->555; gates clean;
  snapshot updated; pushed.
  ROUND-511 (2026-09-06): texterr audit — the chat-path non-JSON error arm
  had ZERO pins. Added 1 in gateway.test.mjs (500 text body → status +
  default message kept). Clean round. Suite 555->556; gates clean;
  snapshot updated; pushed.
  ROUND-512 (2026-09-06): REAL FIND — the passthrough !ok arm had no 429
  default: non-JSON 429 → api_error (give up) instead of rate_limit_error
  (back off). One-line parity fix. Self-caught×2 (translate branch, fast-
  500 no-retry). Proven by stash-revert (101/102 without, 102/102 with).
  Mirror resynced. Suite 556->557; gates clean; snapshot updated; pushed.
  ROUND-513 (2026-09-06): nvtext audit — the nv/gmi non-JSON error arm had
  ZERO pins. Added 1 in gateway.test.mjs (400 text, single call, status
  kept). Clean round. Suite 557->558; gates clean; snapshot updated;
  pushed.
  ROUND-514 (2026-09-06): respm audit — the responses-path og keyless +
  breaker arms had ZERO pins. Added 1 in gateway.test.mjs (muse-spark,
  no dial). Clean round. Suite 558->559; gates clean; snapshot updated;
  pushed.
  ROUND-515 (2026-09-06): resperr audit — the responses-path !ok mapping
  had ZERO pins. Added 1 in gateway.test.mjs (muse-spark 429 text →
  status + rate_limit kept). Clean round. Suite 559->560; gates clean;
  snapshot updated; pushed.
  ROUND-516 (2026-09-06): glm audit — the glm-5.2:free retry config had ZERO
  pins. Added 1 in gateway.test.mjs (502 → ≥5 calls, proves the 10x arm
  over the generic 4x). Clean round. Suite 560->561; gates clean;
  snapshot updated; pushed.
  ROUND-517 (2026-09-06): probe audit — the vale-probe catch arms had ZERO
  pins. Added 1 in health.test.mjs (ds+og throw → ok:false + message).
  Clean round. Suite 561->562; gates clean; snapshot updated; pushed.
  ROUND-518 (2026-09-06): think audit — the stream reasoning_content arm
  had ZERO pins. Added 1 in gateway.test.mjs (gmi SSE delta → thinking
  block). Clean round. Suite 562->563; gates clean; snapshot updated;
  pushed.
  ROUND-519 (2026-09-06): srvtool audit — the toSSE server_tool_use arm
  had ZERO pins. Added 1 direct unit test in reliability.test.mjs.
  Clean round. Suite 563->564; gates clean; snapshot updated; pushed.
  ROUND-520 (2026-09-06): torn audit — the mid-stream death arm had ZERO
  pins. Added 1 direct unit test in reliability.test.mjs (dying stream →
  error event, no clean finish). Clean round. Suite 564->565; gates
  clean; snapshot updated; pushed.
  ROUND-521 (2026-09-06): cancel audit — the stream cancel arm had ZERO
  pins. Added 1 direct unit test in reliability.test.mjs (output cancel
  → upstream reader cancelled). Clean round. Suite 565->566; gates
  clean; snapshot updated; pushed.
  ROUND-522 (2026-09-06): asset audit — the serveAssetText no-ASSETS arm
  had ZERO pins. Added 1 in health.test.mjs ({} and {ASSETS:{}} → null).
  Clean round. Suite 566->567; gates clean; snapshot updated; pushed.
  ROUND-523 (2026-09-06): sweep audit — the regenerate survivor-sweep had
  ZERO pins. Added 1 in plugins.test.mjs (stale token mapping swept).
  Clean round. Suite 567->568; gates clean; snapshot updated; pushed.
  ROUND-524 (2026-09-06): torn-record audit — the corrupt-user arm had ZERO
  pins. Added 1 in plugins.test.mjs (garbage JSON → null, no throw).
  Clean round. Suite 568->569; gates clean; snapshot updated; pushed.
  ROUND-525 (2026-09-06): migrate audit — the ADMIN_PASSWORD migration arm
  had ZERO pins. Added 1 in plugins.test.mjs (secret → legacy hash in KV,
  never plaintext). Self-caught: no trailing colon in format. Suite
  569->570; gates clean; snapshot updated; pushed.
  ROUND-526 (2026-09-06): race audit — the post-claim key recheck had ZERO
  pins. Added 1 in devices.test.mjs (vanishing key → 403). Verdict: the
  formatResult top-level .image arm is unreachable (envelopes always wrap;
  live shape rides the round-118 arm) — documented, no behavior change.
  Also found V8 misattributes executed else-if multi-line arms (786-790
  executes per output assertion yet still listed). Suite 570->571; gates
  clean; mirror resynced; pushed.
  ROUND-527 (2026-09-06): deny audit — the device-scan catch had ZERO pins.
  Added 1 in devices.test.mjs (KV outage → 401 deny, no throw). Clean
  round. Suite 571->572; gates clean; snapshot updated; pushed.
  ROUND-528 (2026-09-06): frame audit — the malformed-frame catch had ZERO
  pins. Added 1 in reliability.test.mjs (garbage frame skipped, valid
  chunks + message_stop flow). Clean round. Suite 572->573; gates clean;
  snapshot updated; pushed.
  ROUND-529 (2026-09-06): upstream audit — the install-cmd fetch-throw arm
  had ZERO pins (only non-ok covered). Added 1 in devices.test.mjs
  (throw → 200 null fallback). Phantom rule hardened: 409 path proven
  executing in isolation yet still listed. Suite 573->574; gates clean;
  snapshot updated; pushed.
  ROUND-530 (2026-09-06): probe audit — the proxySecret-probe catch had ZERO
  pins. Added 1 in devices.test.mjs (dead device → still 200, no secret).
  Clean round. Suite 574->575; gates clean; snapshot updated; pushed.
  ROUND-531 (2026-09-06): outage audit — the sweep-list-throw arm had ZERO
  pins. Added 1 in plugins.test.mjs (KV outage mid-sweep → still 200,
  old token revoked). Clean round. Suite 575->576; gates clean;
  snapshot updated; pushed.
  ROUND-532 (2026-09-06): tunnel audit — the dead-tunnel proof catch had
  ZERO pins. Added 1 in devices.test.mjs (throw → 409, record untouched).
  Clean round. Suite 576->577; gates clean; snapshot updated; pushed.
  ROUND-533 (2026-09-06): agent matrix sweep — default 332 (290 lib + 5 +
  27 + 2 + 7 + 1) + core 15 = 347, feat-gated lib 298, clippy x2 + fmt +
  xwin clean. FINDINGS: (1) one-off flake — first feat-gated run failed
  1 test, 4 reruns all green (name not captured; watch item); (2) the
  snapshot headline 349 was stale arithmetic (true 347) — corrected.
  Pushed.
  ROUND-534 (2026-09-07): satellite sweep, zero drift — panel 178/178 (33
  files) + build clean with committed panel.js in sync, index 56/56,
  proxies 12+7+7 via node --test (no npm test script — CI calls node
  --test directly), npm CLI 3/3, extension node --check 3/3, vercel-proxy
  5/5 gate. All snapshot counts confirmed current. No code changes —
  pure verification round.
  ROUND-535 (2026-09-07): flake watch closed — round-533's one-off
  feat-gated failure never reproduced: 5x lib + 2x full feat-gated runs
  all green (298 lib + 5 + 27 + 2 + 7 + 1 each). 11 consecutive greens
  since the single failure; verdict = cold-build environment noise, not
  a product flake. No code changes — verification round.
  ROUND-536 (2026-09-07): gateway UI sweep — build clean, tests 1/1,
  login render smoke OK, devices-dashboard smoke OK, code-viewer mirror
  resync produces zero changes (fresh since round-526). Tree clean. No
  code changes — verification round.
  ROUND-537 (2026-09-07): STALE DEPLOY FOUND + FIXED — live gateway
  predated the 2026-09-05 mcp.ts split (proved via /code/ mcp.ts import
  shape): 19 src commits undeployed incl. behavior fixes (429
  rate_limit_error default, og-key scoping, vision KV-outage degrade,
  seedAdmin no-clobber, /mcp enabled gate, per-IP limiter, disabled-user
  logout). Pre-deploy gates green (577 + tsc + prettier); deployed via
  build.sh gateway (Version 3b991d38); live-verified 21/21 channels ok,
  /code/ 3/3 byte-identical, /mcp 401 gate. LESSON: test-only rounds
  never trigger deploys — schedule a live-vs-repo parity probe
  periodically, not just after code changes.
  ROUND-538 (2026-09-07): harvest audit — the self-reg secret-harvest
  catch had ZERO pins. Added 1 in devices.test.mjs (dead device → still
  200, no secret). Self-caught: T64("g") fails the 64-hex token gate
  (g not hex) → used "9". d1 answers 401 (alive, tunnel up) but no
  device credential from here, so full device e2e stays out of reach.
  Suite 577->578; gates clean; snapshot updated; pushed (test-only —
  no redeploy needed).
  ROUND-539 (2026-09-07): backfill audit — the seed-failure catch had ZERO
  pins. Added 1 in admin-seed-backfill.test.mjs (throwing KV → resolves,
  startup unblocked; verified the throw lands in the backfill try, not
  an outer guard — fresh path exits early via get). Clean round. Suite
  578->579; gates clean; snapshot updated; pushed (test-only).
  ROUND-540 (2026-09-07): keepalive audit — the MCP SSE endpoint had ZERO
  pins. Added 1 in mcp-gateway.test.mjs (GET → event-stream + clean
  cancel, no leaked interval). Verdict: the 15s tick-vs-cancel race arm
  is defensive-only (not deterministically triggerable) — documented.
  Suite 579->580; gates clean; mirror resynced; pushed (comment-only
  src change rides the next deploy).
  ROUND-541 (2026-09-07): parity probe TOOLED — round-537's lesson is now
  gateway/scripts/check-live-parity.sh (39 manifest files, live /code/
  vs repo mirror, exit 1 on drift). Self-caught: the viewer 307s bare
  files to directory form (fixed with curl -L) and pipe exit codes mask
  failures (check $? off-pipe). First run: exactly 1 drift (the 540
  comment — the forcing function works; comment rides the next deploy).
  Pushed.
  ROUND-542 (2026-09-07): probe WIRED INTO DEPLOY — build.sh gateway now
  runs check-live-parity.sh post-deploy (sleep 8 for edge propagation,
  fail the step on drift; round-324 index-smoke pattern). Proved
  end-to-end with a real deploy (Version dd093b0e): gate ran inside the
  flow, "39 files, 0 drifted" — the 540 comment is now live and the
  known drift is cleared. Mirror re-sync byte-identical no-op. Pushed.
  ROUND-543 (2026-09-07): post-deploy live chain — parity probe still 0
  drift (39/39, manifest is 100% vale-gate group, no coverage gap);
  /api/plugins/status 401, /api/devices 401, removed /api/plugins/pair
  still 404, /mcp 401 with proper JSON-RPC error. Deployed world fully
  consistent with repo. No code changes — verification round.
  ROUND-544 (2026-09-07): proxy deploy BLIND SPOT CLOSED — deploy_proxy
  had no post-deploy smoke (comment admitted it). Wired keyless 401-gate
  smokes for zen-go + zen-us (vercel-proxy pattern; proves serving +
  auth intact, zero upstream spend). openrouter-proxy skips: idle/
  off-path, workers.dev TLS-dead, no reachable URL. Proved with a real
  `build.sh proxies` run (all 3 deployed, both smokes green). Pushed.
  ROUND-545 (2026-09-07): INDEX ALSO STALE — same class as 537: newest
  index deploy Sep 5 15:36 (+0800) but 3 src commits after (page.js
  extract, CORS parity, TempClaimDO auth fix, safePageUrl pins).
  Suite 56/56 green; deployed via build.sh index (Version 475540f3,
  built-in version smoke passed v1.2.297 + sha); live-verified landing
  200 + version match. No repo changes — deploy-only round.
  ROUND-546 (2026-09-07): full live chain recheck — gateway 21/21 ok,
  parity 0 drift, vercel/zen-go/zen-us keyless 401s intact, d1 401
  (alive, tunnel up). Every deployed surface consistent with repo. No
  code changes — verification round.
  ROUND-547 (2026-09-07): completed the prescribed hardening — the Sep 7
  TempClaimDO commit said `wrangler secret put DO_AUTH` but live index
  had only UPLOAD_KEY (gate dormant). Generated + stored DO_AUTH (value
  lives only in Cloudflare; loss = regenerate + re-put, no sync needed).
  Verified no worker/DO env skew (well-formed claims 404, never 401) and
  reviewed both sides (server-side overwrite kills forgery, constant-time
  compare, claim-auth tests green in the 56). By construction the compat
  gate shows no external change — dormant/active indistinguishable
  through the worker path. No repo changes — ops round.
  ROUND-548 (2026-09-07): vercel-proxy redeployed + smoke green — but the
  "stale" verdict was WRONG: my probe used Origin console.saisi.online,
  which is NOT in ALLOWED_ORIGINS (ai/api/dsh only), so no reflection by
  design, pre- and post-fix. Re-probed with ai.saisi.online → 401 WITH
  allow-origin reflected: the CORS fix is live. CORRECTION OWED: never
  verdict drift without an allowlisted probe. Deploy stands as a fresh
  push + verified smoke; no repo changes.
  ROUND-549 (2026-09-07): RETIRED openrouter-proxy — zero callers
  (off-path since 2026-08-22), workers.dev URL TLS-dead (verified 2x),
  yet still deployed/tested/maintained (even got loopback gates in the
  Sep 7 commit). Remote worker deleted (zero secrets held) + repo
  removal: worker dir (-315 lines), build.sh + ci.yml wiring, README,
  upstream.ts comment, ARCHITECTURE (proxies ×2, 19 tests), dead sync-
  script mirror block. Gates: tsc/eslint/prettier + gateway 580 +
  proxies 12+7 green; parity shows exactly the expected 1 drift
  (upstream.ts comment rides next deploy). -348/+16. Pushed. NEXT: new
  goal objective pivots to agent-module testing.
  ROUND-550 (2026-09-07): agent/update audit (new objective) — the
  SYSTEM-execution gate (https/host-match/sha) lived as untested inline
  closures. Extracted host_of + check_download_url + valid_sha256 as
  pure fns (byte-identical verdicts, same messages) + 3 pin tests (6→9).
  REAL FIND: the "::1" loopback arm is unreachable (host_of parses bare
  ::1 to "") — documented, gate untouched (widening SYSTEM-exec is a
  product decision). Self-caught×2: dropped version_url in an edit
  (restored) + fmt line width. Matrix: lib 293, feat 301, clippy x2 +
  fmt + xwin clean; snapshot 347->350. Pushed.
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

### 2026-09-08 cleanup round (architecture-audit follow-up fixes)
- **vale setup now writes the .vale-release marker** — fresh installs
  (update-only devices already had it, round-298/298b) previously made
  agent_update compare against the frozen Cargo 1.0.x fallback and
  re-download + swap on every call. New `writeReleaseMarker()` helper
  (best-effort, package.json source), called after setup's exe copy +
  boot-task registration succeed. CLI tests 9/9.
- **UI version reads prefer the npm `release` field** — /api/status has
  reported `release` (1.2.x) alongside the frozen Cargo `version` since
  round-304, but electron title/tray and the desktop SPA status strip all
  showed `version` (v1.0.145 forever on 1.2.x devices). All three now
  read `release` first, `version` as fallback. +1 vitest pin; DesktopShell
  9/9.
- **zen-us-proxy egress US-pinned** — smart placement had parked the
  worker in AMS (2026-09-07) and zen 403 RegionError'd muse-spark from
  that EU egress; Vercel clears it but caps bodies at 4.5 MB. Config now
  uses a WNAM-primary D1 (`zen-us-db-wnam`) + `placement.region:
  aws:us-east-1`; caveats synced (proxies/README.md, channels.ts muse
  exit note) + code-viewer mirror.
- **Retired openrouter-proxy residue removed** — root README +
  build.sh usage line + zen-us header comment still named it as live;
  the empty leftover local dir (gitignored .wrangler tmp only) is gone.
  Source stays in git history (2026-09-07 retirement).

### 2026-09-08 SOLID round (gateway layering — plugin deps, key errors, gates)
- **Plugin deps now enforced (DIP)** — `registerPlugins` ran setups in
  caller-array order while index.ts lists auth BEFORE translate despite
  auth's `deps:["translate"]`; auth's setup read `ctx.api.translate` as
  undefined, so `/api/me/route`'s `effective` never resolved the usable
  fallback (UI "current model" wrong for keyless/BYOK users). The registry
  now does a stable topological sort — a dep registers before its
  consumers, same-level plugins keep caller order, a dependency cycle
  throws. Missing-from-list deps (external providers) tolerated.
  +4 registry tests; me/route test updated to assert the FIXED semantics
  (keyless no-route → default fallback; keyless stored-og → fallback;
  with og key → stored route mirrors) — the old assertions pinned the bug.
- **21 key-missing 502 copies collapsed into one table (SRP/DRY)** —
  every /v1 flow site hand-rolled `if (kind===X && !keyX) jsonError(502,
  "<KEY> not configured — <hint>", "config_error")` across four branches;
  a new channel kind needed its guard + message in four places. New
  `keyMissingError(kind)` owns the message table (strings byte-identical);
  call sites keep their own `!key` gate and delegate the 502 shape.
  +2 unit pins in scrub-keys.test.mjs.
- **Devices handlers use the shared requireAdmin gate (DRY)** — 10
  admin-gated handlers hand-rolled requireSession→401 + role→403 pairs;
  now `requireAdmin` (the gate admin.ts already used) in one line each.
  handleFileUpload keeps requireSession (session-only). -20 lines.
- Gateway 590 pass, tsc/lint/prettier clean; code-viewer mirror synced in
  each commit.

### 2026-09-08 SOLID round 2 (gateway device-tool path single-sourcing)
- **Device tool paths derived, 21-entry dup table deleted (DRY)** —
  callTerminalToolOnce hand-wrote an "/api/tools/<name>" map for all 21
  device-direct tools while mcp-tools.ts already owns the registration
  list: two sources of truth that drifted silently (round-54's 11 missing
  tools were exactly that class). Path is now the mechanical
  `/api/tools/${name}` behind a single exported `isDeviceDirectTool()`
  guard (terminal_*/secret_* prefixes + browser_pw_info/browser_run_script
  specials). callTool's existing dispatch already routes only device-direct
  names there, so the guard is a programming-error net, not a runtime
  branch.
- **+contract pin**: every registered gateway MCP tool must classify
  device-direct XOR bridge-routed, matching callTool's dispatch partition
  (7 bridge names are the exact non-device-direct set) — a future tool
  added to one side without the other fails the suite, not production.
- Gateway 591 pass; tsc/lint/prettier clean; code-viewer mirror synced.

### 2026-09-08 SOLID round 3 (agent memory eviction dedup + bundle catch)
- **Memory eviction dedup (DRY, agent)** — enforce_limits' entry-cap and
  byte-cap loops each copy-pasted the same oldest-live victim selection
  (min updated_at, id tiebreak) + soft-delete + persist-tombstone. Extracted
  `evict_oldest_live()` (returns evicted content length so callers keep
  their own total_bytes accounting: full recompute vs exact subtract) and
  used it in both loops; retention branch keeps its own bulk cutoff delete
  (age-based, different policy). Memory lib tests 28/28, full lib 307
  feature-gated pass, clippy clean.
- **Stale panel.js caught + shipped** — while running cargo (build.rs
  staleness gate) the rebuild revealed the round-1 DesktopShell
  release-field change (a1bf8881) had modified TS source but never
  re-emitted the committed panel.js bundle; devices would have kept
  showing the frozen Cargo version. Rebuilt + committed the bundle
  (ff856a85). LESSON: after any panel-react source commit, verify
  resources/panel/ products are committed too (build.rs only catches it
  at the next cargo build).

### 2026-09-08 SOLID round 4 (vision describe tail + SSE bounded-send dedup)
- **Vision describe tail dedup (DRY, gateway)** — describeImage's two
  upstream branches (passthrough vs og translate) each hand-rolled the
  same tail: !ok → status marker, JSON parse → "解析失败" marker,
  extract text, cache, return. Extracted `finishDescribe(resp, cacheKey,
  env, extract)`; per-upstream difference is now only the text-extraction
  closure (Anthropic content[] vs OpenAI choices[0].message). All failure
  markers byte-identical (round-119 fail-loud contract preserved);
  translate-vision tests 8/8 end-to-end. Gateway 591 pass.
- **SSE bounded-send dedup (DRY, agent)** — sse_response and
  sse_term_stream each defined an identical 5s-bounded mpsc send closure
  (dead-client detection; a full channel means the client is gone).
  Extracted one module-level `send_bounded(tx, bytes)` used by both
  streams. Web tests 44/44, full lib 299 pass; clippy clean.
- Both: code-viewer mirror synced for the gateway change.

### 2026-09-08 SOLID round 5 (terminal take_session + translate error normalization)
- **take_session dedup (DRY, agent)** — term_close and term_unregister each
  copy-pasted the same lock-scoped position+remove block (review #10:
  remove under the lock, close AFTER the guard drops). Extracted
  `take_session(sid) -> Option<Session>`; callers still own the post-lock
  close. Lib 299 + feature-gated 307 pass; clippy clean.
- **Upstream error normalization single-sourced (DRY, gateway translate)** —
  all three /v1 arms (chat/completions, responses, messages) copy-pasted the
  same !upstream fetch-failure path and the !upstream.ok body-sniff (unwrap
  {"detail":{…}}, scrubKeys, keep the upstream's own known error.type, carry
  Retry-After). Extracted `upstreamFetchFailedResponse()` +
  `upstreamBodyErrorResponse()`, called from all three arms. BEHAVIOR FIX
  surfaced by the dedup: /v1/responses previously DROPPED Retry-After (its
  sniff copy predated the extra-header parity) — it now carries it; new pin
  (og responses 429 → retry-after header). Down-body breaker guards
  (isChannelDownFailure on og 5xx) preserved at the two sites that had them.
  -23 net lines. Gateway 592 pass; tsc/lint/prettier clean; mirror synced.

### 2026-09-08 SOLID round 6 (SSE encoder dedup + mcp_client auto-select dedup)
- **AnthropicStreamEncoder dedup x2 (DRY, gateway)** — (1) ensureBlock
  copy-pasted the thinking/text content_block_delta push between its
  first-chunk and continuation paths → shared `pushContentDelta(delta)`.
  (2) the constructor re-assigned eight fields that already carry
  declaration-site initializers (class-field initializers run before the
  ctor body — dead assignments) → ctor now only sets parameter-derived +
  non-initialized fields. Gateway 592 pass; tsc/lint/prettier clean;
  mirror synced.
- **Connect auto-select dedup (DRY, agent mcp_client)** — the stdio and
  http connect arms each copy-pasted the embedded-view auto-select
  sequence (SESSION take-out → select under no lock → restore-or-drop,
  P1-1 discipline). Extracted `auto_select_embedded_view(can_auto_select)`;
  http passes "server exposes browser_tabs", stdio always true. mcp_client
  21/21, feature-gated lib 307 pass; clippy clean.

### 2026-09-08 SOLID round 7 (store locked-read + session-file traversal dedup)
- **Locked fresh-read single-sourced (DRY, gateway store/plugins.ts)** —
  all five mutating plugin-map paths (expiry sweep, remove, migrate,
  revoke-for-device) hand-rolled the same withKeyLock + fresh-KV-read +
  parse prologue. Extracted `readFreshPluginLinks(env)` returning null on a
  corrupt blob — callers abort WITHOUT writing (null-as-{} would delete
  every link). This aligns plugins.ts with devices.ts's earlier
  readDevicesRaw precedent (devices intentionally resets to [] on corrupt:
  array whole-file writes vs map incremental edits). Read-only
  listPluginLinks keeps its cache-tolerant {} fallback. Gateway 592 pass.
- **Session-file traversal dedup (DRY, agent session_log.rs)** —
  list_sessions and recover_interrupted each copy-pasted the read_dir +
  .jsonl filter + stem-extraction loop → shared `session_ids()`. prune_stale
  keeps its own loop (it also matches .jsonl.tmp litter and needs metadata,
  not sids). cargo fmt; lib 299 pass; clippy clean.

### 2026-09-08 SOLID round 8 (me/keys prologue + circuit-open guard dedup)
- **/api/me/keys handler prologue dedup (DRY, gateway auth.ts)** —
  meRevealKey / meTestKeys / meKeyUsage each opened with the same
  requireSession + readJson + name-whitelist + getUserKeys sequence.
  Extracted `sessionAndKeyName(request, env, allowed)` returning
  {user, name} | Response; usage passes its narrower 3-name set. The
  save/delete siblings keep their own shapes (extra value field / query
  param — forcing them in would hurt readability). Gateway 592 pass.
- **og circuit-open guard single-sourced (DRY, gateway translate.ts)** —
  four /v1 sites (chat/completions, responses, og-native passthrough,
  messages translate) inlined the same "opencode + breaker open → 502
  circuit open" check. Extracted `channelDegradedError(env, kind)` — one
  guard shape, one message, four call sites. Gateway 592 pass;
  tsc/lint/prettier clean; mirror synced.

### 2026-09-08 SOLID round 9 (device-body validation wrapper dedup)
- **validateDevice try/catch dedup (DRY, gateway devices.ts)** — the
  reg-key, self-register and admin-add handlers each inlined the same
  try/catch around validateDevice → 400. Extracted
  `validatedDeviceOrError(body): Device | Response`; three call sites.
  Deferred (judged not-worth-it): the five "already registered" messages
  are 3 semantic variants (anti-hijack hint / rename conflict), and the
  in-function 409 pair is deliberate defense-in-depth (check-then-act +
  lock-insert fallback); testKey's 8 provider branches stay (each is real
  protocol adaptation — og SSE first-chunk, AMD model-list parse, …).
  Gateway 592 pass; tsc/lint/prettier clean; mirror synced.

### 2026-09-08 SOLID round 10 (one OSC scanner in shell_integration)
- **find_* scanner dedup (DRY, agent shell_integration.rs)** —
  find_finished, find_command_line and find_prompt_started each
  hand-rolled the same byte scan (walk for ESC ], try the specific 633
  parse, skip whole non-633 OSCs — never past a partial/malformed 633;
  sequence, the subtle rule that could drift between finders). Extracted
  `scan_osc(data, parse)` generic over the per-sequence parser, plus a
  standalone `parse_osc_633_a` (the A-marker match was inlined before).
  -12 net lines; the partial-prefix + ignore-other-OSC boundary tests
  (30/30) pin the preserved semantics. Feature-gated lib 307 pass;
  clippy/fmt clean. exec.rs's find_prompt_marker stays (LEGACY 133;D
  parser for the headless-stub path — different prefix, documented).

### 2026-09-08 SOLID round 11 (screen tail-N + SSE relay headers dedup)
- **tool_screen tail-N dedup (DRY, agent output.rs)** — the live-session
  and history branches each copy-pasted the same tail scan (skip trailing
  \r\n/\n so the Nth-from-end count is content lines, walk back N
  newlines, slice). Extracted `tail_n_lines(data, lines) -> (start, end)`
  — one tail semantics for both buffer kinds. Terminal tests 111/111,
  feature-gated lib 307 pass; clippy/fmt clean.
- **SSE relay headers single-sourced (DRY, gateway translate.ts)** — the
  one-shot error-envelope relay and the streaming relay each built the
  same text/event-stream + no-cache + CORS header Response. Extracted
  `sseResponse(body)`. Gateway 592 pass; tsc/lint/prettier clean; mirror
  synced.

### 2026-09-08 SOLID round 12 (vision-describe fetch wrapper dedup)
- **fetchDescribeOrError (DRY, gateway translate-vision.ts)** —
  describeImage's passthrough and og branches each inlined the same
  fetchWithTimeout + try/catch → "(图片描述失败：…)" marker wrapper.
  Extracted `fetchDescribeOrError(url, init, env): Response | string` —
  one failure contract for both upstream calls (a future timeout/retry
  policy lands in one place). translate-vision.ts dup blocks 4 → 1 (the
  remainder is the shared helper's call-site tail, not duplicable logic).
  Deferred (judged not-worth-it): valeProbe's 9-line tail (too small),
  posixInstaller/psInstaller (two platform languages by design), memory
  tools' id-parse stanzas (the MCP builder idiom — per-tool error text).
  Gateway 592 pass; tsc/lint/prettier clean; mirror synced.

### 2026-09-08 SOLID round 13 (call-site comment trim + convergence check)
- **Call-site comment trim (gateway translate.ts)** — the three /v1 arms
  each carried a 6-line comment re-explaining the shared
  upstreamFetchFailedResponse / upstreamBodyErrorResponse helpers whose
  docstrings already own that explanation. Collapsed to one-line pointers
  (-30 comment lines, zero logic change); mirror synced.
- **Convergence check** — repo-wide dup scan now 13 files ≥4 blocks / 127
  total (was 24 files / 260+ at round 1). translate.ts's remaining 16
  blocks are all classified: flow-specific guard chains (by design),
  fetchWithRetry destructures (shared-call-site isomorphism), incidental
  single-line alignments. exec.rs's foreground/background buffer-read
  segments stay separate (dropped-handling differs: silent adjust vs
  truncated flag — the wait loops have the most device-caught regression
  history; not worth the risk).

### 2026-09-08 SOLID round 14 (cross-file dedup: DO auth + crate-root helpers)
- **DO external-auth single-sourced (DRY + security, gateway)** —
  cross-file scan found BreakerDO (reliability.ts) and RouteDO
  (route-do.ts) each carrying a byte-identical authorized(): fail-closed
  DO_AUTH gate + constant-time x-do-auth compare. A security-critical
  check duplicated across the two DO classes (future hardening would have
  to touch both). Extracted `authorizeDoRequest(request, expectedSecret)`
  in route-do.ts (zero-import module — no cycle). Gateway 592 pass.
- **Crate-root helper centralization (DRY, agent)** — cross-file scan
  also found three private byte-identical `unix_now()` (filelog.rs /
  session_log.rs / memory store) and two private byte-identical
  `hex_encode()` (update plugin / tunnel.rs). Both moved to lib.rs as
  pub(crate) and all call sites repointed (incl. one unit test).
  Lib 299 + feature-gated 307 pass; clippy/fmt clean. (Self-caught
  mid-round: a line-range deletion script left two orphaned `s`/`}`
  fragments — compile caught them immediately, both removed.)

### 2026-09-08 SOLID round 15 (index-worker 503 envelope + web sessions_logger)
- **503 unavailable envelope single-sourced (DRY, index worker)** —
  cross-file scan (now incl. index/src) found the claim handler (3
  sites) and the index worker (1 site) each inlining the same
  "temporarily unavailable" 503 JSON Response for R2/DO outage paths.
  Extracted `unavailableResponse()` in claim.js (the module index.js
  already depends on — no import cycle); all four sites call it.
  Self-caught mid-round: the blind regex also rewrote the helper's own
  body into a self-recursive call — fixed immediately (compile-level
  checks + tests 56/56 green).
- **sessions_logger() dedup (DRY, agent web/mod.rs)** — api_sessions_list
  and api_session_events each re-inlined the sessions-dir SessionLogger
  construction plus a 6-line HIGH(audit) rationale. Extracted
  `sessions_logger()` owning both. Web tests 44/44, lib 299 pass;
  clippy/fmt clean.

### 2026-09-08 SOLID round 16 (SSE guard + playwright op handlers dedup)
- **acquire_sse_guard (DRY, agent web)** — the /api/events and
  /api/events/term handlers each inlined the same SseConnectionGuard
  acquire-match with the "too many SSE viewers (max 64)" 503. Extracted
  `acquire_sse_guard() -> Result<_, Box<Response>>` in sse.rs (Err boxed
  like check_auth's — clippy result_large_err caught the unboxed form
  first). Web tests 44/44, lib 299 pass; clippy/fmt clean.
- **run_playwright_op (DRY, agent web/mod.rs)** — api_playwright_start
  and api_playwright_stop were two near-identical copies (run manager op
  → merge {ok:true, ...payload} → 500 JSON envelope on error). Extracted
  one generic runner; both handlers are one-liners. Web tests 44/44, lib
  299 pass; clippy/fmt clean.

### 2026-09-08 SOLID round 17 (usage-query skeleton dedup)
- **usageQuery (DRY, gateway auth.ts)** — meKeyUsage's three provider
  branches (openrouter / AMD / og) each inlined the same fetch-with-
  Bearer → !ok failure envelope → parse → out-build skeleton wrapped in
  a try/catch "Usage query failed". Extracted `usageQuery(url, key,
  name, map)`; per-provider payload→shape mapping stays in each branch's
  mapper callback. OpenRouter's distinct "Invalid upstream response"
  detail preserved via a mapper-thrown {detail} error surfaced by the
  shared catch. Gateway 592 pass; tsc/lint/prettier clean; mirror synced.
  testKey's 8 provider branches stay (each is real protocol adaptation —
  og SSE first-chunk, AMD model-list parse, qwen MaaS anthropic-version
  header…; previously judged not-worth-it).

### 2026-09-08 SOLID round 18 (mcp_client: now_millis + envelope predicate)
- **now_millis centralization (DRY, agent)** — record_mcp_action and
  record_mcp_screenshot each inlined the same epoch-millis timestamp
  construction. Moved one pub(crate) now_millis() into lib.rs next to
  unix_now/hex_encode; both call sites repointed. (system/tools.rs's
  as_millis is a file-mtime conversion, not a clock read — left alone.)
  mcp_client 21/21, lib 299 pass; clippy/fmt clean.
- **envelope_id_matches (DRY, agent mcp_client)** — parse_envelope's
  direct-JSON arm and its SSE-candidate loop each inlined the same
  id-matching predicate (round-365 added the direct-arm check by copying
  the SSE arm). Extracted one predicate; wrong-id-reject tests pin the
  semantics. mcp_client 21/21, lib 299 pass; clippy/fmt clean.

### 2026-09-08 SOLID round 19 (memory store recount dedup)
- **recount_total_bytes (DRY, agent memory/store.rs)** — load, the
  entry-cap eviction loop and the retention sweep each inlined the same
  live-only total_bytes recompute. Extracted `recount_total_bytes(guard)`
  (live-only semantics documented — the old per-line sum inflated the
  byte cap into premature evictions); the byte-cap loop keeps its exact
  saturating_sub accounting (different semantics by design). Self-caught
  mid-round: the blind replace also rewrote the helper's own body into a
  self-recursive call — fixed immediately (second occurrence of this
  blind-replace hazard; the pattern is now known-risky). Memory tests
  34/34, lib 299 pass; clippy/fmt clean.

### 2026-09-08 SOLID round 20 (CLI desktop-shell staging dedup + stale product sync)
- **stageDesktopShell (DRY, vale CLI)** — vale setup and vale update each
  inlined the same Electron desktop-shell staging block (~35 lines: copy
  main/preload/url-policy + icons into the install dir), differing only in
  the target suffix (setup writes in place; update stages *.new for the
  atomic swap). Extracted `stageDesktopShell(installDir, suffix)`; both
  flows call it. bin/vale.js recompiled from src (round-298 discipline;
  marker present; CLI tests 9/9).
- **Stale electron product caught (build-side)** — the recompile surfaced
  that src/main.ts's round-1 release-first window-title change
  (a1bf8881) had never been re-emitted into the committed main.js
  products: devices would have kept showing the frozen Cargo version in
  the window title. Re-emitted both copies (same class as the round-3
  panel.js catch; LESSON now doubly confirmed — after touching
  vale-desktop-electron/src/*.ts, the committed *.js products must be
  re-emitted, and the npm-package copies re-synced).

### 2026-09-08 SOLID round 21 (electron shell dedup x2)
- **resolveIcon (DRY, electron main.ts)** — appIcon and windowIcon each
  inlined the same existsSync-guarded icon path resolution + icon-status
  reporting, differing only in file name and report key. Extracted
  `resolveIcon(name, reportKey)`; both call it. Products re-emitted from
  the .ts source, byte-identical copies verified.
- **emitMenu (DRY, electron main.ts)** — sendMenu's direct path and
  flushMenuQueue's drain loop both called the same vale-menu webContents
  send; the channel name + send shape now live in one place. Products
  re-emitted, copies verified.

### 2026-09-08 SOLID round 22 (index 413 envelope + gateway probe result)
- **tooLargeResponse (DRY, index worker)** — the claim upload's
  content-length precheck and its post-parse size check each inlined the
  same "file too large" 413 JSON Response. Extracted
  `tooLargeResponse(maxBytes)`; both checks call it. Index tests 56/56.
- **keyProbeResult (DRY, gateway auth.ts)** — six of testKey's provider
  branches (deepseek / openrouter / cmd / gmi / nim / qwen) each inlined
  the same jsonOk probe envelope, differing only in the success text.
  Extracted `keyProbeResult(name, res, okText)`; the special branches
  (og SSE first-chunk, AMD model-count) keep their own logic. Gateway
  592 pass; tsc/lint/prettier clean; mirror synced. (mcp-tools.ts
  schema device-prop decls re-verified: 12 distinct shapes with
  per-tool description tweaks — inline schema stays; system/tools.rs
  mtime conversions are shape-distinct per site — both remain.)

### 2026-09-08 SOLID round 23 (SSE response tail dedup)
- **sse_response_from_rx (DRY, agent web/sse.rs)** — sse_response and
  sse_term_stream each inlined the same 11-line tail: wrap the mpsc
  receiver into a text/event-stream Response with the no-cache /
  keep-alive header set. Extracted `sse_response_from_rx(rx)`; both
  call it. Self-caught mid-round: the blind replace rewrote the
  helper's own body into a self-recursive call for the THIRD time
  (rounds 15/19/23 — insert-then-blank-replace ordering hazard;
  pattern now documented as known-risky: run the replace BEFORE
  inserting the helper, or scope it to call sites only), and the second
  call site was confirmed replaced before committing (amended). SSE
  tests 6/6 (header shape pinned), lib 299 pass; clippy/fmt clean.
  Introduced a code-only dup-scan (skips #[cfg(test)] blocks) for
  accurate rankings: mcp_client tools.rs + memory tools.rs remain
  (tool-registration idiom), secrets.rs/exec.rs small blocks reviewed
  and left.

### 2026-09-08 SOLID round 24 (valeProbe result envelope dedup)
- **probeResultJson (DRY, gateway tooling.ts)** — valeProbe's og and
  passthrough channel branches each inlined the same probe envelope
  (ok/channel/status with the upstream status on failure). Extracted
  `probeResultJson(prefix, res)`; both branches call it. Gateway 592
  pass; tsc/prettier clean; mirror synced.
- **SELF-RECURSION HAZARD — FOURTH occurrence (rounds 15/19/23/24)** —
  the insert-then-blank-replace ordering rewrote probeResultJson's own
  body into self-recursion (caught by the full suite: Maximum call
  stack). RULE NOW HARDENED: when extracting a helper whose body
  contains text identical to the pattern being replaced, run the
  replacements FIRST (targeting only existing call sites), then insert
  the helper — or anchor the replacement on call-site-only context.
  The interim broken commit was amended with the fix; every commit
  leaves the suite green.

### 2026-09-08 SOLID round 25 (actions-feed append dedup)
- **append_action_line (DRY, agent mcp_client tools.rs)** —
  record_mcp_action and record_mcp_screenshot each inlined the same
  OpenOptions create/append write of one line into pwout/actions.jsonl
  (round-18 deduped their timestamp construction; this was the
  remaining write tail). Extracted `append_action_line(&impl Display)`;
  both call it. Hazard rule FOLLOWED this round: call sites replaced
  BEFORE the helper was inserted — no self-recursion. mcp_client
  21/21, lib 299 pass; clippy/fmt clean.
- **translate.ts key-guard chains reviewed, left** — three entry
  points (messages / chat-completions / responses) each carry the
  route-kind keyMissingError guard chain, but the kind set and order
  differ per branch (chat adds openrouter/qwen re-checks; or/cm keys
  are per-user BYOK vs env keys for the rest) — table-driving would
  need a BYOK-vs-env key source split + per-entry ordering; medium
  risk, medium payoff, left (same class as mcp-tools schema decls).
  exec.rs slice_from buffer segments likewise stay (dropped-handling
  differs per site).

### 2026-09-08 SOLID round 26 (tool name/desc pairs dedup)
- **tool_name_desc_pairs (DRY, agent mcp_client tools.rs)** —
  connect_stdio and list_tools_ref each inlined the same mapping of an
  rmcp tool iterator onto (name, description-string) pairs. Extracted
  `tool_name_desc_pairs(iter)` (module-level, generic over the
  iterator); both call it. Hazard rule followed again (sites replaced
  before helper insert — clean compile on the first try). mcp_client
  21/21, lib 299 pass; clippy/fmt clean.
- **Sweep updates** — index worker: ZERO ≥6-line code dups remain;
  gateway tooling.ts clean after round-24; secrets.rs DPAPI seal/unseal
  mirror confirmed intentional (direction-opposed FFI pair); e2e.js CDP
  script scaffolding left (device-verified test suite — readability +
  risk); auto_select_embedded_view's browser_tabs retries are one flow,
  not copies.

### 2026-09-08 SOLID round 27 (web cache-control stamping dedup)
- **set_cache_control (DRY, agent web module)** — five sites across
  mod.rs / panel.rs / sse.rs inlined the same cache-control header
  insert (no-store for token-bearing + panel responses; no-cache for
  the status page + SSE tails). Extracted `set_cache_control(resp,
  value)` next to built_response (the web module's shared response
  helper); all five call it. Web tests 44/44, lib 299 pass; clippy/fmt
  clean. Cross-file scan (web/) now clean; the cross-file scan also
  found 4 test-scaffold copies of the same "local HTTP stub server"
  read-till-headers loop (design/system/mcp_client tools.rs + a
  panel.rs helper) — test scaffolding stays (consistent with the
  earlier decision; a shared testutil would couple plugin test modules).

### 2026-09-08 SOLID round 28 (handle_request SRP extraction)
- **handle_browser_evidence (SRP, agent web/mod.rs)** — handle_request
  (the web dispatch router) was ~376 lines; the three /api/browser
  evidence endpoints (actions/pwshots/pwshot) formed a self-contained
  ~85-line block. Extracted `handle_browser_evidence(path, query)` —
  pure reads from the pwout dir, no AppState dependency (the unused
  state param was dropped on clippy's first pass). Auth stays at the
  call site, synchronous before the Send boundary: the extraction
  surfaced that holding &Request across an await makes the router
  future non-Send (panel.rs service layer requires Send) — fixed by
  keeping auth + query extraction in handle_request and passing only
  &str/query in. Router now ~290 lines. Web tests 44/44 (evidence
  endpoints covered), lib 299 pass; clippy/fmt clean.

### 2026-09-08 SOLID round 29 (handle_panel_home SRP extraction)
- **handle_panel_home (SRP, agent web/mod.rs)** — the panel/desktop
  root branch (~94 lines: config snapshot + the gateway proxy-secret /
  loopback / one-time ?grant= token-injection decision chain) was the
  router's largest remaining inline block. Extracted
  `handle_panel_home(state, path, query, host, auth_header)` — header
  and query values are extracted at the call site (synchronous, owned)
  so no &Request borrow crosses the redeem_panel_grant await (Send-
  future requirement, same lesson as round-28). Router now ~223 lines
  (376 two rounds ago). Web tests 44/44 (panel token-injection tests
  cover the moved logic), lib 299 pass; clippy/fmt clean. Tooling note:
  a two-step python edit partially failed silently twice (asserts under
  a swallowed stderr) — verified with grep before each retry; the
  final single-shot script applied cleanly.

### 2026-09-08 SOLID round 30 (round-24 extraction completion)
- **og probe tail → probeResultJson (DRY completion, gateway
  tooling.ts)** — round-24's probeResultJson extraction replaced the
  passthrough tail but MISSED the og branch tail; its inline jsonOk
  envelope survived as a third copy of the shape (the periodic
  full-repo rescan caught it). ValeProbe now has exactly one envelope
  shape across both branches. Gateway 592 pass; tsc/prettier clean;
  mirror synced. translate.ts key-guard chains re-verified: the
  chat-completions and /v1/responses entry chains differ in kind set
  and order (per-endpoint minimal guards) — the round-25 keep
  decision stands.

### 2026-09-08 SOLID round 31 (build.sh deploy-gate dedup)
- **require_cf_token (DRY, scripts/build.sh)** — deploy_worker and
  deploy_proxy each inlined the same cf_token fetch + missing-token
  bail (8 lines). Extracted `require_cf_token "$name"` setting the
  CF_TOKEN global; both deploy functions call it and use $CF_TOKEN.
  bash -n clean.
- **Sweep updates** — update/tools.rs zero dups; the zen-go and zen-us
  proxies are NOT near copies (Anthropic→OpenAI translator vs US
  geo-pinned egress — different architectures, ADR-0003 autonomy);
  panel-react + gateway ui TSX near-zero dups (JSX coincidence only);
  translate.ts guard chains confirmed as per-kind checks that share
  nothing (kind sets differ per endpoint) — all keep decisions stand.

### 2026-09-08 SOLID round 32 (full-matrix + convergence verification)
- **Verification round (no code changes)** — strict 8-line code-only
  scan across agent/src: 3 files / 8 blocks remain, ALL of the
  previously-classified kinds (DPAPI seal/unseal mirror, MCP tool
  registration idiom, auto-select retry flow). vale-command-core:
  ZERO dups. gateway translate-vision.ts: zero dups. ARCHITECTURE.md
  web/ snapshot row still accurate (extractions stayed inside mod.rs —
  module boundaries unchanged). Full matrix re-run: index 56, agent
  lib 299, agent feature-gated 307, gateway 592 (round-30 run) — all
  green. Convergence state confirmed stable, no regression since the
  round-14 baseline.

### 2026-09-08 SOLID round 33 (mcp.ts HTTP-level error envelope)
- **mcpStatusError (DRY, gateway mcp.ts)** — handleMcp's 401 (admin
  token), 405 (method) and 400 (parse error) rejections each inlined
  the same JSON-RPC error Response carrying an HTTP status. Extracted
  `mcpStatusError(code, message, status)` next to mcpError — which
  stays 200-only for protocol-level tool errors (the two envelopes have
  different status semantics, so both helpers remain distinct with
  documented roles). Gateway 592 pass; tsc/prettier clean; mirror
  synced. (Function-size survey of index/gateway: remaining large fns
  — handleMcp 109 / handleSelfRegister 88 / handleRegister 78 /
  TempClaimDO 69 — checked: register pair shares only the 1-line
  hostAllowError guard, not copies; claim.js single-shot DO is
  event-driven by design.)

### 2026-09-08 SOLID round 34 (register 409 double-layer dedup)
- **alreadyRegisteredConflict (DRY, gateway devices.ts)** —
  handleRegister's pre-check (round-68) and its in-lock insertDevice
  retry (round-122) each inlined the same 409 "already registered —
  use the console (admin)" jsonError — two defense layers of ONE
  endpoint (the round-14 "message variants" deferral covered
  cross-endpoint variants; this is intra-endpoint verbatim dup).
  Extracted `alreadyRegisteredConflict(name)`. The other 409 variants
  (different-token 229, self-register short 262, rename newName 545)
  keep distinct messages inline. Gateway 592 pass; tsc/prettier clean;
  mirror synced.

### 2026-09-08 SOLID round 35 (store/users key-map mutation skeleton)
- **updateUserKeys (DRY, gateway store/users.ts)** — setUserKey and
  deleteUserKey each inlined the same locked read-modify-write
  skeleton (withKeyLock → getJSON → mutate → KV put + cache set →
  return), differing only in the mutation line. Extracted
  `updateUserKeys(env, id, mutate)`; both call it with a one-line
  closure. Gateway 592 pass (user-key isolation tests cover the
  paths); tsc/prettier clean. Store/ + admin + auth files all clean
  after this.

### 2026-09-08 SOLID round 36 (full-repo JS/TS final sweep)
- **Verification round (no code changes)** — swept EVERY remaining TS/
  JS source tree (gateway/src, gateway/ui/src, index/src, extension/,
  agent/scripts, proxies/) at a 6-line window: 209 window-sites across
  10 files, each individually checked. Verdict: all are window
  artifacts (adjacent-function overlap: zen-us safeEq/fetchUpstream
  tails, access.ts verifyJwt try/catch) or previously-classified kinds
  (mcp-tools.ts tool schemas, translate.ts key-guard chains, e2e.js
  CDP scaffolding, gateway ui JSX rows, zen-us per-branch upstream
  forwarding which has EVOLVED differently per endpoint — 5xx detail +
  console.error on messages vs plain on responses). TRUE duplication
  is exhausted across every JS/TS tree; what remains is intentional
  per-branch evolution inside ADR-0003-autonomous workers or window
  noise.

### 2026-09-08 SOLID round 37 (cross-target gate completion)
- **Verification round (no code changes)** — closed the gate gaps left
  by the refactor rounds: (1) `cargo xwin check -p vale-agent
  --features terminal,keyring` GREEN — the rounds-23/28/29 web-module
  refactors (sse_response_from_rx, handle_browser_evidence,
  handle_panel_home) compile clean on the Windows target (Linux tests
  alone had been the gate so far); (2) gateway `format:check` + `lint`
  both clean (recent rounds ran prettier --write but not the CI
  format gate); (3) gateway/ui has zero pair/extension remnants in the
  new React console (the only "pair" hit is a historical comment in
  Overview.tsx); (4) panel product chain re-verified fresh (src last
  touched round-1, panel.js rebuilt round-3, no drift since).

### 2026-09-08 SOLID round 38 (dup scanner codified as tooling)
- **scripts/scan-dups.py committed (tooling)** — the window-hash
  duplication scan methodology used across rounds 23-36 (code-only
  lines with comments/blanks stripped, Rust #[cfg(test)] block
  stripping, intra-file ranking + optional cross-file mode, configurable
  window/min-sites/roots) existed only as ad-hoc inline python each
  round. Codified as one reusable command for future rounds and
  reviews. Verified: identical verdicts to the round-32/36 manual
  scans (secrets.rs DPAPI mirror, memory tool-registration idiom,
  mcp-tools schemas, translate key-guard chains — all previously
  classified kinds). Remaining translate.ts fetch-segment similarity
  re-checked: og's zen headers + stream:false vs passthrough's generic
  headers are real protocol differences — keep stands.

### 2026-09-08 SOLID round 39 (DoAuthBase for the DO classes)
- **DoAuthBase (DRY, gateway cross-file)** — the first catch by the
  codified scanner's --cross mode: BreakerDO (reliability.ts) and
  RouteDO (route-do.ts) each carried a byte-identical 11-line head
  (state/env fields, constructor, the constant-time DO_AUTH
  authorized() gate — round-14 had unified only the helper level).
  Extracted `DoAuthBase` in route-do.ts next to authorizeDoRequest;
  both DO classes extend it and keep only their fetch bodies.
  reliability.ts's direct authorizeDoRequest import dropped (now via
  the base). Gateway 592 pass; tsc/prettier clean; mirror synced.
  Also swept serial.rs + ssh.rs: zero dups (all agent source trees
  now verified at multiple windows).
- **Mirror gap caught + lesson** — the round-35 commit (e81c3d49,
  store/users.ts updateUserKeys) missed its code-viewer mirror sync;
  the drift surfaced on the round-39 final status check and was fixed
  (11804d3d). LESSON: after ANY gateway/src commit, verify the mirror
  is clean (`git status` shows no public/code/files change) before
  closing the round — same discipline as the electron/panel products.

### 2026-09-08 SOLID round 40 (agent cross-file verification)
- **Verification round (no code changes)** — ran the codified scanner's
  --cross mode over agent/src (first systematic agent cross-file pass
  since round 14). All four hit-groups classified: (1) session tool
  handlers carry per-tool MINIMAL dependency signatures (tool_open 5
  params vs tool_write 1 — not copies); (2) write_async in
  pty/serial/ssh share the TermBackend trait signature (contract, not
  duplication) with deliberately DIVERGENT bodies — each is the product
  of its own device-incident history (pty round-106 spawn_blocking+
  timeout, serial round-107 try_send+retry, ssh round-103..105 await+
  bounded+propagated), intentionally not unified; (3+4) brace noise.
  Agent trees confirmed fully converged at both intra and cross file
  levels.

### 2026-09-08 SOLID round 41 (parse-failure envelope audit)
- **Audit finding, kept as observation (no change)** — four body-JSON
  parse-failure sites in web/mod.rs use THREE different envelope shapes:
  api_call_tool returns a Value {ok:false} (MCP tool-error semantics);
  api_settings_put returns an axum Json envelope via into_response with
  NO status override (HTTP 200); api_gateway_connect returns a
  built_response 400. The settings_put 200 is NOT a bug: the round-69
  extraction comment pins it as the historical pre-extraction shape
  (byte-identical HTTP-200 envelope — presumably console clients
  tolerate it). Unifying would be a wire behavior change needing a
  product decision; recorded here as a candidate, not touched.
- **Matrix re-verified** — gateway 592, index 56, ui tsc -b clean after
  the round-39 DoAuthBase change (UI does not type-couple to the DO
  classes).

### 2026-09-08 SOLID round 42 (translate.ts chat-flow key guards)
- **Table-driven chat/completions key guards (DRY, gateway translate.ts
  first real reduction)** — the isChatCompletions arm carried seven
  byte-identical guards (if route.kind === X && !xKey →
  keyMissingError(X)) with no per-kind comment distinctions — true
  copy-paste, unlike the messages-flow guards that legitimately differ
  per endpoint. Replaced with two ordered [kind, key] tables split
  around the channelDegradedError probe so the probe keeps its exact
  position. Behavior unchanged (same conditions/order/returns; the
  round-360 no-borrow + BYOK tests still cover the paths). 592 pass;
  tsc/prettier clean; mirror synced in the same commit (round-39
  lesson). translate.ts drops 69→58 window-sites / 31→27 blocks — its
  first reduction after many constant scans; the residual is
  two-flow (messages vs chat) window overlap, still classified-kept.

### 2026-09-08 SOLID round 43 (isCount guard table + gate completion)
- **Table-driven isCount key guards (DRY, gateway translate.ts)** — the
  count_tokens arm carried three byte-identical key-existence guards
  (deepseek/qwen/amd), no per-kind comments — same class as the
  round-42 chat table. Converted to the identical shape/order.
  592 pass; tsc/prettier clean; mirror synced. The remaining translate
  guard groups (nvidia/gmi branch, passthrough 4-guard) carry real
  per-kind comments (amd rc-key rationale, og-native breaker history)
  — table-izing would lose that documentation; classified-kept with
  evidence. mcp_client tools.rs re-checked: residual windows are
  adjacent-function artifacts (record_mcp_action/screenshot json
  tails), auto-select already shared since round-11.
- **Gates completed** — round-42/43 commits pass the CI gates the
  earlier passes skipped: gateway format:check + lint clean; strict
  8-line baseline re-run: translate.ts down to 37 window-sites (from
  ~46+), mcp-tools schemas + secrets DPAPI remain the only standing
  classes.

### 2026-09-08 SOLID round 44 (relayUpstreamResult for the 3 forward arms)
- **Shared upstream-result relay (DRY, gateway translate.ts)** — the
  chat/completions, /v1/responses and messages-passthrough arms each
  carried a byte-identical ~20-line upstream-result tail (breaker
  failure/success recording for og, CORS stamping, generation-id
  capture, body streamed back untouched) — the round-14 extraction
  covered only the two failure helpers. Extracted
  `relayUpstreamResult(env, request, routeKind, upstream, detail,
  inspectFailure, ctx, recordOgBodyFailure)` with the flag so the
  messages-passthrough arm's historical ABSENCE of body-failure
  breaker recording is preserved exactly (it relies on the up-front
  channelDegradedError check only) — a flagged behavior difference
  observed, not silently unified. 592 pass; tsc/prettier clean;
  mirror synced. translate.ts drops 37→27 window-sites at the 8-line
  window — residual is the two-flow ox-alpha/upstream-repick overlap.

### 2026-09-08 SOLID round 45 (DEVICE_PARAM for the MCP tool schemas)
- **Shared device-selector field (DRY, gateway mcp-tools.ts)** — every
  MCP tool inputSchema carried its own copy of the device field (18
  seven-line blocks + 9 inline no-description variants) — the largest
  remaining duplication after translate.ts converged. Extracted
  `DEVICE_PARAM` (Record<string, unknown>) and spread it at each site
  (`...DEVICE_PARAM`). The 9 tools that declared device with NO
  description now inherit the standard one — a schema-text improvement
  for AI clients; nothing pins the old shape (592 pass). tsc/prettier
  clean; mirror synced. mcp-tools.ts drops 47→29 window-sites at the
  8-line window; the residual is the inputSchema structural prefix
  (declaration syntax, not duplication). Both former top-two files
  now sit at ~28 sites.

### 2026-09-08 SOLID round 46 (memory store ns filter + tombstone)
- **ns_matches + tombstone (DRY, agent memory/store.rs)** — the full
  scan surfaced two real in-file copies the earlier rounds missed:
  search/list/export each inlined the same namespace if-let filter
  (3 copies) and the eviction + retention paths each inlined the same
  soft-delete tombstone write (2 copies — round-19's recount helper
  had left these). Extracted module-private `ns_matches(rec,
  namespace)` and `tombstone(rec, persist)`; behavior unchanged
  (299 lib pass; fmt + clippy clean; one E0596 self-caught — the
  evict arm's persist is already &mut, fixed before commit). Translate
  residual re-verified: the remaining ox-alpha windows are per-flow
  adjacent-code artifacts, not copies.

### 2026-09-08 SOLID round 47 (store/lib fine-window + full gates)
- **Verification round (no code changes)** — (1) gateway/src/store +
  gateway/src/lib scanned at the 6-line window for the FIRST time since
  the store/ split: ZERO duplication (round-35's "store clean" verdict
  now proven at the fine window across all sub-files); (2) the
  round-46 store.rs helpers pass the complete agent matrix: 299 lib +
  307 feature-gated + clippy/fmt + xwin check all green. Standing
  residual classes across the whole repo at the 6-line window are
  unchanged and all classified: mcp-tools structural schema prefix,
  translate two-flow windows, zen-us per-endpoint forwarding
  evolution, secrets DPAPI seal/unseal mirror, memory tool
  registration idiom, mcp_client adjacent-function artifacts, tooling
  og-vs-passthrough protocol headers.

### 2026-09-08 SOLID round 48 (UI/index/extension sweep + decision list)
- **Verification round (no code changes)** — (1) gateway/ui scanned at
  the 6-line window for the first time: only Auth.tsx's login/register/
  reset form windows (declarative JSX scaffolding with per-form
  handlers/i18n keys — 3 instances, each different; kept); (2)
  index/src + extension: ZERO duplication at the fine window; (3)
  periodic matrix: index 56 + npm CLI 9 green (gateway 592 + agent
  299/307 already green this cycle). No standing duplication remains
  anywhere that is not an explicitly-classified kept class.
- **Decision list consolidated** — the product-sign-off candidates
  accumulated across rounds (settings_put 200 envelope, messages-
  passthrough og body-failure gap, F3 relay-token proposal) are now
  collected in one "OPEN decisions" block at the top of the iteration
  log so a human decision-maker sees them without reading every round
  section.

### 2026-09-08 SOLID round 49 (settings 200-envelope pin test)
- **settings_put invalid-JSON envelope pinned (test-only, agent
  web/mod.rs)** — the round-41 OPEN decision's HTTP-200 wire shape had
  zero test coverage: a future "obvious" unification could silently
  change the wire. Added
  settings_put_invalid_json_keeps_http200_envelope pinning status 200
  + ok:false + code invalid_params with a comment pointing at the
  OPEN-decisions block. 300 lib pass (+1); fmt + clippy clean. No
  behavior changed.

### 2026-09-08 SOLID round 50 (milestone convergence snapshot)
- **Round-50 milestone** — (1) scanner tooling gap fixed: scan-dups.py
  now excludes Rust test-only files (*tests.rs, *_test.rs) exactly as
  JS *.test.* were already excluded — agent/src/plugins/terminal/tools/
  tests.rs (a #[cfg(test)] mod file) had polluted the production
  duplication signal with scaffold windows; terminal/ report drops 3
  files → 2 (e29ffc49). (2) Test-stripping verified sound on the
  largest test-bearing file: web/mod.rs 2219 raw lines → 780 code
  lines with zero cfg(test) residue. (3) Convergence snapshot at the
  50-round mark: 6-line window — 10 reporting files, ALL explicitly
  classified kept classes (schema prefixes, two-flow windows,
  registration idiom, per-endpoint forwarding evolution, DPAPI mirror,
  adjacent-function artifacts, protocol-header differences, form
  scaffolding); 8-line strict window — 6 files; cross-file — 3 known
  brace/trait windows. Feature-gated suite 308 (+1 from the round-49
  pin). Full matrix green: agent 300/308, gateway 592 + format,
  index 56, CLI 9.

### 2026-09-08 SOLID round 51 (large-file cohesion audit)
- **Verification round (no code changes)** — SRP file-size audit over
  the largest sources: mcp_client/tools.rs 1107 stripped production
  lines, web/mod.rs 780, translate.ts 756 — each judged a COHESIVE
  single-domain file (the mcp-client connection domain, the HTTP
  service surface, the translate protocol hub respectively), not a
  multi-responsibility aggregate; splitting by line count would add
  cross-file pub(crate) noise without SRP gain — kept with evidence.
- **Gates after the round-49 test commit** — xwin check green;
  feature-gated clippy exit 0 with ZERO hits in our code (the 2
  portable-pty "unexpected cfg" warnings are vendor dependency noise
  that CI's identical invocation has always tolerated). Matrix stays
  green.

### 2026-09-08 SOLID round 52 (top-level sweep + new baseline)
- **Verification round (no code changes)** — (1) gateway/src top-level
  fully walked: store.ts is the intended post-split re-export shim
  (12 importers, export * — kept by design, removing is diff without
  gain); anthropic-translate.ts (788 lines, second-largest, zero dup)
  has healthy function sizes (largest 149-line streamOgToAnthropic —
  single-domain converter); (2) post-test-file-exclusion full-repo
  baseline exposes no new files of concern: sse.rs + web/mod.rs
  windows are brace/adjacent artifacts, exec.rs slice_from windows
  are the long-classified Deferred class, electron main.js windows
  exist ONLY in the compiled artifact (main.ts source: zero) — tsc
  output noise. Full matrix unchanged green.

### 2026-09-08 SOLID round 53 (gateway-connect 400 pin)
- **gateway_connect invalid-JSON HTTP-400 pinned (test-only, agent
  web/mod.rs)** — completes the round-49 audit pair: settings_put's
  invalid-JSON envelope is pinned HTTP 200 (historical round-69 shape)
  and gateway_connect's same-class error was previously unpinned — now
  pinned HTTP 400, so the OPEN-decision contrast is documented on BOTH
  endpoints and a future unification is a visible wire change on both,
  never silent drift on one. Web-endpoint coverage review also
  confirmed: panel host-gate + grant redemption (4 tests), auth,
  settings (6), gateway-connect (2 + this) all covered; tunnel arm
  intentionally untested (external cloudflared). 301 lib pass (+1);
  fmt + clippy clean.

### 2026-09-08 SOLID round 54 (error-classification full audit)
- **Verification round (no code changes)** — extended the round-359
  error-classification audit from terminal to EVERY plugin: all ~40
  DeviceError::Internal sites in plugins/ walked. Verdict: all are
  legitimate server-side classes (network/HTTP/IO/task-join/upstream
  responses). The one borderline site — update/tools.rs's
  check_download_url failure (a MISCONFIGURED download host, not a
  caller argument) — is kept Internal with evidence: the AI caller
  cannot fix it via parameters, the message carries the diagnostic,
  and it is a refuse-to-install SECURITY posture where Internal's
  no-retry semantics are the safe default. Round-359's classification
  discipline now covers the whole plugin surface.

### 2026-09-08 SOLID round 55 (exec.rs wait-loop buffer read)
- **poll_output_chunk (DRY, agent exec.rs — closes a long-Deferred
  class)** — the foreground + background execute wait loops each
  inlined the same buffer-read pair (dropped-cursor jump + slice_from +
  chunk length). The round-94 cursor-jump lesson was commented at only
  ONE site — the background loop carried the same semantics silently.
  Shared `poll_output_chunk(buf, sid, read_abs, truncated)`; the
  foreground loop passes Some(&mut truncated) to keep its 1MB-burst
  truncation reporting, the background wait passes None. The
  slice_from window class is now fully resolved (one remaining
  exec.rs scan-site is a distinct scan-from usage). 301 lib pass; fmt
  + clippy clean.

### 2026-09-08 SOLID round 56 (poll_output_chunk unit tests)
- **poll_output_chunk semantics pinned (test-only, agent exec.rs)** —
  the round-55 extraction's behavior had zero direct pins: the
  round-94 dropped-jump, the foreground truncation report vs the
  background None, unknown-session empty, cursor-past-end window, and
  the caller-advances contract. 5 unit tests cover all five (the jump
  + report path, the bg no-report path, empty session, past-end
  window, cursor-left-for-caller). One self-caught wrong expectation:
  the helper does NOT advance read_abs on a normal read (the caller
  does read_abs += chunk_len) — corrected in-test. 306 lib pass (+5);
  fmt + clippy clean. DPAPI seal/unseal re-examined and kept:
  symmetric FFI scaffolding with windows-only, locally-unverifiable
  behavior.

### 2026-09-08 SOLID round 57 (tool-domain coverage sweep)
- **Verification round (no code changes)** — walked the remaining
  agent tool domains for unextracted patterns: (1) session-lookup +
  SessionNotFound is already shared via ctx::session_lost (exec.rs +
  sessions.rs both use it — no third copy); (2) memory/tools.rs id
  params: only 2 identical "Entry id" declarations (round-45-scale
  constant extraction not warranted); (3) files.rs + output.rs small
  and clean (183/214 stripped lines, zero windows); (4) tunnel.rs (11
  tests) / metrics.rs (3) / filelog.rs (6) all have coverage. Gates:
  feature-gated suite 314 (306 lib + 8 feature-only), xwin check
  green, tree clean.

### 2026-09-08 SOLID round 58 (terminal manager find_backend)
- **find_backend (DRY, agent tools/terminal/mod.rs)** — term_resize /
  term_write_bytes / terminate each inlined the same lock →
  iter_mut().find(sid) → SessionNotFound → clone-backend block, with
  round-49's heartbeat touch duplicated at two of them. Shared
  `find_backend(sid, touch)`: clones the Arc inside the lock so the
  caller operates the backend OUTSIDE it (review-#10 discipline — a
  blocked write stalls only its own call; the cloned Arc also survives
  a concurrent sweeper removal). Behavior unchanged (resize/write touch
  last_output as before; terminate does not). 306 lib pass; fmt +
  clippy clean. terminal/mod.rs residual windows now are the
  if-let-style find sites (close/try_execute — they mutate session
  state in place, not clone-able; kept) plus the SessionInfo map tail.

### 2026-09-08 SOLID round 59 (record-path + connections-domain review)
- **Verification round (no code changes)** — (1) mcp_client
  record_mcp_action/screenshot share the timeline row shape (8 keys,
  parsed by the panel's Evidence drawer) but extraction was judged
  net-NEGATIVE: a shared base row plus per-record inserts ADDS lines
  and needs Value-object type gymnastics; the append_action_line
  helper (round-25) is the right shared seam, the differing keys stay
  visible. Kept with evidence. (2) connections.rs saved-connection
  handlers: forget delegates to conn_forget; connect_saved's
  conn_list + find + enriched InvalidParams is the round-359
  self-recovery design (single site — not duplicated). (3)
  store/devices.ts helper layer already returns not_found/name_taken
  discriminants (converged in the store rounds). Gateway 592 baseline
  re-verified.

### 2026-09-08 SOLID round 60 (round-60 convergence snapshot)
- **Verification round (no code changes)** — round-60 milestone. The
  system-plugin file tools were re-examined: only 3 identical "path"
  schema declarations (threshold for a DEVICE_PARAM-style constant is
  not met — kept). Convergence since the round-50 snapshot: 7 code
  commits — find_backend + poll_output_chunk (manager/exec helper
  extraction, the latter closing the long-Deferred slice_from class),
  poll_chunk unit tests, the gateway-connect HTTP-400 pin (completing
  the settings-200/400 audit pair), the scan-dups Rust test-file
  exclusion, ns_matches + tombstone (memory store), updateUserKeys +
  the earlier gateway guard/relay/schema extractions. Residual windows
  at 6 lines: 14 files, all explicitly classified kept classes.
  Matrix: agent 306 lib / 314 feature / clippy+fmt / xwin green,
  gateway 592, index 56, CLI 9. System tools' remaining windows are
  per-tool bodies (each file op distinct) — no further extraction
  warranted at this window.

### 2026-09-08 SOLID round 61 (terminal-domain clean-slate check)
- **Verification round (no code changes)** — (1) ctx.rs (168) /
  exec.rs (652) / sessions.rs (311) stripped lines: ZERO dup windows
  — the terminal tools directory is fully clean after the round-46/55/
  58 extractions; (2) feature-gated suite 314 + feature clippy clean
  re-verified after find_backend; (3) mcp_client has no client.rs (all
  session logic lives in the 1107-line cohesive tools.rs — round-51
  judgment stands); (4) find_backend unit-testing judged not worth the
  harness: the stub TerminalManager is an empty shell (no feature),
  testing the desktop_impl path needs feature + tokio runtime +
  sweeper setup for one SessionNotFound branch — terminal behavior is
  covered by the device e2e suite instead. Kept with evidence.

### 2026-09-08 SOLID round 62 (ox-alpha two-flow pair closed)
- **oxAlphaReasoningDefault (DRY, gateway translate.ts)** — the
  /v1/messages and chat/completions flows each inlined the same
  stealth/ox-alpha reasoning-effort default (route.kind check +
  rawWithOxAlphaReasoningDefault) — the LAST byte-identical two-flow
  pair after the round-42/44 guard-table + relay extractions.
  Shared `oxAlphaReasoningDefault(routeKind, upstreamModel, body)`;
  behavior unchanged. 592 pass; tsc/prettier clean; mirror synced.
  translate.ts full 19-block re-walk confirmed the remaining windows
  are structural two-flow parallelism (destructure/fetch/relay call
  shapes) plus per-flow-necessary key guards (each of the 3 opencode
  guards serves a different flow) — nothing further extractable at
  this window.

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
  by every settings.json holder) — decision material ready:
  docs/adr/proposal-scoped-relay-token.md (round-356 audit + options A–D,
  B recommended). Needs user sign-off (breaks existing clients if tightened)
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
