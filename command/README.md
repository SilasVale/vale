# Vale Command

Unified device access for AI agents: **browser automation** and **terminals** (PTY / SSH / serial), served three ways from one codebase:

- **MCP server** — Streamable HTTP at `http://<host>:18080/mcp` (Claude Code, any MCP client)
- **Web panel** — the same tools through a REST panel at `http://<host>:18080/` with a full UI
- **Tauri desktop app** — native window with a child WebView2 driven over CDP (Windows)

All three frontends dispatch through a single `PluginRegistry` — tools defined once, callable everywhere.

## Quick start (headless server)

```bash
cargo run --bin vale-command -- config.yaml
```

On first launch it creates `config.yaml`, generates an API token, and prints it. The token gates every API and MCP request (Bearer header, or `?token=` for SSE):

```json
{ "mcpServers": { "vale-command": { "type": "http", "url": "http://localhost:18080/mcp",
                                "headers": { "Authorization": "Bearer <token>" } } } }
```

Headless features: build with `--features terminal,browser` to enable real
serial/SSH/PTY and a headless Chrome/Edge backend (no Tauri needed). See
[`deploy/README.md`](deploy/README.md) for the full Windows + Cloudflare
deployment (Windows service, `cloudflared` tunnel, Claude Code MCP config,
multi-device aggregation).

## Desktop app (Windows)

```bash
cargo install cargo-xwin
cargo clean && cargo xwin build -p vale-command-desktop --target x86_64-pc-windows-msvc --release
```

Output: `target/x86_64-pc-windows-msvc/release/vale-command-desktop.exe`. See `CLAUDE.md` for the full cross-compile guide. The desktop app additionally runs the MCP server on the same port, so external agents can drive the local browser and terminals.

## What's inside

| Area | Tools |
|---|---|
| Browser | navigate, snapshot, click, type, press_key, screenshot (viewport + full-page), evaluate, wait_for, scroll, back/forward/reload, tab new/list/select/close, screenshot/evaluate of the Vale Command UI itself |
| Terminal | open (pty/ssh/serial), write, read (cursor-based, ANSI-stripping optional), execute (session or one-shot with timeout), resize, select, list, list ports |
| Secrets | set/get/delete SSH passwords in the OS keychain (desktop) |

The activity feed streams every action as an event (SSE or Tauri events) — agents can observe and the panel shows a live log.

## Architecture

```
src/
  main.rs          headless MCP-server binary
  lib.rs           crate root; DEFAULT_CONFIG_YAML embedded
  bootstrap.rs     config load/create + token bootstrap (both binaries)
  state.rs         AppState — managers, EventBus, PluginRegistry
  desktop_api.rs   pure payload builders for Tauri commands (unit-tested)
  mcp/server.rs    rmcp StreamableHttpService + bind()/serve() + TokenGate wiring
  web.rs           web panel as a raw Tower service (NOT axum handlers —
                   axum route handlers break Windows cross-compilation);
                   TokenGate wraps the /mcp route with the same auth
  plugins/
    mod.rs         PluginRegistry (tools cached at register time)
    browser/       BrowserPlugin — 18 tools (tools.rs = one fn per tool)
    terminal/      TerminalPlugin — 12 tools + SessionBuf + clean_terminal_output
  tools/
    browser.rs     BrowserManager (internal lock, CDP pool, webview helper)
    terminal/      TerminalManager + TermBackend trait; pty/ssh/serial/secrets/stubs
    cdp.rs         WebSocket CDP client (port 19623)
    serial.rs      SerialPool (std Mutex, blocked calls run off-executor)
    ssh.rs         russh session
src-tauri/
  src/main.rs      Tauri builder + GLOBAL_STATE
  src/commands.rs  8 Tauri commands (thin wrappers over desktop_api/registry)
  src/setup.rs     boot webview, AppState wiring, MCP spawn on Tauri's runtime
src/ui/            no-build-step ES modules — transport/view/events/tabs split,
                   vendored xterm + Inter font, CSS design tokens
vale-command-core/      Plugin/ToolDef/DeviceError/EventBus/Config (no Tauri deps)
```

Design notes:

- **No npm, no bundler.** The UI is plain ES modules embedded into the binary (`include_bytes!`); Tauri serves the same folder via `frontendDist`.
- **Managers own their locks.** `Arc<Manager>` everywhere; `term_open` runs SSH connects outside the inner lock so one session's handshake never blocks another's writes.
- **Bounded channels.** Terminal output applies backpressure (a stalled consumer pauses the shell); keystrokes drop-on-full.
- **Desktop-gated via features.** `vale-command` builds headless by default; the `desktop` feature pulls in Tauri/PTY/SSH/keyring. Headless stubs return `DeviceError`s so the whole dispatch path is testable without hardware.

## Testing & lint

```bash
cargo test                      # 57 tests: unit + MCP-over-HTTP integration
cargo clippy --all-targets      # must be zero
cargo clean && cargo xwin build -p vale-command-desktop --target x86_64-pc-windows-msvc
```

Desktop-gated code can't compile on Linux (webkit2gtk) — the xwin build is the compile check; runtime verification is the Windows smoke checklist in `CLAUDE.md`.

## Conventions

Commits use conventional style with stage tags (`fix(stage-g)`, `refactor(stage-i)`, …). When adding an MCP tool: define it in `src/plugins/<plugin>/tools.rs`, keep the tool's JSON schema in sync, and it becomes callable from MCP, the panel, and the desktop UI automatically.
