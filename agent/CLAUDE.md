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

## Architecture

vale-agent is a pure service — MCP server + terminal backends + SSE endpoints.
The Tauri desktop app and browser automation (CDP / headless Chrome-Edge) are
retired; the browser extension + gateway MCP replaced them. The web panel
(`/panel`, Apple-style terminal) is served by `src/web.rs` — token entered in
the browser, kept in localStorage (no server-side injection since 1.0.5). A
standalone tray app (`vale-tray/`) controls the Windows service.

- **MCP** (rmcp): external tool interface at `http://0.0.0.0:3000/mcp` —
  token-gated via `TokenGate` in `src/web.rs` (rmcp has no server-side auth hook)

### Module map

```
src/
  main.rs          server binary (config path as argv[1]); Windows service
                   mode via windows-service when launched by the SCM
  lib.rs           crate root; DEFAULT_CONFIG_YAML embedded (include_str!)
  bootstrap.rs     vale_command::bootstrap::load_or_create(path, fallback) —
                   create-if-missing, load, ensure_token. Single bootstrap site.
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
                   POST /api/tools/{name}
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
  Update the tool-count tests (16: 13 terminal_* + 3 secret_*) if adding/removing.

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
