# Vale Desktop (multi-tab terminal) + Device Memory — Design

Date: 2026-08-27
Status: Approved (user confirmed: desktop form, multi-tab terminal rewrite, pure MCP, memory 6 tools, JSONL local, saisi decouple, latest deps)

## Background & goals

vale-agent is currently a headless Windows service (SYSTEM scheduled task, session 0) exposing an MCP server + `/api/tools` + a single-session `/panel` terminal page. The user wants:

1. **A real desktop app** (not a browser tab) with a **multi-tab full-screen terminal** — each tab is one PTY session held by the agent service, so tabs survive window close/refresh.
2. **Device memory**: AI clients (Claude Code / DSH / future) actively persist knowledge entries through MCP `memory_*` tools; entries are shared device-wide across sessions and clients. **No automatic call-log ingestion** (call records stay in the existing session audit JSONL).
3. **saisi.online decoupling**: `console_url` / `download_url` become optional; missing config degrades update/design tools with explicit errors instead of hardcoded URLs. Pure-local MCP + terminal + memory must work with no cloud config.
4. **Latest dependencies** throughout (xterm 6, React 19, Vite 8, TS 7, Tauri 2.11).

## Architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| Desktop shell | **Tauri 2** (user session) + WebView2 (Edge Chromium) | native window/tray; WebView2 = Chromium so xterm rendering matches Chrome; cargo-xwin cross-compile chain already proven for vale-tray; tauri 2.11.5 in cargo cache |
| Terminal display | **xterm.js 6.0** (VS Code-grade) + canvas renderer (default) | industry standard (VS Code/Tabby/Hyper); panel-react already uses it; lock version, no re-minify (avoids #5800-class issues) |
| Session ownership | **agent service holds PTYs** (unchanged) | desktop shell is a UI client over `/api/tools` + SSE; tabs survive shell restart; SSH/serial naturally supported |
| Communication | **Pure MCP** (no built-in AI loop) | clients keep their own agent loops; vale-agent stays a tool server |
| Memory storage | **Local JSONL + in-memory index** (`<install>/memory/memory.jsonl`) | reuse session_log append-write pattern; zero native deps; device-local, offline |
| Memory model | **Only explicit saves** via 6 MCP tools | AI actively curates knowledge; no automatic call recording into memory |
| saisi | **config optional + degrade** | console_url/download_url → Option; update/design tools error when unset |
| Deps | **Latest** (xterm 6.0.0, React 19.2.8, Vite 8.2.2, TS 7.0.2, Tauri 2.11.5) | user requirement |

## New: memory plugin (agent side)

```
agent/src/plugins/memory/
  mod.rs        # MemoryPlugin { store: Arc<MemoryStore> }
  store.rs      # MemoryStore — JSONL append + index + soft-delete + LRU + capacity
  sanitize.rs   # content sanitizer (strip token/password/secret/Authorization)
  tools.rs      # 6 ToolDef builders
```

### Storage schema (`memory.jsonl`, one JSON record per line)

```json
{"id":"m-<ts10>-<rand6>","title":"...","content":"...","tags":["..."],
 "namespace":"shared","source":"claude-code|dsh|vale-desktop|unknown",
 "created_at":1718000000,"updated_at":1718000000,"deleted":false}
```

- Append-only writes (reuse SessionLogger discipline); version header line first.
- In-memory index: `HashMap<id, Record>` + ordered `Vec` (updated_at desc) + tag inverted index.
- Soft delete (`deleted:true`); `memory_update` can restore; compaction (rewrite dropping deleted) on export/startup.
- Capacity from config: `memory: { max_entries, max_bytes, retention_days }` — LRU eviction by updated_at when over.

### MCP tools (6)

| Tool | Params | Behavior |
|---|---|---|
| `memory_save` | title(required), content(required), tags?, namespace?=shared | sanitize content (strip secrets, cap 32KB); returns {id, created_at} |
| `memory_search` | query(required), namespace?, limit?≤50 | case-insensitive substring match title+content+tags; updated_at desc; content truncated 4KB |
| `memory_list` | namespace?, tag?, limit?, include_deleted?=false | list, updated_at desc |
| `memory_update` | id(required), any of title?/content?/tags?/namespace? | update fields + updated_at; can restore soft-deleted |
| `memory_delete` | id(required) | soft delete; returns {deleted:true} |
| `memory_export` | namespace?, format?=jsonl | export all (incl. deleted flag) as JSONL text |

Registration: `plugins/mod.rs` + `state.rs build_registry` — tool count 24 → 30 (update tool-count tests). MCP + `/api/tools/memory_*` both auto-exposed.

source detection: MCP handshake client identifier header; fallback "unknown" (no per-token attribution in v1).

## saisi decouple

- `config.yaml` + defaults: `platform.console_url` / `platform.download_url` → `Option<String>` (default None).
- Degrade: UpdatePlugin (`agent_update`) and DesignPlugin (`page_view`) return explicit "remote endpoint not configured" errors when unset.
- Backward compatible: existing configs keep values and behavior.
- New optional `memory:` config section.

## New: vale-desktop (Tauri 2)

```
agent/vale-desktop/
  src-tauri/
    Cargo.toml        # standalone workspace (same pattern as vale-tray)
    tauri.conf.json   # WebView2 window loading http://127.0.0.1:18080/desktop/
    src/main.rs       # window lifecycle, tray, token injection
  src/                # React frontend (reuse panel-react components)
```

- Window content reuses `agent/resources/panel-react`: add `/desktop/` route — multi-tab terminal page (TabBar + per-tab TerminalPane; each tab = one session), memory page (list/search/delete/export), settings page (memory config, connection).
- Token: injected via Tauri IPC / startup arg into localStorage (no URL leak).
- Tray: open/hide/quit.
- Build: cargo-xwin; shipped alongside vale-agent like vale-tray.

## Implementation order (user-confirmed: desktop shell → memory → saisi)

1. **A. Desktop shell**: Tauri 2 skeleton (window/tray/`/desktop/` route/token) + multi-tab terminal page (reuse TerminalPane + TabBar) — verify display layer early.
2. **B. Memory system**: store.rs → sanitize.rs → tools.rs → register → config → tests.
3. **C. saisi decouple**: config Option + degrade + compat tests.
4. **D. Memory page** in desktop shell (browse/search/delete/export).
5. **Verification**: cargo test / clippy / xwin check green; manual smoke (multi-tab open/switch/close, refresh keeps sessions, tray, memory CRUD).

## Out of scope

- No built-in AI loop / one-shot endpoint (pure MCP).
- No automatic call-log ingestion into memory.
- No kitty graphics protocol (Windows unreliable; mainstream web terminals are xterm.js).
- No gateway-side changes (saisi decouple is agent-config-level only).
