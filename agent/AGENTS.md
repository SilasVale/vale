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

`scripts/build.sh agent` builds vale-agent + the vale-tray app in one go.

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
  a wait page that reappears when the agent dies mid-session. The
  `vale-desktop/` Tauri shell is retired. `/desktop/` reuses `/panel/` assets +
  loopback token injection (web.rs).

## vale-tray (Windows, legacy)

The tray was retired — the npm CLI (`vale` from `vale-agent-npm/bin/vale.js`)
replaced it for management. The crate still builds for reference:

```bash
cd vale-tray && cargo xwin build --target x86_64-pc-windows-msvc --release
```

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

Last updated: 2026-09-04 (round 275 — 1.2.267 LIVE on d1 with the
  hidden-window render fix; E2E suite agent/scripts/e2e/e2e.js 16/16
  incl. panel display verification. Highlights: 266 file transfer, 268
  AI drive paths, 273 repeatable E2E suite, 274 render-freeze root cause
  + fix, 275 doc sync)
  ROUND-245 (2026-09-26, 1.2.244 staged): "AI 操作 terminal/browser 面板不
  显示" triage → FOUR root causes fixed (see Current release): (1) panel
  source had been UNBUILDABLE since f89454d3 (invalid JSX in BrowserPane
  .map + escaped backticks + drawer-tail brace rot; missing useRef/useEffect
  import in TerminalWorkspace) — every release from then shipped the STALE
  c00cbd2d panel.js, so the evidence-drawer animation / stable action keys /
  zoom / banner fixes NEVER reached any device; (2) sanitize redact_line
  INFINITE LOOP (337fb328's re-scan matched the separator it just replaced)
  hung memory_save tool dispatch AND cargo test; (3) bridge idle-capture CDP
  session pinned to the boot page (B3) + frame-cache reset on background-tab
  nav (B2); (4) panel session list had no revive/retry/sweep, so AI-opened
  terminal sessions vanished on a transient refetch failure. d1 also ran
  1.2.241 — two bridge/agent fixes (242/243) behind. Full diagnostics from 2
  parallel audit subagents; all fixes committed + tests green (197 rust / 80
  panel); 1.2.244 = exe rebuild with fixed embedded panel + new bridge.
  ROUND-246 (2026-09-26, 1.2.245 staged): display-path backlog + REAL
  browser. User direction: "面板要像真实浏览器一样清晰,不要截图流,不要
  业务轮询" -> (1) EMBEDDED REAL BROWSER (feat 11aff3a2): Electron shell's
  Browser page now renders a sandboxed WebContentsView over the SPA slot -
  GPU-composited vector text, CDP target on :9333 (SAME endpoint AI drives:
  one browser, zero JPEG). Main-process manager + window.valeEmbedded IPC
  (navigate/place/state, frameOk-gated) + EmbeddedBrowserPane (bounds via
  ResizeObserver, event-driven) + BrowserPage branch (plain browsers keep
  the screenshot stream as fallback). (2) Bridge JPEG q92 for the fallback
  only (bd722b81). (3) C3: ValePlaywright task now probes 9223 and attaches
  --cdp-endpoint when the bridge is up (playwright-probe.ps1; 1f52233b).
  (4) HIGH-3 paged adopt-read (a8ce8c3d) so big AI terminal sessions never
  lose their head (pure helper lib/terminalAdopt.ts + 8 tests). (5) B1
  bridge per-socket ping/pong watchdog reaps ws_relay zombies (f503d614).
  (6) B5 part 2: MCP screenshot action lines link real shots (d35686dc).
  Rust 197 / panel 90 green. Still OPEN: embedded view must be DEVICE-
  VERIFIED on d1 (WebContentsView overlaying the SPA slot, AI driving the
  same target); AI drive-path switch (playwright target = embedded view);
  ValePlaywright task re-register on d1 via next `vale update`.
  ROUND-247 (2026-09-26, 1.2.245 LIVE on d1): embedded real browser
  DEVICE-VERIFIED end-to-end on d1 — SPA Browser page mounts
  EmbeddedBrowserPane (slot ready=1, "native render" badge), main process
  creates the WebContentsView (a first-class CDP target on :9333 alongside
  the desktop SPA), Page.navigate drove it to https://example.com, and the
  view's DOM reads "Example Domain ~ Example Domain" + a 1093x517 PNG
  capture confirms real GPU rendering. AI can attach to the view target on
  the SAME :9333 endpoint it already drives. ValePlaywright task verified
  re-registered with the probe launcher (9223 attach when bridge up).
  Remaining OPEN: SPA-side polish for the embedded pane (nav buttons/zoom/
  evidence drawer parity with the screenshot pane), AI drive-path default
  to the embedded target, and the fullscreen/zoom UX on the real view.
  ROUND-248 (2026-09-26, 1.2.247 LIVE on d1): user report "浏览器超链接
  跳转不了" — real sites open external links in NEW windows (target=_blank);
  the embedded WebContentsView DENIED window.open, so clicks did nothing
  (CDP-reproduced on baidu: click hao123 -> URL unchanged). Fixed: window.
  open is intercepted and the SAME view navigates to the sanitized URL
  (http/https/data/about only; 4a701ecc). Released 1.2.247 + staged on d1
  (main.js round-248 marker x2 verified). Also: embedded pane nav buttons
  (back/fwd/reload) + real URL/history tracking via main-process
  did-navigate events (2e0e6470); AI playwright attach preference desktop
  9333 > bridge 9223 > headless (a8629812). NOTE: device CDP browser-WS
  endpoint became unresponsive to repeated playwright connectOverCDP from
  verification scripts (page-level /json/list works; browser-level WS times
  out) — a test-harness artifact; a clean electron restart resets it. Live
  click-through verification of the target=_blank fix pending a human click
  on the desktop Browser page.
  ROUND-250 (2026-09-26, 1.2.253 LIVE on d1): REVERTED the <webview>
  pivot (1.2.248-252). The pivot was a WRONG call: webview target=_blank
  never worked (allowpopups/attach-timing rabbit hole, 4 releases), while
  WebContentsView had already verified real rendering (round-247) and the
  _blank fix (round-248). The round-248 "instability" was verification
  scripts wedging CDP browser-WS (playwright connectOverCDP), not a
  product defect. Back on WebContentsView (1.2.253) and DEVICE-VERIFIED
  with raw page-level WS (no playwright browser connect): normal link ->
  qq.com CHANGED; target=_blank link -> sina.com.cn CHANGED. LESSON:
  use raw page-level CDP WS for device verification; playwright
  connectOverCDP wedges Electron 33's browser WS after repeated connects.
  ROUND-251 (2026-09-26, 1.2.254 LIVE on d1): embedded pane zoom
  control — the WebContentsView is a REAL browser, so zoom uses the native
  webContents.setZoomFactor via embedded-browser:zoom IPC (0.5-3.0,
  frameOk-gated), with a 75-200% toolbar selector (event-driven).
  DEVICE-VERIFIED: select 150% -> view devicePixelRatio 1.5 on baidu.
  ROUND-252 (2026-09-26, 1.2.255): event-driven AI-actions feed — the
  agent emits `browser-actions-changed` on /api/events when an MCP browser
  action/screenshot is recorded (record_mcp_action / record_mcp_screenshot;
  McpClientPlugin now takes the shared event bus via a module OnceLock
  set_actions_bus). The panel's evidence feed (useBrowser) opens a
  fetch+ReadableStream SSE reader on /api/events (Bearer — EventSource
  can't) and refetches pwshots+actions on the push — AI activity appears
  INSTANTLY; the 3s interval stays only as an SSE-down safety net. +1
  panel test (SSE push -> immediate actions refetch). Rust 198 / panel 91.
  Device: SSE channel streams (epoch frame verified); playwright-changed
  (same bus) device-proven previously.
  ROUND-253 (2026-09-26, 1.2.256 LIVE on d1): embedded-pane AI-activity
  pulse — useAiActivityPulse hook opens the /api/events SSE reader (Bearer)
  and lights a compact "AI operating" chip in the status bar on
  browser-actions-changed / playwright-changed pushes, fading after 8s
  (UI timer — no polling). Chip lives in the SPA chrome strip because the
  native WebContentsView covers the viewport. +1 test (push lights, fade
  clears). Panel 92/92; device-verified (panel.js markers).
  ROUND-254 (2026-09-26, 1.2.257 LIVE on d1): user report "Go 不能用
  回车代替吗" — address-bar Enter now = Chrome-style submit: preventDefault
  + navigate + blur the input, so the real URL (did-navigate push) repaints
  the bar and the view is clickable immediately. Go button remains as the
  mouse path. DEVICE-VERIFIED with real CDP key events (dispatchKeyEvent
  needs text: for char insertion): focus bar -> type bing.com -> Enter ->
  view at https://cn.bing.com/, focus released to BODY, bar shows the real
  URL. +1 test (bare host Enter -> https navigate + blur). Panel 93/93.
  ROUND-255 (2026-09-26, 1.2.258 LIVE on d1): embedded-pane EVIDENCE
  DRAWER (last display-parity gap vs the screenshot pane). New
  self-contained EvidenceDrawer: fetches pwshots + actions ON DEMAND when
  opened + refreshes on the SSE browser-actions-changed push while open
  (round-252) + per-row blob loads — NO polling. Reuses .browser-ev-*
  classes. Embedded pane: "🖼 Evidence" toggle in the status bar; opening
  SHRINKS the native view slot by the drawer width (drawer-open class ->
  ResizeObserver re-places the WebContentsView) so the native view never
  sits under the SPA drawer. DEVICE-VERIFIED: drawer open=true, slot
  753px vs pane 1093px (=340px drawer), 27 shots + 50 actions loaded
  from real pwout. +1 test. Panel 94/94.
  ROUND-256 (2026-09-26, 1.2.259/1.2.260 LIVE on d1): embedded-browser
  RENDERER-CRASH recovery. Before: a crashed renderer left the pane stuck
  on "Starting embedded browser…" forever. Now: main-process
  render-process-gone pushes embedded-browser:gone {reason,exitCode} and
  hides the dead view; embedded-browser:recover force-re-creates the view
  (close + remove + ensure fresh), re-applies the last bounds, navigates
  to the last URL. Pane shows a crash banner ("The embedded browser
  crashed — Reload browser"); recover re-queries state() so the toolbar
  flips back to live. DEVICE-VERIFIED end-to-end: real Page.crash on the
  cn.bing.com view -> banner appeared (reason: crashed) + ready=0;
  clicked Reload -> view recreated at cn.bing.com, banner cleared.
  1.2.260 = ready-state requery fix after recovery. +1 test.
  Panel 95/95.
  ROUND-257 (2026-09-26, 1.2.261 LIVE on d1): ONE-BROWSER completion —
  the ValePlaywright task probe (round-246 C3) only attached playwright-mcp
  to the BRIDGE (9223), so on the desktop the AI drove a chromium the user
  was NOT watching (embedded view on 9333) — or worse, a private --headless
  when the bridge was down. Probe now matches the agent's
  preferred_cdp_endpoint() order: 9333 (Electron desktop embedded view) >
  9223 (bridge) > headless fallback. DEVICE-PROVEN: playwright 1.63
  connectOverCDP attaches to Electron 9333 cleanly (41ms) and DRIVES the
  embedded view (goto example.com OK); earlier connectOverCDP timeouts were
  test-script residuals. After regen + task rerun, playwright-mcp runs with
  --cdp-endpoint http://127.0.0.1:9333 (PID check). Round-246's "AI drives
  what the user sees" architecture now holds end-to-end.
  ROUND-258 (2026-09-26, 1.2.262 LIVE on d1): MAIN-WINDOW HIJACK fix —
  device-caught during one-browser verification: an attached playwright
  (AI) CDP-navigated the MAIN window (Page.navigate bypasses will-navigate)
  — browser_navigate sent the desktop SPA to qq.com and the panel
  vanished, surviving electron restarts (session restore racing loadURL).
  Fix: did-navigate TRIPWIRE on the main window — any landing that is not
  base origin / wait page / about:blank snaps straight back to the desktop
  SPA (snappingBack latch prevents loops). DEVICE-VERIFIED: CDP Page.navigate
  to qq.com -> 6s later the window is back at /desktop/ (SNAPPED_BACK_OK).
  Also DEVICE-PROVEN this round: playwright-mcp browser_navigate works
  against Electron 9333 (qq.com loaded via the real MCP path) and
  playwright connectOverCDP drives the embedded view (goto example.com) —
  the round-246 one-browser architecture is real, now with the main window
  protected from AI hijack.
  ROUND-259 (2026-09-26, 1.2.263 LIVE on d1): AI DEDICATED PAGE — the
  embedded WebContentsView was created lazily (only when the user opened
  the Browser page), so an attached playwright had no safe page to drive
  (it grabbed the main window — round-258 tripwired). The view is now
  created EAGERLY at startup, hidden, loaded to a neutral page; it shows
  only when the SPA Browser page reports bounds. DEVICE-VERIFIED: after a
  fresh electron start (Browser page never opened) CDP lists TWO targets
  (cn.bing.com view + desktop SPA); playwright drives the dedicated view
  (goto example.com) while the main window stays on /desktop/ untouched
  (DEDICATED_VIEW_DRIVEN_MAIN_SAFE).
  ROUND-260..262 (2026-09-04, 1.2.264/1.2.265 LIVE on d1): dead-code
  sweep per user direction ("不用的代码就删除"):
  - ROUND-260: Evidence-toggle attention flash when AI starts a burst.
  - ROUND-261 (1.2.264): mode-B JPEG screenshot stream removed — the
    plain-web BrowserPage fallback (BrowserPane/useBrowser: WS screencast,
    HTTP frame proxy) is gone; plain web shows "browser needs the Vale
    desktop app". Panel 82 tests; -16KB panel.js. DEVICE-VERIFIED.
  - ROUND-262 (1.2.265): agent-side bridge screenshot service removed —
    ws_relay.rs module, /api/browser/frame+input proxy, /api/browser/ws +
    ws-ticket, main.rs bridge autostart+supervision (169 lines), bridge.js
    staging in update flow. pwshots/pwshot/actions KEPT (AI evidence).
    Extension slimmed to studio-links only (browser-control pairing/popup/
    lib/terminal deleted; manifest studio-only). design plugin PAGES no
    longer embeds extension pages. Rust 194 / clippy clean.
    DEVICE-VERIFIED: exe has no ws_relay/ws-ticket strings; ws-ticket ->
    generic not-found; pwshots 200.
  ROUND-264 (2026-09-04): E2E display verification — simulated AI
  operating terminal + browser while watching the Vale Desktop panel:
  TERMINAL: terminal_open via agent HTTP tools -> wrote 30-line output +
  CJK + live marker; panel xterm (DOM renderer, .xterm-rows spans) showed
  ALL of it (hasCJK/hasLine30/hasLive777/hasDONE). BROWSER: playwright
  connectOverCDP drove the embedded view cn.bing.com -> qq.com; SPA
  address bar synced (https://www.qq.com/), canBack true, view target
  confirmed. EVIDENCE: AI screenshot + action line -> drawer shows
  "AI screenshots (28)" + "AI actions (50)". METHOD NOTES for future E2E:
  Page.captureScreenshot on the desktop SPA target TIMES OUT (Electron CDP
  quirk) — verify xterm via .term-host[x].xterm-rows spans (DOM renderer,
  no canvas; hidden hosts exist per session, read the VISIBLE one), and
  verify the embedded browser via the view target URL + SPA .browser-url
  value. Tools: POST /api/tools/{name} with body = the args object (no
  {tool,args} wrapper); terminal_open result is the sid string directly.
  ROUND-265 (2026-09-04): bridge.js FULLY removed — the last 9223 tier is
  gone. mcp_client preferred_cdp_endpoint: 9333 (Electron) -> none
  (headless fork); ValePlaywright probe script no longer probes 9223;
  vale.ts no longer stages/compiles bridge.js; npm package no longer ships
  it; browser-bridge/ source deleted (1647 lines). Non-Electron installs
  fall back to playwright --headless. Rust 194 / clippy clean.
  ROUND-266 (2026-09-04, 1.2.266 LIVE on d1): bidirectional device file
  transfer for AI (user: "传文件到 d1 双向都要"). Added system_file_stat
  (size/kind/modified_ms — call before a transfer to plan paging); raw
  read cap 256KiB -> 1MiB (fewer pull round-trips). DEVICE-VERIFIED:
  300KB upload via 2 append pages, stat size=307200, single-read download
  complete (allA). Rust 196 / clippy clean.
  ROUND-267 (2026-09-04): AI tool-chain workflow E2E — simulated an AI
  completing a real multi-step task across plugins: system_process_list
  (electron 5 procs) -> terminal_execute (local mode, exit 0) ->
  system_file_write (config JSON) -> system_file_stat (59 bytes) ->
  memory_save -> memory_search (retrieved). All tools chained cleanly
  with consistent {ok, result} envelopes — MCP design is AI-friendly
  (execute's NEVER-rerun guidance, read's cursor model).
  ROUND-268 (2026-09-04): AI terminal/browser DRIVE paths E2E-verified on
  the current arch: (1) terminal_execute SESSION mode — open -> execute
  (state:done, prompt-detected, exit 0) -> run_in_background (job_id +
  read_from, status:running) -> terminal_read collects BG-DONE. (2)
  browser_run_script (the AI's canonical browser tool) — self-contained
  CommonJS script connectOverCDP 9333, drove the embedded view to
  example.com, returned TITLE/URL/exit 0; SPA address bar SYNCED to
  example.com (user sees what the AI drives). Both key AI paths clean.
  ROUND-269 (2026-09-04): bridge-removal (round-263) DEVICE-VERIFIED on
  d1: probe script has NO 9223 (9333 + Test-Port only); running exe has NO
  '127.0.0.1:9223' string (9333 present); the live playwright-mcp attaches
  --cdp-endpoint http://127.0.0.1:9333 (not headless). The 9223 tier is
  fully gone on the device — attach chain is 9333 -> headless only.
  ROUND-270 (2026-09-04): doc sync — AGENTS.md/CLAUDE.md build-guide
  sections still described the REMOVED bridge stack (npm bridge.js staging,
  "remote browser (bridge 9224)" summary, ws-ticket/ws_relay + frame/input
  proxy route map). Guide sections now describe the current reality
  (Electron desktop shell on CDP 9333, pwshots/pwshot/actions evidence feed
  only). Round-history entries untouched (they record what was true then).
  ROUND-271 (2026-09-04): doc sync round 2 — "Current release" still said
  "1.2.244 staged" with bridge-era OPEN items; Device facts listed
  "bridge 9224". Both now describe the live state (1.2.266 on d1, bridge
  tiers removed). Round-270's guide-section sync + this status sync leave
  no stale bridge-era description in the agent-facing docs.
  ROUND-272 (2026-09-04): doc sync round 3 — CLAUDE.md's web.rs route map
  still listed the removed frame/input proxy + ws-ticket/ws_relay
  endpoints (round-270 only fixed AGENTS.md's copy); AGENTS.md "Last
  updated" line sat at round 87. Both fixed. No stale bridge-era
  description remains in either agent-facing doc's guide sections.
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

### Current release
- npm **1.2.272 LIVE on d1 (round-285)** — MCP connect auto-selects the
  embedded-view tab on BOTH transports (stdio 1.2.271 + http 1.2.272:
  desktop-CDP + browser_tabs guard) so AI navigation drives the page the
  user watches.
  Earlier: 1.2.267 (round-274) hidden-window render fix; E2E suite
  agent/scripts/e2e/e2e.js 26/26 on d1 (terminal/file/workflow/panel/
  mcp stdio+http/evidence/browser sections).
- Release history below is chronological; older entries record the state
  at the time (bridge-era notes included for context).
- npm **1.2.232 LIVE on d1** — coverage-audit round: gateway auth-gates
  tests (CSRF matrix + Breaker/RouteDO fail-closed denies — shipped with
  ZERO refs), electron FIRST tests via pure src/url-policy.ts extraction
  (userinfo trick, frame IPC auth, scheme sanitizer — chain: build mirror
  + setup/update staging + swap foreach + **package.json files whitelist**
  — the whitelist omission CRASHED electron on 231 (main.js required a
  module the tgz never shipped); device verification caught it in-round,
  232 restaged, electron 4 procs + CDP 9333 + desktop 200 all green. npm
  CLI first tests (psq table + busyIsFresh window, require.main-guarded
  exports); Rust +harden unix 0o600 +tunnel_ctl generation tests (161);
  bridge welcome page now tells users AI drives this same browser.
  RULE: any NEW file under vale-desktop-electron/src or staged onto the
  device MUST be added to package.json "files" AND the staging/swap
  arrays — grep the packed tgz (tar tzf) before deploying. 1.2.230 — ONE-BROWSER (user report): the panel
  screencasts the BRIDGE chromium while playwright-mcp launched its OWN
  headless browser — AI navigation could NEVER appear (live-proved: AI at
  example.com, panel on welcome page). Fix: bridge exposes CDP on loopback
  9223 + auto-FOLLOWS AI tabs (30 s human-pick wins); stdio+HTTP spawns
  attach via --cdp-endpoint (probe, headless fallback); mcp_client_call
  now writes actions.jsonl (timeline + aiActive pulse light up for MCP)
  and --output-dir pins screenshots INTO pwout (its default was CWD-
  relative D:\Vale\playwright\TEMP — invisible forever). DEVICE-PROVEN
  end-to-end: navigate deepseek.com → panel frame shows it; page-*.png
  332KB top of evidence; mcp: lines top of timeline. Also this batch:
  electron IPC audit (origin-pin USERINFO trick 127.0.0.1:18080@evil.com
  → parsed-origin compare; senderFrame auth on all 5 handlers — iframe
  had setAutoLaunch persistence; tray/title /api/status now BEARER-authed
  (401 meant version/CPU/MEM permanently dead); CTRL GET gate; dead
  shell:* IPC removed) + config.yaml unknown-key boot warning + pwshots
  registry-path blindness fix. CI: panel-react lock regenerated with
  optional platform deps (npm-10 CI vs npm-11 local drift), release.yml
  npm ci --include=optional. v1.2.228/229 releases FAILED (lock); 230 =
  RETAGGED onto the npm-10-parity lock fix and the CI flow went FULL GREEN:
  release v1.2.230 (asset vale-agent-1.2.230.tgz) built+attached by
  Actions itself. The lock saga: npm-11 resolution hid vitest→vite8→
  esbuild@0.28.2 from npm-10's ci; regenerated with a locally-installed
  npm@10.9.2 + ci --dry-run verified. Tags now go on via API (git push of
  tags intermittently times out here). CDN pruned to last-5 + latest. 1.2.227 — THREE audits landed same round (extension,
  onboarding, npm-CLI completion): gateway (deployed 7b6f312c) got browser-RPC
  AbortSignal budgets + timeout_secs clamp (was unbounded worker+isolate pin),
  plugin-link expiry sweep INSIDE the lock with fresh reads (stale-isolate
  writeback could resurrect revoked tokens), 256 KiB WS frame cap, Access JWT
  iss pin + atob/verify try-catch (junk sigs 500'd), /mcp one-device fallback
  only for unnamed callers; TEST SUITE followed the new contracts (235 pass).
  npm CLI #6-12: ps() status honesty (task-reg failure now FATAL), psq()
  apostrophe safety, --register deleted (dead + cleartext key in task XML),
  update BUSY marker — FIELD-PROVEN round trip (created→handoff→swap clears;
  planted marker → second update REFUSED with exit 1), uninstall kills
  electron + removes the ValeDesktop pulse, tunnel start truly detached.
  Panel: token trim everywhere, boot setItem guards (private-mode render crash
  loop), htmlFor/aria-label/aria-current. 1.2.226 — post-incident line: 224 = context-proof
  supervisor (device RECOVERED via console; tunnel self-healed through two
  subsequent swaps, cloudflared exactly 1 instance, supervisor line in
  startup.log); 225 = boot-time harden of PRE-EXISTING config.yaml +
  connections CRUD tests (3); 226 = harden switched from NAME grants
  (unmappable machine-account under services → silently NEVER applied,
  config.yaml still world-readable!) to FIXED SIDs — d1 readback now shows
  ONLY Administrators+SYSTEM. kind whitelist device-probed: "SSH" →
  "unknown terminal kind" error. 1.2.222 — DPAPI (VALEDPA1) seals the file secret store
  on Windows (CM still preferred; d1 probe: set→get ACROSS the ':22'/no-
  port spellings — the fallback gap the brand-new unit tests exposed, now
  fixed in file AND keyring get/delete). SPA audit batch device-verified via
  bundle markers: reg-key type=password + wiped, spent-key "do NOT re-send"
  guard, browser-ev-live pulse, max-wait debounce, export busy, keyboard
  tab-close. 155 Rust tests (+3). 1.2.221 — ANSWER to "browser 面板看不到 AI": panel
  activity signal is now the ACTIONS feed too (pulsing dot on Evidence +
  last-action hover), since terminal-driven automation produces none of
  the old screenshot triggers. AUDIT HARVEST (auth-core + plugin-matrix,
  2 sub-agents): gateway got a global CSRF gate (Lax ≠ protection against
  SAME-SITE device panels — cookie mutations now need Sec-Fetch-Site
  same-origin|none), DO_AUTH fail-CLOSED ×3 (DOs have external addrs),
  constant-time admin compares, login dummy-hash; agent: mcp_client
  remote-panic slices (tokio-mutex no-poisoning claim corrected), server-
  path file EXFIL containment, https/loopback policy + 16 MiB caps + log
  rotation; design loopback pin (was an internal port-scan); system clamp;
  update WMI ReturnValue parse + https/same-host download + .old.exe.
  DEVICE-PROBED: design external refused, metadata SSRF refused, loopback
  9229 connects (24 tools) — no false positives. 1.2.220 — CREDENTIAL audit: paths::harden_file shared
  ACL helper, fail-CLOSED for the plaintext secret store (verified on d1
  under SYSTEM: set→get roundtrip exact, file never world-readable, CM
  actually WORKS on d1 so the file fallback rarely engages), terminal_forget_saved
  (was dead forget(): removes saved conn + cascades vault delete — unknown
  id honestly false), secret_delete propagates keyring failures (real
  variant keyring::Error::NoEntry — caught ONLY by the features-matrix
  check; the guessed name would not have compiled), conn list strips legacy
  params.password; MED-3 proxy_secret-in-status investigated + DECLINED
  (it IS the rotation-proof the gateway re-checks). GATEWAY v1 audit:
  chat/completions was ENTIRELY rate-limit-free; probe limiter never wrote
  KV (per-isolate only); model-prefix injected egress URLs (encoded);
  provider 401 bodies echoed KEY FRAGMENTS (scrubKeys); Anthropic SSE
  transform never cancelled upstream on disconnect (billing drain).
  SPA terminal model device-proven: adopt EXACTLY once (base64-hidden
  marker kills the echo false-positive), font 12->13px, forget+26 tools
  live on device spec. 1.2.219 — surfaces audit (Rust): /api/sessions read
  current_exe()/sessions while the WRITER logs to registry DataDir → the
  audit panel was permanently BLIND (verified fixed: endpoint now lists
  real sessions); gateway/connect no longer rewrites config.yaml from a
  token-less default on transient load failure (token-rotation catastrophe
  avoided) + console_url partial semantics; reg-key body via serde_json;
  PUT /api/settings keeps absent keys untouched; session_log: 4 KiB command
  cap + REAL torn-tail repair (first cut was a no-op — caught by self-
  review, regression test now proves it) + .jsonl.tmp pruning. SPA terminal
  audit: cursor model is POSITION-ABSOLUTE (server clamps used to desync it
  permanently → dup/loss storms), evicted→reset, termRef.current=term (one
  line revives refit/resize-push/focus/FONT controls — all silently dead),
  reconnect self-heal, serialized keystrokes, immutable poll updater,
  paged export. Gateway: RouteDO/BreakerDO gained the DO_AUTH gate (they
  ARE externally addressable — PluginHub comment says so). 1.2.218 — (217: three more READ-ONLY audits harvested —
  ELECTRON shell: execSync off the start paths, HTTP liveness watchdog,
  main-window origin pin, permission/window-open denial, CTRL origin gate,
  destroy-eviction; NPM CLI: fresh-install crash, WMI ReturnValue parsed,
  PS -and parse bug (ValePlaywright re-register was NEVER running),
  ensure-desktop path quoting; TERMINAL lock discipline: close() fully out
  of inner). 218 = self-caught REGRESSION of 217: /api/status is token-
  gated so a healthy agent answers the shell's probe with 401 — requiring
  200 made live agents look dead (wait page over a working device).
  Liveness = any HTTP response. Device-verified: running:true + src
  markers. HISTORY: see "history rewrite" section — main@16a01170.
- 1.2.216 durability sweep, two more READ-ONLY audits harvested: MEMORY store (torn-line repair fusing gone, lossy-UTF8 load,
  eviction tombstones PERSISTED, compaction fsync+rollback, append-under-
  lock TOCTOU, sanitizer word-boundary + title/tags coverage + JSON byte-
  stability, nanos mint_id, limit=0; +6 regression tests) and TERMINAL
  backend (CJK tail-trim char-boundary panic → busy-wedge GONE, bg-job
  marks the one real jobs map, shell_633 keys on ACTUAL injection not the
  shell name, serial reconnect shares the live handle with the writer,
  spill_base advances only on successful rotation, first-prompt gate
  covers zero-entry sessions, round-132 D:\diag.log deleted, read_spill
  validates client sids, close reports exit None). DEVICE-PROVEN: flood
  survives, job state:done exit:0, marker path intact, warm bg submit
  62 ms, api_key redacted / tokenizer+secretary benign / ns-id minted /
  tombstone on disk. Also f15ed263 filelog DAILY rotation + dist
  version.json discovery manifest. 1.2.215 was the ws_relay + panel
  dual-review harvest: ws_relay
  hardening (upgrade-header validation before ticket redeem, single-flight,
  3s dial budget, keepalive-adjacent guards, 150 s idle-capped pump
  replacing copy_bidirectional — half-open relays can no longer pin bridge
  WS slots forever; 8-relay budget) + client audit fixes (hidden-tab no
  reconnect, mapXY emits NATIVE frame px — clicks were up to 2x off since
  1.2.185, PROVEN FIXED on d1: precise hit on diag-reported link (262,183)
  → example.com "Learn more" → iana.org; focused address bar no longer
  clobbered by pushes; blob URL + ResizeObserver teardown; evidence cache
  keyed name:mtime; drawer auto-select; lastErr = current-fault gauge,
  cleared on success — verified null after clean nav). 1.2.214 shipped the
  bridge review fixes (212 after catching that 211 carried a STALE dist —
  an old npx-tsc silently emitted nothing; ALWAYS grep the built artifact
  for markers before releasing), 1.2.213 restored the swap script's
  desk-restart `if` opening (a consumed line made the WMI swap die at PS
  PARSE time — two silent no-op updates; diagnose by running the staged
  D:\Vale\vale-update.ps1 synchronously), 1.2.214 killed the last nav bug
  (welcome doc now setContent() + nav verifies page.url() before failing
  on spurious ERR_ABORTED). Browser regression on d1: title push, address
  sync, back/fwd state machine ALL green. Recovered from the dark incident
  via console `schtasks /run /TN ValeAgent` (user action). 1.2.209→210 fixed
  the ValeDesktop hardening: `schtasks /Change` prompts for the /ru password
  (PTY hang!) → use ScheduledTasks cmdlets; pulse action is a GUARDED
  wscript→ensure-desktop.ps1 (Get-Process check → no focus-steal second
  instance). Verified on d1: MSFT_TaskTimeTrigger Rep=PT5M + guarded action.
- 1.2.207: agent.log tracing + wait-page swap; 1.2.206 electron watchdog.
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
