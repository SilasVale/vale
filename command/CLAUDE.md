# Vale Command Build Guide

## Cross-compilation to Windows (MSVC)

Requires `cargo-xwin` for cross-compiling from Linux:

```bash
# Install
cargo install cargo-xwin

# Debug build (use before each test — cargo clean avoids stale cache)
cargo clean && cargo xwin build -p vale-command-desktop --target x86_64-pc-windows-msvc

# Release build
cargo clean && cargo xwin build -p vale-command-desktop --target x86_64-pc-windows-msvc --release
```

Output binaries:
- `target/x86_64-pc-windows-msvc/debug/vale-command-desktop.exe` (debug)
- `target/x86_64-pc-windows-msvc/release/vale-command-desktop.exe` (release)

Headless Windows binary (no Tauri/WebView — serial/SSH/PTY + headless Edge/Chrome):

```bash
cargo xwin build --target x86_64-pc-windows-msvc --features terminal,browser --bin vale-command --release
```

**Desktop-gated code cannot build on Linux (webkit2gtk)** — src-tauri and the
`tauri`-feature modules. After any change to Cargo.toml, feature-gated code, or
src-tauri, run `cargo xwin check -p vale-command-desktop --target
x86_64-pc-windows-msvc` (fast incremental) and a full `cargo xwin build` at
phase end.

## CDP (Chrome DevTools Protocol)

CDP is enabled via WebView2 remote debugging on port 19623.
- `src/tools/cdp.rs` — CdpClient with 3s connection timeout; returns `DeviceError`
- `src-tauri/src/main.rs` — `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (via `cdp_debug_args()`)
- `src/tools/browser.rs` — `new_child_webview()` is the single webview-bootstrap helper
  (boot webview in setup.rs and every new tab; the port string is formatted once)
- Lazy init: CDP connects on first `screenshot()` or `evaluate()` call
- CDP is used for screenshot/evaluate; WebView API used for navigate/display

## Architecture

- **WebView** (Tauri child webview): page display in desktop app
- **CDP** (WebView2 remote debugging): reliable screenshot/evaluate automation
- **MCP** (rmcp): external tool interface at `http://0.0.0.0:3000/mcp` — token-gated
  via `TokenGate` in `src/web.rs` (rmcp has no server-side auth hook)

### Module map (post-refactor)

```
src/
  main.rs          headless MCP-server binary (config path as argv[1])
  lib.rs           crate root; DEFAULT_CONFIG_YAML embedded (include_str!)
  bootstrap.rs     vale_command::bootstrap::load_or_create(path, fallback) — shared by
                   src/main.rs and src-tauri/src/setup.rs (create-if-missing,
                   load, ensure_token). Never duplicate config bootstrap elsewhere.
  state.rs         AppState { serial_pool, browser_mgr, terminal_mgr, event_bus,
                   plugin_registry, config } — managers are Arc<Manager>, no locks
                   in AppState
  desktop_api.rs   status_payload/events_payload — pure, unit-tested; Tauri
                   commands are thin wrappers over them
  mcp/server.rs    DeviceServer (rmcp ServerHandler), bind() -> (addr, handle)
                   (port 0 = ephemeral, used by tests), serve_with_token
  web.rs           WebPanel — hand-rolled Tower service (NOT axum route
                   handlers: they break Windows cross-compilation). TokenGate<S>
                   wraps the /mcp route with the panel's bearer check.
  plugins/         PluginRegistry (tools cached once at register); browser/
                   terminal/ directories: mod.rs (plugin struct + shared
                   helpers) + tools.rs (one builder fn per tool)
  tools/           browser.rs (internal-lock BrowserManager; desktop_impl =
                   Tauri child webviews, headless_impl = browser_headless.rs
                   driving headless Edge/Chrome via CDP, stub_impl = errors),
                   browser_headless.rs (new: lazy-spawn --headless=new browser,
                   Edge/Chrome discovery, configurable CDP port), terminal/
                   (TerminalManager + TermBackend trait; pty.rs, ssh.rs,
                   serial.rs, secrets.rs, stub.rs), cdp.rs, serial.rs, ssh.rs
src-tauri/src/
  main.rs          Tauri builder + GLOBAL_STATE OnceLock + state() -> Result
  commands.rs      8 commands (log_diag, call_tool, get_status, events_poll,
                   browser_nav_cmd, browser_cmd_show/hide/set_rect)
  setup.rs         config bootstrap, boot webview, AppState wiring, MCP server
                   spawned on tauri::async_runtime (single runtime!)
src/ui/            ES modules, no build step: transport.js (Tauri/SSE/poll),
                   view.js (switchTabUI/filterEvents), events.js (feed+dispatch),
                   tabs.js (shared tab-bar component), browser.js, term.js,
                   conn.js, ipc.js (token single source), state.js, icons.js
vale-command-core/      Plugin/ToolDef/ToolHandler/NavItem, Config (+ensure_token via
                   getrandom), DeviceError (typed variants), EventBus/AppEventBus
```

## Conventions

- **Commit style**: conventional commits with stage tags (`fix(stage-g)`,
  `refactor(stage-i)`, `perf(stage-h)`, `feat(stage-k)` …). Each commit must
  leave the workspace green.
- **Verification per change**: `cargo test` → `cargo clippy --all-targets`
  (target: zero warnings) → `cargo xwin check -p vale-command-desktop
  --target x86_64-pc-windows-msvc` (full `cargo xwin build` after touching
  Cargo.toml or feature-gated code). After touching feature-gated code, also
  run `cargo test --features terminal`, `cargo test --features browser`, and
  `cargo clippy --features terminal,browser --all-targets`. Headless smoke:
  `cargo run --bin vale-command --features terminal,browser -- /tmp/ct.yaml`
  then curl `/api/status`, `/api/tools/terminal_list`,
  `/api/tools/browser_tab_list` with the Bearer token from `/tmp/ct.yaml`.
- **Feature-gating rule**: real device/WebView code is gated behind the
  `terminal` (PTY/SSH/serial), `browser` (CDP + headless Chrome/Edge), and
  `tauri` (desktop UI) features. The boundary lives only in the `#[cfg]` mod
  declarations and re-export lines (`pub use desktop_impl::X` /
  `pub use stub_impl::X`). Public paths must stay identical across configs so
  headless tests exercise the full dispatch path against the stubs.
  `--features terminal,browser` = headless binary with real serial/SSH/PTY +
  browser tools (no Tauri); `screenshot_ui`/`evaluate_ui` are desktop-only.
- **Locks**: managers own their locks internally (tokio Mutex on Inner).
  Callers hold `Arc<Manager>` and never `.lock()`. Poison recovery:
  `unwrap_or_else(|p| p.into_inner())` — never silently drop data.
- **Channels**: output bounded with backpressure (blocking_send in reader
  threads); keystrokes try_send drop-on-full.
- **MCP tool additions**: define the tool in `src/plugins/<plugin>/tools.rs`;
  the registry caches it at register time — no other registration site.
  Update the tool-count tests (13 terminal / 18 browser) if adding/removing.

## Windows smoke checklist (manual)

Browser: tab bar + new/close, URL bar navigation, back/forward/reload buttons,
overlay rect sync (resize window — child webview must track #browser-area),
snapshot/type/click via MCP. Terminal: open pty (PowerShell), type + resize
window (xterm refit), ssh + serial dialogs, saved connections + keychain
password. Events: activity feed shows navigation/terminal events; auto
view-switch respects the 3s pin cooldown.
