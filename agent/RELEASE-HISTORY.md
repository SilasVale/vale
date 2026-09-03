# Vale Agent Release History (bridge era and earlier)

Archived from agent/AGENTS.md (round-328 compaction — the main
file exceeded the 65536-byte workspace budget and the oldest
entries were being truncated away every round). Entries are
chronological and record the state at the time; bridge-era
notes are included for context.

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


## Early iteration rounds (ROUND-245..272 — bridge-era fixes)

Archived from agent/AGENTS.md (round-328 compaction, 2nd pass).

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
