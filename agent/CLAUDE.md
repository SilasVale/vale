# Vale Agent Build Guide

> Mirrors agent/AGENTS.md (build/verify/architecture semantics must stay
> identical; the stage-n living log lives ONLY in agent/AGENTS.md — this
> file never mirrors it). agent/AGENTS.md additionally
> carries the stage-n iteration log maintained by the DSH loop.

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

`scripts/build.sh agent` cross-compiles vale-agent (the retired tray/Tauri
desktop builds were removed round-330).

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
  (`deploy/vale-setup.nsi` + `vale-online-setup.ps1`, `scripts/build-installer.sh`)
  wraps the same npm channel; test checklist in `deploy/README-installer.md`.

## Device update — npm one-click update (THE ONLY sanctioned rollout path)

**Always ship device updates through the npm flow. Never hand-roll
kill/copy/restart scripts over a terminal PTY** — the PTY is hosted by the
agent itself, so an inline `Stop-Process` kills your own shell before the
restart command runs and leaves the device dark (happened twice on d1).

**And never START a second `vale-agent.exe` from an agent-hosted terminal.**
The agent puts itself in a kill-on-close Job Object and every child it spawns
inherits membership (`setup_child_reaper_job`, `src/winmain.rs`), so a process
launched from an agent PTY nests inside the running agent's job — observed to
kill the running agent on d1 (the watchdog restarted it). There is also no way
to isolate a second instance: `data_dir()` is registry-first with no env
override, so it shares the live agent's session directory. Launch detached
(WMI `Win32_Process.Create`, as `vale update` does) if one is truly needed.

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

# 4. On the device (PowerShell), exactly two commands — WITH the --prefix. Plain
#    `npm i -g <url>` installs to npm's DEFAULT global prefix, which is NOT where
#    `vale` lives when the agent runs as SYSTEM (observed on d1: `vale` resolved to
#    D:\Vale\components\npm-global\vale.ps1 while `npm prefix -g` was
#    C:\WINDOWS\system32\config\systemprofile\AppData\Roaming\npm). The install
#    reports success, `vale update` stages the OLD exe, and the device silently
#    stays on its previous release with no error anywhere.
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
then: stop ValeAgent task → kill agent
tree → copy with retry → restart task. The terminal connection DROPS for ~10 s mid-update; reconnect
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
+ the Electron desktop shell (embedded real browser on CDP 9333). The Tauri desktop (`vale-desktop/`), the
standalone `vale-tray/`, and the NSIS-era installers are RETIRED; the Electron
shell (`vale-desktop-electron/`) and the gateway device app replaced them. The
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
                   basename guard, `browser-actions-changed` push, and the
                   feed's AGE-BOUNDED RETENTION (`prune`: screenshots +
                   pwai_*.js + old action lines; a 1-day floor makes an
                   in-flight action's artifacts undeletable). ONE owner for
                   both producers (playwright browser_run_script + mcp-client
                   tools) and the /api/browser/* readers.
  text.rs          byte-budget text clipping (crate-private, SOLID R105):
                   `boundary_at_or_below` / `clip` — the "cut to <= N bytes on
                   a char boundary" rule that was hand-written at 8 sites and
                   panicked the session drainer three times.
  jsonl.rs         append-only JSONL crash safety (crate-private, SOLID R111):
                   `prepare_append` (version header on a fresh file, terminate
                   a torn final line) + `has_torn_tail` + `rewrite_atomically`
                   (temp file, fsync, rename — what the two retention prunes
                   age records out with, and why their writers hold a lock).
                   Shared by the audit trail and the memory store.
  operation.rs     the device's MERGED operation timeline (crate-private):
                   terminal audit + browser actions on ONE ordered axis,
                   served by GET /api/operation. Orders on `ts_ms` only — the
                   two feeds stamp `ts` in different units, so a record
                   lacking the explicit millisecond stamp is DROPPED rather
                   than placed by guess. Device-level, not session-level: the
                   embedded browser has no session ownership.
  runs.rs          RUN identity, one AI execution's mint/end log
                   (crate-private): `begin`/`end`/`recent`/`trim` over an
                   append-only runs.jsonl (age-bounded by `trim`, same 1-day
                   floor as the evidence feed). The id is minted DEVICE-side
                   and is a LABEL, NEVER A CREDENTIAL — nothing here returns
                   an authorization decision, and
                   `run_id_is_never_a_credential` pins that.
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
 retired; the npm CLI + Electron shell replaced them.)
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
  a wait page that reappears when the agent dies mid-session. `/desktop/`
  reuses `/panel/` assets + loopback token injection (web/mod.rs).
  round-274: main.ts sets backgroundThrottling:false + the
  --disable-renderer-backgrounding / --disable-backgrounding-occluded-
  windows switches — a hidden window (hide-to-tray / background session)
  otherwise flips the SPA to visibilityState=hidden, Chromium stops
  requestAnimationFrame, and xterm's rAF-driven DOM renderer silently
  stops painting (blank terminals while the AI keeps operating).

## vale-tray / vale-desktop (Tauri) — DELETED (round-330)

Both crates retired (npm CLI replaced the tray; Electron shell replaced
the Tauri desktop); source + builds removed round-330 — git history
retains them. The npm CLI (`vale` from `vale-agent-npm/bin/vale.js`) is
the management surface.

## Panel rendering audit (not a smoke item — it is automated)

`scripts/panel-render-audit.mjs` loads the REAL panel bundle at a real
`/panel/` origin (Playwright route interception — no listener) with
`window.fetch` stubbed, then measures every visible text node and asserts the
governance elements are present. Use it after ANY panel styling change:
hand-built galleries verify only the CSS you were thinking about,
which is how five chrome contrast defects survived several rounds of
"auditing". Needs `VALE_BROWSER_HELPER` to run the audit; without it the
script emits the harness and exits 0.

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
