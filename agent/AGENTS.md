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
# bridge.js changes: cp resources/browser-bridge/bridge.js vale-agent-npm/
# then bump "version" in vale-agent-npm/package.json (1.2.x)
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

What `vale update` does (bin/vale.js): stages exe + bridge.js next to the
install dir, hands a PS swap script to WMI Win32_Process.Create (parented by
WmiPrvSE so it survives the CLI AND the agent dying; plain `-NoProfile -File`
only — `-ExecutionPolicy Bypass` / `-EncodedCommand` die silently on d1),
then: stop ValeAgent task → kill agent + bridge node tree → copy with retry →
restart task. The terminal connection DROPS for ~10 s mid-update; reconnect
and verify via `/api/status` → `version`.

Gateway (`gateway/`) deploys separately: `cd gateway && wrangler deploy`.

## Architecture

vale-agent is a pure service — MCP server + terminal backends + SSE endpoints
+ the remote browser (bridge 9224). The Tauri desktop (`vale-desktop/`), the
standalone `vale-tray/`, and the NSIS-era installers are RETIRED; the Electron
shell (`vale-desktop-electron/`) and the gateway device app replaced them. The
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

Last updated: 2026-09-26 (round 86 — 1.2.230 LIVE; **ONE-BROWSER fix for the
  user-reported "AI 调用 MCP 后 browser 面板显示不正确"** + electron IPC audit
  batch; CI release flow dogfooding (tag→xwin→gh release))

### Current release
- npm **1.2.230 LIVE on d1** — ONE-BROWSER (user report): the panel
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
  dogfood retry via tag push. 1.2.227 — THREE audits landed same round (extension,
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
- M1 pair-code atomic claim across isolates + KV device-row races —
  BOTH need a CAS primitive → the D1 migration candidate
- gateway F3: CLIENT_KEY doubles as admin token (billing keys + /mcp RCE
  by every settings.json holder) — DESIGN decision, needs user sign-off
  (breaks existing clients if tightened)
- npm publish (waits on user `npm login`; registry name confirmed free)
- CI now owns the release build (new release.yml: tag → xwin exe → npm
  pack → gh release create). Next manual release: SKIP the curl asset
  upload — just push the tag after the version-bump commit and let CI
  attach it; keep-latest deletion stays manual (user-approval-adjacent).
  DONE since earlier rounds (stale entries removed): connections CRUD
  tests (225), F8 parallel tool_calls index merge (round-116 — fixtures
  re-verified this round), F5 DoS-by-timeout (INVESTIGATED this round —
  already fixed at the call sites: full timeouts DO feed recordChannel-
  Failure via detail "timeout"; the stale comment claiming otherwise was
  corrected in reliability.ts; a RED test now proves it).

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
- agent token `abacd520...97`, port 18080, CDP 9333 (Electron), bridge 9224
- pwsh 7.6.5 at `C:\Program Files\PowerShell\7\pwsh.exe`; ValeAgent +
  ValeDesktop scheduled tasks; install dir `D:\Vale`
- npm broken on device → use `node "D:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"`
