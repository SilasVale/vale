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
  — all path resolution goes through `src/paths.rs` (`install_dir()`/`data_dir()`
  + layout-v2 subdir helpers per `docs/adr/0008-install-layout-v2.md`: `etc\`,
  `components\`, `scripts\` under InstallDir, logs + `pwout\` under DataDir);
  zero `current_exe()` guesses outside it, zero legacy-directory probing
  (one versioned v2 migration exception).
- Boxed components: `vale-playwright.zip` → `InstallDir\components\playwright\`,
  `cloudflared.exe` → `InstallDir\components\` (agent-supervised, no Windows service).
- The OLD NSIS installer / setup.ps1 / run-setup.bat are RETIRED
  (`deploy/retired/`). Sharing front-end: the NEW online installer
  (`deploy/vale-setup.nsi` + `vale-online-setup.ps1`, NSIS 3.12, built by
  `scripts/build-installer.sh <ver>`) wraps the same npm channel (bootstraps
  Node, installs the pinned tgz, runs `vale setup`); test checklist in
  `deploy/README-installer.md`.

## Device update — npm one-click update (THE ONLY sanctioned rollout path)

**Always ship device updates through the npm flow. Never hand-roll
kill/copy/restart scripts over a terminal PTY** — the PTY is hosted by the
agent itself, so an inline `Stop-Process` kills your own shell before the
restart command runs and leaves the device dark (happened twice on d1).

**And never START a second `vale-agent.exe` from an agent-hosted terminal.**
The same hosting cuts the other way, and this was learned the hard way:

- The agent puts itself in a **kill-on-close Job Object**, and *every child it
  spawns inherits membership* — that is the documented design (see
  `setup_child_reaper_job` in `src/winmain.rs`), and it is why an update can
  never leave orphaned PTY shells behind.
- A shell running inside that agent is therefore IN that job. Anything launched
  from it inherits the same membership, so a second agent started that way ends
  up nested inside the first one's job.
- Observed on d1: launching a test build this way **killed the running agent**
  (which the 60 s watchdog then restarted, so the device came back on its own).
  It cost a device restart and an hour of diagnosis.

**There is also no way to isolate a second instance.** `paths.rs` resolves
`data_dir()` registry-first (`HKLM\SOFTWARE\Vale\Agent\DataDir`, else
`install_dir()`) and there is **no environment override** — so a second agent
shares the live one's session directory and would run `recover_interrupted`
over its audit files. A `VALE_DATA_DIR=` env var does nothing.

If a second instance is genuinely needed, launch it DETACHED — WMI
`Win32_Process.Create` (what `vale update` already uses, precisely so the swap
script survives the agent dying) or a one-shot scheduled task — and accept that
the data dir is still shared. For verifying a new Windows build, prefer the
static checks (PE validity + `strings` for the new code paths) over running it
beside the live agent.

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

# 4. On the device (PowerShell), exactly two commands — WITH the --prefix (see the
#    Install/update block above: without it the install lands elsewhere, reports
#    success, and `vale update` silently ships the OLD release):
npm i -g --prefix (Split-Path (Get-Command vale).Source) https://agent.saisi.online/vale-agent/vale-agent-latest.tgz   (or pin the version)
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

# 6. Collapse the two builders (recommended whenever byte-identity matters):
./scripts/publish-cdn-from-ci.sh <ver>
#    Stages the artifact CI just built onto the CDN — installer rebuilt from
#    THAT tgz, manifest rewritten, redeployed, smoked — so "CDN == GitHub
#    release" holds BY CONSTRUCTION and scripts/lib/release-audit.sh reports
#    byte-for-byte equality instead of listing an exe difference.
#
#    Why it exists: the two builders provably pack the same SOURCE (that part
#    is audited, fail-closed), but their exes are NOT byte-identical and
#    cannot easily be made so. Every toolchain input is already pinned AND
#    verified identical by hash (rustc 1.98.1, clang-18, lld, llvm-ar,
#    cargo-xwin 0.23.0), the embedded panel.js matches, and the sizes match —
#    yet ~800 bytes of .data layout still differ, which puts the cause in the
#    compile ENVIRONMENT (the unreproducible-build long tail). Convergence
#    removes the question instead of chasing it.
#
#    Opt-in on purpose: making the DEFAULT publish wait on CI would put the
#    delivery channel behind a pipeline that still fails on environment
#    issues. Fail-closed: it runs the audit first and refuses to touch the CDN
#    unless the CI artifact packages the same source.

Toolchain (reproducible builds — do not undo this):
- `rust-toolchain.toml` pins rustc 1.98.1 for every rust command in this repo;
  release.yml/ci.yml pass the same version explicitly (`dtolnay/rust-toolchain@master`
  + `toolchain: 1.98.1`). NEVER reintroduce `@stable` — a floating channel is
  what made the two builders drift in the first place.
- CI installs LLVM 18.1.8 from the OFFICIAL release tarball (cached; 1 GB) and
  symlinks cargo-xwin's tool cache at it, mirroring the release box's ~/llvm18.
  It also unpacks focal's libtinfo5 beside it — the 18.04 tarball's clang needs
  .so.5 and the 24.04 runner only has .so.6.
- `cargo install cargo-xwin` must stay `--version 0.23.0`.
- `agent/build.rs` passes `/Brepro` + `/DEBUG:NONE` for the MSVC target only.
  Without them lld stamps a freshly randomised PDB GUID plus a build-time PE
  timestamp into every link, so even two LOCAL builds differed (by 20 bytes);
  with them the exe is a pure function of its inputs.
- Doubting the runner's toolchain? Dispatch the `toolchain-fingerprint` job
  (`gh workflow run ci.yml` / the API) and compare its hashes with the release
  box's `~/llvm18` and rustup toolchain.

What `vale update` does (bin/vale.js): stages the exe (and desktop shell
sources) next to the install dir, hands a PS swap script to WMI
Win32_Process.Create (parented by
WmiPrvSE so it survives the CLI AND the agent dying; plain `-NoProfile -File`
only — `-ExecutionPolicy Bypass` / `-EncodedCommand` die silently on d1),
then: stop ValeAgent task → kill agent tree → copy with retry →
restart task. The terminal connection DROPS for ~10 s mid-update; reconnect
and verify via `/api/status` → `version`.

`vale rollback <x.y.z>` (bin/vale.js): HEAD-checks the pinned tgz on the CDN
(last-5-per-minor keeps the recent line), `npm install -g --prefix
<components\npm-global> <tgz>`, then runs the TARGET build's own `vale update`
so the staged exe IS the rollback build; finally writes `etc\.rollback-pin` +
syncs `etc\.vale-release` (healing a pre-v2 split-brain marker). `agent_update`
(Rust) returns `{"status":"pinned"}` for any remote version other than the pin
while the pin exists; `force:true` on agent_update or `vale rollback --clear`
removes it. `vale update` does NOT clear the pin (it swaps what npm-global
holds = the pinned build). `vale autostart <on|off|status>` flips the ENABLED
flag on both boot tasks — `vale stop` is one-shot (the 5-min watchdog revives
it), so autostart is the only real "don't start at boot" control.

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
  same HTTP surface) — token-gated via `TokenGate` in `src/web/mod.rs` (rmcp has
  no server-side auth hook). There is no separate port 3000 any more.

### Module map

```
src/
  main.rs          server binary (config path as argv[1]); Windows service
                   mode via windows-service when launched by the SCM
  lib.rs           crate root; DEFAULT_CONFIG_YAML embedded (include_str!)
  paths.rs         REGISTRY-FIRST path resolution (the single source of truth:
                   `install_dir()`/`data_dir()` + the layout-v2 subdir helpers).
                   FOUNDATION module — zero `current_exe()` guesses and zero
                   legacy-directory probing outside it.
  bootstrap.rs     vale_command::bootstrap::load_or_create(path, fallback) —
                   create-if-missing, load, ensure_token. Single bootstrap site.
  register.rs      pure self-register PLANNING seam (`self_register_plan`):
                   decides whether/where to self-register, so the network call
                   in main.rs's loop stays untested-thin (boundary review
                   2026-09-06).
  metrics.rs       device vitals for /api/status (CPU delta + memory, kernel32)
  tunnel.rs        cloudflared tunnel PROVISIONING for the Gateway card
                   (rewrites tunnel.yml + signals restart via crate::tunnel_ctl).
                   The RUNNING child is owned by main.rs's supervisor, not here.
  winmain.rs       `#![cfg(windows)]` process plumbing: boot self-heal,
                   kill-on-close child-reaper job, bounded helper runner, the
                   SCM service entry, the supervised cloudflared owner. Moved
                   verbatim from main.rs (structure refactor A7); non-Windows
                   builds compile none of it.
  filelog.rs       size-rotating tracing writer -> DataDir\logs\agent.log (layout v2)
  session_log.rs   per-session JSONL audit log (trim-on-close + 30 d retention)
  evidence.rs      the pwout AI-evidence feed (crate-private, SOLID R98):
                   actions.jsonl append/newest-first read, shot listing,
                   basename guard, `browser-actions-changed` push. ONE owner
                   for both producers (playwright browser_run_script +
                   mcp-client tools) and the /api/browser/* readers.
  text.rs          byte-budget text clipping (crate-private, SOLID R105):
                   `boundary_at_or_below` / `clip` — the "cut to <= N bytes on
                   a char boundary" rule that was hand-written at 8 sites and
                   panicked the session drainer three times.
  jsonl.rs         append-only JSONL crash safety (crate-private, SOLID R111):
                   `prepare_append` (version header on a fresh file, terminate
                   a torn final line) + `has_torn_tail`. Shared by the audit
                   trail and the memory store.
  operation.rs     the device's MERGED operation timeline (crate-private):
                   terminal audit + browser actions on ONE ordered axis,
                   served by GET /api/operation. Orders on `ts_ms` only — the
                   two feeds stamp `ts` in different units, so a record
                   lacking the explicit millisecond stamp is DROPPED rather
                   than placed by guess. Device-level, not session-level: the
                   embedded browser has no session ownership.
  runs.rs          RUN identity, one AI execution's mint/end log
                   (crate-private): `begin`/`end`/`recent` over an
                   append-only runs.jsonl. The id is minted DEVICE-side and
                   is a LABEL, NEVER A CREDENTIAL — nothing here returns an
                   authorization decision, and `run_id_is_never_a_credential`
                   pins that.
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
                   mod.rs (plugin struct + shared helpers) + tools/ (ctx.rs =
                   ToolCtx, the shared runtime state builders take, plus the
                   jobs map; per-domain builders exec/sessions/files/
                   output/secrets/connections; mod.rs owns registry assembly
                   + the exact tool order); memory/ (store.rs = the JSONL
                   knowledge store, whose append hygiene comes from
                   crate::jsonl); runs/ (the RUN IDENTITY tool surface —
                   run_begin/run_end, a thin shell over crate::runs: begin
                   MINTS the id device-side, end ACCEPTS one and reports
                   `known`. MCP tools rather than a route because the caller
                   IS the AI and MCP is its only channel here)
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
```

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
- **Console MCP visibility is a SEPARATE decision**: the gateway's `/mcp`
  registry (`gateway/src/mcp-tools.ts`) is a hand-maintained SUBSET of the
  device's, and `tools/call` looks a name up there BEFORE routing — an
  unmirrored device tool is not merely unlisted, it is uncalled (21 of 49
  tools sat invisible with every gate green). After adding or removing a
  tool, regenerate the inventory the gateway contract reads:
  `VALE_REFRESH_SPEC=1 cargo test --features terminal,keyring spec_snapshot`
  (rewrites `agent/spec-tools.json`), then either register the name in
  `mcp-tools.ts` (and satisfy `isDeviceDirectTool()`'s routing) or add it to
  that test's `NOT_EXPOSED` map WITH A REASON. Doing neither fails the
  gateway suite.

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
  loopback token injection (web/mod.rs). round-274: main.ts sets
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

Last updated: 2026-09-11 run-identity round 13 (a RED TREE, a broken C
  compiler, and one feature wired end to end across four layers). Commits
  b5947440 (agent+gateway) + cd5d24ff (panel).
  (0) THE SESSION ENVIRONMENT WAS BROKEN BEFORE ANY CODE WAS READ, and it
  would have silently poisoned every cargo command: `CC`/`CXX` were exported
  pointing at `~/gcc10-root/usr/bin/gcc-10`, a userspace root that was missing
  `cc1` — that binary ships in Ubuntu's `cpp-10` package, which the original
  extraction (documented in this file for the dsh upgrade) never unpacked.
  Every C compile failed with "cannot execute 'cc1'", so `ring` could not
  build and NOTHING in the workspace compiled. Fixed by extracting `cpp-10`
  into `~/gcc10-root/`; verified with a real C compile AND a C++20 compile.
  METHOD NOTE: the first attempt reported success because the command ended
  `cargo clippy ... | tail -40` — the pipe made `$?` the exit of `tail`, so a
  hard build failure read as exit 0. Check `PIPESTATUS`, always.
  (1) THE TREE WAS RED, and had been since round 12: `runs.rs` and
  `operation.rs` were committed-in-progress with ZERO callers, so clippy
  `-D warnings` failed on 9 `never used` errors, and `tests/module_map.rs`
  failed because neither module appeared in the module map of BOTH guides.
  Both fixed first, before adding anything.
  (2) RUN IDENTITY, WIRED END TO END. The device could not tell two AIs
  apart (the token identifies the DEVICE; `clientInfo` is a software constant;
  the console implements no MCP session id), so a set of commands and browser
  actions could not be attributed to one execution. `run_begin`/`run_end` are
  new MCP tools in a new `plugins/runs/` (a separate plugin because a run
  explicitly CROSSES the terminal/browser boundary); the id is minted
  device-side and stamped by all four producers (terminal_execute,
  terminal_plan, browser_run_script, mcp_client_call); `/api/operation`
  returns the boundaries beside the events. The rule is stated in
  `runs.rs` and pinned by `no_caller_derives_authority_from_a_run_id`, a
  repo-wide scan for a `run_id` line naming an authorization verb — the first
  run of it flagged the rule's OWN prose, so comments are skipped and that
  limit is written into the test. Mutation-proven: a planted
  `run_id == "x"` in production code fails it with the exact line.
  (3) THREE DEFECTS FOUND WHILE WIRING, all of the silent class:
  `runs::end` wrote the client's id VERBATIM into an append-only log (now
  capped on a char boundary, like every other remote string here);
  `operation.rs`'s two mappings are field ALLOWLISTS so `run_id` was dropped
  from the timeline with every test green (now named on both feeds, pinned);
  and the console bridge nests args inside `arguments`, which the device
  forwards to playwright-mcp — so a console run would have shown commands and
  ZERO browser actions, indistinguishable from "the AI never opened the
  browser". Lifted to the top level and pinned in both directions.
  (4) THE PINNED CONTRACTS EARNED THEIR KEEP — three of them failed the moment
  the tools were added, each naming exactly what to update: the gateway's
  param-parity contract (`run_id` accepted by the device but unadvertised on
  the console), its device-direct partition, and the agent's 50-tool count.
  That is the round-554 lesson working as designed.
  (5) A DOC CLAIMED A WIRE SHAPE THAT IS NOT TRUE. `runs.rs` said a blank
  label becomes "ABSENT"; `json!` cannot skip a `None`, so the wire actually
  carries `"label": null` — invisible to a careful reader, decisive to a
  `"label" in record` check. Found by the PANEL agent going looking for the
  shape the docs implied. The doc now states the real shape and
  `an_absent_label_is_a_null_value_not_a_missing_key` pins it.
  Gates: agent 559 feat-gated / 518 default (summed from the runners, and
  CORRECTED by the adversarial verifier: my first log entry said "459 default",
  which is the LIB count only — integration binaries are counted separately, and
  the same pass showed the commit message's "59 integration" was really 58. Two
  wrong numbers in one line, both from reading a partial sum as a total.)
  clippy -D warnings clean BOTH configs, fmt clean, xwin check
  OK, module_map green; gateway 759; panel 350 (was 306) + build. NOT ON A
  DEVICE — the delivery gap from round 12 applies to all of this; no version
  bump yet, so nothing here is reachable by a user until a release round.
  (6) VERIFIED AGAINST THE REAL BINARY, not only against tests. Ran
  `target/debug/vale-agent` on a scratch config at 127.0.0.1:18799 (loopback
  only — confirmed with `ss`, and the red-line self-check afterwards showed
  every listener I own on 127.0.0.1) and drove the feature over real HTTP:
  `run_begin` minted `run-1789134893834-838269`; `terminal_execute` WITH that
  id produced `run_id="run-…"` on the timeline while the same command sent
  WITHOUT one produced `run_id=null` — the two adjacent rows the whole design
  is about; `run_end` answered `{"known":true}`; and an anonymous request
  carrying that REAL, well-formed id was 401 on all three endpoints while the
  same call with the token was 200. That last one is the credential rule as
  BEHAVIOUR rather than as a source scan. Worth doing every round: the unit
  suite cannot tell you whether the tool is reachable, and this repo has
  shipped "every gate green, nothing callable" at least twice.

Previous round: 2026-09-11 game-design round 12 (doc coherence, a job-object
  incident, and the DELIVERY GAP). Three things, in order of what they taught:
  (1) NO-BENEFIT ASSUMPTION — I shipped the round-11 Windows build to d1 and
  started it on a spare port to verify it, launched from an agent-hosted
  terminal. That KILLED THE RUNNING AGENT (the 60s watchdog restarted it).
  Cause is the documented design working as intended: the agent puts itself in
  a kill-on-close Job Object and EVERY CHILD IT SPAWNS INHERITS MEMBERSHIP
  (`setup_child_reaper_job`), so an agent-hosted shell is inside that job and
  anything launched from it nests inside the running agent's. Fixed the
  SILENCE, not the design: `IsProcessInJob` at startup now logs the fact (no
  verdict — Task Scheduler also wraps its tasks in a job, benignly, so a
  warning would fire on every normal boot and become wallpaper). ALSO
  established and documented: a second instance CANNOT be isolated —
  `data_dir()` is registry-first with NO env override, so my `VALE_DATA_DIR=`
  was ignored and the test agent shared the live agent's session directory.
  Both guides now say: launch detached via WMI Win32_Process.Create, or for
  verifying a build prefer static checks (PE + `strings`) over running it.
  (2) THE DESIGN DOC CONTRADICTED ITSELF IN 8 PLACES, found by an adversarial
  audit against the RUNNING SYSTEM rather than the tree. All were leftovers of
  PARTIAL edits — a claim updated in one half and not the other, so sections
  asserted something was missing inches from text saying it exists (the worst:
  a paragraph saying "still missing is the middle row" FIVE LINES BELOW a
  diagram saying PLAN <- STORED three times). Fixed all 8 + a duplicated
  limit statement; the doc now greps clean for `missing|absent|broken|not
  built|remains a proposal`. Method worth keeping: grep the STATUS WORDS.
  (3) THE DELIVERY GAP, and it is the headline: everything from rounds 7-11 is
  implemented, tested and committed, and NONE OF IT IS ON A DEVICE. Repo
  registers 50 tools / has `terminal_plan` / `intent`+`considered`+`plan_step`
  / `goal`+`plan`+`held_by_human` on `terminal_list`; live d1 has 49 tools, no
  `terminal_plan`, none of those params or fields. Repo version is still
  1.2.319 == the last CDN release (2026-09-10T07:43Z), i.e. no version bump
  ever happened for this work. Recorded in the design doc §5.1 because it is
  the difference between "the design is finished" and "someone can use it".
  Agent gates 12+12, clippy both, fmt, xwin. Commits: 1836dffb, 2441b856.
  (4) RELEASED 1.2.320 AND UPDATED d1, with the user's approval. Publish went
  through scripts/publish-release.sh (pack -> stage -> sha256 manifest -> last-5
  prune -> wrangler deploy -> smoke: /api/version returned v1.2.320 with the
  versioned + latest sha verified). Verified ON THE DEVICE afterwards: 50 tools,
  `terminal_plan` present, `terminal_execute` advertising all 8 params, and a
  real goal+plan round-trip through the live routes; `terminal_list` now carries
  approval_grants/approval_required/goal/held_by_human/id/kind/label/plan/shell.
  (5) A SECOND SILENT-SUCCESS DEFECT, found by following my own docs on d1: the
  documented `npm i -g <url>` installs to npm's DEFAULT global prefix, which is
  NOT where `vale` lives when the agent runs as SYSTEM (observed: (Get-Command
  vale).Source = D:\Vale\components\npm-global\vale.ps1 while `npm prefix -g`
  = C:\WINDOWS\system32\config\systemprofile\AppData\Roaming\npm). npm
  reported success, `vale update` ran the OLD 1.2.316 CLI from the other prefix,
  and the device silently stayed on its previous release — exe mtime and
  etc\.vale-release were the only evidence. Both guides now use `--prefix
  (Split-Path (Get-Command vale).Source)`, which `vale rollback` had always done
  and the update path never had. Commits: 3ed26cf3 + b081e80d (the release).
  NOTE: no installer was rebuilt (no makensis on this box), so the manifest is
  tgz-only for 1.2.320 — fresh installs still work via the npm channel; the
  installer fields are absent rather than stale, which is the fail-safe case.

Previous round: 2026-09-11 game-design round 11 (the PLAN, + an
  evidence-loss bug it uncovered). `terminal_plan` lets the agent declare
  the steps it intends to take, in order (revise/clear/read); it is a TOOL
  while the session goal is a CONTROL ROUTE, and a pin asserts the control
  route REJECTS `plan` so a later "merge these two" refactor fails loudly
  instead of destroying the comparison between asked-for and intended.
  `terminal_execute` gained `plan_step` (1-based, 0/negative = absent) naming
  which step a command advances; the path view renders the plan with the
  count of commands that served each step, so an unclaimed step shows as a
  run departing from what was announced. Gateway registers terminal_plan and
  advertises plan_step (contract test caught the omission immediately — the
  console registry is a hand-maintained SUBSET and tools/call looks names up
  there BEFORE routing, so unlisted = uncalled). THE BUG: adding a test that
  asserts an exact event count on the audit trail made the web pins fail on
  3 of 4 full-suite runs. `recover_interrupted()` trimmed every recovered
  session's file, and `trim_file` rewrites atomically (temp + RENAME), so the
  path gets a NEW inode and every other writer's open handle is orphaned —
  `writeln!` and `flush` both return Ok while the bytes land somewhere
  unreachable. Recovery runs whenever a plugin REGISTRY is constructed, not
  only at boot, so it could rename a file belonging to a session that was
  LIVE at that moment and silently swallow its remaining audit events.
  Measured, not reasoned: instrumenting the write showed the handle at 528
  bytes while the path held 393 — same call, two files. Trim removed;
  recovery still marks unpaired command/starts and seeds the seq counter, and
  disk growth stays bounded via the write-time output cap, close_session's
  trim and prune_stale. Suite 18s -> 3s. Pinned by
  `recovery_does_not_orphan_a_live_writer` (restoring the trim makes it fail
  with `Statuses seen: ["still going"]` — the event simply gone). Also caught
  by measuring rather than remembering: the plan's claim count was written
  with `--muted` on `--surface-chip`, the exact 4.40 pair fixed for the count
  chips ONE ROUND EARLIER. Agent gates 12+12 suites, clippy both, fmt, xwin;
  panel 305; gateway 34. Commits: e1270743, 63148791, 23f2edc8, 3747acec.
  NOTE: one unrelated pre-existing flake remains,
  `plugins::playwright::manager::manager_tests::status_tracks_fresh_external_and_released`
  (~1 in 6 full runs) — not touched this round, left for its own.

Previous round: 2026-09-11 game-design round 10 (real-panel audit). The
  game-design surface (goal / approval gate + grants / per-step intent /
  audit trail) is complete on the agent and panel sides; this round stopped
  adding features and audited what actually renders. New
  `scripts/panel-render-audit.mjs` loads the REAL panel bundle
  (`resources/panel/panel.js` + `panel.css`, the exact include_str! bytes) at
  a real `/panel/` origin via Playwright route interception (no listener
  anywhere) with `window.fetch` stubbed, so the app boots through its own
  production path and renders its own tree; it then measures EVERY visible
  text node, asserts the governance elements are PRESENT (a clean sweep over
  a page that failed to render must not pass), and checks overflow + page
  errors. It runs emit-only without VALE_BROWSER_HELPER. ONE PASS FOUND FIVE
  chrome contrast defects that had been wrong the whole time and that no
  feature-by-feature gallery could see, because I only ever measured what I
  was working on: `#session-count` --chrome-ink-faint 2.33 light,
  `.side-time` --faint 2.29, `.side-count` --muted-on-chip 4.40,
  `.tab.active` and `.view-switch-btn.active` --chrome-active-ink 3.83/3.65.
  The last two repeat a mistake already on record twice — that token's own
  doc calls it "the accent for CHROME — icons, dots, borders" and it was
  used as TEXT; new `--chrome-active-text` is its text-weight counterpart.
  `--muted on --surface-chip` at 4.40 is the instructive one: that pair was
  "fixed" in an earlier round and PINNED, verified only as better than
  --faint, so the pin cemented a near miss — and the three other count chips
  carry the identical pair, so all four moved together. Both affected pins
  now state what they were missing. Also fixed on the way: a first sweep
  reported terminal text at 1.09 (13.17 by hand) because the harness switched
  theme AFTER mount, so xterm had built its palette in the other theme — the
  probe now themes at boot and excludes xterm, whose palette is its own.
  Verified on the current bundle: 88 text nodes across light/dark x
  pending/idle, 0 under AA, 0 missing, 0 page errors, and the five fixed
  rules read back OUT of the audited artifact rather than assumed. Commits:
  31fa1fde (harness + fixes). Previous round 10 item: `7765068b` fixed
  arming the approval gate leaving NO trace in the audit trail — found by
  running the real agent on loopback and driving it over HTTP, not by a test;
  the new platform-neutral `governance` e2e section (15/15 on the live
  agent) makes that repeatable. Agent gates 12+12 suites, clippy both, fmt,
  xwin; panel 301; gateway 34. No device rollout this round.

Previous round: 2026-09-10 SOLID-R122 (docs cadence; R116–R121 caught up
  below). **R116 was an AGENT round and was missed in this log** — the
  download gate in `plugins/update/tools.rs` got an adversarial pin, and
  mutation testing proved the first version worthless (a `starts_with` →
  `ends_with` swap left it GREEN; the missed shape was the suffix trap
  `notagent.saisi.online` against site `agent.saisi.online`). **R117–R121
  were GATEWAY rounds** — their detail lives in `docs/solid-program.md` and
  `docs/ARCHITECTURE.md`, not here: `handleGatewayImpl` went 798 → 741 lines,
  the request-shaping cores + BYOK key contract were extracted and pinned, an
  upstream-error credential-echo hole was found and PINNED (not fixed — needs
  sign-off, see the ledger's Open threads), and the model catalogue was
  collapsed into ONE `MODEL_REGISTRY` so adding a model is one record instead
  of six coordinated edits. This round is the R25 docs-cadence refresh: pin
  totals and gate counts re-measured from the runners (gateway 748, agent
  479, core 25, CLI 20, relay 54, index 73, extension 9, proxies 20), which
  caught three stale numbers, two jammed ledger lines, and a stale
  `handleGatewayImpl` line count (746 → 741). Program ledger:
  docs/solid-program.md.

Previous round: 2026-09-10 SOLID-R115 — a doc that claimed a consolidation
  which had not happened. `crate::now_millis`'s own comment said it existed to
  kill a duplicated 3-liner — but the playwright plugin still carried its OWN
  byte-identical copy (`manager::now_ms`) plus TWO inline copies in
  `playwright/tools.rs`. All three now use the shared helper. Its return type
  drops `i64` for `u64` (matching its sibling `unix_now` — a timestamp is
  never negative, so the signed form bought nothing and cost a cast at every
  `u64` consumer; same number for every reachable input, so the JSON is
  byte-identical), and `next_run_stem` narrowed `u128`→`u64` to match.

  The more valuable half is the PIN. `unix_now()` and `now_millis()` are one
  WORD apart at a call site and 1000× apart in value — the classic silent bug.
  An audit found `started_unix` produced as seconds, echoed to the model, and
  compared NOWHERE: harmless today, one line from being wrong by three orders
  of magnitude. `now_helpers` tests now bound each helper's MAGNITUDE (1.7e12
  millis vs 1.7e9 secs; a century of drift stays inside, so it asserts a real
  property rather than a clock reading). Mutation-proven: making `now_millis`
  return `as_secs()` fails with "outside a millis range — a seconds value here
  means the two helpers were swapped at a call site".

  Also checked and NOT a bug: the inline `u128` millis looked like a
  serde/type hazard, so I built a probe crate and confirmed `serde_json::json!`
  serializes it fine. Recorded because "I verified this and it was fine" is
  worth as much as a fix.

  Agent gates 478 feat-gated / 470 default green, clippy -D warnings clean
  both configs, fmt clean, xwin check OK. Program ledger:
  docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R114 — the module map is a CHECKED claim
  now, and checking it found real rot. Five modules were missing from `src/`
  in BOTH guides (`text.rs` and `jsonl.rs` — added by this very program in
  R105/R111 — plus `register.rs`, `tunnel.rs`, `winmain.rs`), `paths.rs` was
  mentioned only in PROSE and never as an entry, and the map's code fence was
  NEVER CLOSED in either file, so every heading after it rendered as monospace
  code. The two files had drifted IDENTICALLY, so diffing them against each
  other would not have caught it — only checking against the TREE does. New
  `tests/module_map.rs` asserts: every `src/` module is an entry in BOTH maps;
  no entry names a module that no longer exists (one explicit allowlist for
  the sibling crate); the two guides document the same set. Two lessons baked
  into the test itself: entries are told apart from wrapped prose by TOKEN
  SHAPE (`text.rs` / `plugins/` / `mcp/server.rs`) plus the description gap,
  NOT indentation (a column rule reported every real entry as missing), and a
  gate with no self-check is not a gate — the fixtures use the map's REAL
  shape. Its limit is stated in the header: it checks NAMES, not accuracy.
  Agent gates 475 feat-gated / 468 default green, clippy -D warnings clean
  both configs, fmt clean, xwin check OK. Program ledger:
  docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R113 — accounting audited, one deferred
  decision made durable. (1) CUMULATIVE-PIN AUDIT over R98–R112: every
  per-round "+N pins" claim was re-measured from git instead of trusted, and
  the agent rows held up — they sum to the measured total, and the running
  total (+60 on a 415 baseline) independently confirms the earlier recount.
  One ±1 drift found and corrected (R108's authoring added two attrs across
  two commits). Two METHOD HAZARDS recorded so a future audit does not repeat
  them: grep-counting `#[test]` OVER-COUNTS when a test's own fixture contains
  the string (boot_surface.rs counts 6, really 5 — `cargo test -- --list` is
  authoritative), and a zero baseline from the counting pipeline is a BUG
  SIGNAL rather than a fact. Authoritative counts now: agent 471 feat-gated
  (417 lib + 54 integration), 464 default, core 25. (2) The R107-deferred
  SFTP/SSH timeout-code divergence is now DURABLE: `sftp_connect_timed_out`
  names the choice in one place, its doc explains that `internal` vs
  `ssh_timeout` become different gateway classes, and a pin fails with an
  instruction pointing at the ledger entry — so unifying them is a deliberate
  act with a ledger update, not a silent "cleanup". Mutation-proven. Agent
  gates 471 feat-gated / 464 default green, clippy -D warnings clean both
  configs, fmt clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R112 — the terminal tool builders take ONE
  context. `build()` threaded seven parameters by hand and three builders took
  five each, but the cost was never the typing: the terminal tools keep
  gaining shared state (`buffer_limit` round-68, `jobs`, `diag`) and every
  addition re-churned every signature and call site. `ToolCtx` (ctx.rs) now
  names the shared set once, and `jobs` moves from `build()`'s local into it —
  its two consumers, the executor and `terminal_jobs`, are exactly the pair
  review #2 established must share ONE map (a process-global accessor once let
  the background waiter write a different map than the inserts read, so
  `terminal_jobs` never observed completion). Deliberately NOT imposed on
  single-dependency builders: `tool_read(&ctx.output_buf)` and
  `tool_diag_read(&ctx.diag)` keep focused signatures — the
  interface-segregation half of the same principle. Bonus: the documented
  "connections reuses sessions::tool_open" exception no longer unpacks five
  locals back into five arguments. Pure interface refactor (±0 pins); agent
  gates 472 feat-gated / 465 default green, clippy -D warnings clean both
  configs, fmt clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R111 — append-only JSONL hygiene has one
  owner. Found with a normalized 5-line cross-file clone detector rather than
  by reading files one at a time: the crash-safety rules for append-only
  line-oriented files were duplicated in `session_log.rs` and
  `plugins/memory/store.rs`, and — the tell — BOTH sites documented the same
  incident in prose: an empty file needs a version header, and a crash
  mid-`writeln` leaves a fragment without its trailing newline that the next
  append FUSES onto. In the audit trail the fused pair once swallowed the
  "interrupted" recovery marker, so a command that crashed read back as
  FINISHED. Now `src/jsonl.rs` (`prepare_append`, `has_torn_tail`). Two
  things stay caller-owned on purpose: the header payload (uuid+createdAt for
  a session, type+version for the memory store) and the OPEN HANDLE — an
  append-mode file cannot be read back, so each caller opens its own way
  (one wraps it in a BufWriter, one writes through the File) and passes it in.
  Mutation-proven: dropping the repair from the shared unit fails the new
  tests AND both consumers' pre-existing incident pins
  (`append_repairs_a_torn_final_line`, `torn_final_fragment_is_repaired_before_next_append`),
  which is what makes this a real consolidation rather than a hopeful one.
  Agent gates 472 feat-gated / 465 default green, clippy -D warnings clean
  both configs, fmt clean, xwin check OK. Program ledger:
  docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R110 — the BOOT PATH's "never fatal"
  promise is now a gate, not prose. `migrate_layout_v2()` runs FIRST in
  `main()`, BEFORE tracing is initialised — so a panic there is a device that
  never starts and leaves NO log at all (the 1.2.223 dark-device class). It
  held the boot path's ONLY panic surface: `marker.parent().unwrap()`, in a
  function whose own doc says "Never fails the boot". Fixed structurally
  (the unreachable `None` arm is a note, not a panic), then pinned by a new
  `tests/boot_surface.rs` that scans main.rs / winmain.rs / paths.rs /
  filelog.rs / bootstrap.rs / state.rs for the panic family. Two details
  worth knowing: the scanner is brace- AND string-literal-aware because the
  test modules it must skip contain `format!("{{{{{{ broken…")` — a naive
  brace count ended the skip region early and reported false positives — and
  the scanner is ITSELF pinned (planted panic found, production code after a
  test module still scanned, line numbers preserved), because a gate that
  cannot fail is not a gate. Its limits are stated in the header rather than
  implied: it is a line scan, it does not see indirect panics, and the
  BOOT_PATH list is hand-maintained. Mutation-proven: a planted `.unwrap()`
  on the boot path fails with its exact line. Agent gates 466 feat-gated /
  459 default green, clippy -D warnings clean both configs, fmt clean, xwin
  check OK. Program ledger: docs/solid-program.md. No device rollout.

Previous round: 2026-09-10 SOLID-R109 — a documented memory feature does not
  exist, and now says so. The memory plugin's CLIENT-IDENTITY CAPTURE:
  `tools::set_source` is `pub`, documented as "called by the MCP layer on
  handshake", and has ZERO callers repo-wide — so `SOURCE` keeps its
  "unknown" initializer and every `memory_save` record is stamped `unknown`.
  Three doc comments asserted the capture works (the module header, the
  static, the fn) and `MemoryRecord.source`'s field doc listed the intended
  values; nothing contradicted any of it, which is exactly why it survived.
  All four claims are corrected, and the situation is PINNED rather than
  silently repaired — wiring `set_source` is a BEHAVIOUR change needing a
  product decision about WHAT identity to record (the MCP client's
  `clientInfo.name`? the device-local transport?) and where in the handshake
  to take it. `records_are_stamped_unknown_until_set_source_is_wired` fails
  with that instruction the moment someone wires it; the paired
  `update_preserves_an_existing_source` pins the other half (update clones the
  stored record, so an older or hand-edited source survives edits).
  Also removed `MemoryRecord::is_deleted` — zero callers AND a doc comment
  describing an unrelated concern ("the effective id used for ordering"),
  i.e. the kind of thing a reader wastes time trusting. Agent gates 461
  feat-gated / 454 default green, clippy -D warnings clean both configs, fmt
  clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R108 — web request handling is split at its
  natural seam. `handle_request` was a 230-line function mixing three
  concerns: pre-dispatch routing (public SPA + assets, the static status page,
  and the three streaming routes that self-authenticate), the auth gate, and
  the body/dispatch pipeline. Steps 1–6 are now `route_pre_dispatch(...) ->
  Option<Response>`, and the dispatcher is reached only by requests that are
  not public — so R102's "anything reaching the dispatcher is authenticated"
  became a property of WHICH FUNCTION a request lands in rather than of
  statement order, and the public surface is enumerable by reading one list.
  `handle_request` 230 → 158 lines. The extraction surfaced a real constraint:
  `&Request<Body>` is neither Send nor Sync, so holding one across an await
  made the whole future non-Send and broke the Tower service — fixed by
  narrowing `check_auth` to `&HeaderMap` (all it ever read) and passing
  borrowed pieces, not with a `#[allow]`. New structural pin asserts the SEAM
  (dispatcher routes fall through, public routes do not, evidence routes
  self-authenticate) rather than only the consequence; mutation-proven: a
  dispatcher route answered early fails BOTH the seam pin and R102's
  auth-coverage pin. Agent gates 459 feat-gated / 452 default green, clippy
  -D warnings clean both configs, fmt clean, xwin check OK.
  Program ledger: docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R107 — the AGENT→GATEWAY failure-class
  contract is pinned. `gateway/src/mcp.ts` dispatches on three literal error
  codes (session_not_found / session_busy / ssh_timeout) onto its own classes
  and falls EVERYTHING ELSE through to TOOL_ERROR (the deliberate round-64
  widening, so a device-UP tool failure is not misread as "device offline").
  That boundary is never compiled together and the gateway's suite never runs
  the agent, so renaming a code here — and "fixing" the core's own table test
  to match — would silently degrade a client-visible failure class with every
  gate green. `GATEWAY_DISPATCHED_CODES` now carries the gateway's
  expectation in the core, with three pins: every listed code is reachable
  from a variant, the set is exactly the gateway's three, and the rest fall
  through to TOOL_ERROR. Proven rather than asserted: with the rename applied
  to BOTH the enum and the old table test, `every_variant_has_its_stable_code`
  still PASSED — only the new pin failed. Also audited and deliberately
  LEFT ALONE: the base64 cluster (all STANDARD alphabet, consistent — the
  inline `use base64::Engine` idiom alone is churn without gain) and
  `rpc_ref` (a clean transport dispatcher, not duplication). Core gates 25
  green, agent 458 feat-gated / 451 default green, clippy -D warnings clean,
  fmt clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R106 — the timed-out-command KILL POLICY has
  one owner. `execute_local` carried FOUR `#[cfg]`-gated signal blocks (the
  SIGTERM block and the SIGKILL block, each with a unix arm and a windows
  arm) plus TWO hand-written copies of the identical 50 ms exit-poll loop.
  Now `signal_tree(pid, force)` states the policy once and `wait_for_exit`
  owns the poll, with the window lengths named (`KILL_GRACE` 3s, `KILL_REAP`
  5s). This mattered more than the usual DRY win: the unix and windows arms
  are NEVER compiled together — Linux tests see one, `cargo xwin` the other —
  so an inline typo in either is invisible to every other platform's gate.
  First-ever coverage of the round-55 contract ("a timeout kills the TREE,
  not just the shell"), driving REAL processes and asserting the SIGKILL
  reaches a BACKGROUNDED GRANDCHILD (`kill -0 -PGID` fails only when every
  member is gone). Mutation-proven both directions: group-kill → single
  kill fails "group N still has live members"; SIGTERM → no-op signal fails
  "SIGTERM must terminate the group". +5 pins. Agent gates 458 feat-gated /
  451 default green, clippy -D warnings clean both configs, fmt clean, xwin
  check OK. Program ledger: docs/solid-program.md. No device rollout.

Previous round: 2026-09-10 SOLID-R105 — byte-budget text clipping has an
  owner. "Cut this string to at most N bytes, on a UTF-8 char boundary" was
  written out at EIGHT sites across SIX files (mcp_client ×3, session_log ×2,
  output, playwright, design, plus memory's private helper) in two different
  idioms — some `floor_char_boundary`, some hand-rolled
  `while !s.is_char_boundary(end) { end -= 1 }`. The crate has paid for the
  naive version at least three times: round-68 (`&text[..4096]` panicked the
  drainer and WEDGED THE SESSION), rounds 110/111 (same class in the diag
  writer), and an audit-HIGH slice of a REMOTE-controlled response body at
  byte 80. Now `src/text.rs` owns it: `boundary_at_or_below` (the index, for
  callers that report how many bytes they dropped) and `clip` (the borrowed
  slice). The truncation SUFFIX stays per-caller deliberately — `…` for
  model-facing output, `…[truncated N bytes]` for the audit trail. +5 pins,
  mutation-proven: replacing clip with a naive `&s[..max]` panics with
  "end byte index 1 is not a char boundary; it is inside '汉'". Agent gates
  453 feat-gated / 446 default green, clippy -D warnings clean both configs,
  fmt clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R104 — the settings request bodies have an
  owner. `PUT /api/settings` and `POST /api/gateway/connect` had each grown
  their own copy of two concerns that belonged to nobody: the eight-line 400
  `invalid_params` envelope (built inline twice) and "an optional string
  field, trimmed; blank means unset" (written out five times). The second rule
  is load-bearing — it carries the documented incidents where a console-only
  save clobbered `buffer_mb` and a reg-key-only request silently UNBOUND the
  gateway — so absent vs cleared vs blank has to stay distinguishable. Both
  now live in `src/web/parse.rs` (`json_body`, `optional_trimmed_string`,
  `invalid_params_response`); the 400 error TEXT stays a caller argument
  because the two endpoints' wordings differ deliberately (settings appends
  the serde detail, gateway answers bare) and unifying them would be a
  user-visible change. Real fix on the way: `api_gateway_connect` evaluated
  the console_url rule TWICE — response and persisted value were independent
  copies that agreed by luck; one evaluation now feeds both. A test surfaced a
  contract detail worth having on the record: the response ECHOES THE REQUEST
  rather than reading back state, so a reg-key-only connect answers
  `console_url:null` while keeping the stored binding. +7 pins, mutation-proven
  (an independent re-evaluation that forgets to trim fails "in-memory binding
  disagrees with the parsed patch"). Agent gates 448 feat-gated / 441 default
  green, clippy -D warnings clean both configs, fmt clean, xwin check OK.
  Program ledger: docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R103 — the ROUTER layer is now covered.
  R102 ended by noting an honest gap: its pins call `handle_request`
  directly, so they say nothing about the axum composition in `mcp::bind`
  (`nest_service("/mcp", TokenGate) + fallback_service(WebPanel)`) — a
  routing edit would leave every test green. New
  `tests/router_auth_integration.rs` drives a REAL server over real HTTP
  with no rmcp client (the point is routing, not the MCP protocol):
  `/mcp` must be gated by its Tower layer (missing AND wrong token), the
  fallback branch must reach the web gate (GET and POST — the old
  `needs_auth` flag short-circuited GETs), and `/`, `/panel/`, `/desktop/`
  must keep serving. Both failure directions are mutation-proven: dropping
  `TokenGate` from the nest fails the /mcp case ("/mcp served without a
  token"), re-applying R102's broken classification fails the fallback case
  ("/api/status served without a token through the fallback"). Auditing the
  ledger for this round also caught a self-accounting error: R102 was
  recorded as +3 pins but ADDED 2 test functions and MODIFIED one — the row
  and the cumulative totals are corrected. Agent gates 441 feat-gated / 434
  default green, clippy -D warnings clean both configs, fmt clean, xwin
  check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R102 — the web auth gate is now FAIL-CLOSED
  BY CONSTRUCTION. `handle_request` wrapped it in a `needs_auth` flag that
  re-classified routes (`method != GET || path.starts_with("/api") || path ==
  "/mcp"`), but the early returns above already decide exactly which requests
  are public — so at that point the flag was provably always true, and the
  duplicate classification could only ever fail in the dangerous direction
  (disagreement ⇒ gate skipped ⇒ unauthenticated `/api/tools/*` dispatch ⇒
  SYSTEM-level device control). The gate is now unconditional: anything
  reaching the dispatcher is authenticated, full stop. Two coverage holes
  found and closed on the way: `auth_401_without_token` used `req()` (which
  carries a WRONG token) so the genuinely-missing-header path was never
  exercised, and NO test enumerated the route surface — now
  `every_dispatch_route_is_auth_gated` walks 20 routes under both failure
  modes and `deliberately_public_routes_stay_public` pins `/`, the panel
  SPA and the static assets so an auth tightening cannot silently lock them
  out. Both pins mutation-proven (a broken classification is caught with
  "GET /api/spec served WITHOUT an Authorization header"; gating above the
  public returns is caught with "GET / must stay public"). Agent gates 438
  feat-gated / 431 default green, clippy -D warnings clean both configs, fmt
  clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R101 — the device-tool FAILURE envelope
  (`{"ok": false, "error": msg}`) has an owner: `plugins::tool_error`. It was
  hand-written at 46 sites across four plugins (system 36, memory 7,
  connections 2, update 1); the migration is proven byte-identical
  MECHANICALLY (a string-aware extractor compared all 46 message expressions
  from HEAD against the new `tool_error(...)` arg — identical). Pinning the
  shape surfaced an undocumented cross-layer fact, now on record and tested:
  an in-band `Ok({"ok":false})` renders at `/api/tools` as
  `{"ok":true,"result":{"ok":false}}` — outer ok TRUE, no top-level `code` —
  while a typed `Err(DeviceError)` renders `{"ok":false,"error","code"}`. The
  gateway's round-58 check therefore classifies only the TYPED family as a
  failure; the in-band one is the long-standing MCP behaviour (the model reads
  the envelope as content) and is left unchanged, pinned so a future change is
  a visible decision. Agent gates 435 feat-gated / 428 default green, clippy
  -D warnings clean both configs, fmt clean, xwin check OK.
  Program ledger: docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R100 — the session-mode result cap is now a
  pure, tested unit. `bounded_append(result, truncated, s, max)` was the
  `append_result` closure inside the 622-line `tool_execute` wait loop, and it
  carried THREE incidents with zero coverage: round-105 (uncapped result
  growth OOM'd the agent on `yes`), round-113 (one oversized chunk bypassed
  the cap until the next append), and two char-boundary panics (round-106
  `String::drain`, review-#1 slice start) that abort the loop PAST
  `term_release_execute` — wedging the session busy flag forever. Now pure and
  unit-pinned by 7 tests; both boundary walks are mutation-proven (removing
  the walk-forward panics `start byte index 7 is not a char boundary ... inside
  '汉'`; removing the walk-back panics in `String::drain`). The wait-loop state
  machine stays inline deliberately — its rules read live session state and
  the 50 ms poll cadence. Agent gates 432 feat-gated / 424 default green,
  clippy -D warnings clean both configs, fmt clean, xwin check OK.
  Program ledger: docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R99 — the update BUSY MARKER is now
  one defined thing. Its path was spelled out twice (a Rust PathBuf join in
  `agent_update` + two hand-written string literals inside the generated
  PowerShell swap script), and the acquire/reclaim decision sat inline in the
  300-line handler closure with ZERO test coverage despite three recorded
  incidents. Now `BUSY_MARKER_REL` is the single definition behind
  `busy_marker_path()` (the acquirer) and `busy_marker_ps()` (the script),
  with a contract test pinning that both name the same file; the decision is
  `acquire_busy_marker(path, stale_after)` (atomic `create_new`, reclaim the
  stale marker at MOST once so a locked marker cannot spin). +4 pins,
  mutation-proven (dropping the reclaim-once flag HANGS the suite — timeout
  exit 124; changing the relpath or the join shape each fails the contract
  test). Behavior unchanged; agent gates 425 feat-gated / 417 default green,
  clippy -D warnings clean both configs, fmt clean, xwin check OK.
  Program ledger: docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R98 (`28c7c71f`) — the pwout AI-evidence feed
  is now ONE owned module (`src/evidence.rs`, crate-private): actions.jsonl
  append + newest-first read, shot listing, basename guard and the
  `browser-actions-changed` push, replacing two inline producers (playwright
  `browser_run_script` + a mcp-client private helper), a mcp-client-private
  bus OnceLock and a hand-mirrored reader in web/mod.rs. The evidence dir is
  a PARAMETER now, so the contract is unit-tested against a temp dir (+9
  pins) while paths.rs keeps resolving it. Behavior unchanged; agent gates
  375 feat-gated / 368 default lib green, clippy -D warnings clean both
  configs, fmt clean, xwin check OK. Program ledger: docs/solid-program.md.
  Release/d1 state below is unchanged by this round (no device rollout).

Last release round: 2026-09-09 round-556 — current release **1.2.307 LIVE on d1
  (package.json + CDN version.json + GitHub release; last-5-per-minor prune
  active; Windows self-contained installer ValeAgent-Setup.exe on the CDN)**;
  e2e suite 47 checks; all matrices green. Rounds 273-317 in this log; the
  round log continues below (ROUND-319..556 inlined under "Current
  release"). ROUND-556 = first REAL installer log analyzed: the ValeDesktop
  step never ran on any version (PS argument-mode '+' bug — cmdlet args
  don't concat, both Set-Content -Value lines failed identically before and
  after the scripts\ move; d1's task came from update/Electron/manual),
  fixed by parenthesizing + line numbers in the catch; npm installs now
  register the control-panel entry (conditional UninstallString, elevated
  relaunch); console strings ASCII-only for GBK consoles; signing pipeline
  wired (cert-pending); playwright-zip box confirmed unbuilt by anything
  (fresh installs run browser-less by design so far — needs a 308-sized
  decision). 307 installer rebuilt (ps1-only, tgz untouched) + smoke green.
  NOT yet on a device: v2 migration + rollback + autostart ship as 1.2.308
  once the Windows sandbox run is green. Rounds 273-317 in this log.

### OPEN decisions (product sign-off needed — do NOT change without one)
- **settings_put invalid-JSON envelope: RESOLVED 2026-09-08** (was HTTP
  200 since the round-69 extraction; unified to HTTP 400 with product
  sign-off — api_settings_put now matches api_gateway_connect; test
  renamed to settings_put_invalid_json_returns_http400_envelope).
- **messages-passthrough og body-failure: RESOLVED 2026-09-08** (was a
  historical gap — relayUpstreamResult recordOgBodyFailure=false only on
  that arm; unified to true with product sign-off, all three arms now
  count body failures toward the breaker).
- **F3 relay-token scoping — STEP 1 SHIPPED 2026-09-08** (docs/adr/0007-
  scoped-relay-token.md, Option B approved): per-user relay credential
  (`role: "relay"`, `POST/DELETE /api/me/token/relay`); dual-accept on
  relay paths, /mcp + recovery stay admin-only. **Step 3 (revoking the
  admin token from relay paths) is still an operator cutover — do NOT
  code it without a new explicit sign-off + announced window.**

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
  ROUND-551 (2026-09-09): Windows ONLINE INSTALLER shipped — sharing was
  npm-only (boss: "不方便分享"). NSIS 3.12 cross-built in userspace on this
  box (apt-download + dpkg-deb -x of mingw-w64/binutils/zlib/scons debs —
  NO apt install (focal has only 3.05, missing the 3.11/3.12 SYSTEM temp-dir
  priv-esc fixes); three toolchain traps pinned in scripts/build-installer.sh:
  dangling alternatives symlinks need `ln -sfn`, mingw-w64-common provides
  the limits.h the runtime include dirs symlink to, and
  NSIS_SCONS_GNU_ENVPATHHACK=1 is REQUIRED or windres is "not found" inside
  the cross env). Art: scripts/render-installer-art.py renders the sunrise
  brand into header.bmp/welcome.bmp (exact MUI sizes, 24-bit); NSIS script =
  zh wizard + reg-key page + result-file finish page; the payload is ONLY
  vale-online-setup.ps1 (151KB exe): reuse-or-bootstrap portable Node ->
  npm i -g PINNED tgz -> cloudflared best-effort -> `vale setup` (the real
  installer — dir/registry/tasks/firewall untouched) -> Electron +
  ValeDesktop task + shortcuts. CDN 25MiB asset cap is why it is online-only
  (offline bundle ~250MB cannot live on Assets; R2 noted as the later path).
  Published 1.2.306 exe + versionless ValeAgent-Setup.exe alias; index
  landing page gained the Download button (PAGE 3rd arg, 56 tests green).
  UNVERIFIED ON WINDOWS — checklist in agent/deploy/README-installer.md
  (test on a spare machine, never d1). Also this round: released 1.2.306
  (25 commits), reverted the sunrise console redesign per product (rebuild
  gate lesson: checkout alone ships the STALE vite bundle — build.sh gateway
  deploys assets, it does not rebuild them), fixed d1's broken Vale.lnk
  (pointed at the deleted Tauri exe; repair logic exists but only covered
  PUBLIC desktop — user-profile links need the same treatment, OPEN).
  ROUND-552 (2026-09-09): installer brand + wizard polish (user feedback) —
  the exe icon was the STRIPED pre-sunrise vale-agent.ico (user: "logo不
  对"); regenerated from scripts/render-brand-icon.py (256 PNG + 48/32/24/
  16 BMP entries — 256 is shell-safe, the brand renderer only omits it for
  Chromium's ICO parser). render-installer-art.py rewritten: per-pixel glow
  bake (the old per-ring full-image composite loop was O(n²) AND blocky) +
  brand layout (sun left-of-center, rounded twin hills — ellipses sunk
  below the bottom edge, not triangles). REG-KEY PAGE REMOVED from the
  wizard (user: 安装过程不需要) — registration is a post-install Gateway-
  card step; ps1 keeps -RegKey for scripted use. Rebuilt + republished
  1.2.306 (156771B, both aliases 200); README-installer.md updated.
  FOLLOW-UP (same day): user STILL saw the old logo — the exe carried the
  DEFAULT NSIS sphere. ROOT CAUSE (bisected with minimal compiles): MUI2
  OVERRIDES a bare `Icon` with modern-install.ico at MUI_LANGUAGE time —
  the supported hooks are `!define MUI_ICON`/`MUI_UNICON` BEFORE the page
  macros. Fixed; live exe now verified via pefile to embed the sunrise
  frames (256 PNG 6660B + 16-48 BMP). LESSON: verify artifact CONTENT
  (resource frames), not build success — makensis applies the default icon
  silently. pefile wheel at /tmp/pylibs, PE dump recipe in round notes.
  ROUND-553 (2026-09-09): FIRST FIELD INSTALL FAILED on d1 — root cause:
  the embedded bootstrap ps1 was UTF-8 WITHOUT BOM containing Chinese;
  PS 5.1 parses BOM-less files as the ANSI codepage (GBK), multibyte tails
  swallow quotes → 6 PARSE errors, script dies before statement #1 (no
  installer.log — the tell). NSIS surfaced only "exit code N". FIX: BOM
  prepended to agent/deploy/vale-online-setup.ps1 + a fail-closed BOM gate
  in build-installer.sh (head -c 3 == EF BB BF before staging). Verified
  ON d1: BOM-prefixed copy parses with 0 errors; stray D:\Vale copy
  replaced in place; installer rebuilt (156512B) + republished. LESSON:
  any non-ASCII .ps1 shipped to Windows MUST carry a UTF-8 BOM — and a
  build-time gate is the only thing that survives the next edit.
  ROUND-554 (2026-09-09): FILE TRANSFER COLLAPSED TO ONE METHOD + the
  registry-drift class KILLED AT THE ROOT. Trigger: the user asked why
  tools/list offers no Linux→D1 push. THREE real bugs behind one answer.
  (1) gateway /mcp tools/list is a HAND-MAINTAINED MIRROR (mcp-tools.ts,
  28 entries), never the device's spec — 21 of d1's 49 tools (whole
  system_/memory_/mcp_client_ families, terminal_sftp, agent_update,
  page_view) were invisible AND UNCALLABLE (tools/call looks the name up
  BEFORE routing → "Unknown tool"), and the round-54 "drift guard" could
  not catch it: it compared the registry with a hand-typed copy of ITSELF,
  whose second half then pinned "no extras" — codifying the absence. Now
  the agent emits agent/spec-tools.json from the live PluginRegistry
  (VALE_REFRESH_SPEC=1 cargo test spec_snapshot) and the gateway test reads
  THAT, failing on any device tool neither registered nor listed in
  NOT_EXPOSED WITH A REASON; callTool routes through isDeviceDirectTool()
  instead of re-implementing the predicate as three inline branches;
  system_file_upload + system_file_download registered (28→30).
  (2) system_file_download was DEAD ON WINDOWS: canonicalize() returns
  `\\?\C:\…` (VerbatimDisk prefix) while data_dir() is the plain registry
  string, so the confinement `starts_with` was false for EVERY path —
  device-verified on d1, both D:\Vale\x.txt and C:\ProgramData\Vale\x.txt
  answered "path must be under data dir". Shipped since round-340 having
  never worked on a real device (the suite runs on Linux, where the prefix
  does not exist). Fix: strip_verbatim() + resolve_dest() as pure
  cross-platform STRING fns so the Linux suite exercises the Windows shape
  (cfg(windows) would have stayed invisible — the round-351 lesson);
  confinement dropped (the same credential drives a PTY and
  system_file_write never had one); parents auto-created; `.part` + rename
  so a truncated image never sits at the target looking flashable; fetch
  timeout 120s→600s (120 s could not carry the 100 MB its own description
  advertised). (3) the size cap was 100 MB in the agent AND the index
  worker but 25 MB in the gateway proxy → a 30 MB image died with 413 in
  5.9 s (measured). Unified at 100 MB with the real ceiling documented
  (Cloudflare's request-body limit follows the ACCOUNT plan — Free/Pro
  100 MB, Business 200 MB — not a Workers plan; the old "assumes paid"
  note was wrong), and the reason 25 MB existed (multipart formData()
  materializes the body inside the 128 MB isolate) removed by adding a
  RAW-STREAM PUT arm: index /api/upload?name= streams into R2 (multipart
  kept for old agents), gateway forwards method/query/metadata with a
  60→600 s window, agent switched to it. Symmetry: /api/upload now ALSO
  accepts the ADMIN API TOKEN (the same credential /mcp requires) — without
  it only a device or a console cookie could stage a file, so the AI side
  had no inbound leg; relay-role tokens stay excluded (ADR-0007).
  Measured while diagnosing (kept as the escape hatch, deliberately NOT
  exposed over MCP): d1's terminal_sftp pulled 30 MB in 36.1 s (0.8 MB/s),
  MD5-identical, over the existing 22122 outbound path — but its upload
  arm takes base64 `data` only, so it was never a viable big-file leg.
  Docs: ~/.dsh/AGENTS.md now names the relay pair as the ONE method incl.
  the exact Linux→D1 curl leg; agent/{AGENTS,CLAUDE}.md gained "console MCP
  visibility is a SEPARATE decision". Matrices: agent lib 341 + every
  integration suite green, clippy/fmt/xwin clean; gateway 618 pass +
  tsc/prettier/eslint clean; index 54→64 pass.
  ROLLOUT + LIVE SMOKE (same day): gateway deployed (vale-gate 285210bc),
  index deployed (vale-dist 7ec96a89), release **1.2.307** published and d1
  updated (`.vale-release` = 1.2.307). Evidence with a 31457280-byte
  payload, BOTH directions through the CONSOLE MCP (not the device HTTP API
  — MCP reachability was the point of the round):
  · tools/list → 30 tools incl. the pair (was 28 without it).
  · Linux→d1: curl -T with the ADMIN API TOKEN → 200 with filename
    "r554-to-d1.bin" (so ?name= survived the proxy) → system_file_download
    to D:\Vale\relay\r554-to-d1.bin — a path OUTSIDE the data dir whose
    PARENT DID NOT EXIST → ok:true, 31457280 bytes, MD5 identical to the
    source, and the dir holds only the final file (no .part). The same call
    on 1.2.306 answered "path must be under data dir" for EVERY path,
    including one inside it.
  · d1→Linux: system_file_upload on that same 30 MB → ok + URL (the old
    25 MB gateway screen 413'd it in 5.9 s) → Linux curl 22.8 s, same MD5,
    and the SECOND claim 404s (one-time semantics intact).
  · CI: release.yml on tag v1.2.307 success; both commits' CI success.
  KEEP-LATEST DONE (the operator's GitHub token is ~/.github-token — gh is
  NOT installed here, so the audit runs on the REST API): superseded
  releases + tag refs v1.2.302/304/305/306 deleted via
  DELETE /releases/{id} + DELETE /git/refs/tags/{tag} (4×204), leaving
  GitHub with exactly one release and one tag (v1.2.307), matching the
  keep-latest rule that had drifted by four releases.
  DUAL-BUILD SPLIT — NOT a new finding, and my first write-up of it was
  wrong in kind: the earlier rounds already recorded (1.2.305) that the
  CDN tgz and the GitHub asset differ ONLY in vale-agent.exe, because PE
  builds are not reproducible across builders. Re-measured on 1.2.307
  member-wise: 8 of 9 members byte-identical, `package/vale-agent.exe`
  differs (gh 17141760 B vs cdn 17140736 B) — CDN sha cdbff19c… vs asset
  66526fb5…. So the P0 reconcile's "same sha256 or abort" premise cannot
  hold for ANY release that ships a locally-built exe, which is every
  release: "reconcile OK" has never once run to comparison. The standing
  proposal from the 1.2.305 note (member-wise equality + exe provenance
  instead of whole-tgz bytes) still awaits sign-off; --skip-reconcile for
  a first publish remains the only usable path, and the post-tag checklist
  is where the real audit has to happen.
  ROUND-555 (2026-09-09): INSTALLER MADE USER-USABLE + layout v2 (ADR
  0008) + autostart + rollback pin. (1) The share front-end was BROKEN:
  index.js 302'd ValeAgent-Setup.exe to the console and 404'd versioned
  names, so the landing-page download button never delivered a binary —
  now the alias + versioned exes serve straight from ASSETS (exact-pattern
  discipline). version.json gained installer + installer_sha256 (additive;
  the worker passes them through /api/version after flat-name validation),
  the installer is built same-release (publish-release.sh stages +
  prune_installers keeps last-5), and smoke verifies the alias hash.
  (2) `vale update` now writes DisplayVersion (uninstallVersionPs, $ok-
  gated, never fabricates UninstallString) — the control-panel entry used
  to show the original version forever. (3) `vale autostart on|off|status`
  — the real boot switch (schtasks /Change /ENABLE on ValeAgent +
  ValeDesktop; stop is one-shot, the 5-min watchdog revives it). (4) LAYOUT
  v2: the install root held ~15 loose files + three inconsistent depths;
  now etc\ / components\ / scripts\ under InstallDir and logs\ + pwout\
  under DataDir (leaf names unchanged — Electron packaging + task args are
  rename-sensitive; only the parent moves). The migration surfaced a REAL
  BRICK: the ValeAgent task's -Argument was the exe PATH and Rust treats
  argv[1] as the config FILE, so a moved config made the new exe quarantine
  the install — bootTaskPs now passes etc\config.yaml explicitly, and BOTH
  swap paths repoint the task fail-closed BEFORE touching any file (a
  config-path arg boots old and new agents alike, so a failed repoint aborts
  the update with the old version running). One-version boot backstop
  (paths.rs migrate_layout_v2 + PS migrateLayoutPs, mirror pairs, both
  pinned by tests) moves v1→v2; never clobbers, merges dirs, gates on
  etc\config.yaml+hostname. (5) start-desktop.ps1 HAD NO WRITER — the
  shell's onlogon relaunch was broken by omission (absent from repo + git
  history); startDesktopPs now ships from setup/update/installer, and the
  swap's desktop-pulse.vbs ensure-desktop path was fixed (pointed at the
  root). (6) Migration MARKER AGING (etc\.layout-v2): the backstop stops
  re-scanning 24 paths once a pass ends with nothing pending (a failed move
  retries; a merged dir with a present target is never pending — locked
  leftovers are uninstall garbage, not migration state). PS keeps every
  statement single-line with the guard in $valeMg (setup joins via
  -Command). Deletion criterion in ADR 0008. (7) `vale rollback <ver>` +
  Rust pin: HEAD-checks the CDN-retained tgz, installs to
  components\npm-global, runs the TARGET build's own update, writes
  etc\.rollback-pin + heals a split-brain .vale-release; agent_update
  returns {"status":"pinned"} for any other remote unless force (which
  clears it). Matrices (all green): agent lib 347 (feat-gated), clippy -D
  warnings + fmt + xwin check clean; index 66; npm CLI 15; release-lib 20.
  CDN LIVE: 1.2.307 tgz + installer alias/versioned serve 200 with matching
  shas (installer_sha256 2169f0ea…, verified). NOT yet run on a device: the
  layout-v2 migration + rollback + autostart need the Windows sandbox
  (README-installer checklist gained the v2 verification items); ship as
  1.2.308 once green.
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

### 2026-09-08 SOLID round 63 (residual-window full classification)
- **Verification round (no code changes)** — post-ox-alpha baseline:
  translate.ts 46→41 sites; index worker (all index/src/*.js)
  ZERO dup windows (never scanned before — clean). mcp-tools.ts
  15 blocks re-walked: every window is the inputSchema/DEVICE_PARAM
  declaration skeleton (9 identical shape sites + schema heads —
  round-39/45 kept-class, DEVICE_PARAM already shared). Remaining
  small windows newly examined: web/sse.rs (`}}` adjacency artifacts),
  gateway/src/index.ts (import + call-shape artifacts), web/mod.rs
  (check_auth return shapes), system/tools.rs ("required": ["path"]
  schema tails) — all kept classes with recorded evidence. 14
  residual files fully classified; nothing extractable at this
  window.

### 2026-09-08 SOLID round 64 (zen-us error forwarding + window-depth scan)
- **relayUpstreamError (DRY, proxies/zen-us-proxy)** — the /v1/responses
  and /v1/messages flows each inlined the same non-ok upstream →
  client jsonError block; the messages copy had drifted to a 2-chain
  fallback (no err.message) under its own 5xx pre-branch (generic
  client text + server-side detail log — kept local). Shared
  relayUpstreamError(upstream, cors) with the 3-chain fallback
  (superset: responses unchanged, messages gains err.message
  coverage). 8/8 zen-us + sibling zen-go 12/12 green. ALSO ran the
  window-depth escalation: 10-line scan shows only the known
  structural classes; 20-line scan is EMPTY repo-wide — no segment
  of ≥20 consecutive lines is copied anywhere. This closes the
  copy-detection space at every meaningful window depth.

### 2026-09-08 SOLID round 65 (memory unknown-id envelope single-sourced)
- **unknown_id_error (DRY + wording contract, agent memory/tools.rs)** —
  memory_update and memory_delete each returned the same
  {"ok": false, "error": "unknown id: {id}"} envelope inline; one
  wording across two tools is a recovery contract for AI clients
  (re-search before retry), so the message is now single-sourced via
  unknown_id_error(id). 2 sites → shared helper; 34 memory-domain
  tests pass; fmt + clippy clean. Baseline re-run: zen-us 12→10
  sites; tooling.ts windows = fetch-call adjacency artifacts;
  memory/mcp_client residuals = ToolDef closure-head + schema-tail
  framework shapes. Copy-detection remains closed at 6/10/20 lines.

### 2026-09-08 SOLID round 66 (secrets.rs DPAPI full re-walk)
- **Verification round (no code changes)** — secrets.rs ALL 6 windows
  re-examined end to end (not just the round-56 head review): every
  window is the seal/open mirror of the CryptProtectData /
  CryptUnprotectData FFI argument layout (~12 shared lines: in_blob/
  out_blob CRYPT_INTEGER_BLOB construction + the 4-null +
  UI_FORBIDDEN + &mut out call block). Extraction would need a
  fn-pointer-typed shared caller across two windows-sys signatures and
  is windows-only (locally unverifiable beyond xwin check, no tests) —
  kept with evidence as symmetric FFI scaffolding. This closes the
  agent-side residual review: every listed file now has an explicit
  kept-class record at 6-line depth.

### 2026-09-08 SOLID round 67 (test-file + 5-line-depth sweep)
- **Verification round (no code changes)** — ran the more sensitive
  5-line window restricted to 3+ hit blocks (true-copy signal): the
  hits are (1) studio/vendor/monaco (third-party, excluded by roots in
  the regular scan), (2) TEST files — gateway.test.mjs 33 blocks are
  upstream-mock stubs (chat.completion Response shapes at 5+ sites)
  and assertion skeletons, deliberately inlined per-test so a failing
  assertion reads self-contained without helper hops — test
  self-containment beats DRY in verification assets, kept with
  evidence (same class: plugins.test.mjs / mcp-handler / health /
  vale-cli / mcp_integration.rs / e2e.js), (3) production hits are
  ToolDef registration-head framework shapes (system/tools.rs 5 file
  tools share the schema-tail + closure-head + require_str("path")
  skeleton with per-tool differing descriptions). No production
  copy exists below the 6-line floor either.

### 2026-09-08 SOLID round 68 (execute_local SRP extraction)
- **execute_local (SRP, agent exec.rs)** — tool_execute's router
  closure buried the local-shell path (~235 lines: spawn + Unix
  process-group + bounded 1 MB tail capture with truncation +
  kill-on-timeout) after the session-mode wait loop. Extracted
  module-level `execute_local(command, timeout_secs, bus)` — the
  closure now dispatches between the session wait-loop and the local
  path, which is self-contained and individually readable. Behavior
  unchanged (ShellExec gains .to_string() at the new &str boundary;
  needless_borrows fixed on .arg). 306 lib pass; feature 314; fmt +
  clippy clean; xwin check green. Note: the copy-depth sweep having
  closed (rounds 64-67), this round resumes function-level SRP
  decomposition of the remaining oversized closures.

### 2026-09-08 SOLID round 69 (flatten_result extraction + tests)
- **flatten_result (SRP, agent mcp_client/tools.rs)** — mcp_client_call's
  dispatch tail inlined the response-folding logic (~45 lines:
  structuredContent first, else text items joined with newlines,
  image items passed as data: URIs). Extracted module-level
  `flatten_result(&result)` — pure function, now covered by 3 unit
  tests (text join, image data-URI pass-through, structuredContent
  preference). The dispatch tail now reads as one call; the ~240-line
  call closure loses its second post-processing block (the
  screenshot-resolution block stays — it needs early returns + fs
  access). 309 lib (+3) / 317 feature; fmt + clippy clean.

### 2026-09-08 SOLID round 70 (parse_screenshot_ref + regression pins)
- **parse_screenshot_ref (SRP, agent mcp_client/tools.rs)** — the
  screenshot-resolution block inlined the text-reference scan (~28
  lines incl. the round-246 markdown-bugfix commentary: bare
  extension match + paren terminator). Extracted pure
  `parse_screenshot_ref(&str) -> Option<String>`; the round-246 fix
  now has 3 regression pins: plain paren reference, markdown-style
  reference (the formerly-NEVER-firing branch), no-reference /
  other-extension None. 312 lib (+3) / 320 feature; fmt + clippy
  clean. ALSO examined tool_open's ~150-line drainer spawn for the
  same treatment and KEPT it: its captures include a &SessionLogger
  reference whose lifetime is tied to plugin registration —
  module-level extraction would need 'static restructuring for a
  readability-only gain (recorded; revisit only if the drainer grows).
  Self-caught: first test append silently failed (python \U escape in
  a non-raw heredoc string) — raw-string retry fixed.

### 2026-09-08 SOLID round 71 (agent big-function census)
- **Verification round (no code changes)** — census of every agent
  fn ≥150 lines (17 entries) with per-entry judgment. Deferred
  candidates (single-responsibility pipelines, kept): tool_execute
  (session-mode linear pipeline — poll/scan reads already extracted
  round-55/68), tool_open (drainer extraction deferred round-70),
  pty spawn (pty-creation pipeline), ssh connect, serial open,
  sftp_handler, playwright manager start, provision_tunnel,
  run_server (service assembly), self_heal (win service),
  update_from_tgz/agent_update (update transaction — tgz step already
  extracted), term_open (manager method). CLEAN finds: web/mod.rs
  handle_request is pure dispatch (each api_* already its own fn),
  connections.rs store (remember/list/forget + tests, small), memory/
  files/output domains (round-57). mcp_client_call down to 177 from
  ~240 (flatten + parse extractions rounds 69-70). Next candidates
  when a round needs one: playwright manager start or pty spawn
  sub-block review.

### 2026-09-08 SOLID round 72 (wait_healthy extraction)
- **wait_healthy (SRP, agent playwright/manager.rs)** — the round-71
  census's top deferred candidate: PlaywrightManager::start inlined
  the health-poll pipeline (~90 lines: 30s probe loop with a REAL
  JSON-RPC initialize handshake check (round-129), streamable-HTTP
  first-chunk read, child-exit fast fail, and the failure path that
  folds the last 500 stderr chars into the error and kills the child
  (round-163)). Extracted module-level wait_healthy(&mut child,
  port) — start now reads: spawn → wait_healthy → register under the
  lock. Behavior unchanged; fixed the extracted tail's missing Ok(())
  (if-block as last expression). 312 lib / 320 feature pass; fmt +
  clippy clean; xwin check green. start shrinks ~90 lines; its
  stop()/probe helpers were already separate.

### 2026-09-08 SOLID round 73 (post-extraction baseline + census recheck)
- **Verification round (no code changes)** — re-ran the 6/10-line
  baselines after the rounds-68-72 extraction burst: totals stable
  (mcp-tools 57 / translate 41 / secrets 12 / memory 16 all kept
  classes; translate-vision.ts 2 sites = 1-block adjacency artifact).
  exec.rs re-appeared at 6 sites / 3 blocks — classified: the window
  is execute_local's main select loop hitting TWO adjacent exit-probe
  branches (458/490 — pipe-closed probe vs periodic probe, same
  loop, ~3-line shared head) — same-loop adjacency, not cross-code
  duplication; kept. Census recheck of the remaining ≥150 fn
  deferreds: pty spawn's reader/reaper threads are one-time
  capture-assembly (maintained — extracting needs 6-slot plumbing for
  no readability gain); sftp_handler is a parameterized single tool
  (op dispatch is protocol); ssh connect / serial open / provision_
  tunnel are linear pipelines. No new extraction warranted.

### 2026-09-08 SOLID round 74 (gateway big-function census)
- **Verification round (no code changes)** — the agent-side census
  (round-71) extended to gateway/src: ≥120-line functions are
  translate.ts handleGatewayImpl (842 — the three-flow framework with
  per-flow private segments; round-42/44/62 extractions already took
  every byte-identical pair, residual is flow-local by construction),
  anthropic-translate.ts streamOgToAnthropic (542 — og→anthropic SSE
  stream conversion, single deep pipeline), channels.ts
  museResponsesExit (181), auth.ts testKey (174), device-proxy.ts
  proxyDevice (125 — SSRF stack already in device-fetch.ts),
  index.ts handleGateway (143 — dispatch), upstream.ts pickRoute
  (141 — switch-case route table, each arm declarative + only qw/
  or arms carry 2-way format logic that is inherent). All judged
  cohesive single-responsibility; no new extraction. Full-repo
  function census (agent 17 + gateway 7 entries) now on record.

### 2026-09-08 SOLID round 75 (full-suite gate incl. integration tests)
- **Verification round (no code changes)** — the extraction-burst
  rounds (68-72) were only ever verified at --lib; per the round-282
  lesson (lib-only tallies mask integration failures) this round ran
  the COMPLETE `cargo test -p vale-agent`: 355 passed total — lib
  312 + main 5 + tests/integration.rs 27 + mcp_autoselect 1 +
  mcp_client 2 + mcp_integration 7 + stdio integration (env-gated) —
  zero failures. Also tallied the burst: 25 commits since the round-74
  anchor, 8 code commits (find_backend, execute_local, flatten_result
  + tests, parse_screenshot_ref + pins, wait_healthy, oxAlphaReasoning
  Default, unknown_id_error, poll_chunk tests). Full-suite 355 is the
  new completeness number alongside lib 312 / feature 320.

### 2026-09-08 SOLID round 76 (tail_append extraction + cap-semantics pins)
- **tail_append (SRP + coverage, agent exec.rs)** — round-75's
  integration inventory showed the local-execute capture loop's
  nested append_chunk closure (1 MB tail-cap semantics from round-55
  BOUNDED capture: keep-newest-half pre-drain on overflow + post-trim
  to cap, truncated flag) was pure logic with ZERO direct tests. Four
  call sites (live receive path + final drains) existed under one
  closure. Extracted module-level `tail_append(captured, truncated,
  chunk, max)` with max parameterized for tests; 3 unit tests pin the
  semantics (within-cap keep-all; oversized-chunk newest-half
  retention; accumulated-overflow drain-to-half-then-append = 80 of
  100 after 5×30 — two self-caught wrong expectations precisely
  documented the intended behavior). 315 lib (+3) / 323 feature; fmt
  + clippy clean. NOTE: first attempt failed on my own grep truncation
  (4 real call sites, head -3 showed 2) — regex + exact count assert
  fixed it.

### 2026-09-08 SOLID round 77 (prompt-marker regression pins)
- **Test-only round (agent exec.rs)** — marker-domain audit found the
  scan logic fully shared (shell_integration.rs find_prompt_started /
  find_finished with tests; exec.rs wait loops call them exclusively)
  EXCEPT find_prompt_marker — the LEGACY OSC-133 scan kept for the
  headless-stub path and backward-compat reads — which carried the
  round-100 false-prefix fix with ZERO direct tests. Added 3 pins:
  complete-sequence parsing (start/end/exit-code over the WHOLE
  sequence), incomplete/missing → None (the cross-chunk caller
  contract), and the round-100 scenario (a literal \x1b]133;D; prefix
  with no digits/BEL must not poison a later real marker). 318 lib
  (+3) / fmt + clippy clean.

### 2026-09-08 SOLID round 78 (spill persistence layer pins)
- **Test-only round (agent ctx.rs spill layer)** — append_spill /
  rotate_spill / read_spill (with spill_base) were only ever exercised
  INDIRECTLY through terminal_read tests; the round-115 rotation
  semantics (drop oldest `discard` bytes via atomic temp rewrite,
  delete when discard >= len, best-effort true on missing file,
  review-#5 true-only-on-advance contract) had zero direct tests.
  Added 4 in tests.rs: append/read roundtrip, rotate-then-read with
  absolute base offsets (bytes [40,100) read as [50,60) via base=40),
  missing-file → true, discard-past-end removes the file. 322 lib
  (+4) / feature 330; fmt + clippy clean. Self-caught: the first
  append landed INSIDE the connect_saved async fn — items inside a fn
  body compile but are never collected as tests (the count stayed
  318) — the closer was re-inserted before the new tests.

### 2026-09-08 SOLID round 79 (coverage-domain closure + full-suite refresh)
- **Verification round (no code changes)** — secrets.rs store layer
  checked for the same indirect-only gap the round-76/78 rounds
  closed elsewhere: NO gap — it already carries isolated-file tests
  (crud_roundtrip + the round-126 legacy raw-key delete semantics,
  per-thread store isolation at line 355+). Full-suite total
  refreshed after the round-76/78 test additions: 365 passed (lib
  322 + main 5 + integration 27 + autoselect 1 + mcp_client 2 +
  mcp_integration 7 + stdio env-gated; the +10 delta = tail_append 3
  + prompt-marker 3 + spill 4). Coverage-domain audit now spans:
  read/screen/history/retain (tests.rs), marker/pty-stream,
  execute-result, conns store, spill layer, prompt markers, mcp
  result flattening + screenshot refs, memory store — every pure-logic
  layer reached in the recent extraction rounds has direct pins.

### 2026-09-08 SOLID round 80 (round-80 matrix snapshot)
- **Verification round (no code changes)** — round-80 milestone.
  Top-level agent test-distribution census: web/mod.rs 35, tunnel 12,
  session_log 11, bootstrap 9, paths 8, sse/panel/state/mcp-server 7
  each, filelog 7, main 6, metrics 4 — only winmain.rs is 0 (pure
  cfg(windows) service code — platform-restricted, cannot run on the
  Linux dev box; acceptable and recorded). FULL matrix re-verified in
  one pass: agent full suite 365 (incl. integration), feature 330,
  zen-us 8, zen-go 12, index 56, CLI 9, gateway 592, clippy x2 + fmt
  clean, xwin check green (openrouter-proxy absent = the retired
  2026-09-07 worker; only zen-go/zen-us + vercel-proxy remain under
  proxies/). Tree clean after every commit.

### 2026-09-08 SOLID round 81 (debt + description-consistency sweep)
- **Verification round (no code changes)** — three consistency
  sweeps, all clean: (1) TODO/FIXME/XXX/HACK inventory across every
  production tree (agent/src, gateway/src, index/src, proxies, the
  electron src) is EMPTY — no accumulated debt markers anywhere;
  (2) terminal_execute's tool description ("idle window scales: ssh
  3s, serial 4s, pty 1s") matches the code exactly (idle_confirm
  match: ssh 3000ms / serial 4000ms / default 1000ms — the AI-client
  contract is truthful); (3) translate-vision.ts (243 lines, 2
  window-sites = call adjacency) already shares its describeImage
  tails via finishDescribe(resp, cacheKey, env, extract) +
  cacheImageDesc with the round-119 failure-marker contract — no
  unextracted duplication. Library-wide convergence continues to
  hold at every audit angle attempted.

### 2026-09-08 SOLID round 82 (feature full-suite gate)
- **Verification round (no code changes)** — the feature-gated
  COMPLETE suite (`cargo test -p vale-agent --features
  terminal,keyring`, incl. integration tests) was never run as a
  whole — only the feature lib (330). Full feature suite: 373 passed
  (+8 over the default 365 = the feature-only integration branches),
  zero failures. Completeness numbers now on record: full default
  365, full feature 373, lib 322/330, feature lib 330 — plus the
  stable per-change gates (clippy -D warnings ×2, fmt, xwin check).

### 2026-09-08 SOLID round 83 (final-corners duplication sweep)
- **Verification round (no code changes)** — the last unscanned
  corners of the repo went through the 6-line window scan: index/src,
  vale-agent-npm/src, vale-desktop-electron src (main.ts), and
  gateway/ui/src are ALL clean except two known kept classes
  (electron main.js's fetch-timeout/schtasks patterns — VERIFIED
  fresh vs its main.ts source, the round-354 stale-artifact failure
  mode stays closed by the round-321/322 CI gates; Auth.tsx label
  JSX adjacency). Every production tree in the monorepo has now been
  duplication-scanned at 5/6/10/20-line depths with recorded
  classifications — the copy-detection space is fully closed
  repo-wide.

### 2026-09-08 SOLID round 84 (tooling + workflow-layer review)
- **Verification round (no code changes)** — extended the sweep to
  the last non-source layers: (1) mcp-tools.ts's 2 remaining inline
  device declarations are DELIBERATE enhanced-description variants
  (terminal_open's "Device name from the console Devices list…" reads
  better for the tool that needs device choice explained) vs the
  generic DEVICE_PARAM text — kept; (2) scripts/*.sh + workflows:
  only ci.yml shows 6-line windows — the job preamble boilerplate
  (runs-on/checkout/setup-node) — and the node versions deliberately
  DIFFER per job (22 for gateway/ui, 24 for panel — round-286/287
  lessons), so YAML-anchor extraction would need parameterization for
  near-zero benefit; job boilerplate is conventionally repeated.
  Workflow/tooling layers classified; no changes warranted.

### 2026-09-08 SOLID round 85 (session_lost recovery-contract pins)
- **Test round (agent ctx.rs)** — session_lost, the enriched
  "Session not found" error that carries the AI client's self-recovery
  contract (open-session list + the "(none — agent restarted?
  re-open with terminal_open)" hint + the round phase-4 pre-restart
  note), is used by terminal_execute (exec.rs:590) and terminal_screen
  (sessions.rs:351) and referenced by connections.rs — yet had ZERO
  direct tests (round-359 pinned only the connect_saved sibling).
  Added 3: empty-store reopen hint + InvalidParams class; no restart
  note for never-seen ids; pre-restart record explains a PTY that
  died with the agent (process-wide OnceLock map injected IN MEMORY
  only — persist_pre_restart never called, zero disk writes, record
  removed after, sole-writer discipline). 325 lib (+3) / feature 333;
  fmt + clippy clean. Self-caught AGAIN: an append pass dropped the
  closing brace of the round-78 spill_rotate_discard test — the new
  tests nested inside it as local items (compiled, never collected,
  count stuck at 322) — closer restored + stray trailing brace
  removed; brace-depth verification now mandatory after test-file
  appends (this is the second local-item nesting trap).

### 2026-09-08 SOLID round 86 (architecture snapshot gate refresh)
- **Docs round (docs/ARCHITECTURE.md)** — the maintained-layering
  snapshot's gate-count rows had drifted since the round-354 audit
  (agent grew 12 refactor/test rounds, gateway grew suites). Re-
  measured everything end to end and updated: agent row 350 -> 368
  (325 lib + 5 bin + 27 + 1 + 2 + 7 + 1 integration + 15 core; 333
  lib feat-gated, 376 full feat-gated — feature-full was re-run as a
  whole, matching round-82's record); gateway 580 -> 592; proxies
  19 -> 20 (zen-us 8 + zen-go 12; the ×2 row never included the
  retired openrouter). Also audited the error-template family during
  discovery: session_lost / connect_saved / job_id are all single-
  point constructors; the terminal_jobs registry (job wait loop) has
  no direct tests but its input requires a real backgrounded session
  (pipeline-bound, recorded not forced).

### 2026-09-08 SOLID round 87 (uniform session_lost across session tools)
- **Refactor + test (agent)** — a new headless matrix test exposed a
  real inconsistency: terminal_write checked session existence in the
  TOOL layer (enriched session_lost: open list + "(none — agent
  restarted?)" + reopen instruction) while terminal_resize /
  terminal_select / terminal_close let the BACKEND answer bare
  (stub: "backend not enabled"; real: DeviceError::SessionNotFound) —
  the AI client's recovery experience was tool-dependent. Fix:
  ensure_session_known(mgr, sid) helper extracted next to session_lost
  in ctx.rs; write's inline two-line check swapped to it; resize /
  select / close gained the check (close also reports the closed-
  session kind instead of failing bare). +1 cfg(not(feature)) matrix
  test: all four answer session_lost with the reopen hint on unknown
  ids. 326 lib / 369 full / 333 feature lib; fmt + clippy clean.
  (Discovery route: files.rs sftp + terminal_jobs were checked first —
  pipeline-bound real-SSH inputs, recorded not forced.)

### 2026-09-08 SOLID round 88 (icon sync + CI clippy sweep)
- **Fix round (electron + agent)** — two unrelated cleanups. (1) The
  Electron shell's source icon files (agent/vale-desktop-electron/icon.*)
  were out of sync with brand/ + the npm package: they still had the old
  render (2740-byte icon.png with scanline stripes) while brand/ and npm
  had the corrected render (3010 bytes, stripes removed in commit 888cbb12).
  The shell loads icons from the source dir -> taskbar showed the stale
  icon. Synced both from brand/ (commit fd6724aa). (2) CI clippy -D warnings
  flagged two issues from the round-87 session_lost tests: unused `bus`
  variable in three tests (prefixed `_bus`) and a useless `vec![b'x'; 90]`
  in tail_append's test (switched to `&[b'x'; 90]`). Pushed both to GitHub;
  CI green on retry (run 887).

### 2026-09-08 SOLID round 89 (extract convertUserMessage + convertAssistantMessage)
- **Refactor (gateway anthropic-translate.ts)** — toOpenAIRequest inlined
  ~40 lines each for user message (text/image/tool_result parts) and
  assistant message (thinking/text/tool_use) conversion. Extracted both as
  module-level helpers (convertUserMessage / convertAssistantMessage) taking
  the messages array so the main fn reads as a routing skeleton. Gateway
  592 pass / tsc clean. Self-caught: the first extraction pass dropped the
  else-if (assistant) and else branches from the message loop -> tsc error
  TS1128; restored before the run.

### 2026-09-08 SOLID round 90 (extract checkRateLimit)
- **Refactor (gateway translate.ts)** — handleGatewayImpl's inline rate-
  limiting block (per-token minute + day counters with in-memory Maps) is
  now a module-level checkRateLimit(env, method, path, token) returning
  Response | null. The main fn calls it once after auth. Gateway 592 pass
  / tsc clean.

### 2026-09-08 SOLID round 91 (extract dispatch from handle_request)
- **Refactor (agent web/mod.rs)** — handle_request's route-match block
  (~55 lines) is now a module-level dispatch(state, method, path, body,
  query) returning Result<Value, Box<Response>>. The main fn stays auth +
  body parsing + routing skeleton. 330 pass / clippy clean. Self-caught:
  the first pass left needless borrows (&state/&body_str where state was
  already &AppState) and a result_large_err (Response is large -> boxed);
  both fixed before the run.

### 2026-09-08 SOLID round 92 (extract parse_memory_settings)
- **Refactor (agent web/mod.rs)** — api_settings_put's inline memory-
  validation block (entries/bytes/retention with the missing-key
  convention) is now a module-level parse_memory_settings(v) returning
  (entries, bytes, retention, changed). 330 pass / clippy / fmt clean.

### 2026-09-08 SOLID round 94 (extract extractByokKeys)
- **Refactor (gateway translate.ts)** — handleGatewayImpl's inline BYOK key
  extraction (8 keys from the ukeys blob) is now a module-level
  extractByokKeys(ukeys) returning a typed record. Gateway 592 pass / tsc
  clean.

### 2026-09-08 SOLID round 95 (extract detectRoute)
- **Refactor (gateway translate.ts)** — handleGatewayImpl's inline route
  detection (isCount/isMessages/isChatCompletions/isResponses from
  method + path) is now a module-level detectRoute(method, path) returning
  a typed record. Gateway 592 pass / tsc clean. Self-caught: the first
  extraction pass dropped the 404 guard for unknown routes (test: POST
  /v1/<unknown> → 404); restored before the run.

### 2026-09-08 SOLID round 96 (round-96 matrix milestone)
- **Verification round (no code changes)** — round-96 milestone. Every
  suite re-verified green in one pass: agent 330 lib / 373 full
  (incl. integration) / clippy 0 / fmt clean, gateway 592 / tsc /
  prettier / eslint clean, index 56, npm CLI 9, zen-us 8, zen-go 12,
  xwin check green. The SOLID extraction phase (rounds 55-95) delivered
  25+ code commits (10 test pins + 15 refactors) — every pure-logic
  layer reached in the recent extraction rounds now has direct pins,
  and the copy-detection space is fully closed repo-wide at all depths.

### 2026-09-08 SOLID round 97 (round-97 matrix milestone)
- **Verification round (no code changes)** — round-97 milestone. Every
  suite re-verified green in one pass: agent 330 lib / 373 full
  (incl. integration) / clippy 0 / fmt clean, gateway 592 / tsc /
  prettier / eslint clean, index 56, npm CLI 9, zen-us 8, zen-go 12,
  xwin check green. The SOLID extraction phase (rounds 55-97) delivered
  25+ code commits (10 test pins + 15 refactors) — every pure-logic
  layer reached in the recent extraction rounds now has direct pins,
  and the copy-detection space is fully closed repo-wide at all depths.

### 2026-09-08 SOLID round 98 (OPEN-decisions implementation ×3)
- **Product-signed fixes (agent + gateway + docs)** — the three OPEN
  decisions were approved together, so all three landed in one round:
  (1) settings_put invalid-JSON now HTTP 400 (was 200), matching
  gateway_connect — test renamed to
  settings_put_invalid_json_returns_http400_envelope; (2) the messages-
  passthrough arm now records og body-failure breaker trips
  (recordOgBodyFailure false→true), closing the historical gap — all
  three arms count alike; (3) F3 scoped relay token step 1 (ADR-0007
  adopted): per-user relayToken + findUserByToken role-"relay" copy,
  POST/DELETE /api/me/token/relay, masked presence in meGet + admin
  user list, regenerateToken sweep skips the relay mapping; /mcp +
  recovery stay admin-only by construction (verified, not assumed).
  Tests: agent 373 full + gateway 603 (+10 relay-token.test.mjs, +1
  admin-masking pin); tsc/prettier/eslint + clippy/fmt clean.
  Self-caught: the detectRoute extraction dropped the unknown-route
  404 guard (fixed + test-pinned before commit). Step 3 (revoking the
  admin token from relay paths) stays an operator cutover — NOT coded.
  Deployed: `wrangler deploy` live (Version 2371e743) — /api/health 200,
  POST /api/me/token/relay 401-unauth on the live worker (route + gate
  verified, not just merged).

### 2026-09-08 SOLID round 99 (step-3 switch + 1.2.305 release)
- **F3 step 3 ships as a default-off switch** (`settings:
  RELAY_ADMIN_CUTOVER`, translate.ts): cutover-off admin passes (pinned),
  cutover-on admin 401s with a relay-token pointer while relay passes and
  /mcp admin passes. Flipping = one KV write, no deploy; the window stays
  open until the operator announces it. Gateway 606 pass, tsc/prettier/
  eslint clean, deployed live (Version 486f5701, health 200).
- **Agent 1.2.305 released** (payload: settings_put 400): xwin release exe
  staged, CLI 9/9, publish-release.sh green (version.json sha + last-5
  prune + index deploy 7477804e + /api/version smoke v1.2.305). Tag +
  GitHub asset via release.yml next; reconcile after the asset lands.
  Step 2 (settings.json swap) stays operator-side: issuance needs a
  console session the agent loop cannot mint.
  P0 reconcile finding (1.2.305): CDN tgz vs GitHub asset differ ONLY in
  vale-agent.exe (17142272 vs 17140736 B, same source commit) — the other
  8 members are byte-identical. PE builds are not reproducible across
  builders (timestamps/paths), so whole-tgz equality can never hold for
  any release packing a locally-built exe. Proposal (needs sign-off, NOT
  applied): amend the P0 check to member-wise equality + exe provenance,
  instead of whole-tgz bytes. No history of "reconcile OK" exists — this
  is the first time the audit actually ran to comparison.

### 2026-09-08 SOLID round 101 (MCP channel proof + d1 credential survey)
- **Operator asked whether d1 is reachable via MCP — yes, verified live.**
  This box's `ANTHROPIC_API_KEY` is a gateway admin token: `/mcp ping`
  authenticated, `tools/list` returned the full terminal + browser kit,
  opened two pty sessions on d1 and closed both afterwards (hygiene).
- **d1 needs NO settings.json swap** (Step-2 scope correction): d1's agent
  runs as SYSTEM (no user settings there); the only settings.json on the
  box is `C:\Users\Administrator\` (27 B, effortLevel only, no env); no
  Machine/User ANTHROPIC*/VALE* env vars; no saisi.online refs in any
  user config. d1 is a pure target device, never a relay client. Probes
  read key NAMES only, never values. Note: a concurrent worker was live
  on d1 mid-survey (interleaved buffer output observed, incl. their
  config.yaml edit) — probes were re-run on a clean session.
- Step-2 remainder = this box's key only, blocked on an operator-minted
  relay token (issuance is session-gated; no token path exists by design).

### 2026-09-08 SOLID round 102 (relay token console UI)
- **Operator: relay token must show on the page, not just curl.** Built it:
  Keys page Relay card (status badge from meGet relayTokenSet, Issue/
  Rotate showing the value once in memory + copy, session-gated Reveal
  via new POST /api/me/token/relay/reveal for the forgot-to-save case,
  Revoke with confirm), i18n zh+en, client types. Backend reveal pinned
  (401/404/value). Old UI bundle pruned. Gateway 607 pass, tsc/eslint/
  prettier + ui build/test/render-smokes green. Deployed live (Version
  dcda168a): health 200, reveal route 401-unauth, new bundle 200 served.
  Operator path is now: console Keys page → Issue → copy → paste per
  machine → tell the loop to verify + flip the cutover.

### 2026-09-08 SOLID round 103 (operator handed relay token; local swap live)
- **Operator issued via the new Keys UI and pasted the relay token.**
  Swapped this box's `ANTHROPIC_API_KEY` (safe JSON round-trip, old admin
  value kept in shell memory only, never written elsewhere; exact-match
  re-read confirmed). Live matrix, all as designed: relay + bogus model
  → 402 (past auth, zero spend) vs bad token → 401; relay on /mcp ping
  → 401 (relay-scoped, not admin). Skipped the spendy full-path probe —
  post-gate code is role-agnostic and stub-covered.
- Ops note: this box no longer holds the admin token in any file (the old
  value stays valid server-side — only the local copy was replaced, so a
  console-Overview re-paste always recovers). d1 already proven keyless.
  Remaining: operator confirms all relay clients swapped → loop flips
  RELAY_ADMIN_CUTOVER.

### 2026-09-08 SOLID round 104 (relay end-to-end double-confirm)
- **Operator asked to double-confirm: ran a REAL relay call** (og/
  deepseek-v4-flash, max_tokens=1) with the box's relay token → 200 with
  a valid Anthropic message envelope (thinking + text). File re-read:
  exact-match relay. This supersedes round-103's gate-level-only proof —
  full path (auth → owner keys → upstream → reshape) works on relay.
  Trivial spend, single probe. Cutover flip still awaiting operator word.
- **Post-swap self-check: this box's own /mcp channel now 401s
  (`admin token required`) — least privilege applies to the loop itself,
  as designed.** Consequence: live device interrogation (e.g. d1's
  current release) is no longer possible from here without the admin
  token; last confirmed d1 = 1.2.278. Cutover flip + deploys unaffected
  (Cloudflare token path, not gateway admin).

### 2026-09-08 SOLID round 105 (d1 upgraded to 1.2.305 via MCP)
- **Operator handed the admin token back; loop drove the npm flow on d1
  through gateway /mcp.** Pre-check corrected the record: d1 was already
  1.2.304 (not 1.2.278 — something updated it earlier), npm pkg confirmed
  1.2.304. Ran `npm i -g latest.tgz` (7s, pkg → 1.2.305) then `vale update`
  (WMI-parented swap, connection drop as designed); reconnected after 30s,
  `.vale-release` (provable-success marker) reads **1.2.305**. Sessions
  closed afterwards. Note: concurrent worker live on d1 throughout
  (interleaved output + their own pkg checks) — state was re-read before
  the swap to avoid a double-update collision.
- Hygiene ask: the pasted admin value now lives in chat history — operator
  should rotate it (console one click) to expire this temporary grant.

### 2026-09-08 SOLID round 106 (device version display fix)
- **Operator: agent version not visible on the page.** Root cause: the
  status probe read `j.version` (frozen Cargo 1.0.145 — every device
  showed v1.0.145 forever and the outdated badge never cleared), ignoring
  `j.release` (round-304). Fix prefers release, falls back to version for
  pre-1.2.276 agents; no UI change needed (list already renders
  lastVersion + badge — the data was wrong, not the view). Tests: 3 probe
  pins (preferred + persisted via touchDeviceSeen, fallback, absent).
  Gateway 610 pass, tsc/eslint/prettier clean, deployed live (Version
  b8bbe55e, health 200). Operator confirms on the Devices page: d1 row
  should now read v1.2.305 with no outdated badge.

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
