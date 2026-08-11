# Vale Command

Device access for AI agents: **terminals** (PTY / SSH / serial) served as a pure
service from one codebase:

- **MCP server** — Streamable HTTP at `http://<host>:18080/mcp` (Claude Code, any MCP client)
- **HTTP API** — the same tools through `POST /api/tools/{name}` plus SSE
  streams (`/api/events`, `/api/events/term`) at `http://<host>:18080/`

Every frontend dispatches through a single `PluginRegistry` — tools defined
once, callable everywhere.

The former web panel SPA, Tauri desktop app, and browser automation (CDP /
headless Chrome-Edge) are retired; the browser extension + gateway MCP replaced
them. A standalone tray app (`vale-tray/`) controls the Windows service.

## Quick start

```bash
cargo run --bin vale-command -- config.yaml
```

On first launch it creates `config.yaml`, generates an API token, and prints it. The token gates every API and MCP request (Bearer header, or `?token=` for SSE):

```json
{ "mcpServers": { "vale-command": { "type": "http", "url": "http://localhost:18080/mcp",
                                "headers": { "Authorization": "Bearer <token>" } } } }
```

Real backends: build with `--features terminal` to enable serial/SSH/PTY.
See [`deploy/README.md`](deploy/README.md) for the full Windows + Cloudflare
deployment (scheduled task, `cloudflared` tunnel, Claude Code MCP config,
multi-device aggregation).

## Tray app (Windows)

```bash
cd vale-tray && cargo xwin build --target x86_64-pc-windows-msvc --release
```

Output: `vale-tray/target/x86_64-pc-windows-msvc/release/vale-tray.exe`. Tray
icon with status (running / subdomain / masked token), start/stop/restart of
the `ValeCommand` scheduled task, copy MCP config, open the console, open a
local terminal.

## What's inside

| Area | Tools |
|---|---|
| Terminal | open (pty/ssh/serial), write, read (cursor-based, ANSI-stripping optional), execute (session or one-shot with timeout), resize, select, list, list ports |
| Secrets | set/get/delete SSH passwords in the OS keychain (`keyring` feature) |

The activity feed streams every action as an event (SSE) — agents can observe
the live log.

## Architecture

```
src/
  main.rs          server binary (Windows service mode via windows-service)
  lib.rs           crate root; DEFAULT_CONFIG_YAML embedded
  bootstrap.rs     config load/create + token bootstrap
  state.rs         AppState — managers, EventBus, PluginRegistry
  mcp/server.rs    rmcp StreamableHttpService + bind()/serve() + TokenGate wiring
  web.rs           HTTP surface as a raw Tower service (NOT axum handlers —
                   axum route handlers break Windows cross-compilation);
                   TokenGate wraps the /mcp route with the same auth
  plugins/
    mod.rs         PluginRegistry (tools cached at register time)
    terminal/      TerminalPlugin — 13 tools + SessionBuf + clean_terminal_output
  tools/
    terminal/      TerminalManager + TermBackend trait; pty/ssh/serial/secrets/stubs
    serial.rs      SerialPool (std Mutex, blocked calls run off-executor)
    ssh.rs         russh session
vale-command-core/      Plugin/ToolDef/DeviceError/EventBus/Config (no Tauri deps)
vale-tray/               standalone tray app crate (Windows-only deps)
```

Design notes:

- **Managers own their locks.** `Arc<Manager>` everywhere; `term_open` runs SSH connects outside the inner lock so one session's handshake never blocks another's writes.
- **Bounded channels.** Terminal output applies backpressure (a stalled consumer pauses the shell); keystrokes drop-on-full.
- **Feature-gated backends.** `vale-command` builds with stubs by default; the `terminal` feature pulls in real PTY/SSH. Stubs return `DeviceError`s so the whole dispatch path is testable without hardware.

## Testing & lint

```bash
cargo test                      # unit + MCP-over-HTTP integration
cargo clippy --all-targets      # must be zero
cargo xwin check -p vale-command --target x86_64-pc-windows-msvc --features terminal
```

Runtime verification is the Windows smoke checklist in `CLAUDE.md`.

## Conventions

Commits use conventional style with stage tags (`fix(stage-g)`, `refactor(stage-i)`, …). When adding an MCP tool: define it in `src/plugins/<plugin>/tools.rs`, keep the tool's JSON schema in sync, and it becomes callable from MCP and the HTTP API automatically.
