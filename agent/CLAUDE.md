# Vale Agent Build Guide

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

`scripts/build.sh agent` builds vale-agent + the vale-tray app in one go.

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

# 3. Publish: stage the tgz into the dist worker assets and deploy them:
cp vale-agent-1.2.N.tgz ../../index/public/vale-agent/
cd ../../index && CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare-token) npx wrangler deploy

# 4. On the device (PowerShell), exactly two commands:
npm i -g https://agent.saisi.online/vale-agent/vale-agent-1.2.N.tgz
vale update
```

# 5. GitHub Release = CI: after the version-bump commit is pushed, create
# the tag ON GITHUB VIA THE API (direct git push of tags is intermittently
# network-blocked here; the API is reliable and the tag-push event triggers
# release.yml: panel SPA build → xwin exe → npm pack → gh release create
# --verify-tag). package.json version MUST equal the tag. keep-latest:
# delete the previous release AND older tag refs via the API.

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
+ the Electron desktop shell (embedded real browser on CDP 9333). The Tauri desktop (`vale-desktop/`), the
standalone `vale-tray/`, and the NSIS-era installers are RETIRED; the Electron
shell (`vale-desktop-electron/`) and the gateway device app replaced them. The
web panel (`/panel`, Apple-style terminal) is served by `src/web.rs` — token
entered in the browser, kept in localStorage (no server-side injection since
1.0.5).

- **MCP** (rmcp): served at `/mcp` ON THE MAIN AGENT PORT (default 18080) —
  token-gated via `TokenGate` in `src/web.rs` (rmcp has no server-side auth hook)

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
                   POST /api/tools/{name}, GET /api/plugins/status,
                   GET/POST /api/browser/{frame,input} + /api/browser/{pwshots,
                   pwshot,actions} (bridge proxy), POST /api/browser/ws-ticket
                   + GET /api/browser/ws (ws_relay ticketed WS), GET
                   /api/sessions (audit list)
  plugins/         PluginRegistry (tools cached once at register); terminal/
                   mod.rs (plugin struct + shared helpers) + tools.rs (one
                   builder fn per tool)
  tools/           terminal/ (TerminalManager + TermBackend trait; pty.rs,
                   ssh.rs, serial.rs, secrets.rs, stub.rs), serial.rs, ssh.rs
vale-command-core/      Plugin/ToolDef/ToolHandler/NavItem, Config (+ensure_token via
                   getrandom), DeviceError (typed variants), EventBus/AppEventBus
vale-tray/         standalone crate (own workspace, Windows-only deps): tray
                   icon + menu — status (running/subdomain/token mask),
                   start/stop/restart the ValeCommand scheduled task,
                   copy MCP config, open console, open local terminal
```

## Conventions

- **Commit style**: conventional commits with stage tags (`fix(stage-g)`,
  `refactor(stage-i)`, `perf(stage-h)`, `feat(stage-k)` …). Each commit must
  leave the workspace green.
- **Verification per change**: `cargo test` → `cargo clippy --all-targets`
  (target: zero warnings) → `cargo xwin check -p vale-agent
  --target x86_64-pc-windows-msvc --features terminal,keyring`. After touching
  feature-gated code, also run `cargo test --features terminal,keyring` and
  `cargo clippy --features terminal,keyring --all-targets`. Smoke:
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
  a wait page that reappears when the agent dies mid-session. `/desktop/`
  reuses `/panel/` assets + loopback token injection (web.rs).

## vale-tray (Windows)

Standalone crate (kept out of the main workspace so its Windows-only tray
dependencies don't affect the Linux build):

```bash
cd vale-tray && cargo xwin build --target x86_64-pc-windows-msvc --release
```

Installed by `deploy/vale-agent-setup.ps1` as the `ValeCommandTray` at-logon
scheduled task. Reads `vale-agent.hostname` (device subdomain),
`vale-agent.console` (console URL, optional) and `config.yaml`
(port + auth token) from the install dir. Controls the `ValeCommand` scheduled
task via schtasks.

## Windows smoke checklist (manual)

Terminal: open pty (PowerShell), type + resize, ssh + serial sessions, saved
connections + keychain password. MCP: `claude` direct device MCP
(`https://dN.../mcp`) and `/api/tools/terminal_list` with the Bearer token.
Events: `/api/events` SSE + `/api/events/term` stream. Tray: status lines
(running/subdomain/token mask) refresh, start/stop/restart work, copy MCP
config pastes the JSON snippet, console opens, local terminal opens.
