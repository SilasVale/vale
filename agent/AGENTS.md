# Vale Agent Build Guide

> Mirrors agent/CLAUDE.md (build/verify/architecture semantics must stay
> identical; the stage-n living log at the end of THIS file is AGENTS-only —
> CLAUDE.md never mirrors it). Post-2026-08-28 additions: registry-
> first path resolution (src/paths.rs), npm-only install channel, Gateway
> Settings card + POST /api/gateway/connect.

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

`scripts/build.sh agent` cross-compiles vale-agent (the retired tray/Tauri desktop builds were removed round-330).

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
  (`deploy/vale-setup.nsi` + `vale-online-setup.ps1`, NSIS 3.12, built by
  `scripts/build-installer.sh <ver>`) wraps the same npm channel (bootstraps
  Node, installs the pinned tgz, runs `vale setup`); test checklist in
  `deploy/README-installer.md`.

## Device update — npm one-click update (THE ONLY sanctioned rollout path)

**Always ship device updates through the npm flow. Never hand-roll
kill/copy/restart scripts over a terminal PTY** — the PTY is hosted by the
agent itself, so an inline `Stop-Process` kills your own shell before the
restart command runs and leaves the device dark (happened twice on d1).

**And never START a second `vale-agent.exe` from an agent-hosted terminal.**
The same hosting cuts the other way, and this was learned the hard way:

- The agent puts itself in a **kill-on-close Job Object**, and *every child it
  spawns inherits membership* — that is the documented design (see
  `setup_child_reaper_job` in `src/winmain.rs`), and it is why an update can
  never leave orphaned PTY shells behind.
- A shell running inside that agent is therefore IN that job. Anything launched
  from it inherits the same membership, so a second agent started that way ends
  up nested inside the first one's job.
- Observed on d1: launching a test build this way **killed the running agent**
  (which the 60 s watchdog then restarted, so the device came back on its own).
  It cost a device restart and an hour of diagnosis.

**There is also no way to isolate a second instance.** `paths.rs` resolves
`data_dir()` registry-first (`HKLM\SOFTWARE\Vale\Agent\DataDir`, else
`install_dir()`) and there is **no environment override** — so a second agent
shares the live one's session directory and would run `recover_interrupted`
over its audit files. A `VALE_DATA_DIR=` env var does nothing.

If a second instance is genuinely needed, launch it DETACHED — WMI
`Win32_Process.Create` (what `vale update` already uses, precisely so the swap
script survives the agent dying) or a one-shot scheduled task — and accept that
the data dir is still shared. For verifying a new Windows build, prefer the
static checks (PE validity + `strings` for the new code paths) over running it
beside the live agent.

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

# 4. On the device (PowerShell), exactly two commands — WITH the --prefix (see the
#    Install/update block above: without it the install lands elsewhere, reports
#    success, and `vale update` silently ships the OLD release):
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
#    Why it exists: the two builders produce the same artifact, and this makes
#    that structural instead of audited.
#
#    THE "EXES ARE NOT BYTE-IDENTICAL" STORY WAS FALSE, AND I MEASURED IT. On the
#    live release pair the two tarballs differ by exactly 3 bytes out of
#    17,774,080, and the 17.5 MB vale-agent.exe is BYTE-IDENTICAL between the two
#    builders — as it has been for at least twenty consecutive releases, since the
#    audit's WARN arm is reachable ONLY when the exes match. The 3 bytes were a
#    FILE MODE: `package/README.md` packed -rw------- here and -rw-r--r-- in CI,
#    because npm pack preserves the worktree's permissions while git tracks only
#    the executable bit. The compile environment was never the problem; a
#    worktree whose permissions differed from a fresh checkout was.
#    publish-release.sh now REFUSES to pack on that difference and
#    release-audit.sh compares modes and fails on any drift.
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
then: stop ValeAgent task → kill agent tree → copy with retry →
restart task. The terminal connection DROPS for ~10 s mid-update; reconnect
and verify via `/api/status` → `version`.

**A DROPPED CONNECTION IS NOT PROOF THE UPDATE STARTED.** It is the documented
signature of a successful swap, and that is exactly the trap: a transport
failure that never delivered the command looks identical from the caller's side.
Observed on d1 (round 17): `vale update` returned a connection error, was read
as "the swap is running", and had in fact never reached the device — no
`update-busy` marker, no staged `vale-agent.new.exe`, no `scripts\vale-update.ps1`,
no `update start` line. The device was still on the old version.

Verify by EFFECT, with two commands that answer it without guessing:

```powershell
vale status                  # release running, this CLI's version, and the update state
Get-Content "$env:ProgramData\Vale\logs\vale-update.log" -Tail 20
```

`vale status` reads the update-busy marker and reports one of three things, which
mean different things and only one of them is an error: **none in flight** (no
marker — a finished swap clears it), **IN FLIGHT** (fresh marker, a swap is
running now), or **STARTED AND DID NOT FINISH** (marker past the 10-minute
freshness window — the update died before its cleanup, and re-running is safe).
It also prints the drift between the running release and this CLI, which is the
plainest answer to "did the update take?".

`vale update` now appends an `update requested X -> Y` receipt to
`vale-update.log` BEFORE the handoff. So one file separates the cases the
connection drop conflates. Read it as a THREE-way distinction, because the
Rust `agent_update` path (the console/auto channel) writes `update start` to
this same log too, but has no receipt — it has its own tool-result channel:

| `update requested` | `update start` | what it means |
|---|---|---|
| present | absent | the CLI reached the device, the swap never launched — re-run |
| present | present | the CLI's swap launched; check `copy ok=` / `task restarted` below it |
| absent | present | the swap was launched by `agent_update` (Rust), not by the CLI |
| absent | absent | the command never reached the device at all |

The busy marker is cleared by a completed swap, so a marker still present past
the 10-minute window means the swap died before its cleanup. Re-running is
always safe — the operation is idempotent.

**WHAT THE ROUND-17 EVIDENCE ACTUALLY PROVES** (worked out afterwards; the log
originally said only "cause not established"). The marker is the FIRST statement
of `update()`, and every branch of that block either creates it or exits 1 — so a
run that reached `update()` ALWAYS leaves a marker. Observed on d1: no marker, no
staged exe, no swap script, no log line. A marker would also have made the SECOND
attempt refuse (fresh <10 min), and it did not. So the CLI-side explanations are
EXCLUDED: **the CLI never executed on that device.** Why is still unknown, but the
investigation belongs at the MCP tool-call transport, not in the script — and that
is a real narrowing, because three plausible explanations were eliminated rather
than guessed away.

**A FAILED SWAP CANNOT BE DETECTED FROM THE CLI'S EXIT CODE.** `vale update`
returns 0 the moment the WMI handoff is ACCEPTED — `ReturnValue=0` means a process
was created, and the script has not yet written its first line. Every decision
that matters (the fail-closed migration gate, the 12× copy retry, the `$ok`-gated
marker write, the task restart) happens after, in a WmiPrvSE-parented process
whose exit code nobody reads. So: **no path returns non-zero for a failed swap.**
`vale rollback` used to depend on that exit code and wrote its version marker
unconditionally as a result — claiming a version the device was not running, which
makes every UI lie AND makes `agent_update` answer `up_to_date` forever. It now
reads the marker BACK and requires it to show the staged version before pinning.
`vale update` itself still returns on handoff, deliberately: it can block without
risk only where the caller already blocks (`rollback` does).

`vale rollback <x.y.z>` (bin/vale.js): HEAD-checks the pinned tgz on the CDN
(last-5-per-minor keeps the recent line), `npm install -g --prefix
<components\npm-global> <tgz>`, then runs the TARGET build's own `vale update`
so the staged exe IS the rollback build. It then **reads `etc\.vale-release`
back and requires it to show the target version** (bounded 90 s) before writing
`etc\.rollback-pin` and deleting a pre-v2 root-level marker. An unproven swap
writes NO pin, NO marker, and exits non-zero naming the version the device is
actually on — see "A FAILED SWAP CANNOT BE DETECTED FROM THE CLI'S EXIT CODE"
above for why the old unconditional write was a lie that could strand a device.
`agent_update`
(Rust) returns `{"status":"pinned"}` for any remote version other than the pin
while the pin exists; `force:true` on agent_update or `vale rollback --clear`
removes it. `vale update` does NOT clear the pin (it swaps what npm-global
holds = the pinned build). `vale autostart <on|off|status>` flips the ENABLED
flag on both boot tasks — `vale stop` is one-shot (the 5-min watchdog revives
it), so autostart is the only real "don't start at boot" control.

Gateway (`gateway/`) deploys separately: `cd gateway && wrangler deploy`.

**THE GATEWAY'S MODEL CATALOGUE IS HARDCODED AND NOTHING WATCHES IT.** It comes
from `gateway/src/channels.ts`'s `MODEL_REGISTRY`, where one record carries SIX
facets (advertised id, upstream wire slug, US-egress policy, web-search
capability, health card, vision) and `model-registry.test.mjs` keeps them
bidirectional. Adding or retiring a model means editing that source and
redeploying — and no workflow deploys this worker (CI runs `wrangler deploy
--dry-run` for the proxies only). So an upstream adding a model, or silently
RETIRING one, tells nobody.

`node scripts/model-drift.mjs [--json] [--strict] [--gateway <url>]` reports what
each channel advertises against what its upstream offers. Four upstreams answer an
unauthenticated `/models` (or 445, nv 82, cm 69, og 37); gmi/qw/amd/ds answer 401
and are reported as NOT CHECKED rather than as empty. `advertisedNotOffered` is
printed as CHECK — never as a verdict — because the router normalises further
(`[1m]` markers, `og/` wire remaps) and raw name diffing reports false drift; see
the first live run, which flagged one genuine absence among several aliases that are
fine. THAT ONE WAS ACTED ON (round 57): `nv/minimaxai/minimax-m3` was advertised and
NVIDIA offers no MiniMax at all — not prefixed, not bare — so the entry was retired
and the live `/v1/models` went 22 -> 21. The check held up under the obvious
objection (that the wire name might differ from the advertised one) precisely
because the BARE name is absent too; `nv/moonshotai/kimi-k3` and
`nv/nvidia/nemotron-3-ultra-550b-a55b` resolve exactly, so the list is current.
`og/minimax-m3` is a different channel and is untouched. It is an OPS TOOL, deliberately NOT a CI gate: it needs four live
third-party endpoints.

## Architecture

vale-agent is a pure service — MCP server + terminal backends + SSE endpoints
+ the Electron desktop shell (embedded real browser on CDP 9333). The Tauri
desktop (`vale-desktop/`), the standalone `vale-tray/`, and the NSIS-era
installers are RETIRED; the Electron shell (`vale-desktop-electron/`) and the
gateway device app replaced them. The
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
 retired; the npm CLI + Electron shell replaced them. Git history has
 the old crates.)
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
  delete, capacity capped OLDEST-WRITTEN-FIRST (not LRU — reads never move
  `updated_at`) from config `memory: { max_entries, max_bytes,
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
  a wait page that reappears when the agent dies mid-session. The
  `vale-desktop/` Tauri shell is retired. `/desktop/` reuses `/panel/` assets +
  loopback token injection (web/mod.rs). round-274: main.ts sets
  backgroundThrottling:false + the --disable-renderer-backgrounding /
  --disable-backgrounding-occluded-windows switches — a hidden window
  (hide-to-tray / background session) otherwise flips the SPA to
  visibilityState=hidden, Chromium stops requestAnimationFrame, and xterm's
  rAF-driven DOM renderer silently stops painting (blank terminals while the
  AI keeps operating).

## vale-tray / vale-desktop (Tauri) — DELETED (round-330)

Both crates were retired long ago (npm CLI replaced the tray; the
Electron shell replaced the Tauri desktop) but their source + build
steps lingered. Round-330 removed the source trees and their builds
from build.sh (git history retains them). The npm CLI
(`vale` from `vale-agent-npm/bin/vale.js`) is the management surface.

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

## Iteration status (stage-n) — UPDATE THIS ON EVERY ROUND

> Living log for the agentic iteration loop. Any agent resuming work MUST
> read this first, then update it at the end of its round (replace the
> "last updated" line + append to Recent / In progress / Next).

Last updated: 2026-09-12 round 79 (two more CLI findings: a destructive step that could
purge the WRONG directory, and a failed delete reported as an absent pin).
Commit: 780f356c. CI green.
  (1) `uninstall` COMPUTED THE DATA DIR ITSELF INSTEAD OF USING ITS OWN RESOLVER. `setup`
  uses `DATA_DIR` (registry-first, `HKLM\...\DataDir`); uninstall recomputed it from
  `%ProgramData%` — so on a REGISTRY-REMAPPED install it deleted a different directory
  than the device uses and named that wrong one in "data kept at", while `--purge-data`
  printed "data dir purged" over whatever `rmdir` did (`sh()` discards its result at
  every call site). Three verifications added — and the pattern for all three was ALREADY
  five lines above in the same function (the legacy-dir loop checks `fs.existsSync` and
  warns). A failed purge now exits 1 naming the survivor.
  (2) `rollback --clear` REPORTED A FAILED DELETE AS "no pin present": `rmSync(force)`
  ignores only ENOENT, so EPERM/EACCES/EBUSY/EISDIR shared a `catch` with the READ
  failure and the command returned 0 — while the pin was still there, `rollback status`
  said "pinned", and agent_update kept refusing every release. The pin is the state that
  governs auto-updates. It now separates a read error from absence and DECIDES ON A
  READ-BACK rather than on the absence of a throw.
  (3) ALSO CHECKED, NOT CHANGED: the four remaining `%ProgramData%` computations are all
  correct — the resolver's own fallback, the `update-busy` path (a cross-language contract
  with the Rust BUSY_MARKER_REL, pinned by tests), and the registry WRITE whose value the
  resolver's fallback then reads back, so they agree by construction.
  (4) VERIFIED BY EFFECT: `node bin/vale.js rollback --clear` with no pin prints "no pin
  present (nothing to clear)" and exits 0 — the new read-back path. Freshness gate passes
  after rebuild; 35 tests pass.
  (5) STILL OPEN from the CLI audit: F1 `vale update` exits 0 on HANDOFF not outcome (the
  guide documents this as deliberate, and `rollback` already has the bounded read-back —
  `awaitReleaseMarker` — to reuse); F5 `tunnel start` claims success from an unobserved
  async spawn; F6 `vale stop` prints "stopped" unconditionally; F7 `vale run` exits 0 when
  the exe is missing; F10 the release marker is written BEFORE the fatal setup paths, so
  an aborted setup reports the new version as installed; F12 "node_modules verified"
  without checking node_modules.
  Gates: CLI 35 + freshness gate; CI green; d1 on 1.2.359.

Previous round: 2026-09-12 round 78 (TWO subagent audits of surfaces nobody had looked at
— the CLI and the gateway's MCP registry — and both found reasons that state something
false). Commits: d271cdba, 6dd8c820, 65ec4133. CI green; gateway deployed; panel audit
CLOSED (the Logs/accelerators split is a coverage difference, not a defect).
  (1) THE MCP REGISTRY: 7 of its 26 NOT_EXPOSED reasons were FALSE, and two of them hid a
  tool no surface could call. `terminal_jobs` mattered because `terminal_execute` EXPOSES
  `run_in_background` (mcp-tools.ts:155) while the job registry that exists so callers
  "poll terminal_jobs instead of blind-read loops" (exec.rs:1090) was uncallable.
  `terminal_forget_saved` was worse: the device's own comment records that `forget()`
  existed but was UNREACHABLE once before — "saved connections accumulated forever and
  their keychain passwords orphaned" (connections.rs:36-38, MED-4) — so an exemption
  claiming a phantom surface PUT THAT DEFECT BACK. Both are registered now (device-direct
  by prefix, no routing change). Five more false reasons corrected; the count 49 -> 52.
  THE GUARD IS REAL and mutation-proven both ways; no phantom entries; 52 = 26 + 26 + 0.
  The defect was never the mechanism — it was that a reason is prose, and nothing checked
  it.
  (2) THE CLI: 13 ranked findings from a full read of bin/vale.js, and the one fixed here
  is the clearest falsehood — a no-key `vale setup` printed "LOCAL install (no cloud)"
  while the agent creates config.yaml from an embedded default pointing at the public
  console and self-registers at boot and every 6h. Privacy-relevant, and the NEXT line
  already said the opposite. The message now states what happens and how to opt out.
  (3) AND CI CAUGHT ME EDITING A GENERATED FILE. `bin/vale.js` is compiled from
  `src/vale.ts`; the freshness gate recompiles and cmps, so my direct edit failed the PR.
  Fixed at the source and verified the gate locally before committing. Same shape as the
  code-viewer mirror that caught me twice — a generated artifact is not a source.
  (4) RECORDED, NOT FIXED — the CLI audit's remaining ranked findings: F1 `vale update`
  exits 0 on HANDOFF not outcome (the guide documents this as deliberate, and `rollback`
  already has the bounded read-back to reuse); F2/F3 `uninstall` claims "program dir +
  registry removed" and "data purged" with every `sh()` result discarded at all 48 call
  sites AND computes the data dir from %ProgramData% instead of its own registry-first
  DATA_DIR, so a remapped install purges the WRONG directory; F8 `rollback --clear`
  reports a failed delete as "no pin present"; F5/F6/F7/F10 similar.
  (5) THE PANEL AUDIT IS CLOSED. The Logs drawer is panel-only and the accelerators are
  desktop-only, but the desktop has the same DATA via Trajectory/Path, nothing promises
  otherwise, and the drawer arrived with the panel redesign rather than being removed —
  a coverage difference, not a defect by this project's standard.
  Gates: gateway 788 + format + mirror; CLI 35 + freshness gate; CI green; d1 on 1.2.359.

Previous round: 2026-09-12 round 77 (the MIRROR of the dangling check had no guard
either: 24 declarations nothing read, FOUR of them mine from the round before). CI green;
landing deployed; no release needed.
  (1) `custom-prop-check.mjs` failed on USED-but-not-DEFINED. Nothing failed on the
  opposite, and it is not harmless: a declaration with no consumer reads as a design
  system, gets copied into the next frontend, and drifts with nothing to catch it.
  Measured: console 6, panel 14, landing 10.
  (2) FOUR WERE MINE, ADDED THE ROUND BEFORE — `--aura-sweep`, `--aura-sweep-soft`,
  `--aura-glow-strong` (speculative; `--aura-glow` IS read by `.btn-accent`). And
  `--aura-sweep` had ALREADY PROPAGATED TO ALL THREE FILES, which is the failure mode
  this check exists for.
  (3) THE LANDING'S ARE DELETED: that page is self-contained, so a token there cannot
  have an external consumer and dead means dead. 15 definition sites for 9 names (both
  themes) plus the `--aura-2` only the removed sweep had used. It is now 24 defined /
  24 used.
  (4) THE REST IS A RECORDED DECISION: `DEAD_ALLOW` lists each remaining token WITH A
  REASON (neutral ramps, rail inks, `--terminal-bg` = painted by the xterm theme not
  CSS). Anything unlisted FAILS, and a STALE entry fails too — an exemption whose token
  is used again documents a reason that is gone. Mutation-proven both ways.
  (5) AND MY OWN FLOOR CAUGHT A CONSEQUENCE: the contract's landing leg asserted
  ">= 8 shared tokens", a number set when the landing had 9; removing the dead ones took
  it to 7 and it fired. 7 IS HEALTHY (`--aura-1/3/4/5`, both fonts, `--glass-blur`),
  so the fix was NOT to lower the number but to require those names BY NAME — a count
  measures the wrong thing, and a parser reading another block cannot satisfy a name
  requirement with five unrelated tokens. Mutation-proven by renaming `--aura-1`.
  (6) VERIFIED LIVE: wash paints, `--aura-1` #22d3ee, font Segoe, duration 0.2s, card
  `blur(14px) saturate(1.4)`, deleted names absent from the response.
  (7) STILL OPEN: Logs is panel-only while the accelerators are desktop-only — a design
  asymmetry, not a defect, and the last item on the panel audit.
  Gates: custom-property green (landing 24/24, every remaining dead token with a reason);
  token contract green; console + panel build; panel 524; CI green; d1 on 1.2.359.

Previous round: 2026-09-12 round 76 (the token contract checked TWO of the three
frontends — the landing page's 9 shared names were never compared, and two of them meant
different things). CI green; landing deployed; no release needed (worker-only).
  (1) THE BLIND SPOT WAS THE CHECK'S OWN. `token-contract-check.mjs` compared console vs
  panel. The landing declares 28 names of its own AND shares 9; nothing looked at them.
  `--ds-font-family` carried the CONSOLE's name with a DIFFERENT STACK ("SF Pro Text"
  vs "Segoe UI") — on Windows, the only OS this targets, that is one name and two
  visibly different fonts; the landing now adopts the console's stack.
  `--ds-transition-duration` carried the PANEL's name with a third value (0.15 vs 0.2) —
  aligned to the panel's, per the contract's own rule.
  (2) AND ONE NAME THAT SHOULD NOT BE SHARED: `--aura-wash` differed BY DESIGN (the
  landing starts dark and carries lower alphas than the console's #fafafa). A shared name
  holding two deliberate values is what this contract forbids, so it is composed where it
  is used now — the same resolution `--glass-bg` got. The PALETTE stays shared.
  (3) THE COMPARISON IS WHITESPACE-INSENSITIVE, because it has to be: the first three-way
  probe reported FOUR divergences and TWO were formatting — prettier reflows one side
  across lines, and a naively squashed comparison still differed inside parentheses. That
  is the "raw name diffing reports false drift" problem model-drift.mjs documents, and
  shipping it would train a reader to ignore the check.
  (4) TWO THINGS I GOT WRONG WRITING IT, both caught by asserting: I fed `page.js` — a JS
  MODULE with a `<style>` block — to a CSS parser, which matched JS braces too and read
  `:root` correctly ANYWAY (the accidental success that hides a parser pointed at the
  wrong input); the stylesheet is extracted first now and a missing `<style>` FAILS. And I
  compared the two DARK OVERRIDE blocks, whose intersection is exactly ZERO because each
  re-namespaces — it would have reported "no disagreement" for the worst reason. Tokens
  are compared as EFFECTIVE sets (`:root` ∪ override), and each read asserts >= 8 shared
  names so a comparison over nothing cannot pass.
  (5) MUTATION-PROVEN (reverting the font fails naming both stacks) and VERIFIED LIVE on
  agent.saisi.online: the font carries "Segoe UI", the duration is 0.2s, the wash is
  composed inline with the token gone, `--aura-1` still `#22d3ee`.
  (6) STILL OPEN: Logs is panel-only while the accelerators are desktop-only (a design
  asymmetry, not a defect); the landing's 9 DEAD token names (bg-mask-1, border-l3,
  brand-primary, label-dimmed, interactive-bg-active, the 3 state colours, shadow-lv3)
  are still declared with no consumer.
  Gates: token contract green across 3 surfaces × 2 themes; custom-property green; CI
  green on main; d1 on 1.2.359.

Previous round: 2026-09-12 round 75 (the accent failed AA in BOTH directions in BOTH
frontends, and nothing watched it — the ladder moved one rung, and a guard now measures
it). Released 1.2.359; d1 on 1.2.359; audit CLEAN; keep-latest applied.
  (1) THE VALUE, NOT THE INK. Light `--accent: #d9480f` was under AA TWICE:
  `--accent-fg` on it (white) = 4.30 — the login button — and `--accent` as TEXT on
  `--bg` = 4.12. The dark theme was 1.90 for the same button. Last round I fixed dark by
  choosing an ink and said the light half could not be: MEASURED, white gives 4.30 base /
  5.49 hover and black gives 4.88 base / 3.82 hover, so NO foreground passes both. The
  value had to move.
  (2) IT MOVED ONE RUNG DOWN A LADDER THE PALETTE ALREADY HAD: `#bf3a0a` was already the
  hover. before accent #d9480f (4.30) · hover #bf3a0a · dark #a63308; after accent
  #bf3a0a (5.49) · hover #a63308 · dark #8f2b06. That also fixes the accent-as-text
  direction (4.12 -> 5.26), which I had not noticed until the matrix was computed. Every
  console use of `--accent` is a border (no requirement), accent-coloured TEXT, or a
  background under `--accent-fg` — all neutral-or-better darkened.
  (3) VERIFIED LIVE both themes: light white on rgb(191,58,10) = 5.49 PASS; dark
  rgb(43,26,9) on rgb(255,169,77) = 8.80 PASS. And ON THE DEVICE (1.2.359): the panel's
  `--accent` is #bf3a0a with `--accent-fg` #ffffff, ratio 5.49, pass.
  (4) THE GUARD: `token-contract-check.mjs` now reads the tokens the two frontends
  actually declare, per theme, and requires `--accent-fg` on `--accent` AND `--accent`
  as text on `--bg` to clear 4.5. A MISSING token is a failure too — an absent
  `--accent-fg` silently inherits, which is exactly how a 1.90:1 button ships.
  Mutation-proven by reverting the value: it fails with the historical numbers named.
  (5) MY FIRST VERSION OF THE GUARD COULD NOT READ ITS OWN INPUT. It called
  `parseColour` from the probe library, which is built for `getComputedStyle` output and
  reads DIGIT RUNS — so `#ffffff` has no digits and parses to null, and every case
  reported "could not be measured". I had made UNMEASURABLE A FAILURE rather than a skip,
  which is the only reason it did not pass while measuring nothing. The resolver handles
  hex now.
  (6) STILL OPEN: the landing page's `--ds-font-family`/`--ds-transition-duration` hold
  other frontends' names with different values, outside the contract (which compares
  console vs panel only); Logs is panel-only while the accelerators are desktop-only.
  Gates: panel 524 (60 files) + build; console 788 + build + deploy; custom-property
  green; token contract green (with the new assertion); CI + release.yml green; release
  audit CLEAN; d1 on 1.2.359.

Previous round: 2026-09-12 round 74 (Ctrl+Shift+Y did nothing AND round 61's PathView "jump
to step" fix was inert — three copies of one state, none authoritative). Released
1.2.358; d1 on 1.2.358; audit CLEAN; keep-latest applied.
  (1) THE DEFECT: `sessionViews` existed in THREE places (App.tsx:82, DesktopShell:179,
  TerminalWorkspace:110) and APP'S COPY WAS WRITE-ONLY. The shortcut hook lives in App
  and wrote it; PathView's `onJumpToStep` wrote it; NOTHING RENDERED FROM IT, because
  each shell rendered its own `useState`. So the accelerator was a no-op — and round 61's
  "jump to step" wiring, which I reported fixed, never worked in EITHER shell.
  (2) ONE OWNER: App, because that is where the shortcut hook is. It travels in the
  `shared` object App already spreads into both shells, so the two CANNOT get different
  answers. Both shells read it; neither keeps a copy.
  (3) THE WIRING IS COMPILER-ENFORCED: `sessionViews` is a REQUIRED prop on both shells,
  so omitting it at a mount is a type error rather than a silently dead shortcut.
  (4) WHY NO TEST SAW IT — three separate blind spots, and the third is the lesson:
  `useDesktopCommands.test` INJECTS `onSetView` and asserts the mock was called (the
  injected-handler trap, the same one that hid `onJumpToStep`); `DesktopShell.test` had
  no `sessionViews` prop at all because `Props` had no such input; and
  `TerminalWorkspace.test` clicked "Trajectory" and asserted the view RENDERED — which
  passed ONLY because the component kept its own copy. THE TEST WAS ASSERTING THE BUG.
  It is split now: one test owns the notify wire, another owns the render, and the render
  test drives the component the way the app does.
  (5) MUTATION-PROVEN: reinstating the shadow copy fails the new test with "the terminal
  container must be hidden while the trajectory view is active: expected '' to be
  'hidden'" — the original defect, named.
  (6) VERIFIED ON THE DEVICE (1.2.358), which is the whole point: before the keystroke
  `selectedView: ["Terminal"], containerHidden: false`; after Ctrl+Shift+Y
  `["Trajectory"], containerHidden: true`. The accelerator moves the view.
  (7) STILL OPEN: the console's light `--accent` is 4.30:1 with white and NO ink fixes it
  (the accent must darken to ~#bf3a0a — a palette decision across every accent usage);
  the landing page's `--ds-font-family`/`--ds-transition-duration` hold other frontends'
  names with different values, outside the contract which compares console vs panel only;
  and Logs remains panel-only while the accelerators are desktop-only.
  Gates: panel 524 (was 522, 60 files) + build; tsc clean; CI + release.yml green;
  release audit CLEAN; d1 on 1.2.358.

Previous round: 2026-09-12 round 72-73 (the 炫彩 art direction, asked for by the user:
a new mark, an iridescent token layer, the wash, and glass surfaces — across all THREE
frontends, then released as 1.2.357). Commits: d29e3138, 654c990b, 472c4bc2, 494723da,
5efd7d5e. d1 on 1.2.357; audit CLEAN; keep-latest applied (v1.2.357 alone).
  (1) THE MARK: same silhouette (near hill, far ridge, sun over the pass), relit as an
  iridescent sky. RENDERED AND LOOKED AT at 140/72/40/22px before keeping it — v1 read as
  "purple sky over a flat orange band", the horizon was a stripe rather than a sunrise,
  so v2 peaks the warmth AT the horizon and lifts the ribbons into the upper half.
  (2) THE TOKEN LAYER (`--aura-*`, 18 declarations per frontend) is DECORATIVE ONLY: no
  text colour is ever taken from it, so no contrast measurement moves. The block is
  lifted verbatim from the panel into the console.
  (3) THE WASH is a fixed `body::before` with `pointer-events: none`, BELOW every
  surface. The first pass was too timid to see at all — measured by looking at a
  screenshot, it rendered as slightly dirty white.
  (4) WHY THE LIGHT THEME WAS FLAT, and it was not the gradient: `.card` was
  `background: var(--bg)`, fully OPAQUE, so the wash rendered behind every card and was
  hidden by it. Cards are now 84% of their own colour + `backdrop-filter`.
  (5) THE MINIFIER WAS SILENTLY EATING THE BLUR. `backdrop-filter` computed to `none`
  while the built CSS contained it, the token resolved, and the engine reported
  `CSS.supports(...) === true`. Cause: with the standard property FIRST and `-webkit-`
  second, lightningcss collapsed the pair and kept the `-webkit-` form, which this
  Chromium reports as UNSUPPORTED. STANDARD LAST is the survivor. Verified:
  `backdropOnCard: "blur(14px) saturate(1.4)"` in both themes.
  (6) THE LANDING PAGE IS WHERE THE DIRECTION READS BEST — lower alphas (26-34%) than
  the console's (30-62%) and visibly stronger, because the console's light theme starts
  from #fafafa where a soft tint has far less room. Not an intensity problem; a
  background problem.
  (7) I SHIPPED THE OLD LOGO IN THE PANEL. The mark exists in THREE places (the panel's
  `BrandMark`, the console's favicon.svg, the landing's data-URI); I changed two and
  forgot the panel, and EVERY gate stayed green. Found by `strings` on the built exe
  looking for a gradient id that was not there. `Icon.test.tsx` now reads
  `brand/logo-aurora.svg` and requires the same gradient ids, path shapes and stop
  colours — mutation-proven by reproducing the exact miss.
  (8) I NEARLY REPORTED A PHANTOM REGRESSION: my contrast probe returned 13/13 failures
  in the light theme (`stat-value` at 1.15:1). The numbers were the PROBE's —
  `getComputedStyle` returns the glass background as `color(srgb 0.98 0.98 0.98 / 0.84)`
  and my parser took the trailing `84` as the ALPHA. I looked at the page before writing
  it down; the text is plainly readable. The broken instrument was mine.
  (9) THE RELEASE GUARD FIRED TWICE, both times correctly: once for uncommitted panel
  artifacts, once because the exe predated the logo-fix commit. Both are the
  fail-closed behaviour working, not obstacles.
  (10) VERIFIED ON THE DEVICE (1.2.357): all seven aurora gradient ids in the rail mark,
  `isAuroraMark: true`, wash active with `pointer-events: none`.
  (11) STILL OPEN: Ctrl+Shift+Y is a no-op and round 61's PathView "jump to step" is
  inert in BOTH shells — `sessionViews` exists in THREE places and App's copy is
  WRITE-ONLY (runtime-reproduced with a positive control by a subagent; the fix is to
  pass it into DesktopShell and delete its local copy). Also: the landing page's
  `--ds-font-family`/`--ds-transition-duration` hold the other frontends' names with
  different values (outside the contract, which compares console vs panel only), and the
  console's light `--accent` is 4.30:1 with white — no ink fixes it, the accent must
  darken to ~#bf3a0a.
  Gates: panel 522 (60 files) + build; console 788 + build + deploy; landing deployed;
  custom-property green; token contract green; CI + release.yml green; d1 on 1.2.357.

Previous round: 2026-09-11 round 71 (the rail's ✕ — three defects in one control: an
accessible name that lied, no way to undo, and a header counting a row it had hidden).
Commit: 064f8b7c. CI green; NOT yet released (the panel ships inside the exe).
  (1) THE ACCESSIBLE NAME SAID SOMETHING THE ACTION DID NOT DO: `title="Hide from list"`
  and `aria-label="Archive session"` on the same button. A sighted user hovering read the
  truth; a screen-reader user heard a STRONGER claim — archiving implies persisted,
  recoverable state, and this is a local Set in React state. Both say "Hide from list"
  now. The existing test asserted the WRONG name, so it was asserting the defect.
  (2) IT COULD NOT BE UNDONE. The only mutation in the file was `.add` — no removal
  anywhere — so a row hidden by accident was gone until a reload. A "+N hidden" chip now
  appears in the header whenever anything is hidden, restores all of them in one click,
  and disappears at zero.
  (3) THE HEADER COUNTED A ROW IT WAS NOT SHOWING. `rows` is filtered by `archived` and
  the header used the UNFILTERED `sessions.length`, so hiding one made the count
  disagree with the list directly beneath it. It reads `rows.length` now.
  (4) MUTATION-PROVEN BOTH HALVES, and the second restore FAILED: reverting the count
  gives "expected '2' to be '1'"; disabling the undo chip gives "Unable to find the text:
  +1 hidden". But `cp` for the second restore hit a path error and LEFT THE FILE MUTATED
  (`{false && (` still in place). I checked the file rather than assuming the restore
  worked and repaired it. A mutation harness that can silently leave its subject disabled
  is worse than no mutation test — check the subject after every mutation.
  (5) THE REPO CAUGHT MY OWN FIX, which is what the check is for: the new `.side-unhide`
  rule used `--border`, `--text` and `--text-secondary`, defined in NEITHER frontend, so
  every declaration using them was silently DROPPED — the exact round-61 disease.
  `custom-prop-check.mjs` failed naming all three. It now uses the measured pair from
  `.side-count` beside it (`--chrome-ink-dim` on `--surface-chip`, picked there because
  `--muted` measured 4.40, just under AA).
  (6) STILL OPEN: Ctrl+Shift+Y is shadowed by DesktopShell so it does nothing; the Memory
  empty state contradicts its own +New; Logs is panel-only while accelerators are
  desktop-only; the landing page's `--dsw-alias-*` rename. This round's fix needs a
  release to reach the device.
  Gates: panel 521 (60 files) + build; custom-property green; token contract green;
  prettier clean; CI green on main; d1 on 1.2.356.

Previous round: 2026-09-11 round 70 (released 1.2.356 — five verified panel fixes had
been sitting unreleased, and the panel is compiled INTO the exe, so unshipped means
unfixed). Tag v1.2.356; d1 on 1.2.356; audit CLEAN; keep-latest applied.
  (1) WHY A RELEASE AND NOT MORE FEATURES: rounds 53 and 63 produced five verified panel
  fixes — the PathView wiring, the shared version rule, the corrected Playwright security
  claim, the Stop confirmation, the three-state readout — and NONE of them had reached a
  device. The console ships from the worker so its fixes were live the moment they were
  deployed; the panel does not.
  (2) VERIFIED IN THE BINARY BEFORE PUBLISHING, because a Windows exe cannot be run here:
  `strings` shows "NO per-launch token", "stop the browser?", "Open the timeline" and
  `plug-confirm-hint` present, with the OLD false claim ("with a per-launch token") and
  the OLD tooltip ("Show this step in the timeline") both ABSENT. (Two strings I checked
  first came back 0 — "no other users yet" is a CONSOLE i18n string and `releaseVersion`
  is minified away — so absence only counts where the string belongs to the panel.)
  (3) VERIFIED ON THE DEVICE AFTER: `release: 1.2.356`, `this CLI: 1.2.356`,
  `this device is current`. The live Plugins page shows the new security text with the
  old claim gone, the Stop button is present, and no `v1.0.x` appears anywhere — the
  frozen Cargo version is no longer displayed beside the release.
  (4) A TRANSPORT FAILURE THAT LOOKED LIKE A NO-OP: my first `npm i -g` returned "fetch
  failed" and had never reached the device. I did NOT re-run it blindly — `vale status`
  said `latest: 1.2.356 is on the CDN -- THIS DEVICE IS BEHIND by 1 release`, which is
  how the CLI reports drift, so the install was simply re-issued. THAT readout is the
  reason "the command failed" and "the command did nothing" are distinguishable here.
  (5) THE ADD-TIME MODEL VALIDATION I FLAGGED LAST ROUND IS NOT BUILT, ON PURPOSE AND
  WITH A REASON: the worker has NO per-prefix `/models` URL (only per-purpose endpoints
  like OG_ZEN_CHAT and CMD_CHAT), and most upstreams need the user's own key — the drift
  tool's four unauthenticated upstreams are the exception, not the rule. Adding a
  per-prefix table would create the "sixth copy of the catalogue" `channels.ts` explicitly
  warns about, to catch typos on 4 of 8 channels. The honest state is that the channel
  dropdown prevents the WORST version (a prefix nothing routes) and a typo still becomes
  one failed request that names the problem.
  (6) STILL OPEN: the panel audit's remaining items — Ctrl+Shift+Y shadowing App's
  sessionViews (a no-op), the rail's ✕ mislabelled "Archive session" with no undo, the
  Memory empty state contradicting its own +New, Logs panel-only while accelerators are
  desktop-only — plus the landing page's `--dsw-alias-*` rename.
  Gates: release audit CLEAN (`CDN == GitHub asset byte-for-byte`); CI + release.yml
  green; d1 on 1.2.356.

Previous round: 2026-09-11 round 69 (the model catalogue feature is now verified END TO
END — through the real dispatcher, because `wrangler dev` cannot run on this box).
Commit: 82094063. CI green.
  (1) WHAT THE 7 UNIT TESTS COULD NOT COVER: the loop an operator actually performs —
  add through the admin API, see it in `/v1/models`, set it as a route, delete it, watch
  it go. That runs through the route table, the session check and the three serve sites,
  and none of it was exercised together.
  (2) `wrangler dev` CANNOT RUN HERE: `workerd` needs GLIBC 2.32/2.33/2.34 and this box
  is Ubuntu 20.04. So the verification drives the REAL dispatcher
  (`createPluginContext` + `registerPlugins` + `dispatch`) with a seeded admin session —
  everything except Cloudflare's edge. Recorded because it is a standing limitation, not
  a one-off.
  (3) FIVE CHECKS: ADD (reaches `/v1/models` AND the console catalogue AND appears under
  its channel as the BARE name the console groups by, then can be set as a route);
  DELETE; DISABLE (a built-in leaves the catalogue, CANNOT be set as a route, is named by
  the state endpoint, and comes back); VALIDATION (unknown prefix refused, a built-in
  cannot be re-added as custom — that would shadow a six-facet record with a thinner one
  — and a bare name with no prefix refused); and SECURITY.
  (4) THE SECURITY REGRESSION IS NOW PINNED, MUTATION-PROVEN: deleting `requireAdmin`
  from `adminModelState` — exactly the line I originally omitted — fails with
  "GET /api/admin/models answered 200 with NO session". The hole that shipped for a few
  minutes is a test that names it.
  (5) MY OWN TEST HAD A BUG, and it is the same lesson as last round's: I passed a body
  on GET, and `new Request` rejects that outright.
  (6) STILL OPEN: the panel's five audit items (Ctrl+Shift+Y no-op, the rail's
  mislabelled ✕, the Memory empty state contradicting its own +New, Logs/accelerators
  split, the `--dsw-alias-*` rename) — all need a release to reach the device.
  Gates: gateway 788 (was 783) + lint + typecheck + format; CI green on main;
  d1 on 1.2.355.

Previous round: 2026-09-11 round 68 (the user asked whether models can be added/deleted in
the page "like DSH" — and that reframing was right: the catalogue is now DATA, so models
are added, deleted and disabled from the console with no rebuild).
Commits: ba31d985, 5b626a82. Worker deployed; auth verified live.
  (1) THE PREMISE, CORRECTED WITH FRESH EVIDENCE: DSH has NO add-model UI. Its models
  are 20 `- id:` entries in `~/.dsh/settings.yaml`, and its source has no runtime
  catalogue API at all. Its advantage is DATA vs CODE — edit a config file, no rebuild —
  while the gateway's catalogue was `MODEL_REGISTRY` in `src/channels.ts`, so adding a
  model meant editing source, rebuilding and redeploying. THAT was the gap, and closing
  it is what "like DSH" actually means.
  (2) WHAT SHIPPED: from the Models page an admin can ADD a model (channel from a
  select, so the prefix cannot name a route that does not exist; `ownedBy` inherited;
  `wire` accepted only on `og/` because `wireModelName` ignores it elsewhere and
  accepting one would be a lie; egress/search as explicit switches), DELETE a custom
  model, or DISABLE a built-in one. Built-ins are never deleted — six facets cannot be
  re-derived by a form and a KV record deleted by accident could not be restored — and a
  "Disabled models" card (only shown when something is off) brings them back.
  (3) FIVE SITES, because "disabled" must mean disabled everywhere: `/v1/models`,
  `/api/admin/public`, `setRoute`, `isModelUsable` (an EXISTING route to a just-disabled
  model stops, or "retired" would mean "retired for new users"), and the per-channel
  lists.
  (4) I SHIPPED AN UNAUTHENTICATED ADMIN SURFACE AND CAUGHT IT BY TESTING THE LIVE
  ROUTES. `GET /api/admin/models` answered **200** with no session while
  `/api/admin/users` answered 401 — every other handler in that file opens with
  `requireAdmin` and my four did not. Anyone could have added, deleted or disabled
  models on production. Fixed and re-verified: all four now 401. WHAT EXPOSED IT WAS
  COMPARING A NEW ROUTE AGAINST A SIBLING; my own routes "worked" perfectly.
  (5) MY FIRST TEST HAD THE SAME BLIND SPOT AS THE BUG. It asserted the disabled model
  leaves its channel's list — which ALSO passes when the bare→full id conversion is
  removed, because then nothing matches and the whole list empties (round 65's defect,
  exactly). The mutation did not bite, so the test gained the other half — the siblings
  must still be listed — and now fails with "disabling one model also removed
  minimax-m3". 7 checks.
  (6) "ALL GATES GREEN" WAS FIVE OF SIX, AND CI SAID SO. The gateway has `lint`,
  `typecheck`, `test` and `format:check`; I had been running three, and eslint caught a
  useless escape in a regex. Rather than patch the escape I replaced the character class
  with a looser shape test, because ids legitimately carry `:floor[1m]` and nested
  slashes — an allow-list is a list to keep getting wrong. The prefix check against the
  REAL route table is the one that matters. Run `npm run lint` too.
  (7) STILL OPEN: the panel's five audit items (Ctrl+Shift+Y no-op, the rail's
  mislabelled ✕, the Memory empty state contradicting its own +New, Logs/accelerators
  split, the `--dsw-alias-*` rename) — all need a release to reach the device.
  Gates: gateway 783 (was 776) + lint + typecheck + format; gateway-ui 11 + build +
  deploy; token contract green; custom-property green; CI green on main; d1 on 1.2.355.

Previous round: 2026-09-11 round 67 (the console audit is COMPLETE — every finding in it
has now been acted on; this round closed the last two, both on the Overview).
Commit: 5b930a11. Worker deployed; both verified live.
  (1) "CHANNELS HEALTHY" LINKED TO `/keys`, A PAGE WITH NO CHANNEL INFORMATION. Counted
  rather than assumed: `Keys.tsx` mentions channels ZERO times, and `/models` is where
  the per-channel health (up / down / not probed) renders. A tile about channel health
  took you to a page about credentials. Now `to: "/models"`.
  (2) THE SAME EIGHT KEYS WERE RENDERED TWICE ON ONE SCREEN: eight chips inside the
  token card and eight rows in the keys card below, both from `KEY_ORDER`. The LIST is
  strictly more informative — it names each provider and says "configured"/"not
  configured" in WORDS — while the chips encoded the same state as a DOT COLOUR with no
  text. The weaker copy is the one that went. This was the audit's softest finding and
  I nearly left it as dashboard-style redundancy; a colour-only duplicate of a list
  that already says it in words is noise on the page a user lands on.
  VERIFIED LIVE: channels tile href "#/models"; `.ov-keychips .kchip` 0 (was 8);
  `.ov-keylist .ov-keyrow` 8; "DEEPSEEK" appears ONCE (was twice).
  (3) THE CONSOLE AUDIT, ALL 8 FINDINGS, ALL ACTED ON: the non-admin logout (r61); the
  four i18n bypasses + the guard that could not see them (r62); "Clear all" revoking
  without asking and toasting the opposite (r62); `Users` rendering "unknown" as a
  definite negative (r64); the default-channel card that could only be empty, and
  "Restore default (ds)" naming a channel that does not exist (r65); the Overview
  asserting a false zero about a fleet it could not read, plus admin dead links (r66);
  the channels tile and the duplicated key surface (r67). The console's own
  `i18n-parity`, `client-paths` and custom-property guards came out of the same work.
  (4) WHAT REMAINS IS THE PANEL, and all of it needs a release to reach the device:
  DesktopShell shadowing App's sessionViews (Ctrl+Shift+Y is a no-op), the rail's ✕
  mislabelled "Archive session" with no undo, the Memory empty state contradicting its
  own +New (and the page having no heading), Logs panel-only while accelerators are
  desktop-only, and the landing page's `--dsw-alias-*` rename.
  Gates: gateway-ui 11 + build + deploy + devices render smoke; custom-property green;
  token contract green; CI green on main; d1 on 1.2.355.

Previous round: 2026-09-11 round 66 (the console's LAST structural audit item: the
Overview asserted a false zero about a fleet it could not read, and linked non-admins
at a page that bounces them — the same shape as round 64, and fixed the same way).
Commit: 2107e396. Worker deployed; three cases verified live.
  (1) WHAT IT SAID FROM A READ THAT NEVER SUCCEEDED: the tile read "0/0" because
  `getDevices()`'s `.catch(() => {})` left `devices` at its `[]` initial value and the
  tile computes `${online}/${length}`; and the fleet card said "No devices yet — add
  your first one in Devices." — an INSTRUCTION built on a false premise about a fleet
  the page could not see.
  (2) FIXED THE WAY ROUND 64 FIXED `Users`, because the pattern is the console's own:
  `devices` is `Device[] | null` (`null` = not read, or the read failed), the tile shows
  `—` rather than a number it does not have, and the fleet card gained the error banner
  + Retry that `DevicesPanel` already uses.
  (3) AND THE LINKS WERE DEAD FOR NON-ADMINS: the tile and "View all ->" both pointed
  at `/devices`, which `AdminOnly` redirects straight back to `/` — a click that appears
  to do nothing. The tile is a `<div>`, not a `<Link>`, when there is nowhere to go, and
  "View all" is not rendered for a non-admin. A card with no destination is not a link.
  (4) VERIFIED BY EFFECT, three cases: admin+failed -> "—" plus "could not read the
  device list" + Retry; admin+1 device -> "0/1" (truthful); non-admin+403 -> "—" and the
  element is a DIV, not an ANCHOR. A genuinely EMPTY fleet still says "no devices yet" —
  true when the read succeeded, which is exactly the distinction the old code could not
  make.
  (5) CONSOLE AUDIT IS NOW DOWN TO ONE ITEM: the 8-key status rendered twice (chips in
  the token card and a full card below it), and the "Channels healthy" tile pointing at
  `/keys`, a page with no channel information. PANEL REMAINS, and needs a release to
  reach the device: DesktopShell shadowing App's sessionViews (Ctrl+Shift+Y is a no-op),
  the rail's ✕ mislabelled "Archive session" with no undo, the Memory empty state
  contradicting its own +New, Logs panel-only while accelerators are desktop-only, and
  the landing page's `--dsw-alias-*` rename.
  Gates: gateway-ui 11 + build + deploy + devices render smoke; custom-property green;
  token contract green; CI green on main; d1 on 1.2.355.

Previous round: 2026-09-11 round 65 (two more console items, both "the UI states
something the server contradicts" — including a button naming a channel that is not in
the catalogue at all). Commit: da3575eb. Worker deployed; both verified live.
  (1) THE MODELS PAGE'S DEFAULT CARD WAS STRUCTURALLY ALWAYS EMPTY. `"none"` is the
  server's sentinel for "no prefix -> Command Code (GOAT), name passed through as-is".
  Round 58 derived every card's chips from the PREFIXED catalogue — right for the real
  channels, and for the default card it filters for "ids matching no known prefix",
  which is ALWAYS nothing because every advertised id is prefixed. Measured on live
  data: unmatched = []. The card rendered 0 and an empty list while the server's own
  entry lists models and the header badge said 21.
  THE TWO CASES ARE OPPOSITES, and the code now says so: for THAT card
  `routes[].models` are the right source AND the right form (bare names are exactly
  what routes there), while for every other card they are the trap that set the wrong
  channel in round 58. VERIFIED LIVE: n=1, chip `deepseek/deepseek-v4.1-flash`, and
  clicking sends exactly it.
  (2) "RESTORE DEFAULT (ds)" NAMED A CHANNEL THAT DOES NOT EXIST. The button calls
  `setRoute(null)`, whose real default is `cm/deepseek/deepseek-v4.1-flash` (Command
  Code); the live catalogue advertises og/, or/, nv/, gmi/, qw/, cm/ — there is no `ds/`
  at all. The label no longer names a channel, because the description directly above it
  already states the real one in both languages. A label that repeats a server constant
  is a second copy that can drift, and this one had. VERIFIED LIVE.
  (3) STILL OPEN, from the two audits: console — the Overview's false zeros for failed
  reads plus `/devices` links that dead-end for non-admins, and the 8-key status shown
  twice. Panel — DesktopShell shadowing App's sessionViews (Ctrl+Shift+Y is a no-op),
  the rail's ✕ mislabelled "Archive session" with no undo, the Memory empty state
  contradicting its own +New, Logs panel-only while accelerators are desktop-only, and
  the landing page's `--dsw-alias-*` rename.
  Gates: gateway-ui 11 + build + deploy; custom-property green; token contract green;
  prettier clean; CI green on main; d1 on 1.2.355.

Previous round: 2026-09-11 round 64 (the console rendered "I could not read it" as a
definite negative, and the console already had the pattern that fixes it — one file
over). Commit: 467b1a30. Worker deployed; three states verified live.
  (1) THE DEFECT: `Users.tsx`'s loader swallowed BOTH reads into `/* noop */`. A failed
  password read rendered "— (not set)" when the truth was "could not read it" — a
  different fact, and the one that matters when you are about to set a password. A
  failed user list rendered as a card titled "Users" with nothing under it,
  INDISTINGUISHABLE from "there are no users".
  (2) THE PATTERN ALREADY EXISTED IN THE CONSOLE, one file over: `DevicesPanel` keeps
  three states — `devices === null` -> skeleton, `length === 0` -> Empty, `loadError`
  -> a banner with Retry. Users had two. "A fix that already existed, applied to one of
  a pair" again (rounds 45, 47, 55, 63) — the most repeated shape in this log.
  (3) THE TYPE-CHECK ENFORCED IT: `users` is `User[] | null` and `pwSet` is
  `boolean | null`, so the compiler REJECTED the two-state version rather than letting
  it compile and lie. Declaring the states in the types is what makes the rendering
  honest, and it caught my first attempt.
  (4) VERIFIED BY EFFECT, all three states in one probe on the live worker:
      failed -> "could not read — state unknown" + "Failed to load the user list" + Retry
      empty  -> "set" + "No other users yet"
      ok     -> the user listed, password "not set" (truthful)
  Before the fix the failed case rendered "— (not set)" with a blank list.
  (5) A STALE-BUNDLE REMINDER, recorded because it nearly produced a false conclusion:
  the first probe of this fix showed the OLD behaviour, because I had built but not
  deployed. Round 46 recorded the same trap for the panel; this is the console's.
  (6) STILL OPEN, from the two audits: console — the Overview's false zeros for failed
  reads plus `/devices` links that dead-end for non-admins, the `none` Models card that
  can only show 0, "Restore default (ds)" naming a default the server contradicts, the
  8-key status shown twice. Panel — DesktopShell shadowing App's sessionViews
  (Ctrl+Shift+Y is a no-op), the rail's ✕ mislabelled "Archive session" with no undo,
  the Memory empty state contradicting its own +New, Logs panel-only while accelerators
  are desktop-only, and the landing page's `--dsw-alias-*` rename.
  Gates: gateway-ui 11 + build + deploy; custom-property green; token contract green;
  CI green on main; d1 on 1.2.355.

Previous round: 2026-09-11 round 63 (three more audit findings fixed AND SHIPPED —
released 1.2.355 because the panel is compiled into the exe, so a panel fix that is
not released is not a fix). Commits: c918f3f7, 58aaadc6. Tag v1.2.355; d1 on 1.2.355.
Audit CLEAN (`CDN == GitHub asset byte-for-byte`); keep-latest applied (v1.2.353/354
releases and tags deleted, v1.2.355 is the only one).
  (1) THE DEVICE REPORTS TWO VERSIONS AND THE PANEL SHOWED BOTH. `release` is the npm
  release (1.2.x) — the number that changes and the only one that answers "is my device
  current?"; `version` is the FROZEN Cargo protocol version (1.0.x). `DesktopShell` had
  learned this and says so in a comment beside its own copy of the rule; `ConnectCard`'s
  probe kept using `version`. In the desktop shell both are on screen AT ONCE — status
  strip v1.2.354, Settings v1.0.145, same device. The rule is now ONE function
  (`lib/agentVersion.ts`) used by both, because two copies is what let them disagree;
  fixing only the second caller would have left the cause. Five tests, one the exact
  regression.
  (2) THE PLAYWRIGHT CARD PROMISED A SECURITY BOUNDARY THE AGENT REMOVED: "loopback-only
  listener with a per-launch token", while `manager.rs` records the token plan as "a
  no-go … no longer a security boundary" (the flag does not exist). The card now states
  what does: 127.0.0.1 binding + `--allowed-hosts 127.0.0.1`, and says plainly there is
  no token.
  (3) "STOP" KILLED THE BROWSER WITH NO CONFIRMATION — `taskkill /T /F` on the whole
  node+Chromium tree, killing a browser an AI client may be driving, while every other
  destructive control in the panel asks first. Same inline two-step now, SHARING one css
  rule with `mem-confirm-hint` instead of adding a second copy of three declarations.
  (4) WHY A RELEASE WAS THE POINT: the panel is embedded in the exe via include_str!,
  so all of it — including round 53's PathView wiring — was invisible until shipped.
  VERIFIED IN THE BINARY before publishing (`strings`: the new security text present,
  the old false claim ABSENT), then on the device after: `release: 1.2.355`, `this CLI:
  1.2.355`, `this device is current`, and the live Plugins page shows the new text with
  the old claim gone.
  (5) STILL OPEN, from the two audits: console — false zeros for failed reads plus
  `/devices` links that dead-end for non-admins, the `none` Models card that can only
  show 0, "Restore default (ds)" naming a default the server contradicts, `Users`
  rendering "not set" for a failed read, the 8-key status shown twice. Panel —
  DesktopShell shadowing App's sessionViews (Ctrl+Shift+Y is a no-op), the rail's ✕
  mislabelled "Archive session" with no undo, the Memory empty state contradicting its
  own +New, Logs panel-only while accelerators are desktop-only, and the landing page's
  `--dsw-alias-*` rename.
  Gates: panel 521 (was 516) + build; release audit CLEAN; CI + release.yml green.

Previous round: 2026-09-11 round 62 (acting on the round-61 audit backlog: a
destructive action that toasted the OPPOSITE of what it did, and four strings that
rendered the wrong language — plus the guard that could not see them).
Commit: 8c8c8e24. Worker deployed; both verified by effect.
  (1) "CLEAR ALL" REVOKED EVERY REGISTRATION KEY WITHOUT ASKING, THEN SAID IT HADN'T.
  `handleRevokeAll` destroyed all unused keys on the first click while every other
  destructive control here confirms (`Keys.tsx`/`Overview.tsx` use `confirm()`, device
  delete uses a modal), and toasted `devices.regKeysEmpty` — the EMPTY-STATE string —
  as if it were success, so the one feedback after a destructive action described the
  ABSENCE of the thing rather than its removal. VERIFIED LIVE: the dialog now reads
  "Revoke all 2 unused registration keys? This cannot be undone.", two DELETEs follow,
  and the toast says "Revoked 2 registration key(s)".
  (2) FOUR STRINGS BYPASSED i18n. Chinese in the English console (`Keys.tsx` window
  labels 周/月, `余额: …`); English in the Chinese console (`Users.tsx` set/not-set,
  `Auth.tsx`'s two placeholders). All six now go through `t()` in both dictionaries.
  (3) AND THE GUARD COULD NOT HAVE CAUGHT IT: `i18n-parity.test.mjs` compares the two
  DICTIONARIES, so a literal written into JSX is invisible to the check whose stated
  purpose is exactly this failure. It now also refuses CJK in console source outside
  `i18n.ts` — the detectable half, unambiguous because the source language is English.
  The other direction cannot be found mechanically and is not claimed.
  (4) TWO THINGS THE NEW GUARD TAUGHT: it immediately found two MORE CJK literals that
  are CORRECT (the language toggle names the other language in its own script), which
  now carry an explicit `i18n-allow-cjk` marker rather than a pattern-match exception;
  and MY FIRST MARKER WAS LINE-EXACT AND PRETTIER REVOKED IT — reformatting moved the
  trailing `{/* … */}` to its own line, so the marker was still in the file and no
  longer beside the literal, and the check reported the two legitimate toggles as
  leaks. The marker is matched over a ±2-line window now. An opt-out whose meaning
  depends on a line boundary is an opt-out a formatter can revoke.
  (5) STILL OPEN, from the two audits and not yet acted on — console: false zeros for
  failed reads plus `/devices` links that dead-end for non-admins, the `none` Models
  card that can only show 0, "Restore default (ds)" naming a default the server
  contradicts, `Users` rendering "not set" for a failed read, the 8-key status shown
  twice. Panel: DesktopShell shadowing App's sessionViews (Ctrl+Shift+Y is a no-op),
  Playwright Stop with no confirm, the rail's ✕ mislabelled "Archive session" with no
  undo, a stale Playwright security claim, ConnectCard showing the frozen Cargo
  version, the Memory empty state contradicting its own +New, Logs panel-only while
  accelerators are desktop-only, and the landing page's `--dsw-alias-*` rename.
  Gates: gateway-ui 11 (was 10) + build + deploy; gateway 776 + format; token contract
  green; custom-property green; devices render smoke OK; CI green on main.

Previous round: 2026-09-11 round 61 (the first MULTI-AGENT round in a while — two audit
subagents, one per frontend, as the objective asks — and the console audit's top
finding was a logged-in NON-ADMIN being signed out by their own landing page).
Commits: 497ee5dd, 2fdf9814, ba56babc. Worker deployed; three fixes verified live.
  (1) DANGLING `var()` SILENTLY DELETES ITS DECLARATION. `color: var(--x)` with `--x`
  undefined makes the declaration INVALID, so the property is DROPPED and the element
  inherits — no error, no log, the page renders, just not the rule. The Models page
  named THREE tokens that exist in the PANEL's set and not the console's
  (`--accent-soft`, `--accent-on-soft`, `--danger`), so the AMD lane had NO stripe and
  the current chip was not highlighted. EVERY CONTRAST SWEEP STILL READ 0/AA: a
  dropped `color` leaves an INHERITED colour, which measures fine. A probe cannot see
  a declaration that never applied, and the token contract could not either — it
  compares names BOTH sides declare and these were declared by neither.
  `scripts/custom-prop-check.mjs` (in CI) now requires every custom property USED in a
  frontend to be DEFINED in it: console 50/47, panel 82/72, landing 28/19, zero
  dangling. Mutation-proven, and it exits 1 rather than warning.
  (2) AND THE TOKEN CONTRACT CAUGHT MY OWN FIX: I defined `--accent-on-soft` with a
  value I picked (#a63308); the contract failed with "console #a63308 vs panel
  #9c3a0a" because that name is shared and round 42's rule is that the panel's value
  wins. Taking it was also better — 6.20 on #ffefe5 against 6.04. A shared name
  meaning two things is exactly what that check exists to prevent.
  (3) THE SEVERE ONE: a logged-in NON-ADMIN was signed out by the Overview's load.
  It probed `/api/plugins/status` for every role; that endpoint answered 401 "Not
  logged in" to an authenticated non-admin, and the client treats ANY 401 as a dead
  session. PROVEN LIVE before fixing: `/api/me -> 200`, `/api/devices -> 403`,
  `/api/health -> 200`, `/api/plugins/status -> 401` => `isLogin: true`. Fixed on BOTH
  sides: the worker now separates `!user -> 401` from `role !== admin -> 403` (as
  `auth.ts` already did), and the console puts every admin-only read behind the one
  guard that already existed. Verified: no plugins/status request at all, stays on
  Overview.
  (4) THE PANEL AUDIT'S TOP FINDING: `onJumpToStep` was declared in `PathView.tsx` and
  passed by NEITHER mount, so every "show this step in the timeline" button was inert
  in both shells — and the component test passed because it INJECTS the handler. The
  component worked; the wiring did not; no test could see the difference. Both mounts
  wired; the tooltip now says what the control does.
  (5) THE REST OF BOTH AUDITS IS RECORDED, NOT LOST. Console: false zeros/empties for
  failed reads plus `/devices` links that dead-end for non-admins; "Restore default
  (ds)" naming a default the server contradicts; `Users` rendering "not set" for a
  failed read; the `none` Models card that can only ever show 0; "Clear all" revoking
  without confirmation and toasting the opposite; the 8-key status shown twice; four
  strings bypassing i18n. Panel: DesktopShell shadowing App's sessionViews so
  Ctrl+Shift+Y does nothing; Playwright Stop with no confirm; the rail's ✕ mislabelled
  "Archive session" with no undo; a Playwright security claim the agent removed;
  ConnectCard showing the frozen Cargo version; the Memory empty state contradicting
  its own +New; Logs panel-only / accelerators desktop-only.
  Gates: gateway 775 + format; gateway-ui 10 + build + deploy; panel 516 + build;
  custom-prop green; token contract green; CI green on main.

Previous round: 2026-09-11 round 60 (I went hunting a "two lists that must agree"
defect, found the code CORRECT twice, and closed the structural gap that keeps it
correct: the rail has a compile-time guard, the two SHELLS had none).
Commit: f8917360. CI green.
  (1) WHAT IS ACTUALLY THERE: `PanelApp` (browser panel at `/panel/`) and
  `DesktopShell` (Electron at `/desktop/`) each render all seven pages, via their own
  `{page === "x" && <XPage />}` chains. Both correct.
  (2) WHAT IS MISSING: `PAGE_ICONS` is `Record<Page, IconName>`, so the TYPE-CHECK
  forces the RAIL to have an icon per page — nothing forces either SHELL to render
  one. Add a member to `Page` and you get a rail button opening a blank content area,
  compiler happy, and the failure lands on ONE shell: this log's most repeated shape
  ("a fix that already existed, applied to one of a pair" — rounds 45, 47, 55).
  (3) `src/lib/pageCoverage.test.ts` (3 checks, in the panel suite CI already runs)
  parses the union from `Shell.tsx` and requires every member as a `page === "x"`
  branch in BOTH shells, plus agreement between them. >= 5 pages and >= 5 branches per
  shell, because a comparison over an empty set passes for ever.
  (4) MUTATION-PROVEN BOTH WAYS: deleting `settings` from `PanelApp` alone fails naming
  the file and the page; adding `| "diagnostics"` to the union fails naming it.
  (5) TWO THINGS I GOT WRONG, both caught by CHECKING: I read `PanelApp`'s render with
  `head -8` and concluded it never rendered `SettingsPage` — a blank Settings page on
  the web panel, which would have been a real defect worth a round. Line 118 renders
  it; my own truncation hid it. And I expected the rail to be a second hand-maintained
  copy of the pages; it is DERIVED from `PAGE_ICONS`, so it cannot drift.
  (6) ALSO VERIFIED RATHER THAN TRUSTED: the guide's claim that an unmirrored device
  tool "is not merely unlisted, it is uncalled" and that doing neither "fails the
  gateway suite". Tested by appending a fake tool to `agent/spec-tools.json`: the suite
  fails with "device tool totally_new_device_tool (plugin terminal) is neither
  registered in mcp-tools.ts nor decided against in NOT_EXPOSED". The assurance HOLDS.
  (7) STILL OPEN: the panel's governance-pill visual prominence (a taste call), the
  `--dsw-alias-*` namespace rename on the landing page, and the drift tool's
  "opportunity" rows.
  Gates: panel 516 (was 513) + build; prettier clean; CI green on main.

Previous round: 2026-09-11 round 59 (the console got its URL contract in round 46; the
PANEL — which ships INSIDE the exe — had none, so it now has one, and writing it
reproduced the very bug the contract exists to catch).
Commit: 642bd484. CI green.
  (1) WHY IT MATTERS MORE ON THE PANEL: every panel test stubs `fetch`, so a path the
  agent does not answer renders an empty view with a GREEN suite — and the panel is
  compiled into the binary, so the defect is not a bad deploy that can be rolled back
  but something baked into a release.
  (2) BOTH SIDES ARE READ: the panel's paths from its own source, the agent's from the
  route literals in `src/web/*.rs`. A hardcoded list on either side would be a third
  copy of the thing being checked.
  (3) MY FIRST VERSION HAD THE BUG THIS FAMILY KEEPS PRODUCING: it stripped `//`-to-end-
  of-line by hand to drop comments, which ate `${proto}//${hostname}/api/events/term`
  — the `//` after `}` is a protocol-relative separator, not a comment — so the real
  path vanished and the check reported one it could no longer see. Replaced with the
  TYPESCRIPT AST (`ts.createSourceFile` + a literal walk). A hand-rolled parser for a
  language that ships its own lexer is a check that can only be wrong: round 48's
  lesson, and round 42's token parser matching inside a comment.
  (4) IT SURFACED A PATH THAT IS CORRECTLY NOT THE AGENT'S: `/api/browser-session/open`
  is on `http://127.0.0.1:9444`, the ELECTRON SHELL's origin. Absolute URLs naming a
  host are excluded — they target a different server by design.
  (5) MUTATION-PROVEN IN BOTH DIRECTIONS, and the first attempt taught something: the
  panel-side rename bit immediately; the AGENT-side rename did NOT, because the literal
  appears FOUR TIMES in `mod.rs` so one edit left the route set intact. I checked why
  instead of recording a proof I did not have — renaming all four fails naming it.
  (6) ALSO CHECKED, found consistent, deliberately unchanged: the console's rail nav and
  its router declare the SAME six paths (no entry can land on a dead route); and the
  panel has NO i18n (hardcoded English), so round 58's zh/en parity defect has no
  counterpart there.
  (7) STILL OPEN: the panel's governance-pill visual prominence (a taste call), the
  `--dsw-alias-*` namespace rename on the landing page, and the drift tool's
  "opportunity" rows.
  Gates: panel 513 (was 510) + build; prettier clean; CI green on main.

Previous round: 2026-09-11 round 58 (I finally COMPARED the two live catalogue surfaces
instead of trusting the word "derived" — and the page I shipped in round 49 was
setting the WRONG CHANNEL and rendering Chinese in an English UI).
Commit: 36d25142. Worker deployed; both verified live in both languages.
  (1) THE COMPARISON, which is the whole round: `/api/admin/public` and `/v1/models`
  were fetched and diffed for the first time. `ROUTE_INFO` carries TWO lists and they
  are NOT interchangeable:
      models:          ["og/mimo-v2.5", ...]        21 PREFIXED ids == /v1/models exactly
      routes[].models: ["mimo-v2.5", ...]           BARE names
  The guide said the catalogue is "derived from MODEL_REGISTRY" — true of the
  top-level list, and I read `routes[].models` instead. "Derived" was an assurance
  about the FILE, not about the FIELD I used.
  (2) THE BUG: routing is by PREFIX and an unprefixed name goes to COMMAND CODE, so
  clicking a model under "OpenCode Go" silently switched to a different channel.
  PROVEN on the live page before fixing: chip `mimo-v2.5` -> `PUT /api/me/route
  {"model":"mimo-v2.5"}`. After: the chip reads `og/mimo-v2.5` and so does the PUT.
  The page renders the AUTHORITATIVE list now; `routes` supplies only each channel's
  name and description. `"none"` is a SENTINEL for the default channel, so it is
  excluded from prefix matching rather than matched literally; a missing `models` list
  FAILS rather than falling back to the bare names, because that fallback IS the bug;
  and `total` no longer double-counts models listed on two channels.
  (3) A SECOND DEFECT IN THE SAME PAGE: every `models.*` key and `nav.models` existed
  in zh and NONE in en, and `t()` falls back to the Chinese dictionary — so `lang=en`
  rendered the page ENTIRELY IN CHINESE ("模型目录", "个模型", "渠道可用", "未探测")
  inside an English UI. Nothing caught it: the keys existed (in zh), the type-check
  passed because the key union comes from either dictionary, and no test compared them.
  (4) THE PIN: `gateway/ui/test/i18n-parity.test.mjs` requires zh and en to declare
  the SAME keys, names the Models surface explicitly, and asserts >= 200 keys per side
  so a parse that reads nothing cannot report parity. Mutation-proven. The dictionary
  is now 258 keys per language with ZERO gaps — so this was the only one, which is
  worth knowing rather than assuming.
  (5) STILL OPEN: the panel's governance-pill visual prominence (a taste call), the
  `--dsw-alias-*` namespace rename on the landing page, and the drift tool's
  "opportunity" rows.
  Gates: gateway 775 + format; gateway-ui 10 (was 7) + both render smokes; token
  contract green; CI green on main.

Previous round: 2026-09-11 round 57 (a finding the ops tool had reported on EVERY run
since it was written was finally ACTED ON — the gateway advertised a model NVIDIA has
never offered, and the console would now offer it as a clickable chip).
Commit: ca8172cb. Worker deployed; verified by effect.
  (1) THE FINDING: `nv/minimaxai/minimax-m3` was in MODEL_REGISTRY and absent from
  NVIDIA's catalogue. The drift tool had flagged it every run; every round recorded
  it as "one genuine absence" and moved on. Recording a defect is not fixing it —
  round 55's lesson, one level up.
  (2) IT SURVIVED THE OBVIOUS OBJECTION, which is why acting was right rather than
  hasty: the tool compares the ADVERTISED id against the upstream list, so the
  mismatch could have been a prefix artefact (`nv/` stripped on the wire). It is not
  — NVIDIA has NO MiniMax entry at all, prefixed or bare, across 82 models of which
  7 are Chinese-lab (yi-large, deepseek x3, kimi x2, glm). `nv/moonshotai/kimi-k3`
  and `nv/nvidia/nemotron-3-ultra-550b-a55b` resolve EXACTLY, so the list is current.
  (3) WHY IT GOT WORSE SINCE IT WAS FOUND: round 49's console Models page renders the
  server-derived catalogue, so this id became a SELECTABLE CHIP. Choosing it fails
  upstream. An advertised model that cannot work costs a user a failed request.
  (4) VERIFIED BY EFFECT ON THE LIVE WORKER: 22 -> 21 advertised; nv/ is now
  [nemotron, kimi-k3]; `og/minimax-m3` is a DIFFERENT channel on a different upstream
  and is untouched. model-drift reports no CHECK for nv/ at all now.
  (5) THE FIXTURE MOVED WITH ITS SUBJECT: the entry was also the BYOK fixture in
  `model-route.test.mjs` ("pure BYOK (nv/gmi): env key never substitutes"), so it
  moved to `nv/moonshotai/kimi-k3` — a model that exists — rather than the test being
  deleted with the entry.
  (6) THE REPO CAUGHT WHAT I WOULD HAVE SHIPPED: editing `src/channels.ts` left the
  SOURCE VIEWER MIRROR stale and `code viewer: the tracked mirror matches what src/
  would publish` failed, naming its own fix (`bash gateway/scripts/sync-code-viewer.sh`).
  That check exists so the viewer cannot serve code the worker does not run.
  (7) THE GUIDE'S CLAIM WAS STALE AND IS FIXED: the model-drift paragraph said this
  was "one genuine absence" and stopped; it now records that it was acted on and how
  the objection was answered.
  (8) STILL OPEN: the panel's governance-pill visual prominence (a taste call), the
  `--dsw-alias-*` namespace rename on the landing page, and the drift tool's
  "opportunity" rows (80 nv / 66 cm models upstream we do not advertise — adding one
  needs the registry's other five facets, so it is a product decision, not a
  mechanical one).
  Gates: gateway 772 + format; token contract green; release-audit 9; e2e-only 5;
  CI green on main.

Previous round: 2026-09-11 round 56 (the FOURTH instance of one disease, and the worst:
a CI gate that runs on EVERY PUSH passed while testing nothing — I stopped fixing
instances and audited the whole repo for the pattern). Commit: 22494a05. CI green.
  (1) THE AUDIT FIRST, and it is part of the result: no `continue-on-error` anywhere
  in `.github/workflows/`; the only conditional steps are `if: failure()` (correct)
  and one `workflow_dispatch`-gated job (by design); ZERO test skips
  (`.skip(`/`it.skip`/`#[ignore]`) in agent, gateway, panel or scripts. The pattern
  was not lurking in the places I expected.
  (2) IT WAS IN THE E2E GATE. CI runs, on every push:
      node scripts/e2e/e2e.js --token "$TOKEN" --base http://127.0.0.1:18811 --only governance,runs
  and the suite ended on `process.exit(failed.length ? 1 : 0)`. `--only` is a FILTER,
  so a name that no longer exists made `want()` false for every section: nothing ran,
  `failed` was empty, and it printed `== 0/0 passed ==` and exited 0. MEASURED before
  the guard: `--only governance-typo,nonexistent` -> `== 0/0 passed ==`, exit 0. One
  renamed section and the gate becomes a no-op that reports success.
  (3) FOURTH INSTANCE OF ONE DISEASE: round 33 "a check that reads nothing must not
  report success"; round 46 an unmocked request rendering as an empty page; round 47
  an audit skip that exited 0; round 56 a gate that passes empty. Unlike the other
  three, this one ran on every push.
  (4) THREE FIXES, because one was not enough: `SECTIONS` is DECLARED and `--only` is
  validated against it (unknown name -> exit 2, printing both the bad names and the
  valid ones); ZERO CHECKS IS NOT A PASS (exit 2, convention now shared with
  panel-render-audit.mjs: 0 ran+passed, 1 ran+failed, 2 DID NOT RUN); and `SECTIONS`
  vs the `want()` call sites must be the SAME SET in BOTH directions, asserted
  statically — a declared name with no dispatch is a ghost, and a `want('x')` not
  declared can never be selected, so that section is dead and nothing said so.
  (5) THE FIRST MUTATION DID NOT BITE AND THAT MATTERED: deleting the zero-check
  guard left the test GREEN because guard 1 already rejected the bogus name, so guard
  2 was untested and I had nearly recorded it as proven. Exercising it directly (a
  valid name with no dispatch) shows it catching the run; removing it then reproduces
  the original defect exactly, `== 0/0 passed ==` exit 0.
  (6) `scripts/test/e2e-only-check.mjs` (5 checks, in CI) also asserts a VALID
  `--only` still RUNS, so the guards cannot be satisfied by making everything exit 2:
  against a closed port `--only governance,runs` exits 1 having executed a check
  (`0/1 passed`, never `0/0`). The ghost drift is mutation-proven.
  (7) STILL OPEN: the panel's governance-pill visual prominence (a taste call), and
  the `--dsw-alias-*` namespace rename on the landing page.
  Gates: e2e-only 5 (new); panel-audit-skip 3; contrast-probe 11; model-drift 6;
  release-audit 9; token contract green; agent fmt clean; CI green on main.

Previous round: 2026-09-11 round 55 (the third instance of "a skip read as a pass",
and this one was MINE — with the defect WRITTEN DOWN in its own output and left
there). Commit: 22ad3289. CI green.
  (1) `panel-render-audit.mjs` needs a Playwright runtime. Where there is none it
  emits its harness — deliberate, "a check that can only run in one environment
  quietly stops running" — but it exited 0, and its message ADMITTED the
  consequence: "It also exits 0 here, so a caller watching only the exit code reads
  this skip as a pass." WRITING A DEFECT DOWN IS NOT FIXING IT: that sentence read as
  a caveat, and survived every round that read past it — including round 46, where
  the same disease was fixed one file over.
  (2) THIS IS THE THIRD INSTANCE, which is why the convention is now explicit rather
  than local: round 33 "a check that reads nothing must not report success"; round 46
  a harness that could not tell an unmocked request from an empty page; round 55 this.
    0  the audit RAN and found nothing
    1  the audit RAN and found failures
    2  the audit DID NOT RUN
  The exit code is the only channel a caller is guaranteed to read, so 2 is not 0,
  and the skip says "EXIT 2: THE AUDIT DID NOT RUN — this is a SKIP, not a pass".
  (3) `scripts/test/panel-audit-skip-check.mjs` (3 checks, in CI beside the
  contrast-probe checks) asserts the CODE, not the prose: it spawns the audit with
  `VALE_BROWSER_HELPER` unset, requires exit 2, requires the words, and requires the
  convention to be documented where the codes are set so the next person adding an
  exit path has something to follow. Mutation-proven: reverting to `exit(0)` fails
  all three, naming the consequence. The real script reports exit=2.
  (4) NOT DONE, deliberately: this does not make the audit RUN in CI — CI has no
  Playwright runtime, so it would exit 2 there every time. The point is that a caller
  can now TELL, which is the difference between a skipped check and a passing one.
  (5) STILL OPEN: the panel's governance-pill visual prominence (a taste call, not a
  defect — the controls DO communicate state, checked in round 54), and the
  `--dsw-alias-*` namespace rename on the landing page.
  Gates: panel-audit-skip 3 (new); contrast-probe 11; model-drift 6; release-audit 9;
  token contract green; CI green on main.

Previous round: 2026-09-11 round 54 (MY OWN MOCKS invented two bugs in one session —
so the console's tests now check their model of the server against the server).
Commit: f610a0a7. CI green.
  (1) THE MISTAKES. Hand-writing browser mocks I guessed `/api/users` for the user
  list; the real path is `/api/admin/users` and `/api/users` is a 404. The page
  rendered an EMPTY card and I spent time reading it as a product defect when only
  my mock was wrong. Earlier the same habit produced a doubled `https://https://`
  base URL (round 52). Both times the mock — the test's model of the server — was
  the broken thing, and nothing checked the model.
  (2) WHY THE SUITE WAS BLIND: every UI test MOCKS `fetch`, so a path no worker route
  answers produces a 404 the tests feed into an empty view. The page renders blank,
  the suite stays GREEN, and the defect exists only in production.
  (3) THE CHECK: `gateway/ui/test/client-paths.test.mjs` reads the client's paths
  from `api/client.ts`'s `request(...)` calls and the worker's from its route
  declarations, resolving `${BASE}` from their own constants. A hardcoded list on
  either side would be a third copy of the thing being checked.
  (4) IT HAD TO LEARN FIVE DECLARATION STYLES, one per failure: `add("GET",
  \`${BASE}/x\`)`, `route(ctx, "POST", "/api/x")`, inline `m === "GET" && p === ...`,
  bare-constant `add("GET", ME_BASE, ...)`, and index.ts's method-less
  `path === "/api/health"`. Missing one would silently shrink the route set and turn
  this into a comparison against a list that is too small — the very failure it
  exists to catch, one level up. Regex matchers reduce to a prefix; query strings are
  stripped. It asserts it found >= 15 routes AND >= 15 client paths, because a
  comparison over zero routes passes for ever.
  (5) MUTATION-PROVEN WITH MY OWN MISTAKE: `getUsers` back to `/api/users` fails with
  "1 path(s) no worker route answers … these would 404 in production with a green
  suite".
  (6) AND THE HARNESS NOW SAYS WHEN IT IS THE PROBLEM: `devices-render-smoke.mjs`
  used to answer 404 for unmocked paths and say nothing more, so "the app rendered
  nothing" and "I did not mock that" were indistinguishable. It records every
  unmocked request and FAILS, naming them. Mutation-proven by deleting one route.
  (7) ALSO CHECKED AND FOUND GOOD, so not changed: the panel's governance controls
  communicate STATE properly — `#approval-arm` changes label ("Ask before each
  command" <-> "Asking first"), dot (`data-state`) AND background, with
  `aria-pressed`; `SessionControl` has the same shape. My earlier note about their
  "low emphasis" was about visual weight, which is taste, not a defect. The console's
  Keys view renders correctly; Users was the mock's fault, now impossible to misread.
  (8) STILL OPEN: the panel's governance-pill visual prominence (a taste call), the
  `--dsw-alias-*` namespace rename on the landing page.
  Gates: gateway-ui 7 (was 5) + both render smokes; gateway 772 + format; token
  contract green; CI green on main.

Previous round: 2026-09-11 round 53 (the console had TWO pages answering "which
model?" — and the overlap was MINE, created when I added the Models page two rounds
earlier; this round gives each page one job and makes the nav say so).
Commit: a58f301d. Worker deployed twice (the page, then its copy).
  (1) THE DEFECT WAS SELF-INFLICTED, and naming that matters: round 49's Models page
  made the Routes page half redundant. Both let you choose a channel, and ROUTES DID
  IT WORSE — it listed one row per channel using each channel's HEALTH-PROBE model,
  so a channel offering eight models appeared to offer one. Two pages answering the
  same question is not a design; it is the residue of adding one without looking at
  what was already there.
  (2) THE ROLES ARE NOW DISTINCT AND THE NAV SAYS SO:
    Models (模型目录) — the catalogue: every channel, every model, health, switch.
    Routes (接入设置) — what is selected and how to connect. RETITLED, because
                       "模型路由" stopped describing it.
  Concretely: the per-channel switchboard became ONE line (the current route) plus a
  link to Models ("在模型目录中选择 →"). The US-egress toggle and the copy-paste
  client config stay — they exist nowhere else.
  (3) THE COPY HAD TO MOVE WITH THE CONTROL, which is this log's most common defect:
  the card still said "在这里点一下即可切换" / "flip channels here — no restart needed"
  after the switcher left. A description that outlives its control is exactly the
  family recorded in rounds 26, 35 and 47; both languages now say where switching
  happens.
  (4) THE BUILD'S TYPE-CHECK FOUND WHAT NOTHING ELSE WOULD HAVE: `laneClass`,
  `handleSwitch`, the `switching` state and the `grouped` grouping all became dead,
  and `loadChannels` was STILL FETCHING `/api/health` for a card that no longer
  rendered it — a request kept alive by nothing but the line that set its state. The
  call is gone with its reader.
  (5) VERIFIED against the real response shape: Routes renders three cards
  (美国出口 / 当前渠道 / 客户端接入示例), the current route reads "og/mimo-v2.5" with a
  working link, Models still renders its catalogue. Deployed and CI green.
  (6) STILL OPEN: the panel's governance-pill prominence (the product's core story
    rendered at the lowest emphasis on the page), the `--dsw-alias-*` namespace
    rename on the landing page, and whether the console's remaining four views want
    anything beyond what they have — the Overview was checked in round 52 and is
    already a real dashboard.
  Gates: gateway 770 + format; gateway-ui 5; token contract green; CI green on main.

Previous round: 2026-09-11 round 52 (I went looking for the console's remaining weak
pages and found the Overview already good — but the CLIENT CONFIG it hands a user
doubled its scheme for one of the two ways an operator writes `API_HOST`).
Commit: 4c0597d8. Worker deployed; all three spellings verified live.
  (1) WHAT I LOOKED AT FIRST, and did NOT change: the console's Overview is a real
  dashboard (four stat cards with lane accents, a gateway-token card with
  copy/show/regenerate, device and channel summaries, a keys list) and the panel's
  governance row + status bar are present and readable since round 47. INVENTING
  churn on a page that is already designed is not iteration; recording that it was
  checked is.
  (2) THE DEFECT: `Routes.tsx` built the copy-paste client config as
  `apiHost ? `https://${apiHost}` : ...` — the scheme prefixed UNCONDITIONALLY.
  `API_HOST` is operator-set and `https://api.saisi.online` is as natural to write as
  `api.saisi.online`, so the second spelling produced
  `"ANTHROPIC_BASE_URL": "https://https://api.saisi.online"` in every copied config,
  on the ONE screen whose purpose is to be pasted into a client, and nothing
  validated it.
  (3) FOUND IN A MOCK, AND THE DISTINCTION MATTERS: my harness set `apiHost` WITH the
  scheme, the live value is BARE, so PRODUCTION WAS CORRECT and only the assumption
  was wrong. A mock more permissive than production invents bugs; one less
  permissive hides them. This one surfaced a real FRAGILITY (an operator-set value
  with two spellings, one of which silently breaks the output) rather than a real
  outage — worth closing either way, because the failure mode is a broken config
  handed to a user.
  (4) EXTRACTED TO `src/lib/baseUrl.ts` so the rule can be PINNED — `clientBase()`
  adds the scheme only when missing, and trims. Four tests in `test/baseurl.test.mjs`
  (the console's second unit test, beside `maskToken`); one sweeps five inputs
  asserting no output ever contains a doubled scheme, a missing scheme or stray
  whitespace. Mutation-proven: removing the scheme test fails with "doubled scheme".
  (5) VERIFIED ON THE LIVE PAGE, all three spellings through the real app:
  bare -> https://api.saisi.online, WITH-scheme -> https://api.saisi.online (the one
  that broke), unset -> https://api.saisi.online. No doubling anywhere.
  (6) STILL OPEN: the console's subjective information architecture beyond this —
  Routes and the new Models page OVERLAP (Routes switches the active route and shows
  the client config; Models lists every model of every channel and also switches),
  and that overlap is MINE, created in round 49. Naming the two roles clearly, or
  merging them, is the next real IA decision. Also open: the panel's governance-pill
  prominence, and the `--dsw-alias-*` namespace rename on the landing page.
  Gates: gateway 770 (was 766) + format; gateway-ui 5 (was 1); token contract green;
  CI green on main.

Previous round: 2026-09-11 round 51 (the THIRD frontend — the one the user's question
about ai.saisi.online surfaced — was the last holdout of a blue brand the rest of the
product had already abandoned). Commit: 0755d51b. vale-dist deployed; live verified.
  (1) THREE FRONTENDS, ONE OF THEM NEVER OPENED. `agent.saisi.online` and
  `command.saisi.online` serve a self-contained page from `index/src/page.js` — 330
  lines building one HTML string, no framework, and its OWN token namespace
  (`--dsw-alias-*`). It is the only surface no round had looked at, and it was found
  by answering "what is ai.saisi.online?" with the Cloudflare API rather than a guess
  (round 49).
  (2) WHAT THE SCREENSHOT SHOWED: a 440px content column in a 1440px window — the
  same ribbon-in-a-void the console login had before round 44; `--dsw-alias-brand-
  primary: #4d6bfe`, a BLUE brand, with a near-BLACK primary button (#0f1115) while
  the console and panel are ORANGE (#d9480f); and installer URLs breaking across
  lines in the MIDDLE of the path. THAT BLUE IS THE SAME FAMILY AS THE PANEL'S DEAD
  FALLBACKS (#4f7cff / #4f6bed) removed in round 43 — this page is where the old
  brand survived, and the panel had merely stopped drawing it.
  (3) NOW: the product's token SCALE, a split composition (brand + description left,
  the things you DO right — the same shape the console login uses), numbered steps,
  and `word-break` control so a URL is one token. The NAMES stay (`--dsw-alias-*`) so
  the file was not rewritten in the same change; every VALUE is the panel's scale, so
  all three surfaces finally RESOLVE to the same colours. Renaming is a recorded
  follow-on.
  (4) MAKING THE BUTTON ORANGE IS THE OBVIOUS MOVE AND IT IS WRONG ALONE: white on
  `--accent` (#d9480f) measures **4.30**, under AA — the exact defect the panel's
  `.btn-new`/`.goal-save` had, and why `--accent-solid` exists. The primary uses it
  and measures **6.08**, verified in the browser rather than computed by hand. This
  is the third surface to need the same lesson, which is why it is written down
  three times now.
  (5) VERIFIED: deployed and confirmed in the live HTML; measured in a real browser
  (aside 492px at x=200, card 492px at x=748, main 1120px, no horizontal scroll,
  3 steps, button 6.08); swept with the TESTED probe in BOTH themes — **0 under AA
  across 18 rows each** — and dark SCREENSHOTTED to confirm it renders rather than
  merely passing a number. Index 73 tests, CI green.
  (6) ALL THREE SURFACES ARE NOW ON ONE SCALE, IN BOTH THEMES, EACH MEASURED. Still
  open: the console's subjective information architecture (whether five views is the
  right five), the panel's governance-pill prominence, and the `--dsw-alias-*`
  namespace rename.
  Gates: index 73 + deploy; CI green on main.

Previous round: 2026-09-11 round 50 (the user reported seeing NO CHANGE, twice; the
deploy WAS live, and the reason a working deploy would not show up was a cache rule
that covered the path nobody visits). Commits: eb9ee2b2, 8736988d. Worker deployed.
  (1) FIRST, WHETHER THE WORK WAS ACTUALLY LIVE — because "the user is wrong" is not
  a diagnosis. Verified three ways: the live bundle CONTAINS the new page
  (`模型目录`, `models-card`, `model-chip`); the live CSS contains the login redesign
  (`auth-aside`, `auth-pitch`); and a COLD browser session (cookies cleared,
  localStorage cleared, reloaded) renders the redesigned split login with the
  duplicated wordmark gone. The work was deployed.
  (2) SO WHY WOULD IT NOT SHOW UP? `gateway/public/_headers`, whose own comment
  describes this EXACT report: "a cached shell keeps referencing the previous hashed
  bundle and a deploy 'doesn't show up' until a hard refresh (the exact report that
  prompted this file)". Measured on the live worker:
      /index.html  ->  cache-control: no-cache, must-revalidate      (rule matched)
      /            ->  cache-control: public, max-age=0, must-revalidate
                       cf-cache-status: HIT                          (rule MISSED)
  `_headers` matches on the REQUEST PATH. NOBODY VISITS /index.html; they visit `/`.
  The rule fired for a URL nobody uses and left the root document — the shell that
  names the hashed bundle — cacheable. A fix that does not cover the case it exists
  for: round 40's family, in a file that had already written the symptom down.
  Both spellings are now listed. Verified after deploy: `/` returns `no-cache,
  must-revalidate`.
  (3) WHAT I AM NOT CLAIMING. `max-age=0, must-revalidate` ALSO asks for
  revalidation, so a browser obeying it should have refetched; I cannot prove this
  fully explains the symptom. It is the one inconsistency I could MEASURE, it is now
  correct, and `/` and `/index.html` finally agree. The honest next step for the user
  is one hard refresh.
  (4) THE SAME ROUND ALSO SHIPPED THE FIRST GENUINELY NEW PAGE, after the user's
  first report made the real problem clear: everything else I had done to the console
  was INVISIBLE BY CONSTRUCTION (token values, contrast, dead code). `#/models`
  renders `ROUTE_INFO`, which the Routes page has always fetched and used one field
  of (`apiHost`). See round 49's entry for that work's details.
  (5) A USER-VISIBLE LESSON WORTH KEEPING: "I see no change" is a REPORT, not an
  error, and the first job is to establish whether the change is live before
  explaining anything. Here it was live, and the explanation was a cache rule; in
  round 46 the same report would have been a stale local build. Both were found by
  MEASURING the deployed artifact rather than re-reading the source.
  Gates: gateway 766 + format; gateway-ui 1; token contract green; CI green on main.

Previous round: 2026-09-11 round 49 (the user said they saw NO CHANGE on the console —
and they were right, because almost everything I had done there was invisible; this
round ships the first page that is NEW). Commit: eb9ee2b2. Worker deployed. d1 on
1.2.354 and current.
  (1) ANSWERING "WHAT IS ai.saisi.online?" WITH CLOUDFLARE, NOT WITH A GUESS. Custom
  domains are bound in the DASHBOARD, not in the repo (`index/wrangler.jsonc` says
  so outright), so the repo cannot answer it. The API can:
    vale-gate -> api.saisi.online AND ai.saisi.online
    vale-dist -> agent.saisi.online AND command.saisi.online
  So `ai.saisi.online` is a SECOND DOMAIN ON THE SAME WORKER — same assets, same
  deploy, and it is behind Cloudflare Access (302 to vale-saisi.cloudflareaccess.com,
  which swallows even /assets/*). Nothing about it needs separate work.
  (2) BUT THERE IS A THIRD FRONTEND NOBODY HAD OPENED: `agent.saisi.online` and
  `command.saisi.online` serve a self-contained "Vale Agent" page from
  `index/src/page.js` — 330 lines building one HTML string, NO framework and no
  external CSS/JS, carrying its OWN token namespace (`--dsw-alias-*`, 66 uses,
  "DSH-aligned"). So the product has THREE design token systems, not two. Untouched
  and still open.
  (3) THE ROUND'S DELIVERABLE, AND WHY IT TOOK THIS TO SEE IT: almost everything I
  had done on the console was invisible by construction — aligned token VALUES,
  contrast, dead-code removal. The login split was visible but only on the login
  screen. A "redesign" that cannot be seen is not what was asked for.
  (4) THE NEW PAGE IS MOSTLY DELETION OF AN OVERSIGHT: `/api/admin/public` returns
  `ROUTE_INFO` — every channel with `prefix`, `backend`, `desc` and a `models` list
  the server DERIVES from `MODEL_REGISTRY`, so it cannot drift from `/v1/models`.
  The Routes page has ALWAYS fetched it and used exactly ONE field, `apiHost`. The
  console showed a route SWITCHER and never the catalogue: you could pick a model
  only if you already knew its name. `#/models` renders it — no model id typed in
  the view, because a hand-maintained second copy is what `channels.ts` records as
  the FIFTH drifted copy of the catalogue.
  (5) DESIGN DECISIONS WORTH KEEPING: the channel's lane hue rides a LEFT BORDER,
  not the text, so the colour stays vivid while the label keeps a readable ink; the
  health badge has THREE states (up / down / NOT PROBED), because an unprobed
  channel is not a down one and must not borrow either colour; and a catalogue that
  could not be read SAYS SO, because an empty list claims the gateway advertises
  nothing, which is a different fact.
  (6) THE BUILD'S TYPE-CHECK CAUGHT TWO REAL ERRORS before the page was ever seen —
  no `models` rail icon existed, and `PageHeader` takes props not children. The same
  type-check that sat red for months in the Electron shell because nothing built it.
  (7) VERIFIED: rendered against the real response shape (5 channels / 20 chips /
  1 current / three-state health), screenshotted, and swept with the TESTED probe in
  BOTH themes — 0 under AA across 36 rows. Deployed and the live bundle confirmed
  against the local build. The gateway suite showed ONE 765/1 run; it was chased, not
  assumed, and three consecutive re-runs are 766/0.
  (8) STILL OPEN: the subjective half of the redesign — layout, density, navigation,
  whether the FIVE views are the right five; and the third frontend in (2).
  Gates: gateway 766 + format; gateway-ui 1 + render smoke; token contract green;
  contrast-probe 11; CI green on main.

Previous round: 2026-09-11 round 48 (four rounds of contrast sweeps retyped an ad-hoc
snippet, and it was wrong twice — so the math is now ONE tested copy, and the
correct implementation turned out to have been sitting inside another script the
whole time). Commit: 9576e72d. NO RELEASE: tooling only, nothing a device runs.
  (1) THE TWO DEFECTS, now with numbers. The snippet read
  `rgba(255,255,255,0.07)` as if it were WHITE: the chip composites to
  rgb(44,45,49) where the text measures **5.49**, but against white it "measures"
  **2.51** — TWENTY of the fifty dark-mode findings were that. And a skip rule that
  looked reasonable (ignore anything with a background-image ancestor) silently
  skipped EVERY node in the panel and reported `checked=0, underAA=0`, which reads
  exactly like a pass. THAT IS ROUND 33'S LESSON COMMITTED AGAIN BY THE TOOL BUILT
  TO APPLY IT.
  (2) THE CORRECT IMPLEMENTATION ALREADY EXISTED as a string inside
  `agent/scripts/panel-render-audit.mjs` — background alpha, the ancestor OPACITY
  chain, and the foreground's own alpha, all composited. Nothing could test it, so
  every sweep re-derived it. `agent/scripts/lib/contrast-probe.mjs` is that
  implementation in one place, with the math as REAL FUNCTIONS, and
  `panel-render-audit.mjs` now imports it rather than carrying a copy.
  (3) THE TESTED CODE IS THE CODE THAT RUNS: `PROBE_SOURCE` embeds the functions
  with `Function.prototype.toString()`, and `scripts/test/contrast-probe-check.mjs`
  (11 checks, in CI) exercises the exact text the browser evaluates. A test on one
  copy can only ever compare copies — round 37's lesson, applied structurally.
  (4) THE PROBE NOW SAYS WHAT IT CANNOT MEASURE instead of guessing. A GRADIENT
  background is reported `gradient: true, cr: null` and excluded — it previously
  walked PAST the gradient and reported the panel's gradient-filled "V" as
  white-on-white 1.0. An INACTIVE control is flagged: WCAG 1.4.3 exempts it, and the
  disabled Start button measures a truthful 2.1:1 through its opacity chain — a real
  reading of a control nobody can use, not a defect. FLAGGED, NOT FILTERED, so the
  number stays visible.
  (5) I WROTE THE BACKTICK GUARD THREE TIMES AND EVERY VERSION HAD A WRONG PREMISE:
  the file holds 42 backticks, not 2; `lastIndexOf` reaches into the JSDoc below the
  template; the first backtick-semicolon matches the stray's own close. Then I saw
  the guard ALREADY EXISTS — the test file IMPORTS the module, so a stray backtick
  makes the import throw and the whole file fails loudly (watched it twice). A
  hand-rolled parser for a case the import already catches is a check that can only
  be wrong, so it is gone with the reasoning left in its place.
  (6) THE BETTER TOOL IMMEDIATELY FOUND MORE: with the shared probe on the panel,
  light mode shows 15 under AA across 675 rows that the inferior sweep had missed —
  `mem-tag` 4.3 (`--tag-ink` #0b7a6e) and `plug-tools`/`plug-tag` 4.4 (`--muted` on
  surfaces darker than white, the same CONDITIONAL-PASS shape the console had in
  round 46). Dark mode is 1, and that one is the exempt disabled button. Recorded,
  NOT rushed: they want the same token-level decision the console got, not a
  selector patch under time pressure.
  (7) STILL OPEN AND UNCHANGED: the subjective half of the redesign — layout,
  density, navigation, whether the console's five views are the right five. Now
  asked across five rounds; the objective half of both surfaces is measured, clean,
  and backed by a tested tool.
  Gates: contrast-probe 11 (new, in CI) + model-drift 6 + release-audit 9; panel
  509; agent fmt clean; gateway 766; CI green.

Previous round: 2026-09-11 round 47 (every contrast measurement in this repo had been
taken in LIGHT mode; the DARK theme is a second surface with its own 39 values, and
it held 50 text elements under AA — while MY OWN SWEEP was hiding them, two ways).
Commits: c0651a12, f0fa4544. Released 1.2.352 and 1.2.353; d1 is on 1.2.353 and
current; audit CLEAN (`CDN == GitHub asset byte-for-byte`).
  (1) THE SWEEP WAS THE STORY. It hid the defects TWO ways, and I only caught both
  by PRINTING THE COUNTS:
  * it skipped any element with a background-image ANYWHERE among its ancestors, so
    the panel's one gradient wrapper skipped EVERY text node and it reported
    `checked=0, underAA=0` — which reads exactly like a pass. It now walks to the
    NEAREST painted background and decides there. THIS IS ROUND 33'S LESSON ("a
    check that reads nothing must not report success") committed again by me, in the
    tool built to apply it.
  * it read `rgba(255,255,255,0.07)` as WHITE: twenty of the 50 were near-invisible
    chips measured against the wrong surface. It now alpha-composites the whole
    background stack.
  (2) THE TWO CAUSES WERE ALREADY WRITTEN DOWN IN THE REPO.
  * `tokens.css` says of `--accent-ink`: "the accent for CHROME — icons, dots,
    borders … it was also being used as TEXT on two different chrome surfaces and
    failed on both". SIXTEEN call sites were still doing exactly that.
  * `themeContrast.test.ts` already pins the `--faint`-inherited `<strong>` defect
    for `.browser-crash-banner` — and `.browser-placeholder`'s `<strong>` had no
    colour of its own either and inherited `--faint`, unnoticed, because the fix
    went to ONE banner.
  Measured: `--faint` #6f707a on #1c1d22 = 3.42 (and #a1a1aa in LIGHT is 2.56 —
  below even the 3.0 bar for a mark); `--accent-ink` #d9480f = 3.23-4.27 wherever it
  is text; `--danger` #dc2626 = 3.32 on its own dark soft chip.
  Fixed 16 `--accent-ink`, 40 `--faint` and 18 `--danger` `color:` declarations to
  their text counterparts (`--accent-on-soft` 6.21/9.19, `--muted` 4.63-4.83/6.97,
  `--danger-on-soft` 6.91). All three tokens keep `background` and `border-color`:
  the rule is written against `color:` with a word-boundary guard.
  (3) THE INJECTION PROVED MY FIRST PASS INCOMPLETE, WHICH IS WHY THE FIX WENT TO
  THE TOKEN. Injecting the three declarations I had written took Archive 1 -> 0, but
  pages whose state I had not rendered (Plugins, Settings) then surfaced FURTHER
  `--faint` text rules (`plug-meta`, `plug-btn`, `connect-where`, `connect-muted`).
  Fixing selectors I had measured would have left those; fixing the TOKEN did not.
  (4) AND THE RULE THEN FOUND 18 MORE, again: adding `--danger` to the pinned list
  immediately failed on seventeen further declarations, mostly `:hover` states a
  sweep cannot render. Fixing the measured instance, then writing the rule, then
  letting the rule find the rest — third round running, and still the highest-yield
  move here.
  (5) FINAL STATE, VERIFIED ON THE DEVICE RUNNING 1.2.353, alpha-composited, all
  eight rail pages, dark theme: **0 under AA across 1508 text nodes** (was 50).
  Injection checks along the way: `.plug-btn.danger` 3.32 -> 6.91.
  (6) BOTH SURFACES ARE NOW CLEAN IN BOTH THEMES: console light 0/223 and dark
  0/264 (round 46), panel light (rounds 35-36) and dark 0/1508. THE SUBJECTIVE HALF
  OF THE REDESIGN IS STILL OPEN AND STILL WANTS THE USER'S DIRECTION — layout,
  density, navigation, whether the console's five views are the right five.
  Gates: panel 509 + build; agent 583 + fmt clean; gateway 766; token contract
  green; CI green on main; audit CLEAN.

Previous round: 2026-09-11 round 46 (I opened the console's FIVE VIEWS BEHIND THE
LOGIN for the first time — by mocking the admin APIs in a real browser — and the
whole accessibility class turned out to have one cause the theme was missing).
Commit: 4f80ba15. Worker deployed; live bundle verified. NO DEVICE RELEASE: the
console is served by the worker, not embedded in the exe.
  (1) HOW TO SEE A LOGGED-IN VIEW WITHOUT CREDENTIALS, which is reusable: navigate
  the device's browser to the LIVE console with `page.addInitScript` stubbing
  `window.fetch` BEFORE boot (returning mocked `/api/me`, `/api/devices`,
  `/api/plugins/status`, `/api/keys`, `/api/routes`, `/api/users`), set
  `localStorage.valegate-lang`, then load `#/<view>`. `gateway/ui/devices-render-smoke.mjs`
  already holds a working mock set. The live bundle is the same code as the repo's,
  so nothing needs transferring.
  (2) AN ORPHAN SEPARATOR, found in the DOM not by eye. `d2`'s meta line rendered
  as "· z9y8x7…t3s2". The JSX gave EACH optional part its own leading " · " while
  the TOKEN's was UNCONDITIONAL, so a device with neither lastSeenAt nor
  registeredAt got a separator with no left side. Now a `.filter(Boolean).join(" · ")`.
  Pinned in `devices-render-smoke.mjs`; mutation-proven (restoring the unconditional
  prefix fails "no meta line starts with an orphan separator"). MY FIRST MUTATION
  DID NOT BITE and I checked WHY before trusting the pin — the replacement I wrote
  had not reproduced the defect.
  (3) THE ROUND'S REAL FINDING: A SEMANTIC COLOUR HAS TWO WEIGHTS, and the console
  had one value per state used for both. As a MARK (dot, border, filled badge) 3:1
  suffices; as TEXT it is 4.5:1. Measured on the devices view: 在线/隧道正常 3.13,
  可更新到 3.30, 离线/隧道断开 4.11, 删除 4.32 — the STATUS WORDS, the most important
  information on the page. THE PANEL ALREADY SOLVED THIS: `--success-text` exists
  there beside `--success` for exactly this reason, plus `--danger-on-soft` and the
  whole `--chrome-active-*` family. The console now has `--success-text` /
  `--warning-text` / `--error-text` in BOTH theme blocks.
  (4) AND THE NEUTRAL LADDER IS THE SAME STORY, measured per surface:
    #71717a (--text-muted)  white 4.83 | --bg 4.63 | --bg-secondary 4.40 | --bg-tertiary 4.10
    #a1a1aa (--text-faint)  white 2.56 | --bg 2.46 | --bg-secondary 2.34 | --bg-tertiary 2.18
  `--text-muted` passed or failed depending on WHICH SURFACE a rule landed on —
  invisible to any stylesheet check. 25 `color:` rules used it, 5 used `--text-faint`.
  THE TRADE-OFF IS STATED IN THE CSS because it is real: this loses one step of
  hierarchy on white cards, taken deliberately, because a rule that can be ENFORCED
  beats a nuance that cannot.
  (5) THE CHECK GENERALIZED FROM MY SIX FIXES TO THE CLASS — 15 more rules, several
  on views I had not yet opened. That is the pattern worth keeping: fix the measured
  instance, then make the rule, then let the rule find the rest.
  (6) THE STALE-BUNDLE TRAP, recorded because of the wrong conclusion it invites: my
  first sweep after the fixes reported them MISSING, because I had run `npm run
  build` and never `wrangler deploy`. "The fix did not work" was one command away
  from being written down as fact.
  (7) FINAL STATE, verified on the deployed worker: all five views swept,
  **0 under AA across 223 text nodes**. (Two reported failures were FALSE POSITIVES
  of the sweep — `.rail-avatar` and `.empty-mark` are white on `background-image`
  GRADIENTS, which a `backgroundColor` walk cannot see; the sweep now skips anything
  under a background-image and says so.)
  (8) STILL OPEN: the redesign's subjective half — the console's information
  architecture beyond colour (whether five views is right, the layout of each), and
  the panel's governance-pill prominence. Both want a human's direction; the
  objective half of both surfaces is now measured and clean.
  Gates: token contract green (17 light / 12 dark shared tokens agree; no dead
  fallbacks; no mark weight paints text); gateway 766 + format; gateway-ui 1 +
  render smoke + devices dashboard render; agent 583 + fmt clean. CI green on main.

Previous round: 2026-09-11 round 45 (I swept the live panel for EVERY text node under
the AA contrast bar instead of spot-checking; four defects fell out, and every one
was a measured fix that already existed on its SIBLING). Commits: 2ad79c06,
8f3def97. Released 1.2.350 and 1.2.351; d1 is on 1.2.351 and current; the
dual-builder audit is CLEAN for the second consecutive release.
  (1) THE STEADY STATUS READOUT WAS UNREADABLE. `.desktop-status.idle` — session
  count, release, uptime, CPU, memory, and the ONLY place the release appears
  anywhere in the panel — painted `--chrome-ink-faint` on `--chrome-bg-2`:
  **2.56:1** in light, 3.45 in dark, at 11.5px. Below the 4.5 TEXT bar AND the 3.0
  MARK bar, in both themes, in the panel's DEFAULT state.
  (2) I HAD ALREADY PUBLISHED THE OPPOSITE CLAIM, ONE ROUND EARLIER. Round 44's log
  says the status bar measures 7.03 and is fine. My probe had matched the wrong
  element. A single measurement is a CLAIM and has to be checked before it is
  written down — this is the same correction I made to the model-drift checker and
  to the token parser, now applied to my own previous sentence.
  (3) THE TOKEN, NOT THE ONE RULE, WAS THE DEFECT: `--chrome-ink-faint` fails the
  text bar and the mark bar in light mode wherever it is used, so five `color:`
  declarations stopped using it (closed tabs, tab glyphs, two close buttons). It
  stays valid for `background` (dots) and `border-color` (hairlines) — the rule is
  written against `color:` with a word-boundary guard, because `border-color:`
  contains that substring.
  (4) THEN THE SWEEP FOUND THREE MORE, AND THEY ARE THE ROUND'S REAL STORY. All on
  the default desktop screen, all the SAME SHAPE — a fix that already existed,
  applied to one of a pair:
  * `.dtab.active` 3.83 — `tokens.css` DOCUMENTS that exact 3.83 as a defect FIXED
    by `--chrome-active-text`; `.tab.active` uses it, and `.dtab.active`, the rule
    the DESKTOP shell actually renders, kept `--accent-ink`.
  * `.desktop-view-switch .view-switch-btn.active` 4.30 — got the same fix, but
    this selector is MORE SPECIFIC (three classes against two) and SILENTLY WON
    with the old token. A fix that is overridden looks exactly like a fix that
    works.
  * `.btn-new` 4.30 — `components.css` says outright "White on --accent-solid, not
    on --accent: the brand orange gives white text 4.30, under AA at this size, and
    this is the primary action", and fixed `.goal-save`; `.btn-new`, the OTHER
    primary action in the SAME header, kept the brand orange. Its hover also went
    to a LIGHTER token than its base.
  (5) VERIFIED BY INJECTION ON THE LIVE PAGE, sweeping every visible text node:
  BEFORE `[3.83, 4.30, 4.30]` -> AFTER `[]`, `ALL_PASS=true`. Then shipped, and
  re-measured on the device running 1.2.351: `underAA` is empty but for one FALSE
  POSITIVE OF MY OWN SWEEP — `.empty-mark` is white on a `background-image`
  GRADIENT, and `bgOf()` walks `backgroundColor` only, so it read the parent's
  white and reported 1.0. A sweep is a tool with blind spots; state them.
  (6) FOUR TESTS ADDED, each mutation-proven with the measured numbers in the
  failure message: no `color:` may use `--chrome-ink-faint`; the steady readout
  must use the readable ink; the three twins must use the fixed tokens (restoring
  `--accent-ink` on `.dtab.active` fails naming it). Panel 508, was 506.
  (7) STILL OPEN, now measured rather than guessed: the console's five views beyond
  login (Overview, Users, Devices, Keys, Routes) — none of which I have looked at;
  and `agent/scripts/panel-render-audit.mjs` EXITS 0 when `VALE_BROWSER_HELPER` is
  unset ("running in EMIT mode"), which is deliberate and documented but means a
  caller watching only the exit code reads a skip as a pass. Nothing calls it
  automatically today, so it is a note rather than a defect.
  Gates: panel 508 + build; agent 583 default, fmt clean; gateway 766; token
  contract green; CI green on main; audit CLEAN on 1.2.350 and 1.2.351.

Previous round: 2026-09-11 round 44 (the first redesign slice that changes what a
person SEES — I stopped auditing stylesheets and drove a real browser at both live
surfaces, then worked from the pictures). Commit: 1af31917. d1 UPDATED TO 1.2.349.
  (1) HOW I LOOKED, because it is reusable: the device's own playwright drives a
  page (`browser_run_script` + `acquireBrowser()`), screenshots to
  `C:\ProgramData\Vale\pwout`, `system_file_upload` hands back a one-time URL, and
  `curl` on this box fetches it. No listener on either side. THE TWO LIVE SURFACES
  ARE `https://api.saisi.online/` (the console) AND `http://127.0.0.1:18080/desktop/`
  (the panel, reachable FROM d1) — and `networkidle` NEVER fires on the panel
  because it holds an SSE stream open by design; use `domcontentloaded`.
  (2) WHAT THE CONSOLE'S LOGIN SCREENSHOT SHOWED, all visible at 1440x900: a 396px
  card floating in ~1440px of nothing; the ONLY explanatory sentence on the page
  sitting OUTSIDE the card, under it, in the smallest type on screen, belonging to
  nothing; and THE WORDMARK RENDERED TWICE — `<h1>Vale</h1>` followed by `app.sub`,
  whose value began with "Vale" ("Vale / Vale 平台 · AI 网关与设备"). `app.sub` is
  used in exactly ONE place, directly under that `<h1>`, so the duplication was
  structural rather than a typo.
  NOW: a split page. Brand owns the left half (wordmark, one-line description, and
  that sentence, centred as one group); the form owns the right; the language
  toggle moved to the brand half where a PAGE-level control belongs.
  (3) MY FIRST ATTEMPT MADE IT WORSE AND THE SCREENSHOT SAID SO, which is the whole
  reason for looking. Moving the brand out SHORTENED the card, and the language
  button — absolutely positioned at its top-right — landed ON the card's top
  border. The accent wash I added was clipped to a corner smudge by
  `overflow: hidden`, and after repositioning it was STILL invisible because
  `--accent-soft` (#ffefe5) on `--bg` (#fafafa) is imperceptible at that size; it
  is REMOVED rather than left as decoration that does nothing. `max-width: 34ch`
  is a LATIN measure — CJK glyphs are about twice as wide, so the Chinese copy
  broke after twelve characters and left "转发。" alone on a line; now `30em`.
  (4) VERIFIED AT TWO WIDTHS, BY MEASUREMENT AND BY EYE: wide 1440
  `overlapsCard=false` (card x=882, lang x=653); narrow 700 `overlapsCard=false`,
  card 396px, `hScroll=false`. Screenshots of both. Deployed and confirmed live.
  (5) THE PANEL, MEASURED FOR THE NEXT ROUND rather than guessed at: it is in far
  better shape than the console was. 57px icon-only rail, session tabs, a
  governance pill row (Take control / Set a goal for this session / Ask before
  each command), an xterm surface, a status bar. `bodyBg` is `rgb(250,250,250)` and
  `railW` 57. TWO THINGS WORTH TAKING NEXT, both from the picture: the STATUS BAR
  is the only place the release shows and it is the smallest, lowest-contrast text
  on screen (`1 session · v1.2.348 · up 1h 24m · CPU 2% · MEM 63%`); and the three
  GOVERNANCE PILLS are the product's core story rendered at the lowest emphasis on
  the page. `painted: 0` canvases — xterm is on its DOM renderer, as round-274
  documented.
  (6) AND THE SCREENSHOT CAUGHT A REAL DEPLOYMENT GAP: its terminal still showed
  the `npm i -g …` I ran in round 31, and the status bar read **v1.2.348** — the
  CLI had been updated but `vale update` was NEVER RUN, so the device was behind
  while I believed it current. Ran it; the execute returned a 502, WHICH IS THE
  DOCUMENTED MID-SWAP DROP AND NOT PROOF OF ANYTHING, so it was verified BY EFFECT:
  `release: 1.2.349` / `latest: 1.2.349 (this device is current)`. The round-39
  drift check answered it in one line.
  (7) STILL TO DECIDE, and now with evidence in hand: the panel's remaining
  subjective work (status-bar emphasis, governance-pill prominence, whether an
  icon-only rail is right) and the console's VIEWS beyond login (Overview, Users,
  Devices, Keys, Routes) — none of which I have looked at yet.
  Gates: token contract green; gateway 766 + format; gateway-ui 1 + render smoke +
  build; panel 506; agent 583 default. CI green on main.

Previous round: 2026-09-11 round 43 (still the frontend redesign, still the axis that
can be MEASURED: last round the two surfaces disagreed on token VALUES, this round
on DISCIPLINE — and the panel was the one that was wrong). Commit: 4bcd32bb. NO
RELEASE: the change is proven rendering-neutral, so there is nothing to ship.
  (1) THE PANEL'S COMPONENT CSS CARRIED 38 DEAD FALLBACKS. `var(--accent, #4f7cff)`
  can never apply — `--accent` is always defined — so it is not a safety net but a
  DESCRIPTION OF A DESIGN THE PANEL NO LONGER HAS. Together the 38 spelled out an
  entire abandoned palette: a BLUE accent (#4f7cff/#4f6bed/rgba(79,124,255,0.2))
  where the panel's accent is #d9480f, a darker grey family (#1c1e22/#23262c/
  #2a2d34) than the zinc scale, plus #4caf50/#d97706/#111/#333/#666/#999/#eee.
  THE CONSOLE HAS ZERO FALLBACKS OF ANY KIND, so this was a divergence too.
  (2) VERIFIED DEAD, NOT ASSUMED. All 38 name tokens `tokens.css` declares, with no
  conditional or scope-limited definitions. A fallback on a variable the system does
  NOT own is a different thing and is deliberately NOT reported — that is how a
  caller defaults a variable someone else defines.
  (3) THE REMOVAL IS PROVEN RENDERING-NEUTRAL RATHER THAN ARGUED: the previously
  built `panel.css` with its fallbacks mechanically stripped is BYTE-IDENTICAL to
  the newly built one. THAT IS ALSO WHY THERE IS NO RELEASE. The panel is compiled
  into the exe, so shipping it means minting a version — for a diff that cannot
  alter a single computed value. It goes with the next real release; the tracked
  artifact and `panel-react/src` are both updated so `build.rs`'s staleness gate
  is satisfied.
  (4) MY OWN CHECK HAD THE BUG IT EXISTS TO CATCH, and it is the sharpest kind. I
  inserted the new block ABOVE `let failures = 0`, so on a CLEAN tree the line was
  never reached and the check PASSED, while on a tree WITH a defect it crashed on a
  ReferenceError instead of reporting. A gate that only breaks when it has something
  to say — whose exit code is non-zero either way — is invisible to CI, and the
  non-zero exit is exactly what would have hidden it. Found by running the mutation
  and READING THE OUTPUT instead of trusting the exit code. Its failure summary also
  named only one of the two causes it now covers, which would send a reader hunting
  a value mismatch that is not there.
  (5) THE SHAPE WORTH NAMING, because it recurs: fixing a thing exposes the same
  thing one layer over. Round 42 aligned the console's chrome and left its body;
  round 43 removed the panel's dead fallbacks and found its own checker was dead
  code in the same way — an assertion that cannot run is the fallback that cannot
  apply. Both were caught by making the check and then MUTATING it.
  (6) STILL TO DECIDE, unchanged: the SUBJECTIVE half of the redesign — layout,
  density, navigation, whether the console's five views are the right five. Two
  rounds have now improved the objective half without touching a single page, and
  that is deliberate: there is no test to appeal to for the rest, so it wants the
  user's direction rather than my guess.
  Gates: token contract green (both frontends, both modes, no dead fallbacks);
  agent 583 default, fmt clean, panel 506 + build; gateway 766; gateway-ui 1.
  CI green on main including the extended check.

Previous round: 2026-09-11 round 42 (user asked to redesign both frontends; started
with the half that is MEASURABLE — the two surfaces disagreed on the values of
their shared design tokens — and it turned out I could make it worse by doing half
of it). Commits: afb1b721, eb6d9b6c. Deployed to the live worker and verified.
  (1) THE MEASURED DEFECT, BEFORE ANY TASTE. The console (`gateway/ui`, served by
  the `vale-gate` worker) and the device panel (`agent/resources/panel-react`) are
  ONE PRODUCT with two hand-rolled token sets that shared SIXTEEN token NAMES, of
  which TWELVE HELD DIFFERENT VALUES: `--chrome-bg` was Bootstrap gray-100 in one
  and zinc in the other, `--chrome-ink` gray-900 vs `#1d1d1f`, `--radius-sm` 6px
  vs 10px, `--radius-lg` 14px vs 20px. So a shared name meant two different things
  depending on which surface you looked at — and THE CONSOLE'S OWN COMMENT SAID
  "Same vocabulary as the device panel's frame". That sentence is what stopped
  anyone checking: not a lie about code, a half-truth about DESIGN that read as an
  assurance.
  (2) THE DARK SETS HAD ALREADY BEEN ALIGNED (2 of 11 differed), which is exactly
  why the divergence survived — whoever built dark mode compared the two, and
  light was never compared. A surface checked once is not checked.
  (3) I MADE IT WORSE BEFORE BETTER, AND THE FIX IS THE INTERESTING PART. Aligning
  only `--chrome-*` left a ZINC FRAME AROUND A BOOTSTRAP BODY — the two halves
  disagreeing INSIDE one surface rather than across two. The contract check could
  not see it, because it compares names BOTH sides declare and the console's own
  `--text`/`--border`/`--bg-secondary` are not shared names. So the check now ALSO
  requires every console neutral to be a value the panel DECLARES, and the moment
  that was written it found EIGHT MORE in dark mode — the same half-alignment, one
  mode over. It then caught two values I had INTERPOLATED rather than taken from
  the palette (`--border-strong`, `--text-muted`): a design system with invented
  midpoints is not a system. All now drawn from the panel's scale.
  Mutation-proven on the exact mistake: `--text: #212529` fails with "console
  neutral(s) are NOT on the panel's scale".
  (4) THE DIRECTION IS DELIBERATE: the console FOLLOWS the panel (104 tokens
  against 78, palette documented, and it is the device's primary operator
  surface). Resolving one `var()` level is required to compare fairly — the panel
  writes `var(--ds-neutral-50)` where the console writes `#fafafa`, which is
  legitimate — and anything deeper is reported UNRESOLVED rather than treated as
  a match.
  (5) THE CHECK'S PARSER LIED FIRST, the same way the model-drift checker did one
  round ago: it matched `body[data-theme="dark"]` inside a COMMENT and read the
  LIGHT block as if it were the dark one. Comments are now stripped before
  parsing, and the check asserts it found at least 8 shared tokens so a wrong
  block cannot pass as agreement. Caught by reading the raw file instead of
  trusting the tool's output.
  (6) ALSO FIXED, found by doing the work twice: EVERY CONSOLE BUILD LEFT ITS
  PREDECESSOR BEHIND. `vite.config` sets `emptyOutDir: false` deliberately (that
  directory also holds the code-viewer mirror), so every hashed bundle this
  console has ever built stayed in the repo and shipped with the worker; two
  rebuilds in one round left two superseded files, both TRACKED by git.
  `prune-stale-assets.mjs` now runs after vite and removes ONLY unreferenced
  `assets/index-*.{js,css}`, refusing to act when `index.html` references nothing.
  The directory went from six files to two.
  (7) VERIFIED ON THE LIVE WORKER, not the repo: `https://api.saisi.online/`
  serves the new pair, and the served CSS contains all six zinc values with ZERO
  of the seven Bootstrap ones. (My first live check read a CACHED response and
  looked like a failed deploy; a cache-busted fetch and a direct 200 on the new
  bundle settled it — worth recording because "the deploy did not take" is the
  wrong conclusion I nearly drew.)
  (8) STILL TO DECIDE, and I am not guessing: the scope of the REST of the
  redesign. This slice is the objective half — the surfaces measurably disagreed.
  The subjective half (layout, density, navigation, whether the console's five
  views are the right five) is a design decision with no test to appeal to, and it
  wants the user's call on direction before pages move around.
  Gates: token contract green (16 light / 11 dark shared tokens agree; every
  console neutral on the panel's scale in both modes); gateway 766 + format;
  gateway-ui build + tests + jsdom render smoke; panel 506 untouched.

Previous round: 2026-09-11 round 41 (asked whether the gateway can add models and
whether it updates itself: it can do neither by itself, and nothing was watching —
so the watching is now a tool). Commit: de5b625c. NO RELEASE: `scripts/` is not in
the npm package, so this change cannot reach a device.
  (1) THE QUESTIONS, ANSWERED WITH EVIDENCE RATHER THAN OPINION.
  * "Can the gateway add models?" Yes — but ONLY by editing
    `gateway/src/channels.ts`'s MODEL_REGISTRY and redeploying. No runtime or
    admin route exists (the worker's routes are `/api/health`, `/api/vale-*`,
    `/mcp`, `/v1/*`). One record carries SIX facets and `model-registry.test.mjs`
    keeps them bidirectional.
  * "Is it self-updating?" NO, on both counts. NO WORKFLOW DEPLOYS THIS WORKER —
    `ci.yml`'s only `wrangler deploy` calls are `--dry-run` and are for the
    proxies; `release.yml` ships the agent's npm package. And the catalogue is
    source, so adding or retiring a model requires a human and a deploy.
  * "DSH discovers provider models by itself" — IT DOES NOT. Verified: zero
    `fetchModels`/`listModels`/`/v1/models` in its `lib/*.js` OR its web bundle
    (the only `models` match there is `"\\models"`, a regex), and
    `~/.dsh/settings.yaml` HARDCODES 20 `- id:` entries. Its real advantage is
    narrower and worth stating correctly: a model is added by editing a CONFIG
    FILE, with no rebuild. Note its `baseURL` is `https://api.saisi.online` — the
    vale gateway itself — so the chain is upstreams → gateway → DSH, and the
    gateway is the only link that cannot update itself.
  (2) SO THE WATCHING IS NOW A TOOL: `scripts/model-drift.mjs`. Reports what each
  channel advertises against what its upstream offers. MEASURED LIVE: or 445,
  nv 82, cm 69, og 37 answer unauthenticated `/models`; gmi/qw/amd/ds answer 401
  and are reported as NOT CHECKED, never as empty.
  (3) THE ROUND'S REAL LESSON IS A CHECKER THAT LIED, AND I CAUGHT IT BY NOT
  TRUSTING IT. My first comparison diffed raw prefix-stripped names and produced
  FALSE POSITIVES ON EVERY CHANNEL — `og/` looked 2-of-8 broken. It is not: zen's
  list carries those entries past the window I had printed, and the router
  normalises further than a prefix strip (`[1m]` markers, `og/` wire remaps).
  `advertisedNotOffered` is therefore printed as CHECK, never as a verdict. Only
  ONE finding survives scrutiny: `nv/minimaxai/minimax-m3` — NVIDIA's public list
  contains NO minimax model at all, and `wireModelName` passes `nv/` through
  UNCHANGED ("currently only og/ has aliases"), so that entry routes verbatim to
  a name NVIDIA does not offer. The other two nv/ entries are present.
  LABELLED LIMIT, because overclaiming here would be the same defect: a models
  LIST is not proof of a 404. NVIDIA may serve what it does not enumerate, and I
  could not make a call (no VALE_API_KEY on this box). The entry is recorded, NOT
  removed on a string comparison.
  (4) IT IS AN OPS TOOL, DELIBERATELY NOT A CI GATE — it needs four live
  third-party endpoints, and a check whose inputs are unavailable where it runs
  reports success for work it never did (round 26). What runs in CI is the PURE
  half, `scripts/test/model-drift-check.mjs` (6 checks): bracket normalisation,
  the prefix boundary (`o` must not match `og/`), both diff directions.
  Mutation-proven both ways.
  (5) NO RELEASE, DELIBERATELY. `vale-agent-npm`'s `files` list ships README/bin/
  exe/desktop-electron only, so `scripts/`, the workflow and the docs cannot reach
  a device; releasing would have minted a version for nothing. CI green on main
  INCLUDING the new step.
  (6) OPEN AND UNSTARTED: the request to REDESIGN BOTH FRONTENDS (the agent panel
  at `agent/resources/panel-react/`, 506 tests, and the gateway console). Scope was
  asked and not yet answered — visual refresh vs information architecture vs
  rebuild — and the constraint is that both suites pin behaviour that must survive.
  Also open from the same conversation: the model catalogue could move to an
  upstream-fed overlay with a policy facet table, which is the "A+B" option whose
  default policy for UNSEEN models is the thing that needs deciding.
  Gates: model-drift 6 (new), release-audit 9, release-lib 20; agent 583 default /
  634 feat-gated, gateway 766, CLI 35, shell 9, panel 506 — none touched by this
  change.

Previous round: 2026-09-11 round 40 (the desktop shell's control-API origin veto
was BYPASSABLE — its twin's bug, documented as fixed — and the suite that would
have caught it ran NOWHERE). Commit: 0a1e9640, plus 1.2.348.
  (1) A DELEGATED AUDIT OF THE RELEASE/ROLLOUT MACHINERY — `scripts/`, the
  workflows and the Electron shell, none of which any round had ever opened —
  found IPC AUDIT #1 STILL LIVE ON ITS TWIN. The 9444 loopback control API vetoed
  foreign origins with an inline regex in `main.ts` that has NO `$` ANCHOR:
  `/^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|file:\/\/)/i`.
  EXECUTED: `http://127.0.0.1.evil.com`, `http://localhost.evil.com` and
  `http://127.0.0.1x` ALL PASSED. The API reflects the caller's Origin, so a page
  an attacker hosts could READ `/api/browser-session/list` (session URLs) and
  `/api/shell/icon-status` (local paths) and POST `/api/browser-session/open` and
  `/api/shell/start-agent` (`schtasks /run ValeAgent`).
  `url-policy.ts`'s header records that exact class — "startsWith(BASE) was
  BYPASSABLE" — and `isDesktopSpaUrl`'s test pins the sibling-host lookalike TWO
  TESTS ABOVE the new ones. The HTTP path kept the old shape because it was the
  one origin decision that never moved into the policy module.
  `controlOriginOk(origin)` now compares the PARSED hostname, permits an ABSENT
  Origin deliberately (curl/native tooling send none; the data: wait page sends
  "null" — a carve-out `main.ts` documents), and REFUSES an unparseable value
  rather than treating it as one it recognises. Mutation-proven: restoring a
  prefix test fails with "sibling-host lookalike".
  (2) WHY NOTHING COULD SEE IT: THE SHELL'S SUITE RAN NOWHERE. Its `package.json`
  has defined `"test": "node --test"` for as long as `test/url-policy.test.mjs`
  has existed, and NO CI job had that working directory — every other `npm test`
  names gateway, gateway-ui, panel-react, vale-agent-npm or index, and CI only
  COMPILES the shell. `ci.yml` gains that step. This is the same shape the log
  recorded at ci.yml's own "THE SUITE NOTHING RAN" note, and it is why a security
  predicate had no home.
  (3) AND THE SHELL'S OWN BUILD WAS RED. `emitMenu` dereferenced a possibly-null
  `win` against a comment saying "win validated by callers"; this package's
  `npm run build` TYPE-CHECKS, so it failed — unnoticed for exactly the reason in
  (2), and harmless only because CI's `--noCheck` emit is what ships. Fixed with
  the guard the comment described rather than silenced. `npm run build` is green
  in that directory for the first time.
  (4) RELEASED 1.2.348 and updated d1. THE ROUND-39 DRIFT CHECK EARNED ITS KEEP
  IMMEDIATELY: `vale status` reported "THIS DEVICE IS BEHIND by 2 releases" before
  I looked, then "this device is current" after the swap — the check built one
  round earlier, catching a real gap in its first live use. CI and the release
  workflow green on the tag, INCLUDING THE NEW SHELL STEP; keep-latest left ONE
  release and ONE tag; the dual-builder audit reported the STRONGER WARN verdict
  for the TWENTIETH consecutive release.
  (5) THE RELEASE AUDIT'S OWN FINDINGS, NOT ACTED ON, WITH HARD EVIDENCE. The
  19-release WARN IS ONE FILE MODE, and this is measured rather than inferred: the
  live CDN and GitHub 1.2.346 tarballs differ by EXACTLY 3 bytes out of 17,774,080
  — the mode field of `package/README.md` (`-rw-------` locally, `-rw-r--r--` in
  CI, because npm pack preserves source modes) and its header checksum. EVERY
  file's sha256 is identical INCLUDING `vale-agent.exe`. TWO CONSEQUENCES: the fix
  is a `chmod`; and because the WARN branch is reachable only when the two exes are
  byte-identical, NINETEEN CONSECUTIVE WARNs PROVE the two builders have produced
  identical exes for nineteen releases — which FALSIFIES the stated rationale of
  `publish-release.sh`, `release-audit.sh` and the whole of `publish-cdn-from-ci.sh`
  ("the exes are not byte-identical and cannot easily be made so").
  ALSO OPEN: the audit can PASS WHILE COMPARING NOTHING (its two `cd`s are
  unchecked command substitutions; a tarball whose top dir is not `package` makes
  both listings empty, they compare equal, and the function returns 0 — reproduced
  against trees with a different top dir); its two call sites DISAGREE on that
  failure because bash disables errexit inside a `||` list; `--skip-reconcile`'s
  refusal guard discards the very API call it depends on (`|| true` + `2>/dev/null`),
  so a missing token turns the documented refusal into "audit SKIPPED"; the default
  publish leaves a STALE installer alias that its own smoke cannot see; the
  tag/release step exists only as PRINTED TEXT, and the CDN is live before any tag
  exists; the release gate's 10-minute bound is shorter than the eleven-job matrix
  it waits for, and its `read <<< "$(...)"` is not fail-closed as its comment
  claims; the two "last-5" prunes implement different policies while one calls
  itself the other's companion; and `release-audit.sh` — the highest-stakes gate —
  is the only lib in the toolbox with NO TEST, which is how the above survived.
  Gates: shell 9 (was 0 — the suite did not run) and `npm run build` green for the
  first time; agent 583 default / 634 feat-gated, clippy -D warnings clean BOTH
  configs, fmt clean, xwin OK; gateway 766 + format; CLI 35; panel 506.

Previous round: 2026-09-11 round 39 (THE DELIVERY GAP FINALLY HAS A CHECK — the
most repeated finding in this log, closed where an operator already looks).
Commit: 156a991e, plus 1.2.346.
  (1) IT IS THE MOST REPEATED FINDING HERE AND IT WAS NEVER CHECKED. Round after
  round records a device found many releases behind the CDN — five, six, and once
  THREE IN A SINGLE ROUND — and every time the only thing that noticed was a human
  looking. The log has said for several rounds that "a future round should build
  the check". `vale status` answered "what is this device running" and never "is
  that current", and those two questions are answered by DIFFERENT MACHINES: the
  device knows its own release, the CDN knows the newest one, and nothing had ever
  put them side by side.
  It does now, in the one command an operator already runs after every update.
  (2) VERIFIED IN BOTH DIRECTIONS ON THE LIVE DEVICE, which is the strongest
  evidence this log has produced for anything. With the CLI updated and the device
  not yet:
    `latest: 1.2.346 is on the CDN -- THIS DEVICE IS BEHIND by 1 release; run 'vale update'`
  and after the swap:
    `latest: 1.2.346 (this device is current)`
  The feature caught the exact gap it was built for, on the device, in the
  operator's own command — not in a test fixture.
  (3) AN UNREADABLE CDN IS NOT AGREEMENT. A failed check prints "could NOT be
  checked … this says nothing about whether the device is current", because
  silence here is indistinguishable from "fine" and that is the failure mode this
  whole log is about. NOT THEORETICAL: while verifying, the first live call
  returned `null` from a transient blip and the line said so, then answered
  `1.2.345` on the next three attempts. The fetch is `curl` with a 3 s cap — the
  same tool `vale rollback` uses for its HEAD check — so `status`, which an
  operator runs when something is ALREADY wrong, cannot hang on a bad network.
  (4) `behindBy` COUNTS ONLY WHAT IT CAN COUNT. Patch distance within a minor is a
  real number ("5 releases"); a cross-minor jump is "a release line, not a patch
  count", because the CDN prunes last-5-per-minor and `vale rollback` refuses that
  jump for the same reason; an unparseable version is "an unknown number of
  releases". It never fabricates a figure a reader would act on.
  (5) AND THE FIRST VERSION HAD THE BUG THIS LOG KEEPS FINDING — committed by me,
  ONE ROUND AFTER fixing its twin in the panel. It tested `latestVersion === null`,
  so a caller that merely OMITS the field fell through to the drift branch with
  `undefined` and crashed reading `.split` of nothing; the PRE-EXISTING
  `statusReport` test caught it immediately. Missing and null are both "we do not
  know what the CDN has"; only a STRING is a comparison. The `undefined`-is-not-
  `null` lesson, re-learned in a new language within one round.
  (6) RELEASED 1.2.346, updated d1 and confirmed the line flipped to "current".
  CI and the release workflow green on the tag; keep-latest left ONE release and
  ONE tag; the dual-builder audit reported the STRONGER WARN verdict for the
  NINETEENTH consecutive release. (The audit itself returned "Empty reply from
  server" on the first attempt and passed on retry — a transient, noted because
  this log records failures that were discarded as successes.)
  (7) STILL OPEN, with evidence. From the panel data-layer audit: `useSSE`'s
  comment guarantees a retry removed in round 163 and the sweep loss is real;
  `useSessions` presents a stale list as current (`?? Date.now()` for `openedAt`,
  which the device never sends, rendered as the session's AGE and used for
  sorting) and its failed-fetch test is VACUOUS (it never consumes its
  `mockRejectedValueOnce`, so it passes whether or not the failure path works);
  `usePlugins` invents "ok" for a start/stop whose answer carried no status;
  `PluginsPage` renders `started_at ?? Date.now()` as "up 0s" for the production
  EXTERNAL playwright branch, which omits that field; `revokeGrants` substitutes
  `[]` for a missing device field and reports success while its twin guards it;
  `useCommandEvents`'s absent-`found` default of `true` is a completeness claim,
  not a neutral one. From the CLI: `vale uninstall` cannot report failure;
  `vale update`'s receipt result is discarded; the staging guard is a REGION;
  the CLI's fallback roots differ from the agent's; `autostart off` prints a
  success sentence after a per-task failure. From earlier: a backgrounded
  command's exit code is memory-only; the migration test's drive-letter fixtures;
  no Windows test job in CI.
  Gates: agent 583 default / 634 feat-gated, clippy -D warnings clean BOTH configs,
  fmt clean, xwin OK; gateway 766 + format; CLI 35 (was 31); panel 504.

Previous round: 2026-09-11 round 38 (a 2xx the console could not read became a
SUCCESSFUL tool result; one update lock had two staleness windows; and a failed
inventory read claimed progress for ever). Commits: 79402d50, 5a70b668, plus
1.2.344 and 1.2.345.
  (1) THE GATEWAY TURNED A NON-JSON 2xx INTO A SUCCESSFUL TOOL RESULT.
  `resp.json().catch(() => ({}))` produced `{}` for an empty, truncated or
  non-JSON body — and `{}` PASSES the agent-ok check below it, because `data.ok`
  is `undefined`, not `false`. The model received a successful result containing
  nothing and would report work it had no evidence for. The round-58 comment
  above that check documents THE SAME DEFECT through a different door: it taught
  the code to read the AGENT's `ok` flag, and the fallback manufactured one
  whenever the agent's answer could not be read at all. `null` now means "no
  parseable body" and is reported as a failure. Mutation-proven, and the mutation
  prints the harm verbatim: `{"result":{"content":[{"type":"text","text":"{}"}]}}`.
  (2) ONE UPDATE LOCK, TWO STALENESS WINDOWS. The marker PATH agreed across the
  two languages; the WINDOW did not — the CLI reclaimed an abandoned marker after
  TEN minutes while the agent refused for an HOUR. At eleven minutes the CLI
  OVERWROTE a marker the agent still honoured, so a CLI update could start
  alongside a console-launched one and interleave `Copy-Item` on `*.new` — the
  half-written exe reported "ok" the marker exists to prevent. The agent's own
  comment made the choice indefensible: it cites round-54 as "a stuck marker
  blocked updates for up to an hour", then picked an hour. Both sides now use ten
  minutes, PINNED ACROSS THE LANGUAGE BOUNDARY (the CLI test parses both
  literals), because no test inside either language can see the other's number.
  Mutation-proven: restoring 3600 fails with "the two sides disagree about when
  an abandoned update marker may be reclaimed".
  (3) A FAILED INVENTORY READ SAID "Loading inventory…" FOR EVER. `usePlugins`'
  spec fetch was `catch { /* transient — retry next tick */ }` — it set NOTHING,
  and `specLoaded` is the only thing that re-arms the fetch. THERE IS NO TICK: the
  5 s poll was removed in round 163, four lines below the comment promising the
  retry. The status fetch in the SAME hook sets `loadError`; the twin rule applied
  to one branch and not the other, inside one function. AND THERE WERE TWO SILENT
  PATHS: `if (Array.isArray(specRes?.plugins))` had NO else, so a 200 the panel
  cannot use fell through without a throw — the same permanent "Loading…" reached
  without an exception. Both now go through ONE failure path.
  MY OWN FIRST FIX HAD THE DEFECT ONE LEVEL UP and the test caught it: the two
  reads shared one `loadError`, so the status fetch's SUCCESS cleared the spec
  error microseconds later. A single cell cannot carry two independent facts.
  (4) THREE COMMENTS DESCRIBED POLLS THAT NO LONGER EXIST (`useCommandEvents`'s
  "Poll the audit log"/"Cards update every poll"/"a FAILED poll", and
  `usePlugins`' "don't wait for the poll"). No timer has existed since round 163;
  `pollMs` is inert and now says so where it is declared, because a test that
  "polls" at 30 ms cannot be evidence of a cadence that does not exist.
  (5) `lib/runs.ts` STATED THE OPPOSITE OF THE DEVICE: its `RunBoundary` doc said
  label/goal/outcome "are ABSENT (a missing key, not `null` and not `""`) … so
  presence is read, never truthiness", while `runs.rs` says outright that `json!`
  renders `None` as `null` and the key IS present, and that every consumer must
  treat null, missing AND blank alike. The code always did the right thing; the
  sentence would have licensed a future key-existence check that misses every real
  case. Corrected, with the test that restated the false premise.
  (6) THE DELIVERY GAP. d1 needed a manual update in every round this log records
  — three times in this round alone (1.2.343 → .344 → .345) — and NOTHING CHECKS
  IT. A future round should build the check; it is the single most repeated
  finding here and it is caught only by looking.
  (7) A PROCESS NOTE WORTH KEEPING: 1.2.344 reached the CDN with NO TAG AND NO
  RELEASE, because the tag API call carried a hardcoded SHA and failed silently
  behind a `>/dev/null`. 1.2.345 supersedes it and `vale rollback` resolves
  targets from the CDN (not GitHub), so the impact is nil — but the lesson is the
  round's own family: a step whose failure is discarded reports success.
  (8) STILL OPEN, with evidence. From the panel data-layer audit: `useSSE`'s
  comment guarantees a retry removed in round 163 and the sweep loss is real;
  `useSessions` presents a stale list as current (`?? Date.now()` for `openedAt`,
  which the device never sends, rendered as the session's AGE and used for
  sorting); its failed-fetch test is VACUOUS (it never consumes its
  `mockRejectedValueOnce`, so it passes whether or not the failure path works);
  `usePlugins` invents "ok" for a start/stop whose answer carried no status;
  `PluginsPage` renders `started_at ?? Date.now()` as "up 0s" for the production
  EXTERNAL playwright branch, which omits that field; `revokeGrants` substitutes
  `[]` for a missing device field and reports success while its twin guards it;
  and `useCommandEvents`'s absent-`found` default of `true` is a completeness
  claim, not a neutral one. From earlier rounds: `vale uninstall` cannot report
  failure; `vale update`'s receipt result is discarded; the staging guard is a
  REGION; the CLI's fallback roots differ from the agent's; `autostart off` prints
  a success sentence after a per-task failure; a backgrounded command's exit code
  is memory-only; the migration test's drive-letter fixtures; no Windows test job
  in CI.
  Gates: agent 583 default / 634 feat-gated, clippy -D warnings clean BOTH configs,
  fmt clean, xwin OK; gateway 766 (was 765) + format; CLI 31 (was 30); panel 504
  (was 503) + build.

Previous round: 2026-09-11 round 37 (the CLI's tunnel config pointed the ingress at
an address the agent does not listen on, and dropped the guard against a stale
REMOTE config doing the same — settled on the LIVE DEVICE, not by reading).
Commit: 2fc6dc69, plus 1.2.343.
  (1) `vale tunnel install` WROTE A DEAD INGRESS. It put
  `service: http://127.0.0.2:<port>` into `etc\tunnel.yml`; the agent's own
  provisioning writes `127.0.0.1`, keeps a helper (`ingress_service`) whose comment
  says it exists to "reach the agent where it actually listens", and calls 127.0.0.2
  "a dead address (502)". Two writers, two answers, one file — and nothing in
  either language could see the other.
  (2) THE DEVICE SETTLED IT, WHICH IS THE METHOD WORTH KEEPING. The repo contained
  TWO CONTRADICTORY CLAIMS about the same address — `tunnel.rs` calling 127.0.0.2
  dead, `ServerConfig::default`'s comment calling it "cloudflared's canonical
  ingress ... Nothing else is reachable" — so reading could not decide. `netstat`
  on d1 shows the listener on `127.0.0.1:18080`, and d1's own `etc\tunnel.yml`
  says `service: http://127.0.0.1:18080`. The CLI would have repointed a working
  tunnel at a socket nobody holds, on the one command whose entire job is to make
  the tunnel work.
  (3) IT ALSO DROPPED `allow-remote-config: false`, AND THE LIVE FILE CARRIES IT.
  The agent writes that line deliberately: cloudflared prefers a REMOTE config when
  one exists, so a stale remote ingress keeps proxying to a dead address "no matter
  what tunnel.yml says". The CLI's writer silently re-enabled exactly that. TWO
  REGRESSIONS IN ONE FILE WRITE, both disproven by the device rather than by
  reading — and both invisible to any test that did not compare the two writers.
  (4) A THIRD SPELLING WAS WRONG TOO: `ServerConfig::default()` set
  `host: "127.0.0.2"`, a default that disagreed with the shipped `config.yaml` it
  exists to replace, with the agent's own ingress, and with the device. Now
  127.0.0.1, with the evidence in the comment. Its pin (`tests/integration.rs`) moved
  with it.
  (5) THE PIN IS CROSS-LANGUAGE, which is the only kind that could have caught this.
  The new CLI tests read BOTH `src/vale.ts` AND the compiled `bin/vale.js` and
  require the ingress to be 127.0.0.1, forbid 127.0.0.2, and require
  `allow-remote-config: false`; a second test pins the agent's default host against
  the same rule. This is the gateway's code-viewer mirror shape and for the same
  reason: A TEST ON ONE COPY CAN ONLY EVER COMPARE COPIES. It also caught a stale
  `bin/vale.js` immediately, because the compiled CLI is tracked and CI compares it
  against a fresh compile — the first run failed on the `bin` half rather than
  passing on `src`. Mutation-proven: restoring 127.0.0.2 fails with "127.0.0.2 is
  back — the agent calls it a dead address (502)".
  (6) RELEASED 1.2.343, updated d1 and verified by effect (`release: 1.2.343`). CI
  and the release workflow green on the tag; keep-latest left ONE release and ONE
  tag; the dual-builder audit reported the STRONGER WARN verdict for the
  EIGHTEENTH consecutive release.
  (7) STILL OPEN, with evidence. From the CLI/gateway audit: ONE UPDATE LOCK WITH
  TWO STALENESS RULES — the marker PATH agrees across languages but the WINDOW does
  not (CLI 10 min, Rust 3600 s), so the CLI OVERWRITES a marker the Rust side still
  refuses and either swap script's unconditional `Remove-Item` releases the other's
  exclusion, while the operator docs state only the 10-minute rule;
  `vale uninstall` cannot report failure (it claims removal and exits 0 whatever
  happened, while its LEGACY-dir twin IS verified and prints a warning);
  `vale update`'s receipt is written but its `ps()` result discarded, so a failed
  write manufactures the documented "the command never reached the device"
  conclusion; the staging guard is a REGION, so five later writes (including the
  swap script itself) can strand the busy marker; the CLI's fallback roots
  (`C:\Program Files\Vale`) are not the agent's (exe dir) and `update` — unlike
  `uninstall` — has no guard against staging into a directory the agent is not
  running from; `autostart off` prints a success sentence after a per-task failure;
  and the gateway turns a 2xx with a non-JSON body into a SUCCESSFUL tool result
  (`resp.json().catch(() => ({}))`). From the panel: `usePlugins` reports "Stopped"
  for a status never read; `SettingsPage` names a pre-v2 memory path; `useSSE`'s
  comment guarantees a retry removed in round 163; the device timeline drops a
  >500-event window's middle while its comment claims the limit is safe; and
  `lib/path.ts`'s header denies a capability it implements. From earlier rounds: a
  backgrounded command's exit code is memory-only; the migration test's drive-letter
  fixtures; no Windows test job in CI; and THE DELIVERY GAP (d1 has needed a manual
  update in every round this log records).
  Gates: agent 583 default / 634 feat-gated, clippy -D warnings clean BOTH configs,
  fmt clean, xwin OK; gateway 765 + format; CLI 30 (was 28); panel 503.

Previous round: 2026-09-11 round 36 (a browser action that never started was shown
as "running" while the device's explanation went undrawn; and ROUND 26'S FIX HAD
PROMISED A SAFETY NET IT NEVER WOVE). Commit: 58814a1c, plus 1.2.342.
  (1) A BROWSER ACTION THAT NEVER STARTED WAS SHOWN AS "running". The panel mapped
  `exit_code === null` to that badge, and NO RECORD IN THE FEED CAN BE RUNNING —
  every writer appends only after the action ends (the playwright producer writes
  the result triple; the mcp-client producers write `exit_code: if ok { 0 } else
  { 1 }`). The device distinguishes the two null-code cases with `timed_out`:
  `Err(_)` = timed out, `Ok(Err(e))` = SPAWN FAILURE, and it writes
  "spawn failed: {e}" to stderr. That sentence — `stderr_tail` — was DECLARED on
  the panel's type, FETCHED from the route, and rendered NOWHERE, so every failure
  arrived with no visible reason. The device did its job; the surface dropped it.
  TWO MORE COLLAPSES FIXED: `undefined` is not `null` (the old `=== null` test
  sent an absent field down the exit-code branch and rendered the literal string
  "exit undefined" in the error class), and success is `exit_code === 0` and
  nothing else. All of it is one `actionVerdict()` now, not a re-derivation at the
  badge. Mutation-proven: making a null code read "running" fails the test naming
  it. Also: `recipe.ts` omitted `bg`, so a path whose commands were all handed off
  produced a recipe reading complete — the FOURTH place round 31's state had to be
  added by hand, which is why `PATH_STATES` now exists as the one list.
  (2) ROUND 26'S FIX SHIPPED ITS OWN DEFECT, and it is the sharpest instance of
  this log's family yet. `browser-contract.test.mjs` documented: "WHEN THE BUNDLE
  IS PRESENT we also check the snapshot against it, so a stale snapshot fails on
  any box that has the artifact ... the banner below says so rather than letting a
  skip look like a pass." THERE WAS NO SUCH CHECK, NO BANNER, AND `shippedBundle()`
  WAS CALLED BY NOTHING — the comment and the orphan arrived in the SAME COMMIT,
  the one that replaced both call sites with the snapshot reader. So the snapshot
  could go stale in silence while every contract below it validated the console
  against a server that is not the one we ship, which is EXACTLY the failure the
  snapshot exists to prevent. Not a comment describing code wrongly: a comment
  describing a SAFETY NET that was never woven, in the round that shipped the net.
  THE VERSION IS NOW REALLY CROSS-CHECKED (`shippedMcpVersion()` vs the snapshot's
  declared source), and the skip PRINTS what it did not verify. Mutation-proven:
  a snapshot claiming 0.0.78 fails with "the snapshot is STALE".
  WHAT IT STILL DOES NOT CHECK, stated in the code instead of implied away: the
  schema TEXT. Each entry is a NON-CONTIGUOUS concatenation — a bundle slice plus
  referenced definitions appended from elsewhere — so "does the bundle contain this
  string" is FALSE for 28 of the 78 tools and a naive containment check would fail
  on a CORRECT snapshot. Measured before ruling out; a real text check needs the
  extractor's own logic.
  (3) THE STALENESS GATE CAUGHT MY OWN RELEASE. An unused test helper broke the
  panel build (unused locals are errors), so `build.sh` refused to ship an older
  exe: "predates the newest exe-input commit — rebuild, re-stage, retry". The gate
  worked exactly as designed, on me, before any device saw it.
  (4) RELEASED 1.2.342, deployed the gateway (no targets — only a test file
  changed), updated d1 and verified by effect (`release: 1.2.342`). CI and the
  release workflow green on the tag; keep-latest left ONE release and ONE tag; the
  dual-builder audit reported the STRONGER WARN verdict for the SEVENTEENTH
  consecutive release.
  (5) CLI/GATEWAY AUDIT FINDINGS NOT ACTED ON, recorded with evidence. The two
  sharpest: `etc\tunnel.yml` has TWO WRITERS THAT DISAGREE — the CLI writes
  `service: http://127.0.0.2:<port>` (`vale.ts:767`) while the agent's own
  provisioning writes `127.0.0.1` (`tunnel.rs:405-407`, test-pinned) and its
  comment calls 127.0.0.2 "a dead address (502)"; fresh installs bind 127.0.0.1,
  so the CLI's file points the tunnel at a socket nobody holds, and `vale tunnel
  status` reports RUNNING from the process table, never reachability. And ONE
  UPDATE LOCK WITH TWO STALENESS RULES: the marker PATH agrees across languages
  but the WINDOW does not (CLI 10 min, Rust 3600 s), so the CLI OVERWRITES a
  marker the Rust side still refuses, and either swap script's unconditional
  `Remove-Item` releases the other's exclusion — while the operator docs state
  only the 10-minute rule. Also open: `vale uninstall` cannot report failure (it
  claims removal and exits 0 whatever happened, while its LEGACY-dir twin IS
  verified and prints a warning); `vale update`'s receipt is written but its
  `ps()` result discarded, so a failed write manufactures the documented "the
  command never reached the device" conclusion; the staging guard is a REGION, so
  five later writes (including the swap script itself) can strand the busy marker;
  the CLI's fallback roots (`C:\Program Files\Vale`) are not the agent's (exe
  dir), and `update` — unlike `uninstall` — has no guard against staging into a
  directory the agent is not running from; `autostart off` prints a success
  sentence after a per-task failure; and the gateway turns a 2xx with a non-JSON
  body into a SUCCESSFUL tool result (`resp.json().catch(() => ({}))`).
  Gates: agent 583 default / 634 feat-gated, clippy -D warnings clean BOTH configs,
  fmt clean, xwin OK; gateway 765 (was 764) + format; panel 503 + build.

Previous round: 2026-09-11 round 35 (the live views claimed a session had run
NOTHING, from a read that had not finished or had failed — round 27's defect one
field over, in the same object literal). Commit: 832c7aa4, plus 1.2.341.
  (1) `useCommandEvents` HAS REPORTED `readState` FOR LONGER THAN THE ARCHIVE HAS
  USED IT, and the Archive was its ONLY consumer. The live slice dropped it:
  `App` built `{cards, events, firstSeq}` — the SAME object literal round 27 taught
  to carry `firstSeq`, ONE LINE away from this field. So `TrajectoryView` printed
  "No commands in this session yet." and `PathView` printed "This session has not
  run a command." unconditionally, through TWO reachable windows: every SESSION
  SWITCH (`useCommandEvents` resets `events` to `[]` synchronously while the new
  read is in flight, so the operator is told the session is empty for the whole
  round trip), and any read that failed or never succeeded.
  (2) "THIS SESSION HAS NOT RUN A COMMAND" IS A CLAIM ABOUT THE DEVICE and is only
  sayable once a read SUCCEEDED. The rule was already written down TWICE and
  honoured once: `ArchivePage`'s header says "a session whose trail cannot be read
  SAYS SO, and never renders as an empty history", and its test says the empty line
  "is a CLAIM about the session … and must not stand in for a failed read". Both
  sentences were about this field, and neither could see the two views that lacked
  it. A rule stated twice and enforced once is this log's most productive family.
  (3) THREE PARTS, and the second is the one that lasts. `lib/trailRead.ts` owns
  the WORDING, because three views render this sentence and three copies of one
  sentence is how this repo's surfaces come to disagree about what they are saying
  (the Archive's phrasing is preserved verbatim). `readState` is a REQUIRED member
  of the `CommandEvents` slice, exactly as `firstSeq` became in round 27 and for
  the identical reason — and it paid immediately: the compiler surfaced BOTH `App`
  mounts, every view prop, and three fixtures, INCLUDING
  `TerminalWorkspace.test.tsx`, which PINS THE DEFECT as the live contract. The
  distinction does not swallow the real case: a session that ran nothing and whose
  read succeeded still says so, and a test asserts each of the three answers.
  Mutation-proven: making the notice unconditional again fails three tests.
  (4) RELEASED 1.2.341. CI and the release workflow green on the tag; keep-latest
  left ONE release and ONE tag; the dual-builder audit reported the STRONGER WARN
  verdict for the FIFTEENTH consecutive release. d1 updated to it the same round
  and verified by effect (`release: 1.2.341`).
  (5) STILL OPEN, with evidence, in the order I would take them. (a) A browser
  action that FAILED TO SPAWN renders as "running" in `EvidenceDrawer`: the device
  writes `exit_code: null` for a spawn failure and the panel collapses that into
  the running badge; the same lines mishandle an ABSENT field (`=== null` never
  matches `undefined`, so a record without one renders "exit undefined" in the
  error class), and `stderr_tail` — the text that would explain the failure — is
  declared and rendered NOWHERE. `lib/runs.ts` does it right (`num()`) and
  `ActivityPage` states the rule ("`exit 0` and no exit code was recorded are
  different renderings"). (b) `usePlugins` derives one fact twice and reports
  "Stopped" for a plugin status that was never read, on every mount until the
  reply lands and permanently if the status fetch fails. (c) `SettingsPage` tells
  the operator memory lives in `<install>/memory/memory.jsonl` where the store is
  `<data>/memory` — round 32 fixed six RUST doc paths of this family and missed the
  operator-facing copy. (d) `useSSE`'s comment guarantees a 5 s retry that was
  removed in round 163, and the loss it describes is real. (e) The device timeline
  silently drops the middle of a >500-event window while its one comment claims the
  limit is "large enough that a run's events are not cut in half" — the device keeps
  the NEWEST. (f) `lib/path.ts`'s header denies a "who ran this" capability the same
  file implements 100 lines below. (g) `recipe.ts` omits `bg` from its state list,
  so a path of backgrounded commands yields a clean-looking recipe. (h) From the
  earlier audits: a backgrounded command's exit code is memory-only; the CLI's
  registry fallbacks differ from the agent's; the migration test's drive-letter
  fixtures; no Windows test job in CI.
  (6) THE DELIVERY GAP REMAINS THE MOST REPEATED FINDING — it was caught only by
  looking again this round, and a future round should consider a check for it.
  Gates: agent 583 default / 634 feat-gated, clippy -D warnings clean BOTH configs,
  fmt clean, xwin OK; gateway 764 + format; panel 496 (was 492) + build.

Previous round: 2026-09-11 round 34 (a tool that answered "no process matched"
from a command that never ran; a state I shipped with no dot; and `startup.log`
finally served). Commit: 9de7034c, plus 1.2.340.
  (1) `system_process_kill` BY NAME WAS A SILENT NO-OP OFF WINDOWS, AND IT LIED
  ABOUT IT. The `pgrep` fallback sat inside `if let Ok(o) = &r`, so it ran only
  when `taskkill` RAN and failed. Where `taskkill` cannot be spawned at all —
  any non-Windows host — nothing looked, `killed` stayed empty, and the operator
  was told "no process matched <name>". That is not a failure to act: it is a
  FALSE STATEMENT ABOUT THE PROCESS TABLE, manufactured from a command that never
  ran. The pid branch above has always done it correctly (`!ok` catches both a
  failed `taskkill` and one that could not start), so this is the TWIN RULE
  applied to one branch and not the other. The fallback now covers the spawn
  error, and when NEITHER tool exists the answer says the kill could not be
  ATTEMPTED rather than falling through to the same false claim.
  Its test's PREMISE was the defect: the comment read "pgrep finds no pids (and
  taskkill is absent outside Windows) → no process matched" — treating the
  ABSENCE of the Windows tool as the REASON for that answer, which is exactly the
  reasoning that produced the bug.
  WHY THE PIN IS STRUCTURAL, AND ITS HONEST LIMIT. Provoking "no matcher exists"
  means emptying `PATH` — process-global state in a suite that runs its tests in
  PARALLEL THREADS of one process. My first version did that behind the module's
  env lock and BROKE EIGHT UNRELATED TESTS, because the lock only excludes tests
  that also take it and the terminal tests spawn shells. That is the THIRD time
  this log records process-global state colliding with parallel tests; the fix is
  not a wider lock but not reaching for the global at all. The pin then took three
  more attempts to get right, each failing against CORRECT code: a fixed-length
  window read a NEIGHBOURING tool, and the next version read the TEST MODULE —
  whose assertion message QUOTES the string it forbids. A check that reads its own
  text always finds what it is looking for. It now pins the correct `matches!`
  construct positively, in a window bounded to the function. LIMIT, STATED: I did
  not produce a compiling mutation demonstrating this pin biting.
  (2) I SHIPPED A STATE WITH NO VISUAL CHANNEL IN ROUND 31. `bg` was added to
  `PathState`, returned by `cardState` and rendered as `data-state` — while
  `data-state="bg"` occurred ZERO times in every stylesheet AND in the built
  artifact. Base `.cmd-dot` sets only size and border-radius, so an unmatched state
  is an INVISIBLE 8px circle: the dot did not render unstyled, it rendered NOTHING.
  The round-31 tests asserted words and counts, which is exactly the layer where
  the bug was not.
  THE DURABLE FIX IS NOT THE TWO CSS RULES. `PATH_STATES` is now the ONE list with
  `PathState` DERIVED from it, and `statePalette.test.ts` iterates it and requires
  every state to have a rule in the BUILT sheet. That contract used to iterate a
  HARDCODED five names — a contract that enumerates its own subjects cannot notice
  a new one, which is why `bg` sat outside the guarantee the test exists to state.
  The sheet's legend said "FIVE states" and now says six, naming the new channel
  (half-fill + ring, keeping the circle-and-FILL vocabulary the legend describes).
  Mutation-proven: deleting the rule fails two tests with "has NO rule, so a step
  in that state renders an invisible dot" — my own regression, restored.
  (3) `startup.log` IS NOW SERVED BY `/api/logs`. The route's own doc has listed it
  among the files layout v2 moved into that directory since the route was written,
  while the served set was three files without it — so the only record of a rotated
  `device_token` was the one the operator's log card could not read, and the symptom
  it explains (every client 401s) is total and otherwise unexplained. Pinned by
  NAME, not by count, so dropping a different file to make room cannot pass.
  VERIFIED ON d1: `names=agent.log,vale-update.log,mcp_diag.log,startup.log`,
  `startup_present=True`.
  (4) THE DEVICE WAS SIX RELEASES BEHIND AGAIN (1.2.334 vs 1.2.340) and the first
  update attempt returned "fetch failed" — which the docs say looks identical to a
  successful swap. Checked BY EFFECT: still 1.2.334, no `update requested` receipt,
  nothing in flight, so the command never reached the device; retried and it took
  (`release: 1.2.340`). THE DELIVERY GAP IS NOW THE MOST REPEATED FINDING IN THIS
  LOG and it is caught only by looking — a future round should consider a check.
  (5) RELEASED 1.2.340. CI and the release workflow green on the tag; keep-latest
  left ONE release and ONE tag; the dual-builder audit reported the STRONGER WARN
  verdict for the FOURTEENTH consecutive release.
  (6) PANEL AUDIT FINDINGS NOT ACTED ON, recorded with evidence so the next round
  does not re-derive them. F1 is the sharpest and is ROUND 27's PATTERN EXACTLY:
  `useCommandEvents` computes `readState` ("reading"|"ok"|"unreadable") and it has
  ONE consumer (the Archive); the live slice drops it, so `TrajectoryView` renders
  "No commands in this session yet." and `PathView` renders "This session has not
  run a command." DURING EVERY SESSION SWITCH and on any failed read — while the
  rule is written down twice ("must not stand in for a failed read") and honoured
  once. Also open: a browser action that FAILED TO SPAWN renders as "running" in
  `EvidenceDrawer` (`exit_code === null`, which is exactly what the device writes
  for a spawn failure) and its `stderr_tail` is fetched and never rendered; the
  panel's sixth state has no visual channel (FIXED here); `usePlugins` derives one
  fact twice and reports "Stopped" for a status that was never read; the
  SettingsPage names `<install>/memory/memory.jsonl` where the store is
  `<data>/memory` (round 32 fixed six Rust paths of this family and missed the
  operator-facing copy); `useSSE`'s comment guarantees a 5 s retry that was removed
  in round 163; three hand-written "is this an error?" prefix lists, all different;
  the device timeline silently drops the middle of a >500-event window and its one
  comment claims the limit is "large enough that a run's events are not cut in
  half" while the device keeps the NEWEST; and `lib/path.ts`'s header denies a
  "who ran this" capability the same file implements 100 lines below.
  Gates: agent 583 default / 634 feat-gated (was 582/633), clippy -D warnings clean
  BOTH configs, fmt clean, xwin OK; gateway 764 + format; panel 492 (was 491) + build.

Previous round: 2026-09-11 round 33 (a fresh audit of `system_*` found two
descriptions stating behaviour the handlers do not have — binary reads that
promised an error and returned mojibake, and an upload described as streamed that
reads the whole file into memory). Commit: 32aaa353, plus 1.2.339.
  (1) `system_file_read` PROMISED AN ERROR FOR BINARY AND RETURNED MOJIBAKE. The
  description said "binary files return an error — use a terminal session for
  binary inspection" and named `raw: true` as the escape; the handler ran
  `String::from_utf8_lossy`, so a PE, an archive or a blob came back as
  U+FFFD-substituted text THAT READS AS CONTENT. A model cannot tell it from a
  real read, and nothing pointed it at the documented escape. THE DESCRIPTION WAS
  RIGHT AND THE CODE WAS WHAT HAD TO CHANGE.
  No lossy fallback, deliberately: `from_utf8_lossy` also silently repairs a
  mostly-text file with one damaged byte — the same silence in a smaller dose. The
  caller asked for TEXT, so it gets text or a refusal naming `raw: true`.
  `bytes`/`truncated` keep their meaning; only the conversion changed.
  Mutation-proven, and the mutation prints the harm verbatim: restoring the lossy
  read returns `"text":"MZ\u{fffd}\u{0}\u{fffd}\u{fffd}\u{0}\u{1}"` for a PE header.
  (2) THE RELAY UPLOAD NEVER STREAMED, IN EITHER COPY. The device and the gateway
  catalogue both said "streamed from disk straight to the relay" while the handler
  does `std::fs::read` + a buffered body — up to 100 MiB resident. The DOWNLOAD
  direction really does stream (`bytes_stream()`), WHICH IS WHAT MADE THE SHARED
  SENTENCE LOOK VERIFIED: a twin that behaves differently is how one description
  survives in two places. The load-bearing true part ("the bytes never pass through
  the AI context") is kept and the real cost is now stated. Both copies corrected,
  and the gateway re-deployed — verified on the LIVE URL, byte-equal to the repo
  mirror (`75b9d7dc657f`), with the false phrase absent from what the console serves.
  (3) THE ASSERTION I WROTE FOR (2) FAILED AGAINST THE CORRECT TEXT. It forbade
  /streamed from disk/i and the corrective sentence says "the upload is NOT streamed
  from disk". A CHECK THAT READS A PHRASE WITHOUT READING ITS POLARITY reports a
  problem for the sentence that fixes it. It now pins the exact disproven claim and
  separately requires the real cost to be stated.
  (4) THE ROUND-25 MIRROR GATE FIRED ON THIS COMMIT BEFORE I DID — the second time
  it has caught work in a later round — and `scripts/sync-code-viewer.sh` re-synced
  the served copy (3 host redactions, as designed).
  (5) RELEASED 1.2.338 (the staged-leftover list) and 1.2.339 (these two contracts).
  CI and the release workflow green on both tags; keep-latest left ONE release and
  ONE tag; the dual-builder audit reported the STRONGER WARN verdict for the
  THIRTEENTH consecutive release. The DEVICE was five releases behind again this
  round — caught by looking, not by any gate.
  (6) AUDIT FINDINGS NOT ACTED ON, recorded with evidence. From the `system_*`
  audit: `mem_total_mb` is published and read by NOTHING (both real consumers take
  `mem_pct` only), so the number that would give the percentage meaning is unused;
  the console's stated reason for withholding `system_file_list`/`stat` ("the panel
  has the GUI") is FALSE — no file UI exists in panel-react, so an exposure
  decision rests on a false premise; `system_process_kill` by NAME is a silent
  no-op off Windows because the pgrep fallback sits INSIDE `if let Ok(o) = &r`,
  running only when taskkill RAN and failed (the pid branch's twin covers the spawn
  error), and its test names a path it never takes; the tray reports SYSTEM-wide
  CPU/memory with an "Agent running" label; bootstrap's quarantine narration goes to
  startup.log which `/api/logs` does not serve, so the reason for a mass 401 is
  unreadable from the Device-logs card; an EMPTY config.yaml takes the quarantine
  arm, finds no token, and silently rotates BOTH credentials — untested; and the
  Windows `tasklist` parser is not CSV-aware (`split(',')` against quoted fields
  with `"1,234 K"` memory), with no test on its own platform.
  (7) ALSO STILL OPEN from round 31: a backgrounded command's exit code lives only
  in an in-memory capped evicting map while the durable trail ends at
  `status: "backgrounded"`; the CLI's registry fallbacks differ from the agent's and
  `setup` discards the `reg add` status; the migration test's drive-letter fixtures;
  no Windows test job in CI.
  Gates: agent 582 default / 633 feat-gated (was 581/632), clippy -D warnings clean
  BOTH configs, fmt clean, xwin OK; gateway 764 + format; panel 491.

Previous round: 2026-09-11 round 32 (the console's commands were NEVER recorded,
though the module header claimed every command was — and the test that proved it
exposed a race across the whole test file). Commit: b61d7e4b, plus 1.2.337.
  (1) A TRUTH GAP IN THE GOVERNANCE RECORD ITSELF. `session_log.rs` opens by
  stating "Every terminal command on a device is recorded as an event stream". It
  was FALSE for the local branch — the one the CONSOLE takes, because the gateway
  never injects a session id. That path called `execute_local`, a logger-free
  executor, so a console command left NO durable trace: only a transient SSE frame
  with no retention, invisible to `/api/sessions` and to the archive. The sentence
  claiming otherwise is the only reason nobody looked.
  (2) THE FIX RECORDS IT IN THE SAME CORPUS, NOT A PARALLEL ONE. Commands without
  a session share ONE device-level stream (`LOCAL_SID = "device"`, labelled
  "console (no session)"), so they land under the same list route, the same archive
  page, the same close-time trim and the same 30-day retention. A second log would
  have been a second answer to "what ran on this device" — this repo's recorded
  defect — and would have needed its own retention decision.
  CLOSED WITH WHAT IS KNOWN AND NOTHING INVENTED: `execute_local` reports
  `{kind, text, truncated}` and no exit code, so none is recorded. A fabricated `0`
  would read as "succeeded" in every view that renders exit codes.
  (3) THE ANNOTATIONS NEEDED HOISTING, NOT COPYING. `intent`, `considered`,
  `plan_step` and `run_id` were extracted INSIDE the session branch, under a
  comment that says "a second extraction at the log site is how the two drift".
  Re-reading them in the other branch would have created exactly that drift, so the
  block now sits above the branch and both paths share one read.
  (4) AND THE TEST FOUND A LATENT RACE ACROSS THE WHOLE FILE — round 20's lesson,
  second site, identical tell (GREEN ALONE, RED IN THE SUITE). `seeded_tools()`
  built its log directory as `vale-sesslog-tools-{pid}` — per PROCESS — while
  `cargo test` runs the tests in PARALLEL THREADS of one process, and EVERY one of
  its 33 callers began by REMOVING that directory. So the tests were wiping each
  other's audit trail, and any test that wrote a record and read it back raced the
  rest. Each invocation now gets its own directory, and
  `seeded_tools_with_logger` hands the logger back so a test reads the trail it
  drove instead of guessing a path. Five consecutive full-suite runs green.
  (5) THE TEST DRIVES THE TOOL — no `session_id`, then reads the record back —
  because this repo has recorded three times that a test exercising the layer BELOW
  the one that was broken stays green while the bug lives on. Mutation-proven:
  removing the recording fails it on "a session-less command must leave a record".
  (6) ALSO CORRECTED: six doc paths that layout v2 MOVED and that still read
  `<install>/...` — the audit trail's own header (the very header whose claim this
  round made true), the memory store's, the playwright component's, the
  boxed-versions file's, and `filelog.rs`'s "next to the exe".
  (7) RELEASED 1.2.337. CI and the release workflow green on the tag; keep-latest
  left ONE release and ONE tag; the dual-builder audit reported the STRONGER WARN
  verdict for the TWELFTH consecutive release.
  (8) STILL OPEN from the round-31 audit, with evidence: the boot stale-cleanup
  probes PRE-V2 spellings while staging writes `components\...`, so a power cut
  leaves leftovers the NEXT swap applies (version skew under a new release marker),
  and it is the literal counterexample to the guide's "zero legacy-directory
  probing outside paths.rs"; a backgrounded command's exit code lives only in an
  in-memory capped evicting map while the durable trail ends at
  `status: "backgrounded"`; the CLI's registry fallbacks differ from the agent's
  and `setup` discards the `reg add` status; the migration test's fixtures are
  drive-letter based and NO test runs on Windows in CI.
  Gates: agent 520 default / 630 feat-gated (was 519/629 with the one new test),
  clippy -D warnings clean BOTH configs, fmt clean, xwin OK; gateway 764 + format.

Previous round: 2026-09-11 round 31 (a FRESH AUDIT of `paths.rs` — the foundation
module no round had ever opened — found the layout migration could NEVER finish on
a two-volume device and blamed a file lock for it; plus a backgrounded command the
operator was told had been interrupted). Commits: e7158bea, 68129b44, plus
1.2.335 and 1.2.336.
  (1) THE MIGRATION COULD NOT CROSS VOLUMES. `move_one` used `std::fs::rename`
  with no fallback, and `rename` is documented to fail across mount points. The
  migration moves the logs and `pwout` from InstallDir to DataDir — which on d1 are
  `D:\Vale` and `C:\ProgramData\Vale`, TWO VOLUMES — so every data-side move
  failed, the marker was never written, `migration_pending` stayed true FOREVER,
  and every boot announced "INCOMPLETE (pending moves locked?)".
  THE DIAGNOSIS WAS THE SECOND HALF OF THE DEFECT: nothing was locked, and the
  message sent a reader hunting a file lock that never existed. A message is a
  claim about the world; this one was false on every single boot. It now names the
  conditions that actually cause it.
  The fix is copy-then-remove on rename failure only, so a same-volume move keeps
  its atomicity. Two details are load-bearing: the source is left in place if the
  COPY fails (a half-copied tree that also deleted its origin loses data), and the
  move reports SUCCESS if the copy landed but the source could not be deleted —
  the leftover is a duplicate, not a loss, and retrying forever over an
  undeletable file would keep the device permanently "INCOMPLETE".
  THE TEST USES A REAL CROSS-DEVICE RENAME: `/tmp` is ext4 and `/dev/shm` is tmpfs
  here, so `rename` between them fails with EXDEV for the same reason it does on
  the device. It asserts that premise FIRST, so it would fail loudly rather than go
  vacuous if the two ever became one filesystem, then moves a FILE and a DIRECTORY
  TREE across the boundary. Mutation-proven: rename-only fails it on the file.
  LABELLED LIMIT: `cfg(target_os = "linux")` — it needs a second filesystem, and
  the fallback itself is platform-neutral.
  (2) TWO MORE IN THE COMMENT-CLAIMS-WHAT-THE-CODE-DOES-NOT FAMILY, now seven
  rounds running. `layout_marker_file()` had ZERO callers (its only reader was its
  own test) while `migration_notes` hardcoded the same path TWICE — the reason is
  legitimate (the migration takes its roots as ARGUMENTS so tests can pin the plan
  without the process-global cached dirs), which is why there are two functions and
  no reason for three copies of the literal. And `winmain.rs`'s half-swap recovery
  said it "runs from the BOOT task wrapper (which exists independently)": THERE IS
  NO WRAPPER — `self_heal` is called from inside this process and the boot task's
  Execute IS this exe, so the `!exe.exists()` branch cannot run in the situation it
  was written for. If a swap leaves no exe, nothing starts the agent and nothing
  repairs it. The branch is still worth keeping (it diagnoses a doubled-up state
  from `startup.log`), and the comment now says what it can and cannot do. CLOSING
  THE GAP NEEDS A LAUNCHER THAT IS NOT THE EXE; NOT DONE, deliberately — untested
  Windows-only boot recovery is worse than a documented absence.
  (3) A BACKGROUNDED COMMAND WAS REPORTED AS "INTERRUPTED", found by the same
  scout after its brief was complete. The card said "Backgrounded" while the STATE
  it fed was `warn`, and the path summary's word for `warn` is "interrupted" — so
  work still legitimately RUNNING was summarized as stopped, and `bad = fail +
  warn` lit the session's "bad" marker for a session nothing had gone wrong with.
  TWO PRE-EXISTING TESTS WERE PINNING THE DEFECT and that is the part worth
  keeping: one asserted the state list `[...,"warn","warn",...]` for a fixture
  whose third entry is a BACKGROUNDED command, the other asserted
  `reason: "backgrounded"` maps to `state: "warn"`. Both were green and both
  described the bug as the contract. A TEST THAT PINS A DEFECT IS WORSE THAN A
  MISSING ONE, because its green is taken as evidence the behaviour is intended.
  `bg` is now a distinct state, counted separately, ranked with `running`, excluded
  from `bad`, and rendered on its own neutral line. Adding it also exposed the
  state union being declared in THREE places; both components now use the shared
  `PathState`, so the next state is one edit.
  (4) THE ROUND'S OTHER FINDING IS THAT THE DEVICE WAS FIVE RELEASES BEHIND.
  `vale status` read 1.2.329 while the CDN served 1.2.334 — the delivery gap this
  log keeps recording, caught only by LOOKING. d1 is now on 1.2.334 (then 1.2.336),
  verified by effect: `found=True first_seq=34 events=26` (the trim disclosure) and
  `unfiltered=2 filtered_by_net=1` (round 29's tag filter — before that fix the
  second number would have been 2, the unfiltered result presented as filtered).
  (5) AUDIT FINDINGS NOT ACTED ON, recorded with their evidence so the next round
  does not re-derive them. The scout's TOP finding is a TRUTH GAP rather than a
  bug: session-less `terminal_execute` — the path the CONSOLE uses, since the relay
  never injects a session id — calls a logger-free `execute_local`, so
  `session_log.rs`'s "Every terminal command on a device is recorded as an event
  stream" is FALSE for that path, and `/api/sessions` can never show it. Also open:
  the boot stale-cleanup probes PRE-V2 spellings (`<install>\vale-playwright.new.zip`)
  while staging writes `components\...`, so a power cut leaves leftovers the NEXT
  swap applies (version skew under a new release marker) — and it is the literal
  counterexample to the guide's "zero legacy-directory probing outside paths.rs";
  a backgrounded command's exit code lives only in an in-memory capped evicting map
  while the durable trail ends at `status: "backgrounded"`; the CLI's registry
  fallbacks (`C:\Program Files\Vale`) differ from the agent's (exe dir) and `setup`
  discards the `reg add` status; the migration test's fixtures are drive-letter
  based and NO test runs on Windows in CI; and six modules still carry
  `<install>/...` doc paths that layout v2 moved.
  Gates: agent 578 default / 629 feat-gated, clippy -D warnings clean BOTH configs,
  fmt clean, xwin OK; gateway 764 + format; panel 491 (was 487) + build.

Previous round: 2026-09-11 round 30 (the trail dropped a run attribution the device
had ALREADY RECORDED — and a comment explained the loss away as a design choice).
Commit: 0bcb2798, plus 1.2.334.
  (1) `useOperationRuns.ts` OPENED BY STATING that `useCommandEvents` "reads ONE
  session's audit log (`/api/sessions/{sid}`), which carries no `run_id` at all".
  It does. `run_id` is written onto every `command/start` executed under a run
  (`SessionEvent.run_id`, set by `terminal_execute`, re-surfaced by
  `operation.rs`), and the route serves the event verbatim. What was missing was
  on the PANEL's side: `CommandEvent` never declared the field, so the trail
  reader discarded an attribution the device had recorded.
  (2) A STATED ABSENCE THAT IS NOT TRUE IS WORSE THAN AN UNKNOWN ONE, and this is
  the round's sharpest point. The comment did not merely describe the code
  wrongly — it made the loss look like a DESIGN DECISION ("that is why the strip
  polls separately"), so nobody went looking for a value already on the wire. The
  family this log has recorded for four rounds now has a third shape: not a
  capability that was never built, and not one broken at a call site, but one that
  EXISTED AND WAS DENIED IN PROSE.
  (3) THREE PARTS, EACH NECESSARY: the COMMENT now gives the real reason both
  sources exist (`/api/operation` is retained for a day and read-capped; the
  session trail is the 30-day record); `CommandEvent` DECLARES `run_id`, so the
  type describes the wire; and `lib/path.ts` DERIVES it while `PathView` renders
  it. Declaring a field nothing reads would have been its own defect — a value
  written but never consumed, which is on this log's list.
  (4) PRESENTED AS A CLAIM, AND IT GROUPS NOTHING. `run_id` is recorded verbatim
  and the device never verifies it; `runs.rs` pins "a LABEL, NEVER A CREDENTIAL"
  twice. The element's title says "the run the agent says this command belonged
  to", and NO grouping was added: real grouping lives in `lib/runs.ts` on the
  device-level timeline, and a second implementation here would be two reads of
  one fact — this repo's recorded defect, avoided rather than repeated. It earns
  its place because this trail is the 30-day record while the run strip's window
  is a day, so "which execution was this?" is answerable only from here once that
  window passes. A blank id is treated as ABSENT, matching the device's own rule.
  Mutation-proven: restoring the drop (`runId: null`) fails both the derivation
  test and the render test.
  (5) RELEASED 1.2.334. CI and the release workflow green on the tag; keep-latest
  left ONE release and ONE tag; the dual-builder audit reported the STRONGER WARN
  verdict for the TENTH consecutive release.
  (6) THE LOGGED BACKLOG IS NOW EMPTY. Every finding from the three delegated
  audits that produced rounds 24-30 has either been fixed or explicitly cleaned
  as a false positive, and the last one closed here. The next round should START
  FROM A FRESH AUDIT rather than from this list — a scout pointed at a subsystem
  no previous round has opened, with the standing instruction to prefer the
  recurring family (a statement the code does not honour) and to say what it could
  NOT verify rather than guessing.
  Gates: panel 487 (was 483) + build; agent 577 default / 631 feat-gated, clippy
  -D warnings clean BOTH configs, fmt clean, xwin OK; gateway 764 + format.

Previous round: 2026-09-11 round 29 (`memory_search`'s tag filter was a SILENT
NO-OP the panel's own comment recorded as fixed — and the mutation that did not
fail is the round's lesson). Commit: 76fc30c0, plus 1.2.333.
  (1) THE USER-VISIBLE DEFECT IS A WRONG ANSWER WEARING THE SHAPE OF A RIGHT ONE.
  `MemoryPage` has passed `params.tag` to `memory_search` since round 161, and its
  comment records that round as the fix ("the tag filter is now passed to SEARCH
  too"). The tool never DECLARED the parameter and the handler never READ it, so
  an operator who typed a tag got UNFILTERED results presented as filtered. The
  store could always do this — `list` has filtered by tag for longer; `search`
  simply had no way to be asked.
  (2) THREE THINGS WERE WRONG, EACH FIXED AT ITS OWN LAYER: `MemoryStore::search`
  gained the filter, using the SAME rule `list` uses (exact, case-insensitive, not
  a substring) so the two surfaces cannot disagree about what "tag = x" means — a
  test pins the exactness, because a substring rule returns plausible WRONG
  answers rather than none; the tool now DECLARES `tag`; and the handler reads and
  passes it. The query is a NAMED struct rather than a fourth positional argument
  because `namespace` and `tag` are both `Option<&str>` and adjacent — a swap
  filters on the wrong axis and looks plausible — which is the fourth time this
  repo has chosen a named shape over a tuple for that reason.
  (3) THE ROUND'S REAL LESSON IS A MUTATION THAT DID NOT FAIL. My first test
  called `MemoryStore::search` directly, and pinning the store looked sufficient —
  then I disabled the handler's read of `tag`, restoring the ORIGINAL defect
  verbatim, and it stayed GREEN. The helper was perfect; the bug was in how it was
  CALLED. That is rounds 18/19's lesson for the THIRD time in this log, and the
  tell is always the same: a test that exercises the layer BELOW the one that was
  broken. The wiring test invokes `memory_search`'s handler with
  `{"query": ..., "tag": "net"}` and asserts one hit; with the defect restored it
  returns BOTH records, printing exactly the unfiltered output an operator would
  have been shown. A second test pins the declaration, and both mutations bite.
  (4) `agent/spec-tools.json` IS REGENERATED, and the STALENESS GATE FIRED BEFORE
  I REMEMBERED — the snapshot's whole job is to make a parameter addition visible
  to the gateway contract, and it did. `memory_search` sits in the gateway's
  `NOT_EXPOSED` map ("device KB — panel surface"), so there is no console-parity
  obligation and the gateway suite is unchanged.
  (5) RELEASED 1.2.333. CI and the release workflow green on the tag; keep-latest
  left ONE release and ONE tag; the dual-builder audit reported the STRONGER WARN
  verdict for the NINTH consecutive release.
  (6) STILL OPEN, with evidence: `useOperationRuns.ts` claims the session route
  "carries no `run_id` at all" and it does (`SessionEvent.run_id`), so the panel's
  trail reader drops attribution already on the wire — the same shape as this
  round's defect, one layer up: a stated absence that is not true.
  Gates: agent 518 default / 628 feat-gated, clippy -D warnings clean BOTH
  configs, fmt clean, xwin OK; gateway 764 + format; panel 483 + build.

Previous round: 2026-09-11 round 28 (the crash-safety family FINISHED — four
readers and one append that never got the rule their foundation module claimed
they shared). Commit: 15477059, plus 1.2.332.
  (1) `jsonl.rs` OPENS BY CLAIMING "the crash-safety rules every append-only,
  line-oriented file in this crate shares" AND THEN NAMES TWO FILES. The audit
  trail and the memory store had the rules; the AI-evidence feed and the run log
  did not. A sentence describing a rule the code had not finished applying — this
  log's recurring family, this time in its own foundation module.
  (2) THE MECHANISM IS THE ONE THIS LOG KEEPS REDISCOVERING. `read_to_string`
  requires the WHOLE file to be valid UTF-8, and the tear a crash leaves — a
  multi-byte character cut in half — is invalid. So a strict read does not
  degrade, it rejects EVERY record in the file, intact ones included:
    * `evidence.rs`'s `recent_actions` returned an EMPTY feed, indistinguishable
      from "nothing has happened", while its own doc comment promised three lines
      above the call that a torn line "is SKIPPED rather than failing the whole
      feed" — the sentence described behaviour the code could not have;
    * `runs.rs`'s four readers (`known`, `recent`, `trim`, boot recovery) failed
      the same way, so `known` answered false for a run that IS recorded and the
      recovery arm closed nothing;
    * `evidence.rs`'s append had NO torn-tail repair, so a new record FUSED onto
      the fragment and the pair became one unparseable line — losing the record
      already there AND the one just written. Round 20 found exactly this in
      `runs.rs`; the feed never got the guard.
  (3) THE FIX PUTS THE RULE IN ONE PLACE. `jsonl::read_lossy` is the family's
  owner: bytes decoded lossily, so a damaged line becomes a line that does not
  PARSE — which every reader in the family already skips — instead of a file that
  cannot be read. The promotion rule satisfied honestly (several real consumers,
  an incident lesson, no environment coupling), and the header is now accurate
  because the family is. The evidence append repairs its tail before writing,
  guarded to non-empty files because `prepare_append` also writes a version
  header and this feed has none: `recent_actions` returns every parseable line, so
  a header would surface as a PHANTOM ACTION in the operator's timeline. There is
  a test for that too.
  (4) WHY THE EXISTING TEST COULD NOT SEE ANY OF IT — round 23's lesson again.
  `recent_actions_caps_and_skips_torn_lines` EXISTS and passes; it plants ASCII
  junk, which is VALID UTF-8 and merely unparseable. The covered behaviour was not
  the production one, and only a damaged BYTE tells the two apart. Every fix here
  is pinned by a test that plants a truncated multi-byte sequence, and all three
  are mutation-proven: disabling the tail repair fails with `["earlier"]` (the
  later record swallowed), restoring the strict read fails the feed test with
  `[]`, and restoring it in `runs.rs` fails with "the run IS recorded — one
  damaged byte must not deny it".
  (5) RELEASED 1.2.332. CI and the release workflow green on the tag; keep-latest
  left ONE release and ONE tag; the dual-builder audit reported the STRONGER WARN
  verdict for the EIGHTH consecutive release.
  (6) STILL OPEN, with evidence: `useOperationRuns.ts` claims the session route
  "carries no `run_id` at all" and it does (`SessionEvent.run_id`), so the panel's
  trail reader drops attribution already on the wire; and `memory_search`
  silently ignores `tag` while `MemoryPage.tsx` says round 161 fixed exactly that.
  Gates: agent 574 default / 625 feat-gated (was 570/621), clippy -D warnings
  clean BOTH configs, fmt clean, xwin OK.

Previous round: 2026-09-11 round 27 (the trim disclosure, told ONCE and told
correctly — and the live view that was structurally unable to tell it). Commit:
828f0ce2, plus 1.2.331.
  (1) MY ROUND-23 SENTENCE WAS FALSE BY AN ORDER OF MAGNITUDE, and a scout found
  it by reading the code rather than the log. The archive told the operator "the
  device keeps roughly the last 2000 lines of a closed session." That is NOT what
  `trim_file` does: it DRAINS EVERYTHING BEFORE THE LAST `command/start` — a
  session that ran commands keeps only its most recent one onward — and the
  2000-line cap applies only if that window is STILL over it. The code's own test
  asserts the drain (`!content.contains("first-cmd")`), and round 23's own d1
  evidence makes it concrete: `first_seq=34 events=26` is 33 events discarded and
  26 surviving, while the operator was told ~2000 lines were kept.
  (2) AND THE LIVE VIEW COULD NOT HAVE CORRECTED IT, because it was never given
  the fact. `useSessionEventsWithState` has returned `firstSeq` since round 23;
  the Archive disclosed the trim from it; and `App` built the command slice as
  `{ cards, events }` — dropping the field ONE LINE above the mounts — while
  `TrajectoryView`'s own comment stated the obligation ("the view must not present
  such a trail as complete") that the wiring made UNSATISFIABLE. That is a new
  entry in this log's family: not a comment that describes the code wrongly, but a
  comment that states a requirement the DATA FLOW cannot meet. It reads as
  handled, so nobody looks.
  The fix puts the notice in `TrajectoryView` and makes `firstSeq` a REQUIRED
  member of the `CommandEvents` slice, so every mount is covered by construction
  and a future one cannot forget. The Archive's DUPLICATE notice is deleted rather
  than kept: one implementation, one wording, no chance of the two drifting — this
  repo's own "two implementations of one read" defect, avoided rather than
  repeated.
  MAKING IT REQUIRED WAS THE POINT and it paid immediately: the type surfaced
  every producer and fixture that had been silently omitting the field, INCLUDING
  the `App` construction the scout had identified by reading. Absent still means
  "an older agent that does not report it", which is NOT "not trimmed", so the
  view claims nothing in that case instead of claiming completeness. Mutation-
  proven: disabling the notice fails BOTH the live-view and archive tests by name.
  (3) RELEASED 1.2.331. CI and the release workflow green on the tag; keep-latest
  left ONE release and ONE tag; the dual-builder audit reported the STRONGER WARN
  verdict for the SEVENTH consecutive release.
  (4) STILL OPEN from the same scout, with evidence, unchanged: `evidence.rs` and
  four `runs.rs` readers still `read_to_string` while `jsonl.rs`'s header claims
  "every append-only, line-oriented file in this crate shares" the crash-safety
  rules; `useOperationRuns.ts` claims the session route "carries no `run_id` at
  all" and it does, so the panel's trail reader drops the attribution already on
  the wire; and `memory_search` silently ignores `tag` while `MemoryPage.tsx`
  says round 161 fixed exactly that.
  Gates: panel 483 (was 481) + build; agent 570 default / 621 feat-gated, clippy
  -D warnings clean BOTH configs, fmt clean; gateway 764 + format.

Previous round: 2026-09-11 round 26 (`/api/logs` got its first consumer; then a
scout proved the console ships a browser tool family that CANNOT work — verified
against the bundle the device installs — and it was fixed on the LIVE worker).
Commits: 49563387 (logs) + da788294 (browser contract), plus 1.2.330.
  (1) `/api/logs` HAD ZERO CONSUMERS. Built so a remote client could see why the
  agent behaved oddly "without asking someone to open files (or guessing a path
  and cat-ing it over a PTY)" — then nothing read it (verified by grep across the
  panel, gateway, CLI and scripts). Same shape as `/api/sessions` before round 21.
  The concrete question it unblocks is the one the release docs answer with a
  four-way table: after `vale update` the connection ALWAYS drops for ~10s, and
  that drop is the DOCUMENTED signature of a successful swap, which makes it
  useless as evidence because a command that never arrived looks identical.
  `lib/updateDiagnosis.ts` is PURE (no fetch, no clock) and the tests assert the
  VERDICT, not the presence of lines, since each verdict drives a different
  operator action. Two distinctions it refuses to collapse: "launched" is not
  "replaced" (a swap whose `copy ok=false` leaves the old binary, and a summary
  stopping at "launched" reads as success), and an ABSENT log is `no-log`, NOT
  `never-arrived` (telling an operator their update was lost on a device that has
  never been updated is a worse failure than saying nothing). Presence is decided
  PER KIND, not by which line is last: a device whose earlier update used the CLI
  and whose latest used the Rust path has both, and ordering by index would
  report `cli-only` and hide that a swap ran.
  (2) BUILDING THE FAILED-READ TEST FOUND A REAL GAP IN MY OWN COMPONENT: it
  checked only the promise rejection, so a device answering `{ok:false}` fell
  through to `setLogs([])` and rendered EXACTLY like a healthy device that has
  written nothing — a claim about the device made from a response that refused to
  make it. Mutation-proven. HONEST NOTE: driving the failure through a rejected
  promise makes vitest attribute an "unhandled rejection" to the test even though
  the component catches it (the DOM proved the catch ran and a call-count
  assertion pinned one request); I could not attribute the harness report and
  would not suppress it, so the test drives the SAME branch through the
  `{ok:false}` path instead. I spent more calls on this than it deserved.
  (3) A SHIPPED CONSOLE TOOL FAMILY COULD NOT WORK, and a scout proved it by
  reading the bundle the agent INSTALLS rather than the repo. `browser_*` is the
  one family the gateway TRANSLATES rather than relays: `mcp-browser.ts` maps the
  name and forwards arguments VERBATIM. `browser_wait` advertised `condition` —
  **and marked it REQUIRED** — while the shipped `@playwright/mcp` 0.0.79 has no
  such parameter (`browser_wait_for` takes `time`/`text`/`textGone`, all
  optional), so the console's only required argument for that tool was one the
  server does not have and a schema-validating client could not have made a
  working call. `browser_screenshot` advertised `full_page` where the server
  declares `fullPage`, so a full-page request returned a viewport shot silently.
  Both fixed, and the description now says what the server does instead of
  promising a selector wait that does not exist.
  (4) WHY NOTHING CAUGHT IT — the round-25 lesson one level over. The
  parameter-name contract tests compare the gateway against the DEVICE
  (`spec-tools.json`), but these tools are bridge-routed and never reach the
  device's registry, so that axis does not cover them. `mcp-browser.test.mjs`
  pinned only `browser_open -> browser_navigate`; the other six mappings were
  pinned by NOTHING. And the round-25 mirror gate proves mirror == src and CANNOT
  see src == the server: A TEST ON A COPY CAN ONLY COMPARE COPIES.
  `browser-contract.test.mjs` compares the console against the BUNDLE — the third
  party in the contract — and pins all seven mappings against the tools the
  server actually defines.
  (5) A TEST PARSER THAT READS NOTHING REPORTS NO PROBLEMS. My first two
  extraction attempts (a lazy regex, then a brace walk) both returned EMPTY
  parameter sets for every tool while reporting they had found the tools — "no
  problems found" for everything they failed to read. The third uses a window
  between one tool's `name:` and the next and ASSERTS every window is
  substantial, so a change in the bundle's shape fails loudly instead of turning
  the suite into a no-op. Same failure mode as round 25's wrong-premise test, in
  a new costume.
  (6) THE ROUND-25 MIRROR GATE EARNED ITS KEEP IMMEDIATELY: it fired on this very
  commit and caught the two edited gateway files before I did — the first time in
  this log that a gate added in one round has caught work in the next.
  (7) RELEASED 1.2.330 and DEPLOYED the gateway. CI and the release workflow
  green on the tag; keep-latest left ONE release and ONE tag; the dual-builder
  audit reported the STRONGER WARN verdict for the SIXTH consecutive release.
  VERIFIED ON THE LIVE WORKER (not the repo): the served
  `/code/files/vale-gate/src/mcp-tools.ts` no longer contains the bogus
  `condition` parameter, carries the `text_gone` translation, and is BYTE-EQUAL
  to the repo mirror (same sha256) — the check round 24 lacked.
  (8) SCOUT FINDINGS NOT ACTED ON, with evidence, so the next round does not
  re-derive them. A1 is the sharpest and is MY OWN round-23 sentence being FALSE:
  `ArchivePage.tsx` tells the operator "the device keeps roughly the last 2000
  lines of a closed session", but `trim_file` DRAINS EVERYTHING BEFORE THE LAST
  `command/start` — the 2000-line cap only applies if that window is still over
  it (its own test asserts the drain: `!content.contains("first-cmd")`). Round
  23's own d1 evidence (`first_seq=34 events=26`) is 33 discarded, 26 surviving,
  operator told ~2000 were kept. Worse, `useSessionEventsWithState` DOES return
  `firstSeq` but `App.tsx` passes only `{cards, events}` to `TrajectoryView`, so
  the LIVE view is structurally silent about the trim while its own comment
  states the obligation. Also open: `useOperationRuns.ts` claims the session
  route "carries no `run_id` at all" and it does (`SessionEvent.run_id`), so the
  panel's trail reader drops the attribution that is already on the wire;
  `evidence.rs` and four `runs.rs` readers still `read_to_string` while
  `jsonl.rs`'s header claims "every append-only, line-oriented file in this crate
  shares" the crash-safety rules; and `memory_search` silently ignores `tag`
  while `MemoryPage.tsx` says round 161 fixed exactly that.
  (9) AND THE CONTRACT TEST I SHIPPED AN HOUR LATER FAILED IN CI, which is worth
  recording as the round's sharpest lesson because it is the SAME mistake in a new
  costume: it read `agent/deploy/vale-playwright.zip` directly, and that is a 31 MB
  BOXED ARTIFACT THAT IS NOT TRACKED BY GIT — so it passed here and had no input to
  read there. A green local run said the contract was checked. A check whose INPUT
  is not available where it RUNS reports success for work it never did. Fixed with
  the repo's own pattern: `gateway/playwright-tools.json` is a committed snapshot
  generated by `scripts/extract-playwright-tools.mjs`, naming its source version,
  exactly as `agent/spec-tools.json` does for the device inventory.
  IT TOOK FOUR PARSERS, each wrong in a different way, and the fourth explained the
  others: a lazy regex and a brace walk both returned EMPTY parameter sets for every
  tool while reporting they had found the tools; an indentation-bounded slice pulled
  `handle`/`result`/`isError` out of handler bodies. The reason is that
  `browser_take_screenshot` declares `inputSchema: screenshotSchema` — a NAMED
  REFERENCE that CHAINS (`screenshotSchema = optionalElementSchema.extend({...})`).
  A composition graph is not something a hand-rolled parser should chase, so the
  snapshot now stores RAW SCHEMA TEXT plus referenced definitions and the test reads
  the shipped bytes; the only thing left to get wrong is the window, and its size is
  asserted. The extractor fails loudly under 200 captured characters, because "read
  nothing, reported no problems" was the shared failure mode. Verified against seven
  known cases before being trusted.
  Gates: agent 570 default / 621 feat-gated, clippy -D warnings clean BOTH
  configs, fmt clean, xwin OK; gateway 764 (was 762) + format; panel 481 + build.

Previous round: 2026-09-11 round 25 (the console really did keep serving a
disproven claim — I checked the LIVE URL this time — plus the `required` axis,
off-plan visibility, and a format gate I skipped). Commits: 71aabe17, 5124e8aa,
plus 1.2.329.
  (1) MY ROUND-24 COMMIT MESSAGE WAS FALSE, and a scout caught it by FETCHING THE
  LIVE URL instead of reading the repo. Round 24 said "the console stops serving a
  disproven claim". What the console SERVES is a TRACKED SECOND COPY of the
  catalogue at `gateway/public/code/files/vale-gate/src/mcp-tools.ts`, and it still
  carried the sentence round 21 disproved. It was **13 commits behind, 10 files
  differed**, and NOTHING could see it: the mirror is refreshed only inside
  `scripts/build.sh` at deploy time, `check-live-parity.sh` compares LIVE against
  the MIRROR (never mirror against `src`), and CI runs `wrangler deploy --dry-run`
  while no test mentioned `code/files` at all. A direct `wrangler deploy` — which
  the docs ALSO prescribe — refreshes the worker and leaves the served source
  stale, and the repo could not tell those two states apart. THAT
  INDISTINGUISHABILITY IS THE DEFECT, more than the stale bytes.
  (2) AND ROUND 24'S TEST HAD A WRONG PREMISE — this log's most-repeated finding
  class. It asserted a property of `src/` while the claim was about the CONSOLE: a
  test on the source cannot see a stale copy of the source. `code-viewer-mirror`
  now compares the two and was RED when written, naming all ten files. It APPLIES
  THE SCRIPT'S OWN RULES rather than restating them — the mirror is deliberately
  NOT byte-identical (three files have the production host redacted, fail-loudly
  counted), so the test parses the `redact` lines out of `sync-code-viewer.sh` and
  applies them itself. One source of truth for the rules; a changed rule cannot
  silently leave the test checking the wrong thing.
  (3) I ALMOST REPEATED THE ERROR ONE LEVEL UP. After committing the fix I checked
  the LIVE URL: it STILL served the old sentence, because fixing the repo mirror is
  not deploying it. I ran the deploy and re-verified: the live copy is now
  byte-equal to the repo mirror (same sha256 prefix), carries the 1 MiB cap, and
  has RUNS_TOOLS it never had. The one surviving occurrence of the phrase is the
  explanatory COMMENT, confirmed by checking it is a `//` line and not a served
  string — a grep count alone would have read as a failure.
  (4) THE `required` AXIS IS NOW CONTRACT-CHECKED, closing the hole that let the
  drift through. `spec-tools.json` carried parameter NAMES only, so nothing
  compared the arrays; it now carries `required` and a gateway test compares it in
  BOTH directions (a required parameter the device does not require discourages a
  valid call; a missing one turns a schema error into a runtime rejection). RED
  when written, naming three real drifts: the console required `session_id` for
  `terminal_execute` where the device makes it optional and has a whole non-session
  branch — so a schema-validating client was FORBIDDEN a call the device supports —
  and the DEVICE's own `terminal_resize` declared `rows`/`cols` required while its
  handler had always defaulted them to 24x80. Both fixed, defaults now stated in
  the schema, and VERIFIED ON d1: `resize required=session_id`,
  `execute required=command`.
  (5) TWO MORE FALSE DESCRIPTIONS, and the direction REVERSES between them, which
  is why each is read rather than assumed. The DEVICE told AI clients `secret_set`
  stores "in the OS keychain ... Desktop only": it is a file-backed store with a
  keychain attempt first, and there has been no desktop build since the Tauri shell
  was retired (round-330). The harm chain is labelled rather than measured — a
  model that believes storage is desktop-only inlines a plaintext SSH password into
  a command, and the audit corpus keeps full command text. Meanwhile the GATEWAY's
  `terminal_history` said "closed sessions" only, contradicting its own `limit`
  parameter three lines below and the device; for that one the hand-copied twin was
  the WRONG one and the device was right.
  (6) `plan_step` CLAIMS THE PLAN CANNOT HOLD ARE NO LONGER DROPPED. `plan_step` is
  recorded verbatim — the device does not validate it — so a plan revised from five
  steps to three leaves earlier claims pointing past the end. `PathView` counted
  only `planStep === n` over the DECLARED steps, putting those in no bucket at all
  while its own comment promised to surface "work that was never announced". They
  get their own line rather than being folded into a numbered step: attributing one
  to step 3 would invent a fact about which step the command served.
  (7) I SKIPPED A GATE CI RUNS, AND CI SAID SO. The gateway has a prettier gate
  (`npm run format:check`); I never ran it, so CI failed on `gateway (test +
  typecheck + lint + format)` → Format while every local suite was green. That is
  the shape of "gates I did not run", not "gates that passed", and the per-subproject
  gate list in this repo's convention section is the checklist that would have
  caught it. Prettier's only change was quote style; the tag was re-pointed at the
  CI-green commit so the release workflow gates on it, and the CDN artifact was
  unaffected because `gateway/src` is not part of the agent tgz.
  (8) RELEASED 1.2.329. CI and the release workflow green on the tag; keep-latest
  left ONE release and ONE tag; the dual-builder audit reported the STRONGER WARN
  verdict for the FIFTH consecutive release. Verified on d1 by effect: `release:
  1.2.329` and both `required` arrays answering correctly.
  (9) SCOUT FINDINGS NOT ACTED ON: `mcp-browser.ts`'s timeout clamp is justified by
  a parameter no bridge-routed tool advertises (`browser_run_script` is
  device-direct), so the 300 s clamp is unreachable and the comment's reasoning
  rests on an argument that cannot arrive — same rot, no behavioural consequence
  established. The scout also swept ALL shared tools so the gap is closed: the
  remainder is OMISSION (the execute state machine, the 120/600 browser timeout,
  the diag cap 200), not falsehood, and it rejected its own candidate #7 (a
  write-time bound on a LIVE session file rewrites a file a live writer holds open —
  the round-11/116 defect class) with that reason.
  Gates: agent 570 default / 621 feat-gated, clippy -D warnings clean BOTH configs,
  fmt clean, xwin OK; gateway 762 (was 761) + format; panel 468 (was 467) + build.

Previous round: 2026-09-11 round 24 (a damaged byte stopped erasing records, the
console stopped serving a claim round 21 disproved, and a recorded session can
now say what it was — then RELEASED). Commit: ddfc4301, plus 1.2.328.
  (1) THE ROUND'S SHAPE, and it is now the dominant one: a delegated audit of the
  DURABLE-RECORD READ LAYER — chosen because rounds 20-23 each fixed ONE reader in
  isolation and nobody had audited the family's policy — found FOUR defects, and
  THREE were survivors of my own recent work. The scout's account of why it picked
  that subsystem is the reusable part: "the reader round 23 repaired sits next to
  the one it left strict."
  (2) ONE DAMAGED BYTE ERASED A RECORD FROM THREE CALLERS. Round 23 taught the
  LIST to read bytes and decode lossily, and the log states that property
  generally. It was NOT general: `read_events` — a different function — still did
  `read_to_string`, so a single invalid byte made the whole file unreadable to
  three callers that are not the list:
    * `events_of` -> `/api/sessions/{sid}` answered `found:false` for a session
      that demonstrably exists: the route told the operator "no record" about a
      record it was holding;
    * `recover_interrupted` skipped the file, so an interrupted command NEVER got
      its `interrupted`/`abandoned` arm — round 18's silent governance loss, back
      through a different door;
    * `max_seq_on_disk` returned 0, so after a restart the shared counter re-seeded
      at 0 and re-issued `seq` values already on disk — round 22's collision,
      re-reachable through the file round 23 proved reachable.
  A crash mid-write of a multi-byte character leaves exactly a truncated sequence,
  and `memory/store.rs` already documented that mechanism for its own reader. Fixed
  by decoding lossily, which makes the function's EXISTING skip-the-junk-line
  policy actually reachable. THE LESSON: fixing one reader does not fix the family,
  and a property stated in this log must be checked against every reader that
  claims it — AGENTS.md said "a damaged region cannot erase a healthy file" while
  three readers still did the opposite.
  (3) THE GATEWAY SERVED A CLAIM ROUND 21 DISPROVED. `mcp-tools.ts` hand-copies
  each tool's prose, and `terminal_read` still promised "`offset: 0` re-reads from
  the beginning" — the exact sentence round 21's commit is TITLED on, corrected on
  the device while this copy kept reaching every console client verbatim.
  Invisible to the contract test because it compares parameter NAMES only
  (`spec-tools.json` is generated "names only, no types" by design). Fixed, and the
  FACT is now pinned: a test asserts the disproven sentence is ABSENT and the 1 MiB
  cap is PRESENT. Descriptions are deliberately re-worded for the console, so a
  text-equality test would rot; pinning the fact rather than the prose is the
  distinction that makes it durable.
  (4) ROUND 23'S OWN TWO FALSEHOODS HAD SURVIVORS — the same shape as the one
  round 23 caught in round 21, now confirmed as a PATTERN rather than an incident.
  `web/mod.rs` still documented the route as "full audit events for one session",
  and `ArchivePage.tsx` promised an operator that a session "opens here with its
  full audit trail" while the note the SAME PAGE prints for a trimmed trail says
  earlier events are not recorded. Both strings were in the shipped 1.2.327 bundle.
  (5) SESSION IDENTITY IN THE DURABLE RECORD. A recorded session was an opaque
  `term-<hex>-<n>`: `kind` and `target` sat unused in scope at the `opened` call
  site, the live kind/label die with the process, and d1's archive held 620 rows
  that could not be told apart after a restart. `kind` and the operator-facing
  `label` now ride the session's version HEADER — one line — so the list route
  answers without reading a trail that can be megabytes, the same economy the tail
  fold uses. The raw `target` is deliberately NOT recorded: it can carry a port and
  connection options the label drops, and that privacy judgment is STATED in the
  code rather than made by omission (the corpus already holds full command text and
  output). A record written before this OMITS the keys, so a consumer can tell "the
  device does not know" from a real value. VERIFIED ON d1: `term-651eb2-0 kind=pty
  label=PowerShell`, and exactly **1 of 622 rows named** — the honest limit, since
  the other 621 predate the field and will stay anonymous.
  (6) TWO METHOD NOTES. First: I proved the helpers with real round-trip tests, then
  REMOVED THE CALL SITE and watched BOTH TESTS STILL PASS — rounds 18/19's "the
  helpers were perfect; the bug was in how they were CALLED", biting again. The
  wiring is now pinned STRUCTURALLY (the open path needs a real backend, so no
  behavioural test can reach it), and the pin fails on both the missing call and the
  wrong ORDER, with a message explaining why before/after matters. Second: my own
  restore from a pre-mutation backup silently wiped a test module I had just added —
  A RESTORE CAN UNDO MORE THAN THE MUTATION, and the only reason I caught it was
  that the test count did not move. Copy the backup AFTER the test is in place.
  (7) RELEASED 1.2.328. CI and the release workflow green on the tag; keep-latest
  left ONE release and ONE tag; the dual-builder audit reported the STRONGER WARN
  verdict for the FOURTH consecutive release. Verified on d1 by effect: `release:
  1.2.328`, receipt `update requested 1.2.327 -> 1.2.328`, and session identity
  answering on a real session.
  (8) SCOUT FINDINGS NOT ACTED ON, with evidence: `required` drift on the axis the
  contract test cannot see (gateway `terminal_execute` requires
  `["session_id","input"]` where the device requires `["command"]` and explicitly
  calls session_id optional, and the relay never injects one — so a
  schema-validating client is forbidden a call the device supports;
  `terminal_resize`'s own `required` contradicts its handler's defaults); and
  `plan_step` is accepted verbatim and never checked against the declared plan, so a
  claim of step 5 against a 3-step plan renders on the Activity row and NOWHERE in
  the plan view, while `PathView`'s comment claims the comparison is complete. Also
  recorded: the scout CLEANED its own false lead (it chased "`last_event_of`'s 4 KiB
  premise is wrong" and proved the premise holds, because plan/goal/command/output
  are all capped) and refused three directions for stated reasons, including
  cross-session search — "the exact cost round 23 just paid a round to remove".
  Gates: agent 570 default / 621 feat-gated, clippy -D warnings clean BOTH configs,
  fmt clean, xwin OK; gateway 760 (was 759); panel 467 + build.

Previous round: 2026-09-11 round 23 (a trimmed trail says where it begins, and the
session list stopped reading twenty megabytes — MEASURED, then RELEASED).
Commits: ccc960e0, plus 1.2.327.
  (1) A TRIMMED TRAIL NOW SAYS SO. A closed session's file is trimmed to ~2000
  lines (round-98/99: a serial console scrolling for hours grew an unbounded
  `.jsonl` on the install disk), and the reader returned the SURVIVORS with no
  indication that anything was dropped — so a consumer could not tell a short
  session from a long one whose head was discarded, and the panel's own comment
  claimed `/api/sessions/{sid}` "returns the FULL audit log" while it does not.
  `events_of` now returns a `SessionRecord { events, found, first_seq }`; a
  struct rather than a tuple because the three fields answer three different
  questions and two are easy to transpose when positional (clippy already
  rejected an anonymous 7-tuple in this crate for the same reason). PROVEN ON A
  REAL TRIMMED SESSION on d1: `found=True first_seq=34 events=26` — events 1-33
  are gone, and before this round the panel drew those 26 as the whole trail.
  (2) TWO FALSEHOODS, AND THE SECOND IS THE INSTRUCTIVE ONE. I corrected
  `TrajectoryView.tsx`'s "returns the FULL audit log" comment, and in the SAME
  edit added a comment above ArchivePage's empty-record line noting the old
  wording was "made untrue" by round 10's `found` flag — WHILE LEAVING THE
  UNTRUE SENTENCE SHIPPING TWO LINES BELOW IT. A DELEGATED SCOUT CAUGHT IT, and
  its reasoning is the part worth keeping: the branch is reachable only with
  `found:true`, so both clauses were false. A comment that names a lie and
  leaves it in place is worse than no comment, because it reads as having
  handled it. That is a new failure mode for this log's "comment claims what the
  code does not do" family: the comment was TRUE about the code and still wrong,
  because the fix it described had not been made.
  (3) THE SESSION LIST READ EVERY FILE END TO END, AND I MEASURED BEFORE
  FIXING. A scout flagged the route as a cost concern and CORRECTLY REFUSED to
  rank it without a number ("I could not read d1's disk in this session, so it is
  premature"). So the number came first: **618 files, 21.01 MB total, 10.09 MB in
  the SINGLE largest file, `/api/sessions` 300 ms** — the route read ten
  megabytes to look at one line, on the async worker thread (`web/mod.rs` has no
  `spawn_blocking` on this path), on a route the panel refetches on every
  `sessions-changed` push and on focus. A LIVE session's file is never trimmed
  (trim happens at close), so the worst file grows unbounded between closes.
  `last_event_of` reads a 64 KiB tail and walks back to the last line that
  parses. AFTER, ON THE SAME DEVICE, WITH MORE SESSIONS: **620 rows, 101 ms** —
  3.3x, measured before and after rather than asserted.
  (4) BUILDING THAT TEST FOUND A SECOND, UNRELATED DEFECT. `read_events` does
  `read_to_string`, which requires the WHOLE file to be valid UTF-8 — so ONE
  damaged byte anywhere made `terminal_state_of` return `None` and the session
  VANISH FROM THE LIST entirely, permanently, because nothing rewrites the file.
  A crash mid-write of a multi-byte character leaves exactly that. The new reader
  takes bytes and decodes lossily, so a damaged region cannot erase a healthy
  file.
  (5) AND THE TEST ITSELF IS THE ROUND'S METHOD LESSON. My first version asserted
  the right ROW and PASSED against the old whole-file reader — a behaviour test
  cannot see "it reads too much", and it cannot see a robustness property that
  the old code happens to satisfy on intact input. The discriminator is invalid
  UTF-8 in a file's HEAD whose tail is healthy: the whole-file read fails and
  loses the session; a tail read never looks at it. Both halves are
  mutation-proven — restoring the whole-file read fails on the UTF-8 assertion,
  removing the walk-back fails on the torn tail.
  (6) RELEASED 1.2.327. CI and the release workflow green on the tag;
  keep-latest left ONE release and ONE tag; the dual-builder audit reported the
  STRONGER **WARN** verdict for the third consecutive release (every
  source-derived file matches INCLUDING the exe; only container bytes differ).
  Verified on d1 by effect: `release: 1.2.327`, receipt `update requested 1.2.326
  -> 1.2.327`, the route at 101 ms, and `first_seq` answering a real trimmed
  session.
  (7) SCOUT FINDINGS NOT ACTED ON, recorded with their evidence so the next
  round does not re-derive them: the durable record cannot say what a session WAS
  (`sessions.rs` logs `log_status(&id,"opened")` with no kind/target/label;
  `/api/sessions` answers `{id,state}` only, so the 617 rows are opaque ids after
  a reload — the version header already carries caller-supplied JSON and `age_of`
  already reads its first line, so the plumbing exists; the open question is
  whether an ssh `target` belongs on disk for 30 days). The scout also CLEANED
  four candidate defects as false positives (`operation.rs` dropping `reason`/`ts`
  has no consumer; `timed_out` IS carried; the operation feed's ts_ms ordering
  cannot invert on the kinds it includes; the panel's null-ts arms are
  unreachable but harmless), which is worth as much as a finding.
  Gates: agent 566 default / 617 feat-gated, clippy -D warnings clean BOTH
  configs, fmt clean, xwin OK; panel 467 + build.

Previous round: 2026-09-11 round 22 (one seq counter, a reader that orders by it,
and a flake carried since round 11 finally killed — then RELEASED). Commit:
6fa4313f, plus 1.2.326.
  (1) `seq` WAS NOT UNIQUE, AND CONSUMERS DEPEND ON IT. The counter was
  per-INSTANCE (`SessionLogger::new` built a fresh map, seeded from disk only on
  first use), so a long-lived logger's counter went stale the moment any other
  instance wrote:
      plugin: start    -> seq 1, counter now 1                   (disk: 1)
      web:    asked    -> fresh logger seeds disk (1) -> seq 2   (disk: 1,2)
      plugin: approved -> its counter is 1, so it hands out 2    <-- DUPLICATE
  DETERMINISTIC, not racy: `sessions_logger()` builds a logger per web call, so
  a gate question arriving after a command starts is enough to hit it.
  Reproduced as `[1, 2, 2]`, then on d1 as an out-of-order file (below). The
  panel keeps `seq` as its "nothing new" watermark AND as a React key, so a
  repeat is a dropped event and a duplicated row at once.
  Fixed with ONE process-global counter keyed by dir+sid — the POSITIVE form of
  the `JobsMap` lesson: that incident was two maps where there should have been
  one, and a global whose whole job is to BE the one map cannot repeat it.
  THE EXISTING UNIQUENESS TEST DID NOT CATCH THIS, and why is the useful part:
  it ends every command first, and `log_command_end` FLUSHES, so each new logger
  seeded from a disk that was already current. It passed for a reason that had
  nothing to do with the invariant it names. My first replacement test was ALSO
  wrong — I assumed the collision needed an unflushed write, measured the disk,
  found `command/start` flushes, and only then found the real sequence (a STALE
  counter, not a stale disk).
  (2) THE READER RETURNED FLUSH ORDER, NOT `seq` ORDER — found by driving the
  real binary rather than by reading. Two instances write the same file with
  INDEPENDENT buffers, so events interleave on disk in the order they flushed.
  On d1 the trail read `1, 2, 4, 5, 6, 3, 7, …`: seq 3 was a buffered `output`
  that landed six events late, because the plugin's persistent `BufWriter`
  flushes only at command boundaries (round-58) while a web write flushes
  immediately. `read_events` returned that order verbatim, and an event numbered
  BELOW the watermark is treated as already seen — the panel would silently drop
  it. Fixed by sorting stably on `seq` at READ: the write order across
  independent buffers is not something the writer can control without
  serialising every append, and the reader is where the ordering promise is
  consumed. Pinned by `reading_a_session_orders_by_seq_not_by_flush_time`, which
  failed with the device's own `[1, 2, 4, 3]`.
  BOTH halves are mutation-proven: reverting the counter to per-instance fails
  with `[1, 2, 2]`; removing the read sort fails with `[1, 2, 4, 3]`.
  (3) A FLAKE CARRIED IN THIS LOG SINCE ROUND 11 IS ADDRESSED. It was recorded
  for ten rounds as "left for its own", and this round it cost a real diagnostic
  cycle: a red run whose test NAME I had not captured. Cause: closing a listening
  socket is not instantaneous with respect to a concurrent `connect()`, so
  sampling ONCE straight after `drop(listener)` failed roughly one full run in
  six. The post-drop assertion now polls with a 5s budget.
  HONEST LIMIT, stated rather than glossed: I could not isolate a mutation that
  reaches the POLLED assertion alone. Making the probe unconditionally healthy
  trips the test's FIRST assertion; keeping the listener bound trips the probe's
  own behaviour under repeated connections (the backlog fills, connects then time
  out, and it reports unhealthy for a different reason — it passed in 5.37s,
  which at least proves the loop runs its full budget). Observed rate went
  ~1-in-6 -> 1-in-10 -> 0-in-12, and I did not capture that one failure's
  identity, so the claim is that the IDENTIFIED mechanism is fixed, not that the
  test can no longer fail.
  (4) RELEASED 1.2.326, carrying rounds 21 AND 22 — two rounds of agent + panel
  work that were on no device, which is the gap this log has recorded before.
  CI and the release workflow green on the tag; keep-latest left ONE release and
  ONE tag; the last-5 window still holds 1.2.322-326.
  VERIFIED ON d1 BY EFFECT, feature by feature: `release: 1.2.326` with the
  receipt reading `update requested 1.2.325 -> 1.2.326`; the memory meter answers
  `memory_entries=6 memory_bytes=230 cap=10000`; `/api/sessions/<missing>` answers
  `found=False ok=True` (the API says "no record" instead of implying "recorded
  nothing"); and `/api/sessions` returns **617 sessions** — the corpus the new
  Archive page reads.
  (5) THE DUAL-BUILDER AUDIT REPORTED **WARN** AGAIN, and per round 20 that is
  the STRONGER verdict: the OK path tolerates a differing `vale-agent.exe`, while
  WARN is reached only when EVERY source-derived file matches INCLUDING the exe.
  Two consecutive releases have now converged this way, so the byte-identity goal
  step 6 of the release docs exists to reach appears to be holding rather than
  being a one-off.
  (6) STILL OPEN from round 21's audit, deliberately not fixed here: the
  audit corpus' close-time trim to 2000 lines is invisible to
  `/api/sessions/{sid}` (and the panel's own comment claims it "returns the FULL
  audit log"); a LIVE session file has no write-time bound on event COUNT while
  each refetch re-reads the whole file; and `terminal_history` can list one
  session twice in a narrow window. Each needs its own evidence.
  Gates: agent 564 default / 615 feat-gated, clippy -D warnings clean BOTH
  configs, fmt clean, xwin OK; panel 465 + build.

Previous round: 2026-09-11 round 21 (the archive the corpus never had, a silent
  session that read as a dead one, and an API that could not say "no record").
  Commits: e4e389aa + 29698045 (the meter and the silent session), bde07b0f (the
  archive + the `found` flag), fdfda96f (the false read claim).
  (1) THE DURABLE AUDIT CORPUS HAD NO READER. `GET /api/sessions` returns every
  session file the device holds — 30 days of governance evidence, surviving
  restarts — and had NO consumer anywhere in the repo (verified by grep, not
  assumed). The panel built its list from `terminal_list`, which is LIVE-only, so
  a closed tab was an inert no-op while its tooltip promised history no view
  could show, and after a reload or restart past sessions were unreachable
  entirely. A read-only Archive page now lists what the device RECORDED, paged,
  opening each session through the EXISTING reader and the EXISTING trajectory
  renderer — no second timeline, no new route, 465 panel tests (was 416) with
  all four requirements mutation-proven by the delegated agent.
  (2) A SILENT SESSION READ AS A DEAD ONE. `terminal_read` answered
  `evicted: true` for a LIVE session that had produced no output yet. The marker
  exists so a client can tell "no data" from "gone" — its own comment says so —
  but the live buffer entry is created LAZILY by the drainer on the first frame,
  so a session with no output has neither a live nor a history entry and fell
  through to the gone-marker. EVERY session is in that state from `terminal_open`
  until its first chunk, and a silent one (a serial line waiting for a device)
  stays there indefinitely. The cost is the failure mode this repo has ALREADY
  RECORDED: an AI that believes `evicted` reopens the session it is holding (d1:
  321 idle partials against 167 terminal_opens). It now asks the MANAGER — the
  only thing that knows whether a session is alive — instead of inferring
  liveness from the presence of buffered bytes. PROVEN ON THE REAL BINARY: a
  fresh session answers `{text:"",start:0,end:0}` with NO evicted flag while
  `terminal_list` still lists it, and a session that never existed STILL answers
  `evicted:true`, so the marker keeps the power it was built for.
  (3) THE API COULD NOT SAY "NO RECORD" — and the panel agent found it, correctly
  refused to paper over it, and said so. `api_session_events` collapsed
  `read_events`'s `Option` with `unwrap_or_default()`, so a session whose file is
  gone answered exactly like one that recorded nothing: `200 {events:[]}`. The
  archive's "unreadable" requirement was therefore satisfiable only as a hedge.
  `events_of` now returns `(events, found)`; `ok` stays true in both cases (the
  REQUEST succeeded — what differs is whether a record exists). `found` is
  authoritative only when PRESENT, because an older agent omits it and treating a
  missing field as unreadable would make every older device look broken; there is
  a test for that too.
  (4) THE MEMORY METER, and my own test being wrong is the instructive part.
  `/api/settings` reported the caps and no usage, so a limit could be lowered
  below the current contents — after which the device silently evicts the OLDEST
  knowledge — with nothing able to show it from the UI. Shipping the meter BEFORE
  round 20's ledger fix would have published a number that was wrong after any
  edit or delete, so the order mattered and is recorded in the code. Then MY test
  asserted an absolute `0` for an "empty store" and failed on a leftover 1 entry
  / 16 bytes: `AppState::new` builds its store on `default_memory_dir()`, a
  PROCESS-GLOBAL path, so every web test in that binary shares one store. Same
  trap round 20 hit from the other side. Fixed by measuring DELTAS and by making
  the record ids carry pid+clock — a fixed id would make `insert` an UPDATE and
  move the count by 1 instead of 2, which it also did before I caught it.
  (5) AN AUDIT FOUND A FALSE CLAIM IN THE READ PATH, and it is the class this log
  keeps recording: the tool description said "`offset: 0` re-reads from the
  beginning" and an inline comment said the stream "reads continuously from any
  absolute offset". Both are FALSE past 1 MiB of spill — `read_spill` caps one
  read at 1 MiB and returns the window's TAIL, so the head is unreachable by ANY
  offset. The cap is deliberate (round 110's OOM fix) and is NOT changed; the
  claim is. The round-111 note that made `start` report the true start is kept
  and made precise: it makes the gap VISIBLE, it does not make the head
  reachable. Pinned by a test at PRODUCTION SIZE (1.5 MiB) — every existing spill
  test used <=100 bytes, so the covered behaviour was not the production one.
  (6) THE AUDIT'S REMAINING FINDINGS ARE RECORDED, NOT FIXED, and each needs its
  own round and its own evidence: `terminal_history` can list one session twice
  in a narrow window (live/0 then closed/N) and `terminal_read` can serve a sid
  history never lists; the audit corpus' close-time trim to 2000 lines is
  invisible to `/api/sessions/{sid}` (the panel's own comment claims it "returns
  the FULL audit log"), and a live file has no write-time bound on event COUNT
  while each refetch re-reads the whole file; `seq` is not unique because the
  counter is per-instance and every web call builds a fresh logger that re-seeds
  from disk, while consumers use it as a React key and a watermark. The audit
  also CLEANED the question this log cares most about — whether any other caller
  trims/renames a session file under a live writer (round 11's defect): no,
  `trim_file` has exactly one caller and it flushes its own handle first.
  Gates: agent 562 default / 613 feat-gated, clippy -D warnings clean BOTH
  configs, fmt clean, xwin OK; panel 465 + build.

Previous round: 2026-09-11 round 20 (the memory ledger that never moved, the run
  family's turn, and two flakes killed at the cause). Commits: 5bd73924 (ledger),
  9ff2d5d3 (abandoned runs), 6a7bbd29 + e1521114 (release 1.2.325), 1ecf7db7
  (the two flakes).
  (1) THE MEMORY BYTE LEDGER MOVED FOR SOME WRITES ONLY. `total_bytes` is what
  `enforce_limits` reads for `max_bytes`. `insert()` maintained it and `load()`
  recomputed it; `update()` did NEITHER — and `update()` is the path every EDIT
  and every SOFT-DELETE takes (`delete()` delegates to it). So an edit that grew
  content UNDERCOUNTED (the cap silently stopped being enforced) and a soft-delete
  kept counting removed content so the ledger OVERCOUNTED and enforce evicted LIVE
  records for a phantom — the "premature eviction" a load-time comment claims was
  already fixed. Fixed with `ledger_adjust(guard, prev, next)`, which states the
  invariant once (ledger = sum of content over records where !deleted) and which
  all three write paths now call. Not "remember to update it here too" — the
  chance to forget is gone.
  WHY IT SURVIVED: the only test naming the ledger DROPS AND REOPENS the store,
  and the reopen recomputes it — its own comment says "total recomputed on load".
  The in-process ledger was asserted nowhere, and no production reader existed to
  notice.
  (2) THE RUN FAMILY GOT ITS RECOVERY ARM. `runs::end` has exactly ONE caller (the
  `run_end` tool), so a run killed mid-flight by the watchdog, a crash or an
  update (which kills the agent BY DESIGN) stayed "open" forever. This is round
  18's approval loss in the sibling event family, and it belongs at BOOT because
  that is the one moment that can tell "nobody said" apart from "still going".
  Idempotent by construction — round 18's own lesson. THE PAYOFF WAS IMMEDIATE ON
  d1: the first boot after the release closed **two real orphaned runs**, one of
  them the run minted in ROUND 15 for the release smoke test. They had been
  reading as live for days.
  (3) IT ALSO FOUND A SECOND, PRE-EXISTING DEFECT. `runs.rs` was the ONE
  append-only log in this crate that never repaired a torn tail: `session_log` and
  the memory store have called `jsonl::prepare_append` since round 111; runs.rs did
  not. A crash mid-write leaves a fragment with no newline, the next append FUSES
  onto it, and two records become one unparseable line — both vanish. My own test
  surfaced it (it closed an orphan and then could not read the closure back).
  Fixed with `has_torn_tail` — repair ONLY, no version header, because `recent`
  returns every parseable line and a header would surface as a phantom entry to
  /api/operation (verified: adding one failed four existing tests).
  (4) TWO FLAKES, BOTH "GREEN ALONE, RED UNDER LOAD", BOTH FIXED AT THE CAUSE.
  (a) MINE: the new eviction test reused the temp dir `vale-mem-evict-{pid}` that
  `eviction_tombstones_persist_across_restart` already owned. Tests run in
  PARALLEL THREADS of one process, so the two stores shared a file and one's
  `remove_dir_all` wiped the other's records — the ledger read 18 where 16 was
  written. The tell was the "2 extra bytes": my other new test writes content
  "ab", and 18 = 16 + that stranger. (b) PRE-EXISTING, and the one that ACTUALLY
  BROKE CI: `force_signal_kills_the_whole_group_not_just_the_shell` SAMPLED
  `kill -0 -PGID` once, and `kill -0` succeeds on a ZOMBIE until the reaper runs;
  on a loaded runner that lag is enough. The probe now POLLS for 5s — which does
  NOT weaken it, proven by mutation: reintroducing the round-55 bug (kill the
  direct pid, not the group) still fails it after the full 5s.
  (5) RELEASED 1.2.325 AND IT IS LIVE ON d1. CDN sha matches the manifest; CI and
  the release workflow green on the tag; keep-latest left one release and one tag;
  the last-5 window still holds 1.2.321-325 so rollback is possible. The receipt
  read `update requested 1.2.324 -> 1.2.325` — round 19's fix holding in
  production — and the boot log showed the new pass closing those two old runs.
  (6) A NOTE ON THE DUAL-BUILDER AUDIT: it reported **WARN**, not OK, and the WARN
  is the STRONGER result. The OK path lists a differing `vale-agent.exe`; the WARN
  path is reached only when EVERY source-derived file matches INCLUDING the exe,
  and just the tarball container bytes differ (packaging metadata). The two
  builders converged for this release — the outcome step 6 of the release docs was
  written to achieve. The script's wording undersells it.
  Gates: agent 559 default / 609 feat-gated, clippy -D warnings clean BOTH
  configs, fmt clean, xwin OK. The full suite ran 6x consecutively green after the
  flake fix.
  METHOD NOTE, third time this session and now written into the log's own body:
  a mutation or a diagnosis has a PREMISE, and checking the premise matters more
  than reading the result. Three of my mutation scripts had a wrong anchor this
  session and reported "fail 0", which measures nothing.

Previous round: 2026-09-11 round 19 (I SHIPPED A BUG, FOUND IT ON THE DEVICE, AND
  FIXED IT IN THE SAME ROUND). Commits: c9309ed8 (1.2.323), 13983349 (the shell
  fix), then 1.2.324.
  (1) THE BUG I SHIPPED. Round 7's update receipt is the thing that tells an
  operator "the CLI ran and the swap did not" apart from "nothing ran" — and it
  landed on d1 mangled:
      update requested 1.2.322 - (CLI reached the device...)
  The arrow and the TARGET VERSION were gone, and a stray ZERO-BYTE FILE named
  `1.2.323` had appeared in the working directory. Confirmed on the device by
  char code, not by eye (the gap is `... 1.2.322 <sp> 45 <sp> 40`, i.e. `- (`).
  CAUSE: `ps()` built a command STRING and ran it with `shell: true`, so cmd.exe
  re-parsed it. cmd has no `\"` escape — a quote is a TOGGLE — so the quoted
  region ended early and the `>` in `1.2.322 -> 1.2.323` became a REDIRECTION
  OPERATOR. The target version was written to a FILE NAME. The fix is structural:
  spawn `powershell` with argv (`["-NoProfile", "-Command", script]`), so nothing
  sits between the two and the script arrives VERBATIM. That is what every other
  spawn in that file already did — `ps()` was the lone exception, which is exactly
  what an audit catches and a feature-by-feature test does not.
  IT ALSO THREATENED `vale setup`: `firewallPs()` contains BOTH double quotes and
  unquoted `|` pipes, so firewall provisioning was equally exposed. One function,
  one fix.
  (2) WHY THE ROUND-7 TEST COULD NOT SEE IT, and this is the round's real lesson.
  The test asserted the string `updateReceiptPs` GENERATES. That string was
  correct. What was wrong was what ARRIVED. **GENERATE vs LAND is a gap, and a
  test on the generating side cannot close it.** The fix's test therefore asserts
  the transport (one argv element, verbatim, no cmd-style escaping anywhere,
  `shell: true` absent), and it is structural because the real thing needs a
  Windows PowerShell to execute. Mutation-proven BOTH ways: reverting to the
  string form fails it, and so does keeping argv while adding `shell: true` back.
  This is the same shape as round 18's rollback finding — the helpers were perfect
  and the bug was in how they were CALLED — and it is the second time the lesson
  has cost a round.
  (3) RELEASED TWICE, deliberately. 1.2.323 carried round 7/18's work to devices
  (the tgz ships `bin/`, so CLI fixes reach nobody without a release). 1.2.324
  fixes the bug 1.2.323 shipped. Both: CI + release workflow green on the tag,
  dual-builder audit passes (source-identical; only the exe differs by toolchain),
  keep-latest left exactly ONE release and ONE tag, and the CDN's last-5 window
  still holds 1.2.320-324 so a rollback is possible.
  (4) VERIFIED ON d1 BY EFFECT, which is the only way that counts here. Before:
  `vale status` printed `release: 1.2.322 / this CLI: 1.2.323` plus the drift line
  — round 7's feature earning its keep on a real device, telling me plainly the
  device was behind. After the update to 1.2.324, the receipt reads
      update requested 1.2.323 -> 1.2.324 (CLI reached the device...)
  with the arrow AND the target intact, and the stray-file count is 0. I also
  verified the PUBLISHED tgz by extracting it and reading `ps()` out of the
  shipped bytes — "generate vs land" applies to releases too, and checking the
  build directory would not have caught a staging mistake.
  (5) THE HONEST SUMMARY: I introduced a defect in round 7, shipped it in 1.2.323,
  and it was caught by reading the log on a device rather than by any gate — the
  suite was green, CI was green, the audit passed. The gates check that a release
  is CONSISTENT, not that its behaviour is right; only driving the real thing does
  that. The correction cost one extra release and is fully closed.
  (6) A SCOUT FOUND A REAL DEFECT WHILE RANKING DIRECTIONS (same pattern as round
  18, and worth recording as a method): `MemoryStore::update()` never maintains
  the `total_bytes` ledger that `enforce_limits` reads for `max_bytes` eviction —
  `insert()` and `load()` do, `update()` does not. So an edit undercounts (the
  byte cap silently stops being enforced) and a soft-delete overcounts (live
  records get evicted early — the exact defect a load-time comment claims was
  fixed). The only test that names the ledger DROPS AND REOPENS the store, which
  recomputes it, so the in-process ledger is asserted nowhere, and no production
  reader exists to notice. NOT FIXED YET — it is the first item for the next
  round, with the scout's other finding that "LRU" is really oldest-WRITTEN
  (reads never touch `updated_at`).
  Gates: agent 555 default / 605 feat-gated, clippy -D warnings clean BOTH
  configs, fmt clean; CLI 28 (was 26), both new properties mutation-proven.
  Released 1.2.324, live and verified on d1.

Previous round: 2026-09-11 round 18 (the update path audited, and the last silent
  governance loss closed). Commits: 4457f52e + d4662e12 + 91839497 (update
  path), 2de64c25 (rollback marker), 27ba321e (abandoned question).
  (1) THE ROLLBACK PIN LIED, and it is the worst defect of the three because it
  is PERMANENT. `etc\.vale-release` is the device's only local version truth:
  `agent_update` reads it as `local` and answers up_to_date when the remote is not
  newer, and /api/status serves it as `release`, which the panel, the tray and the
  console fleet card all display. `vale rollback` wrote it UNCONDITIONALLY once
  `vale update` returned status 0 — but status 0 means the WMI HANDOFF was
  ACCEPTED (`ReturnValue=0` = a process was created), not that the swap succeeded.
  Every decision that matters happens afterwards in a WmiPrvSE-parented process
  whose exit code nobody reads, so **no path returns non-zero for a failed swap**.
  A rollback whose swap died therefore claimed a version the device was not
  running: every UI lies, AND once the pin is cleared `agent_update` sees the fake
  version, decides the device is current, and it is STUCK on the old release with
  no error anywhere. The swap script always gated the same write on a provable
  copy; the CLI never did. It now READS THE MARKER BACK and requires the staged
  version (bounded 90 s — the swap kills the agent, so a delay is normal, but a
  marker that never arrives is a failure).
  (2) A STAGING THROW STRANDED THE UPDATE LOCK. The busy marker is created before
  staging, and the only things that release it are the WMI-failure handler and the
  swap's own cleanup — neither covers a throw from `copyFileSync` or
  `stageDesktopShell` (full disk, AV lock, EPERM). That escaped to the top level
  leaving the marker on disk, so the NEXT `vale update` refused for ten minutes
  citing an update that never started, while the operator saw a stack trace. The
  region is now guarded and releases the marker. Its neighbours
  `writeBoxedVersions`/`writeReleaseMarker` were already best-effort; this was the
  one place a throw strands a LOCK.
  (3) ROUND 17'S SILENCE IS NOW EXPLAINED AS FAR AS THE CODE ALLOWS. That round
  recorded "cause not established". It is now established that THE CLI NEVER RAN:
  the marker is the first statement of `update()` and every branch either creates
  it or exits 1, so reaching update() always leaves a marker; a marker would also
  have made the second attempt refuse, and it did not. Three plausible CLI-side
  explanations are ELIMINATED, which points the remaining question at the MCP
  tool-call transport. Why is still unknown and is not guessed at. Also added: an
  `update requested X -> Y` receipt before the handoff, so vale-update.log now
  distinguishes four cases (CLI-only / CLI+swap / agent_update-only / neither) and
  `vale status` reports the running release, this CLI's version, the DRIFT, and
  the marker's three states (none / IN FLIGHT / STARTED AND DID NOT FINISH).
  (4) THE LAST SILENT GOVERNANCE LOSS. The approval gate's pending question lives
  in process MEMORY; the trail records `asked` and a terminal outcome
  (`approved`/`refused`/`expired`) only when one lands. When the agent died — the
  watchdog, an update (which kills it BY DESIGN), a crash — the question ceased to
  exist and NOTHING recorded it, so after a restart a run that stopped because
  nobody was watching was INDISTINGUISHABLE from one that was never gated. That is
  the exact confusion `asked`/`expired` were added to kill, surviving on the last
  uncovered event family. `recover_interrupted` now writes `abandoned`, naming the
  command. POSTURES ARE NOT ANSWERS (`granted`/`armed` do not close a question),
  and `abandoned` is itself terminal or each pass would append another one.
  PROVEN ON THE REAL BINARY: parked a real question (`pending_approvals = 1`),
  SIGKILLed the agent mid-question, restarted — the trail went from ending on
  `asked | echo never-answered` to `armed → asked → abandoned`, command named.
  (5) THE LESSON OF THE ROUND, learned three times over: MUTATION REVEALS
  TEST GAPS, AND A MUTATION WITH A WRONG PREMISE MEASURES NOTHING. Restoring the
  ORIGINAL rollback bug at the call site left the whole suite GREEN, because the
  pure helpers were perfect and the bug WAS in the wiring — `rollback()` does real
  I/O (spawnSync, process.exit) that `node --test` cannot drive, so the pin had to
  become structural (scan the call site for the verdict gate). And widening the
  abandoned-scan's terminal set to include a posture ALSO left the suite green,
  because my first test had no case where a posture change follows an unanswered
  question; that case is now in the test. Separately, TWO of my mutation scripts
  had a wrong anchor and reported "fail 0", which measures nothing — grep the
  compiled text before mutating it. That is three times this session.
  (6) A SCOUT REPORT EARNED ITS KEEP BY FINDING WHAT IT WAS NOT ASKED FOR: it
  audited the whole update path while ranking directions, and findings (1) and (2)
  came from that audit rather than from the ranked list. It also, correctly,
  refused to propose the receipt/status work it could see uncommitted in the
  worktree — the delegation contract working in the other direction.
  Gates: agent 555 default / 605 feat-gated, clippy -D warnings clean BOTH
  configs, fmt clean; CLI suite 26 (was 20) with every property mutation-proven.
  NOT RELEASED — the CLI fixes reach devices only through a release (the tgz
  carries bin/vale.js).

Previous round: 2026-09-11 round 17 (the suite nothing ran now runs; 1.2.322 is on
  d1). Commits: ad4d306a (CI e2e job), a7b48a0b + the publish commit.
  (1) THE E2E SUITE IS IN CI, and that is the durable fix for round 16's finding.
  Its `governance` section had been RED for a full round because no workflow
  executed it — round 14 inserted an `asked` event into the audit sequence, no
  assertion was updated, and nothing could notice. New job `agent-e2e` builds
  the agent for the host, writes a scratch config on 127.0.0.1:18811, starts the
  REAL binary, and runs the two PLATFORM-NEUTRAL sections. The others are
  device-targeted by design (PowerShell, `C:\ProgramData\...` joins) and are
  excluded with the reason in the job comment.
  VERIFIED THREE WAYS, because a CI job that cannot fail is decoration:
  (a) every step was RUN VERBATIM on this box — 24/24, exit 0; (b) its teeth were
  tested by restoring the STALE assertion, which failed the suite with exit 1
  and named the check; (c) it is confirmed RUNNING GREEN in real GitHub Actions
  (`agent (e2e governance + runs, real binary on loopback) — completed success`).
  (2) THE THIRD FALSE ENVIRONMENT CLAIM IN FIVE ROUNDS, and this one was in the
  recipe the CI job would have copied: the e2e README told the reader to export
  `VALE_DATA_DIR=/tmp/vale-e2e/data`. There is NO such override — `paths.rs`
  resolves the data dir registry-first and reads no environment at all — so the
  agent ran against `target/debug/` while the reader believed it was isolated.
  The pattern across all three (`makensis`, the `--prefix` install, this) is
  identical: a sentence nobody re-measured. A claim about the environment has a
  shelf life; the doc now says where the data actually lands.
  (3) RELEASED 1.2.322 AND UPDATED d1. Publish went through
  `scripts/publish-release.sh 1.2.322 --skip-reconcile --with-installer`; the CDN
  tgz sha matches the manifest byte for byte; CI AND the release workflow both
  green on the tag; the dual-builder audit passes (source-identical, only the exe
  differs by toolchain, CDN authoritative); keep-latest retired v1.2.321's
  release + tag, leaving exactly one of each.
  VERIFIED ON THE DEVICE BY EFFECT, feature by feature: `release=1.2.322` on
  `/api/status`; `pending_approvals` is ABSENT (not zero) with nothing waiting,
  which is the shape designed and tested in round 16; `run_id` is present in the
  device's `memory_save` SCHEMA; and the full join works end to end — `run_begin`
  minted `run-1789148767682-11e970`, `memory_save` carried it, and `memory_list`
  read back `"run_id":"run-1789148767682-11e970"` on the record. 52 tools.
  (4) A DEVICE-SIDE OBSERVATION WORTH KEEPING, cause NOT established: the FIRST
  `vale update` attempt silently did nothing. No `update start` line in
  vale-update.log, no `vale-agent.new.exe` staged, no swap script written — and
  the MCP call returned a connection error that LOOKED like the documented
  mid-swap drop. Only the release marker (still 1.2.321) revealed it. A second
  attempt ran normally (copy ok=True, task restarted) and the device came up on
  1.2.322. I did not establish the cause and will not guess one, but the lesson
  is the one the docs already record and I re-lived: VERIFY THE UPDATE BY EFFECT,
  never by the absence of an error — the failure mode of this command is silence.
  (5) A SELF-INFLICTED PROCESS NOTE: I burned real budget fighting the PTY's
  multi-line paste handling on the device (a here-string got re-parsed line by
  line and produced a ParserError, twice). Single-line commands with the JSON
  body written to a file first worked every time. Worth doing that way from the
  start.
  Gates: agent 554 default / 604 feat-gated, clippy -D warnings clean BOTH
  configs, fmt clean, xwin OK; gateway 759; panel 416 + build; e2e 24/24 locally
  and in CI. Released 1.2.322, live on d1.

Previous round: 2026-09-11 round 16 (three holes of the same shape: code that
  works, and nothing that reaches it). Commits: a991ba3f (doc drift), 1fa7851a
  (status + e2e), 1488c6f7 (Activity), plus the memory-provenance work below.
  THE ROUND'S PATTERN, and it is the one this log has now recorded three rounds
  running: the defect is not broken code, it is a JOIN that was never made.
  (1) MEMORY PROVENANCE — the last producer that was CLAIMED but not WIRED.
  `runs.rs` had listed `memory_save` as a run-id producer since round 13 while
  `grep -rn "run_id" src/plugins/memory/` returned nothing, and it OMITTED
  `terminal_plan`, which does stamp one. So the list was wrong in both
  directions at once — a reader would look for a field that was not there and
  fail to look for one that was. Now `memory_save` reads and stamps `run_id`
  (trimmed, byte-capped on a char boundary, blank = ABSENT, key OMITTED from
  the JSONL via `skip_serializing_if` — the stronger of the two shapes available
  here, and deliberately not `source`'s `"unknown"` sentinel, because a
  fabricated run id is groupable evidence of an execution that never happened).
  `memory_update` deliberately does NOT restamp: an edit revises content, it
  does not re-attribute knowledge. Verified on the live binary: a save WITH the
  id writes it, a save WITHOUT it writes no key at all, and `runs/runs.jsonl`
  holds the matching begin — the join works on disk.
  (2) A WAITING DECISION IS NOW VISIBLE EVERYWHERE. Round 14 made the gate
  answerable, but its push terminates in an OPEN panel — so the Electron tray
  and the console fleet card, which poll `/api/status`, could not say "a
  decision is waiting". One count field fixes all of them. My own test caught me
  writing it wrong: `json!` renders `None` as `"key": null`, so the field would
  be PRESENT on every response and a consumer could not tell "nothing waiting"
  from "an older agent" — the exact trap round 13 recorded for `runs::clean`.
  Insert-after-construction instead, asserted in BOTH directions, and
  mutation-proven (counting ARMED sessions instead of WAITING questions — the
  slip a scout predicted was likeliest — fails).
  (3) THE ACTIVITY PAGE, and the sharpest version of the pattern: the merged
  timeline was built, served, fetched by a hook... and REDUCED TO COUNTERS.
  `groupOperation` kept `{terminal: 3, browser: 1}`; nothing rendered a
  `command`, a `script`, an `intent`. An operator could see three commands ran
  and never learn what they were. It was also session-gated, so browser-only
  work had no view at all. The page reuses the same hook, the same grouping and
  the same header component, so the two views cannot drift. The old
  "runs belong inside the Path view" argument is KEPT and extended rather than
  deleted: the strip answers "what did the device do while I read THIS session",
  the page answers "what has this device been doing at all" — neither can answer
  the other's question.
  (4) THE E2E SUITE WAS SILENTLY RED FOR A ROUND. Running it against the real
  binary showed `gov: the trail records the whole approval posture` failing,
  because round 14 inserted the `asked` event into that sequence and nothing
  updated the assertion — and nothing could, since the suite is wired into no
  workflow. Fixed, and added the `runs` section it never had (mint → stamp →
  unattributed sibling → ordered timeline → close → unknown id), 9/9 on the
  real binary and 24/24 with governance. THE LESSON: an unrun test is a
  DECORATION. A suite nothing executes does not report drift, it accumulates it.
  Gates: agent 554 default / 604 feat-gated, clippy -D warnings clean BOTH
  configs, fmt clean, xwin OK; gateway 759; panel 416 (was 383) + build; e2e
  24/24 on a loopback binary. NOT RELEASED — 1.2.321 remains the live version on
  d1, so everything in this round is on main and on no device yet.
  LIMIT STATED RATHER THAN PAPERED OVER: the real-browser render audit cannot
  run on this box (the bundled chromium needs libatk-1.0.so.0, absent, and there
  is no sudo), so panel verification is jsdom plus CSS pins read from the BUILT
  artifact. A visual pass still needs the device path.

Previous round: 2026-09-11 round 15 (THE DELIVERY GAP IS CLOSED — 1.2.321 is on
  d1). Commits: a0b26f04 (retention), 23df1cd3 + 3238e5ee (the release), plus
  f2bbef3f and 2eec519c earlier in the round.
  THE HEADLINE, after three rounds of this log calling it out: every round
  13/14 feature is now REACHABLE. Released 1.2.321 through
  `scripts/publish-release.sh 1.2.321 --skip-reconcile --with-installer`, then
  updated d1 through the sanctioned npm flow. MEASURED ON THE DEVICE, not
  inferred: `/api/spec` reports **52 tools** (was 50) with `run_begin`/`run_end`
  present; `run_begin` MINTED `run-1789143443091-b50f43` with its label and goal;
  `/api/operation` then served that run and 14 events. `etc\.vale-release` reads
  `1.2.321`. The feature that was "implemented, tested, committed, and on no
  device" for two rounds is now doing its job on the real one.
  `makensis` EXISTS — round 12's note that it did not is WRONG. It lives at
  `~/nsis-dist/bin/makensis` (v3.12) and is simply NOT ON PATH, which is what
  made `command -v makensis` come back empty. So 1.2.321 shipped a
  SELF-CONTAINED INSTALLER (6.9 MB > the 6.6 MB tgz, i.e. it bundles Node), the
  manifest carries `installer` + `installer_sha256`, and the landing alias
  `ValeAgent-Setup.exe` was verified NOT STALE by comparing its etag to the
  versioned file's — the failure the smoke would otherwise skip silently.
  Verified from here: `/api/version` returns 1.2.321, the downloaded tgz sha
  matches the manifest byte for byte, and the script's own smoke passed.
  THE `--prefix` TRAP WAS REAL, AND I WATCHED IT: on d1 `vale` resolves to
  `D:\Vale\components\npm-global\vale.ps1` while `npm prefix -g` is
  `C:\WINDOWS\system32\config\systemprofile\AppData\Roaming\npm`. Two READMEs
  still taught the plain `npm i -g` form (2eec519c) — the two a person is most
  likely to be reading while updating a device. The flow used the prefixed form.
  RETENTION (a0b26f04): the evidence feed and runs.jsonl were the only two
  durable records with NO bound. Age-bounded, not size-triggered — a size trigger
  fires exactly when a long operation has produced the most evidence. 30 d for
  evidence (matching the audit trail), 90 d for runs (it is the INDEX of the
  evidence and tiny; dropping the index first would be backwards). The feed was
  also a CRASH risk: trimming an append-only file rewrites it, and a temp+rename
  orphans an in-flight writer's handle — verbatim the round-116 defect. Fixed
  with a per-record mutation mutex + `jsonl::rewrite_atomically`; INDEPENDENTLY
  VERIFIED here by removing the lock, which loses **129 of 132** concurrent
  appends.
  ALSO THIS ROUND (f2bbef3f): `/api/logs` had resolved `exe_dir()`, a path layout
  v2 MOVES the logs out of, so on every v2 device it answered `""` — well-formed,
  empty, unnoticeable, and unconsumed. Now reads `logs_dir()` and returns the
  tails of the three real logs. `text::tail` joined `clip` while there (the
  double-reversal hand-roll existed at two sites, which is the promotion rule's
  second consumer).
  METHOD NOTE WORTH KEEPING: round 12 recorded "no makensis on this box" and I
  repeated it for two rounds without re-checking a binary sitting in $HOME. A
  negative claim about the ENVIRONMENT has a shelf life; re-measure it before it
  shapes a decision.
  And round 13's lesson repeated in miniature: I committed a non-snake_case test
  name and left HEAD red on CI's clippy gate. The retention agent found it and
  REPORTED it rather than silently editing a file it did not own. That is the
  delegation contract working.
  Gates: agent 547 default / 596 feat-gated, clippy -D warnings clean both
  configs, fmt clean, xwin OK; gateway 759; panel 383 + build. Released 1.2.321;
  tag v1.2.321 cut via the API so CI builds the GitHub asset.
  THE PUBLISH CHECKLIST IS COMPLETE, verified item by item: CI on the tag went
  GREEN (both `CI` and `release` workflows); the GitHub release v1.2.321 exists
  with its tgz asset (6,658,733 B); the dual-builder audit PASSES — "every
  source-derived file matches byte-for-byte", with only `vale-agent.exe`
  differing by TOOLCHAIN (4dfff449… local vs 7de13775… CI), which is the
  documented long-tail difference the audit exists to tolerate, and the CDN
  stays authoritative for devices; and keep-latest ran — v1.2.319 and v1.2.320
  releases + tags deleted (HTTP 204 each), leaving exactly ONE release and ONE
  tag, matching the repo's recorded state.
  ROLLBACK NOTE: `vale rollback` for a device still needs the CDN tgz, and the
  last-5-per-minor prune kept 1.2.317-321 there, so the rollback window is
  intact even though only the newest GitHub release remains.

Previous round: 2026-09-11 round 14 (the approval gate becomes ANSWERABLE). Three
  commits: 78ff244a (panel), ecd267b1 (agent). The round before this one is
  logged below as round 13.
  THE DEFECT THIS FIXES is not a crash — it is a gate nobody could answer. An
  execute blocked 60 s, then failed closed with `approval_timeout` AND threw the
  question away at the same instant, while holding the session's execute lock for
  the whole wait. An operator who was not staring at the right pane at the right
  second therefore could not answer at all, and being away from the desk was
  punished with a frozen session.
  TWO CLOCKS. The BLOCK (60 s, unchanged) is how long one tool call may hang; the
  TTL (15 min, new) is how long the QUESTION stands. On the block deadline the
  execute PARKS: it releases the lock, keeps the registration, and returns
  `state:"awaiting_approval"` + `ran:false` + the gate id. Ok-with-a-state, not an
  error — the vocabulary already had done/partial/timeout and an error would say
  what a refusal says. A refusal stays a typed `approval_denied` error on purpose:
  the gateway dispatches on that code.
  A LATE YES IS A PERMIT — one-shot, bound to (session, the EXACT command the
  operator read, gate id), consumed on match. Without it a late answer would
  decide a request nobody is waiting on: recorded, and doing nothing. A different
  command with the same id ASKS AGAIN, because a permit is one yes to one line,
  not the prefix-grant "remember this" means. Proven on the live binary: the same
  command with the id ran unasked; a different command with that id parked again.
  The trail gains `asked` and `expired`. Without them an unanswered gate leaves NO
  trace, so a run that stopped because nobody was watching looked identical to one
  that was never gated. Live trail read: armed → asked → approved → asked.
  `ApprovalOutcome::{Granted, Parked}` replaces `Result<bool>` — two shapes forced
  "nobody answered YET" to be reported as a failure, which is precisely how an
  unattended gate became indistinguishable from a refusal. `Denied` is absent from
  the enum and stays an error.
  DESIGN CORRECTION found while testing: `parked` is a RECORDED flag set by the
  waiter when ITS budget expires, not a derivation from `requested_at` against the
  production constant. The block is the CALLER's budget and a caller may wait less
  than 60 s — the tests do. A derivation would report "nobody is waiting" while an
  execute still was, and a late answer would mint a permit for a command about to
  run anyway: running it twice.
  THE BUG THE SUITE COULD NOT SEE, and the round's real lesson: `term_list` /
  `term_info` project a request through `live_pending`, while every test read
  `term_pending_approval`. TWO implementations of ONE read, and the covered one
  was not the one the panel calls. With `live_pending` still measuring the block,
  the parked execute returned a perfectly correct body while `terminal_list`
  reported NO pending request — the prompt vanished from the panel at the exact
  moment it became answerable. Everything was green. Found by driving the REAL
  BINARY over loopback (`terminal_execute` → park → `terminal_list`), then pinned
  by `a_parked_question_is_visible_through_term_list` and mutation-proven
  (restoring the block deadline fails it with "got 59799ms"). The general lesson
  is worth more than the fix: when two functions answer one question, the test
  must read the one the PRODUCT reads.
  THE PANEL HALF (78ff244a, a delegated agent) fixed a second real bug the new TTL
  exposed: `ApprovalGate` combined a refreshed `expiresIn_ms` with a locally
  accumulated elapsed, so with a 15-minute TTL and a 2 s poll the displayed time
  fell ~2× too fast — invisible at 60 s. `mapPending` now stores an ABSOLUTE
  `expiresAtMs` and the relative field is gone from the type entirely. Mutation-
  proven: halving the budget fails "does NOT fall twice as fast". Also: a settled
  expired row (`role="status"`, no buttons, never a 0 s answerable prompt); a
  ceiling minute/second countdown ticking 1 s only in the last minute; the
  countdown `aria-hidden` with a STATIC `aria-describedby` (the dialog's
  `role="alertdialog"` is implicitly an assertive live region, so a 1 Hz change
  would machine-gun a screen reader for 15 minutes); badges on the tab, the
  status bar and the rail that key off `pendingApproval` and NEVER off `armed`.
  Gates: agent 568 feat-gated / 519 default, clippy -D warnings clean both
  configs, fmt clean, xwin OK, module_map green; gateway 759; panel 383 (was 350)
  + build. NOT ON A DEVICE — still no version bump, so none of this is reachable
  by a user yet; the delivery gap noted in round 12 stands.

Previous round: 2026-09-11 run-identity round 13 (a RED TREE, a broken C
  compiler, and one feature wired end to end across four layers). Commits
  b5947440 (agent+gateway) + cd5d24ff (panel).
  (0) THE SESSION ENVIRONMENT WAS BROKEN BEFORE ANY CODE WAS READ, and it
  would have silently poisoned every cargo command: `CC`/`CXX` were exported
  pointing at `~/gcc10-root/usr/bin/gcc-10`, a userspace root that was missing
  `cc1` — that binary ships in Ubuntu's `cpp-10` package, which the original
  extraction (documented in this file for the dsh upgrade) never unpacked.
  Every C compile failed with "cannot execute 'cc1'", so `ring` could not
  build and NOTHING in the workspace compiled. Fixed by extracting `cpp-10`
  into `~/gcc10-root/`; verified with a real C compile AND a C++20 compile.
  METHOD NOTE: the first attempt reported success because the command ended
  `cargo clippy ... | tail -40` — the pipe made `$?` the exit of `tail`, so a
  hard build failure read as exit 0. Check `PIPESTATUS`, always.
  (1) THE TREE WAS RED, and had been since round 12: `runs.rs` and
  `operation.rs` were committed-in-progress with ZERO callers, so clippy
  `-D warnings` failed on 9 `never used` errors, and `tests/module_map.rs`
  failed because neither module appeared in the module map of BOTH guides.
  Both fixed first, before adding anything.
  (2) RUN IDENTITY, WIRED END TO END. The device could not tell two AIs
  apart (the token identifies the DEVICE; `clientInfo` is a software constant;
  the console implements no MCP session id), so a set of commands and browser
  actions could not be attributed to one execution. `run_begin`/`run_end` are
  new MCP tools in a new `plugins/runs/` (a separate plugin because a run
  explicitly CROSSES the terminal/browser boundary); the id is minted
  device-side and stamped by all five producers (terminal_execute,
  terminal_plan, browser_run_script, mcp_client_call, memory_save — the last
  one joined in round 16, having been CLAIMED since round 13 while stamping
  nothing); `/api/operation`
  returns the boundaries beside the events. The rule is stated in
  `runs.rs` and pinned by `no_caller_derives_authority_from_a_run_id`, a
  repo-wide scan for a `run_id` line naming an authorization verb — the first
  run of it flagged the rule's OWN prose, so comments are skipped and that
  limit is written into the test. Mutation-proven: a planted
  `run_id == "x"` in production code fails it with the exact line.
  (3) THREE DEFECTS FOUND WHILE WIRING, all of the silent class:
  `runs::end` wrote the client's id VERBATIM into an append-only log (now
  capped on a char boundary, like every other remote string here);
  `operation.rs`'s two mappings are field ALLOWLISTS so `run_id` was dropped
  from the timeline with every test green (now named on both feeds, pinned);
  and the console bridge nests args inside `arguments`, which the device
  forwards to playwright-mcp — so a console run would have shown commands and
  ZERO browser actions, indistinguishable from "the AI never opened the
  browser". Lifted to the top level and pinned in both directions.
  (4) THE PINNED CONTRACTS EARNED THEIR KEEP — three of them failed the moment
  the tools were added, each naming exactly what to update: the gateway's
  param-parity contract (`run_id` accepted by the device but unadvertised on
  the console), its device-direct partition, and the agent's 50-tool count.
  That is the round-554 lesson working as designed.
  (5) A DOC CLAIMED A WIRE SHAPE THAT IS NOT TRUE. `runs.rs` said a blank
  label becomes "ABSENT"; `json!` cannot skip a `None`, so the wire actually
  carries `"label": null` — invisible to a careful reader, decisive to a
  `"label" in record` check. Found by the PANEL agent going looking for the
  shape the docs implied. The doc now states the real shape and
  `an_absent_label_is_a_null_value_not_a_missing_key` pins it.
  Gates: agent 559 feat-gated / 518 default (summed from the runners, and
  CORRECTED by the adversarial verifier: my first log entry said "459 default",
  which is the LIB count only — integration binaries are counted separately, and
  the same pass showed the commit message's "59 integration" was really 58. Two
  wrong numbers in one line, both from reading a partial sum as a total.)
  clippy -D warnings clean BOTH configs, fmt clean, xwin check
  OK, module_map green; gateway 759; panel 350 (was 306) + build. NOT ON A
  DEVICE — the delivery gap from round 12 applies to all of this; no version
  bump yet, so nothing here is reachable by a user until a release round.
  (6) VERIFIED AGAINST THE REAL BINARY, not only against tests. Ran
  `target/debug/vale-agent` on a scratch config at 127.0.0.1:18799 (loopback
  only — confirmed with `ss`, and the red-line self-check afterwards showed
  every listener I own on 127.0.0.1) and drove the feature over real HTTP:
  `run_begin` minted `run-1789134893834-838269`; `terminal_execute` WITH that
  id produced `run_id="run-…"` on the timeline while the same command sent
  WITHOUT one produced `run_id=null` — the two adjacent rows the whole design
  is about; `run_end` answered `{"known":true}`; and an anonymous request
  carrying that REAL, well-formed id was 401 on all three endpoints while the
  same call with the token was 200. That last one is the credential rule as
  BEHAVIOUR rather than as a source scan. Worth doing every round: the unit
  suite cannot tell you whether the tool is reachable, and this repo has
  shipped "every gate green, nothing callable" at least twice.

Previous round: 2026-09-11 game-design round 12 (doc coherence, a job-object
  incident, and the DELIVERY GAP). Three things, in order of what they taught:
  (1) NO-BENEFIT ASSUMPTION — I shipped the round-11 Windows build to d1 and
  started it on a spare port to verify it, launched from an agent-hosted
  terminal. That KILLED THE RUNNING AGENT (the 60s watchdog restarted it).
  Cause is the documented design working as intended: the agent puts itself in
  a kill-on-close Job Object and EVERY CHILD IT SPAWNS INHERITS MEMBERSHIP
  (`setup_child_reaper_job`), so an agent-hosted shell is inside that job and
  anything launched from it nests inside the running agent's. Fixed the
  SILENCE, not the design: `IsProcessInJob` at startup now logs the fact (no
  verdict — Task Scheduler also wraps its tasks in a job, benignly, so a
  warning would fire on every normal boot and become wallpaper). ALSO
  established and documented: a second instance CANNOT be isolated —
  `data_dir()` is registry-first with NO env override, so my `VALE_DATA_DIR=`
  was ignored and the test agent shared the live agent's session directory.
  Both guides now say: launch detached via WMI Win32_Process.Create, or for
  verifying a build prefer static checks (PE + `strings`) over running it.
  (2) THE DESIGN DOC CONTRADICTED ITSELF IN 8 PLACES, found by an adversarial
  audit against the RUNNING SYSTEM rather than the tree. All were leftovers of
  PARTIAL edits — a claim updated in one half and not the other, so sections
  asserted something was missing inches from text saying it exists (the worst:
  a paragraph saying "still missing is the middle row" FIVE LINES BELOW a
  diagram saying PLAN <- STORED three times). Fixed all 8 + a duplicated
  limit statement; the doc now greps clean for `missing|absent|broken|not
  built|remains a proposal`. Method worth keeping: grep the STATUS WORDS.
  (3) THE DELIVERY GAP, and it is the headline: everything from rounds 7-11 is
  implemented, tested and committed, and NONE OF IT IS ON A DEVICE. Repo
  registers 50 tools / has `terminal_plan` / `intent`+`considered`+`plan_step`
  / `goal`+`plan`+`held_by_human` on `terminal_list`; live d1 has 49 tools, no
  `terminal_plan`, none of those params or fields. Repo version is still
  1.2.319 == the last CDN release (2026-09-10T07:43Z), i.e. no version bump
  ever happened for this work. Recorded in the design doc §5.1 because it is
  the difference between "the design is finished" and "someone can use it".
  Agent gates 12+12, clippy both, fmt, xwin. Commits: 1836dffb, 2441b856.
  (4) RELEASED 1.2.320 AND UPDATED d1, with the user's approval. Publish went
  through scripts/publish-release.sh (pack -> stage -> sha256 manifest -> last-5
  prune -> wrangler deploy -> smoke: /api/version returned v1.2.320 with the
  versioned + latest sha verified). Verified ON THE DEVICE afterwards: 50 tools,
  `terminal_plan` present, `terminal_execute` advertising all 8 params, and a
  real goal+plan round-trip through the live routes; `terminal_list` now carries
  approval_grants/approval_required/goal/held_by_human/id/kind/label/plan/shell.
  (5) A SECOND SILENT-SUCCESS DEFECT, found by following my own docs on d1: the
  documented `npm i -g <url>` installs to npm's DEFAULT global prefix, which is
  NOT where `vale` lives when the agent runs as SYSTEM (observed: (Get-Command
  vale).Source = D:\Vale\components\npm-global\vale.ps1 while `npm prefix -g`
  = C:\WINDOWS\system32\config\systemprofile\AppData\Roaming\npm). npm
  reported success, `vale update` ran the OLD 1.2.316 CLI from the other prefix,
  and the device silently stayed on its previous release — exe mtime and
  etc\.vale-release were the only evidence. Both guides now use `--prefix
  (Split-Path (Get-Command vale).Source)`, which `vale rollback` had always done
  and the update path never had. Commits: 3ed26cf3 + b081e80d (the release).
  NOTE: no installer was rebuilt for the FIRST 1.2.320 publish, so that
  manifest was briefly tgz-only — fresh installs still worked via the npm
  channel, and absent fields are the fail-safe case. **THIS PARAGRAPH USED TO
  CLAIM "no makensis on this box", AND THAT WAS FALSE** — see round 15: the
  binary is at `~/nsis-dist/bin/makensis` and simply is NOT ON PATH, which is
  why `command -v makensis` came back empty. The 1.2.320 republish (d899709b)
  did build the installer. Corrected in place rather than left standing,
  because I believed this line for two rounds and it cost a release feature
  every time: a false negative about the environment is worth less than no
  claim at all.

Previous round: 2026-09-11 game-design round 11 (the PLAN, + an
  evidence-loss bug it uncovered). `terminal_plan` lets the agent declare
  the steps it intends to take, in order (revise/clear/read); it is a TOOL
  while the session goal is a CONTROL ROUTE, and a pin asserts the control
  route REJECTS `plan` so a later "merge these two" refactor fails loudly
  instead of destroying the comparison between asked-for and intended.
  `terminal_execute` gained `plan_step` (1-based, 0/negative = absent) naming
  which step a command advances; the path view renders the plan with the
  count of commands that served each step, so an unclaimed step shows as a
  run departing from what was announced. Gateway registers terminal_plan and
  advertises plan_step (contract test caught the omission immediately — the
  console registry is a hand-maintained SUBSET and tools/call looks names up
  there BEFORE routing, so unlisted = uncalled). THE BUG: adding a test that
  asserts an exact event count on the audit trail made the web pins fail on
  3 of 4 full-suite runs. `recover_interrupted()` trimmed every recovered
  session's file, and `trim_file` rewrites atomically (temp + RENAME), so the
  path gets a NEW inode and every other writer's open handle is orphaned —
  `writeln!` and `flush` both return Ok while the bytes land somewhere
  unreachable. Recovery runs whenever a plugin REGISTRY is constructed, not
  only at boot, so it could rename a file belonging to a session that was
  LIVE at that moment and silently swallow its remaining audit events.
  Measured, not reasoned: instrumenting the write showed the handle at 528
  bytes while the path held 393 — same call, two files. Trim removed;
  recovery still marks unpaired command/starts and seeds the seq counter, and
  disk growth stays bounded via the write-time output cap, close_session's
  trim and prune_stale. Suite 18s -> 3s. Pinned by
  `recovery_does_not_orphan_a_live_writer` (restoring the trim makes it fail
  with `Statuses seen: ["still going"]` — the event simply gone). Also caught
  by measuring rather than remembering: the plan's claim count was written
  with `--muted` on `--surface-chip`, the exact 4.40 pair fixed for the count
  chips ONE ROUND EARLIER. Agent gates 12+12 suites, clippy both, fmt, xwin;
  panel 305; gateway 34. Commits: e1270743, 63148791, 23f2edc8, 3747acec.
  NOTE: one unrelated pre-existing flake remains,
  `plugins::playwright::manager::manager_tests::status_tracks_fresh_external_and_released`
  (~1 in 6 full runs) — not touched this round, left for its own.

Previous round: 2026-09-11 game-design round 10 (real-panel audit). The
  game-design surface (goal / approval gate + grants / per-step intent /
  audit trail) is complete on the agent and panel sides; this round stopped
  adding features and audited what actually renders. New
  `scripts/panel-render-audit.mjs` loads the REAL panel bundle
  (`resources/panel/panel.js` + `panel.css`, the exact include_str! bytes) at
  a real `/panel/` origin via Playwright route interception (no listener
  anywhere) with `window.fetch` stubbed, so the app boots through its own
  production path and renders its own tree; it then measures EVERY visible
  text node, asserts the governance elements are PRESENT (a clean sweep over
  a page that failed to render must not pass), and checks overflow + page
  errors. It runs emit-only without VALE_BROWSER_HELPER. ONE PASS FOUND FIVE
  chrome contrast defects that had been wrong the whole time and that no
  feature-by-feature gallery could see, because I only ever measured what I
  was working on: `#session-count` --chrome-ink-faint 2.33 light,
  `.side-time` --faint 2.29, `.side-count` --muted-on-chip 4.40,
  `.tab.active` and `.view-switch-btn.active` --chrome-active-ink 3.83/3.65.
  The last two repeat a mistake already on record twice — that token's own
  doc calls it "the accent for CHROME — icons, dots, borders" and it was
  used as TEXT; new `--chrome-active-text` is its text-weight counterpart.
  `--muted on --surface-chip` at 4.40 is the instructive one: that pair was
  "fixed" in an earlier round and PINNED, verified only as better than
  --faint, so the pin cemented a near miss — and the three other count chips
  carry the identical pair, so all four moved together. Both affected pins
  now state what they were missing. Also fixed on the way: a first sweep
  reported terminal text at 1.09 (13.17 by hand) because the harness switched
  theme AFTER mount, so xterm had built its palette in the other theme — the
  probe now themes at boot and excludes xterm, whose palette is its own.
  Verified on the current bundle: 88 text nodes across light/dark x
  pending/idle, 0 under AA, 0 missing, 0 page errors, and the five fixed
  rules read back OUT of the audited artifact rather than assumed. Commits:
  31fa1fde (harness + fixes). Previous round 10 item: `7765068b` fixed
  arming the approval gate leaving NO trace in the audit trail — found by
  running the real agent on loopback and driving it over HTTP, not by a test;
  the new platform-neutral `governance` e2e section (15/15 on the live
  agent) makes that repeatable. Agent gates 12+12 suites, clippy both, fmt,
  xwin; panel 301; gateway 34. No device rollout this round.

Previous round: 2026-09-10 SOLID-R122 (docs cadence; R116–R121 caught up
  below). **R116 was an AGENT round and was missed in this log** — the
  download gate in `plugins/update/tools.rs` got an adversarial pin, and
  mutation testing proved the first version worthless (a `starts_with` →
  `ends_with` swap left it GREEN; the missed shape was the suffix trap
  `notagent.saisi.online` against site `agent.saisi.online`). **R117–R121
  were GATEWAY rounds** — their detail lives in `docs/solid-program.md` and
  `docs/ARCHITECTURE.md`, not here: `handleGatewayImpl` went 798 → 741 lines,
  the request-shaping cores + BYOK key contract were extracted and pinned, an
  upstream-error credential-echo hole was found and PINNED (not fixed — needs
  sign-off, see the ledger's Open threads), and the model catalogue was
  collapsed into ONE `MODEL_REGISTRY` so adding a model is one record instead
  of six coordinated edits. This round is the R25 docs-cadence refresh: pin
  totals and gate counts re-measured from the runners (gateway 748, agent
  479, core 25, CLI 20, relay 54, index 73, extension 9, proxies 20), which
  caught three stale numbers, two jammed ledger lines, and a stale
  `handleGatewayImpl` line count (746 → 741). Program ledger:
  docs/solid-program.md.

Previous round: 2026-09-10 SOLID-R115 — a doc that claimed a consolidation
  which had not happened. `crate::now_millis`'s own comment said it existed to
  kill a duplicated 3-liner — but the playwright plugin still carried its OWN
  byte-identical copy (`manager::now_ms`) plus TWO inline copies in
  `playwright/tools.rs`. All three now use the shared helper. Its return type
  drops `i64` for `u64` (matching its sibling `unix_now` — a timestamp is
  never negative, so the signed form bought nothing and cost a cast at every
  `u64` consumer; same number for every reachable input, so the JSON is
  byte-identical), and `next_run_stem` narrowed `u128`→`u64` to match.

  The more valuable half is the PIN. `unix_now()` and `now_millis()` are one
  WORD apart at a call site and 1000× apart in value — the classic silent bug.
  An audit found `started_unix` produced as seconds, echoed to the model, and
  compared NOWHERE: harmless today, one line from being wrong by three orders
  of magnitude. `now_helpers` tests now bound each helper's MAGNITUDE (1.7e12
  millis vs 1.7e9 secs; a century of drift stays inside, so it asserts a real
  property rather than a clock reading). Mutation-proven: making `now_millis`
  return `as_secs()` fails with "outside a millis range — a seconds value here
  means the two helpers were swapped at a call site".

  Also checked and NOT a bug: the inline `u128` millis looked like a
  serde/type hazard, so I built a probe crate and confirmed `serde_json::json!`
  serializes it fine. Recorded because "I verified this and it was fine" is
  worth as much as a fix.

  Agent gates 478 feat-gated / 470 default green, clippy -D warnings clean
  both configs, fmt clean, xwin check OK. Program ledger:
  docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R114 — the module map is a CHECKED claim
  now, and checking it found real rot. Five modules were missing from `src/`
  in BOTH guides (`text.rs` and `jsonl.rs` — added by this very program in
  R105/R111 — plus `register.rs`, `tunnel.rs`, `winmain.rs`), `paths.rs` was
  mentioned only in PROSE and never as an entry, and the map's code fence was
  NEVER CLOSED in either file, so every heading after it rendered as monospace
  code. The two files had drifted IDENTICALLY, so diffing them against each
  other would not have caught it — only checking against the TREE does. New
  `tests/module_map.rs` asserts: every `src/` module is an entry in BOTH maps;
  no entry names a module that no longer exists (one explicit allowlist for
  the sibling crate); the two guides document the same set. Two lessons baked
  into the test itself: entries are told apart from wrapped prose by TOKEN
  SHAPE (`text.rs` / `plugins/` / `mcp/server.rs`) plus the description gap,
  NOT indentation (a column rule reported every real entry as missing), and a
  gate with no self-check is not a gate — the fixtures use the map's REAL
  shape. Its limit is stated in the header: it checks NAMES, not accuracy.
  Agent gates 475 feat-gated / 468 default green, clippy -D warnings clean
  both configs, fmt clean, xwin check OK. Program ledger:
  docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R113 — accounting audited, one deferred
  decision made durable. (1) CUMULATIVE-PIN AUDIT over R98–R112: every
  per-round "+N pins" claim was re-measured from git instead of trusted, and
  the agent rows held up — they sum to the measured total, and the running
  total (+60 on a 415 baseline) independently confirms the earlier recount.
  One ±1 drift found and corrected (R108's authoring added two attrs across
  two commits). Two METHOD HAZARDS recorded so a future audit does not repeat
  them: grep-counting `#[test]` OVER-COUNTS when a test's own fixture contains
  the string (boot_surface.rs counts 6, really 5 — `cargo test -- --list` is
  authoritative), and a zero baseline from the counting pipeline is a BUG
  SIGNAL rather than a fact. Authoritative counts now: agent 471 feat-gated
  (417 lib + 54 integration), 464 default, core 25. (2) The R107-deferred
  SFTP/SSH timeout-code divergence is now DURABLE: `sftp_connect_timed_out`
  names the choice in one place, its doc explains that `internal` vs
  `ssh_timeout` become different gateway classes, and a pin fails with an
  instruction pointing at the ledger entry — so unifying them is a deliberate
  act with a ledger update, not a silent "cleanup". Mutation-proven. Agent
  gates 471 feat-gated / 464 default green, clippy -D warnings clean both
  configs, fmt clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R112 — the terminal tool builders take ONE
  context. `build()` threaded seven parameters by hand and three builders took
  five each, but the cost was never the typing: the terminal tools keep
  gaining shared state (`buffer_limit` round-68, `jobs`, `diag`) and every
  addition re-churned every signature and call site. `ToolCtx` (ctx.rs) now
  names the shared set once, and `jobs` moves from `build()`'s local into it —
  its two consumers, the executor and `terminal_jobs`, are exactly the pair
  review #2 established must share ONE map (a process-global accessor once let
  the background waiter write a different map than the inserts read, so
  `terminal_jobs` never observed completion). Deliberately NOT imposed on
  single-dependency builders: `tool_read(&ctx.output_buf)` and
  `tool_diag_read(&ctx.diag)` keep focused signatures — the
  interface-segregation half of the same principle. Bonus: the documented
  "connections reuses sessions::tool_open" exception no longer unpacks five
  locals back into five arguments. Pure interface refactor (±0 pins); agent
  gates 472 feat-gated / 465 default green, clippy -D warnings clean both
  configs, fmt clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R111 — append-only JSONL hygiene has one
  owner. Found with a normalized 5-line cross-file clone detector rather than
  by reading files one at a time: the crash-safety rules for append-only
  line-oriented files were duplicated in `session_log.rs` and
  `plugins/memory/store.rs`, and — the tell — BOTH sites documented the same
  incident in prose: an empty file needs a version header, and a crash
  mid-`writeln` leaves a fragment without its trailing newline that the next
  append FUSES onto. In the audit trail the fused pair once swallowed the
  "interrupted" recovery marker, so a command that crashed read back as
  FINISHED. Now `src/jsonl.rs` (`prepare_append`, `has_torn_tail`). Two
  things stay caller-owned on purpose: the header payload (uuid+createdAt for
  a session, type+version for the memory store) and the OPEN HANDLE — an
  append-mode file cannot be read back, so each caller opens its own way
  (one wraps it in a BufWriter, one writes through the File) and passes it in.
  Mutation-proven: dropping the repair from the shared unit fails the new
  tests AND both consumers' pre-existing incident pins
  (`append_repairs_a_torn_final_line`, `torn_final_fragment_is_repaired_before_next_append`),
  which is what makes this a real consolidation rather than a hopeful one.
  Agent gates 472 feat-gated / 465 default green, clippy -D warnings clean
  both configs, fmt clean, xwin check OK. Program ledger:
  docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R110 — the BOOT PATH's "never fatal"
  promise is now a gate, not prose. `migrate_layout_v2()` runs FIRST in
  `main()`, BEFORE tracing is initialised — so a panic there is a device that
  never starts and leaves NO log at all (the 1.2.223 dark-device class). It
  held the boot path's ONLY panic surface: `marker.parent().unwrap()`, in a
  function whose own doc says "Never fails the boot". Fixed structurally
  (the unreachable `None` arm is a note, not a panic), then pinned by a new
  `tests/boot_surface.rs` that scans main.rs / winmain.rs / paths.rs /
  filelog.rs / bootstrap.rs / state.rs for the panic family. Two details
  worth knowing: the scanner is brace- AND string-literal-aware because the
  test modules it must skip contain `format!("{{{{{{ broken…")` — a naive
  brace count ended the skip region early and reported false positives — and
  the scanner is ITSELF pinned (planted panic found, production code after a
  test module still scanned, line numbers preserved), because a gate that
  cannot fail is not a gate. Its limits are stated in the header rather than
  implied: it is a line scan, it does not see indirect panics, and the
  BOOT_PATH list is hand-maintained. Mutation-proven: a planted `.unwrap()`
  on the boot path fails with its exact line. Agent gates 466 feat-gated /
  459 default green, clippy -D warnings clean both configs, fmt clean, xwin
  check OK. Program ledger: docs/solid-program.md. No device rollout.

Previous round: 2026-09-10 SOLID-R109 — a documented memory feature does not
  exist, and now says so. The memory plugin's CLIENT-IDENTITY CAPTURE:
  `tools::set_source` is `pub`, documented as "called by the MCP layer on
  handshake", and has ZERO callers repo-wide — so `SOURCE` keeps its
  "unknown" initializer and every `memory_save` record is stamped `unknown`.
  Three doc comments asserted the capture works (the module header, the
  static, the fn) and `MemoryRecord.source`'s field doc listed the intended
  values; nothing contradicted any of it, which is exactly why it survived.
  All four claims are corrected, and the situation is PINNED rather than
  silently repaired — wiring `set_source` is a BEHAVIOUR change needing a
  product decision about WHAT identity to record (the MCP client's
  `clientInfo.name`? the device-local transport?) and where in the handshake
  to take it. `records_are_stamped_unknown_until_set_source_is_wired` fails
  with that instruction the moment someone wires it; the paired
  `update_preserves_an_existing_source` pins the other half (update clones the
  stored record, so an older or hand-edited source survives edits).
  Also removed `MemoryRecord::is_deleted` — zero callers AND a doc comment
  describing an unrelated concern ("the effective id used for ordering"),
  i.e. the kind of thing a reader wastes time trusting. Agent gates 461
  feat-gated / 454 default green, clippy -D warnings clean both configs, fmt
  clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R108 — web request handling is split at its
  natural seam. `handle_request` was a 230-line function mixing three
  concerns: pre-dispatch routing (public SPA + assets, the static status page,
  and the three streaming routes that self-authenticate), the auth gate, and
  the body/dispatch pipeline. Steps 1–6 are now `route_pre_dispatch(...) ->
  Option<Response>`, and the dispatcher is reached only by requests that are
  not public — so R102's "anything reaching the dispatcher is authenticated"
  became a property of WHICH FUNCTION a request lands in rather than of
  statement order, and the public surface is enumerable by reading one list.
  `handle_request` 230 → 158 lines. The extraction surfaced a real constraint:
  `&Request<Body>` is neither Send nor Sync, so holding one across an await
  made the whole future non-Send and broke the Tower service — fixed by
  narrowing `check_auth` to `&HeaderMap` (all it ever read) and passing
  borrowed pieces, not with a `#[allow]`. New structural pin asserts the SEAM
  (dispatcher routes fall through, public routes do not, evidence routes
  self-authenticate) rather than only the consequence; mutation-proven: a
  dispatcher route answered early fails BOTH the seam pin and R102's
  auth-coverage pin. Agent gates 459 feat-gated / 452 default green, clippy
  -D warnings clean both configs, fmt clean, xwin check OK.
  Program ledger: docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R107 — the AGENT→GATEWAY failure-class
  contract is pinned. `gateway/src/mcp.ts` dispatches on three literal error
  codes (session_not_found / session_busy / ssh_timeout) onto its own classes
  and falls EVERYTHING ELSE through to TOOL_ERROR (the deliberate round-64
  widening, so a device-UP tool failure is not misread as "device offline").
  That boundary is never compiled together and the gateway's suite never runs
  the agent, so renaming a code here — and "fixing" the core's own table test
  to match — would silently degrade a client-visible failure class with every
  gate green. `GATEWAY_DISPATCHED_CODES` now carries the gateway's
  expectation in the core, with three pins: every listed code is reachable
  from a variant, the set is exactly the gateway's three, and the rest fall
  through to TOOL_ERROR. Proven rather than asserted: with the rename applied
  to BOTH the enum and the old table test, `every_variant_has_its_stable_code`
  still PASSED — only the new pin failed. Also audited and deliberately
  LEFT ALONE: the base64 cluster (all STANDARD alphabet, consistent — the
  inline `use base64::Engine` idiom alone is churn without gain) and
  `rpc_ref` (a clean transport dispatcher, not duplication). Core gates 25
  green, agent 458 feat-gated / 451 default green, clippy -D warnings clean,
  fmt clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R106 — the timed-out-command KILL POLICY has
  one owner. `execute_local` carried FOUR `#[cfg]`-gated signal blocks (the
  SIGTERM block and the SIGKILL block, each with a unix arm and a windows
  arm) plus TWO hand-written copies of the identical 50 ms exit-poll loop.
  Now `signal_tree(pid, force)` states the policy once and `wait_for_exit`
  owns the poll, with the window lengths named (`KILL_GRACE` 3s, `KILL_REAP`
  5s). This mattered more than the usual DRY win: the unix and windows arms
  are NEVER compiled together — Linux tests see one, `cargo xwin` the other —
  so an inline typo in either is invisible to every other platform's gate.
  First-ever coverage of the round-55 contract ("a timeout kills the TREE,
  not just the shell"), driving REAL processes and asserting the SIGKILL
  reaches a BACKGROUNDED GRANDCHILD (`kill -0 -PGID` fails only when every
  member is gone). Mutation-proven both directions: group-kill → single
  kill fails "group N still has live members"; SIGTERM → no-op signal fails
  "SIGTERM must terminate the group". +5 pins. Agent gates 458 feat-gated /
  451 default green, clippy -D warnings clean both configs, fmt clean, xwin
  check OK. Program ledger: docs/solid-program.md. No device rollout.

Previous round: 2026-09-10 SOLID-R105 — byte-budget text clipping has an
  owner. "Cut this string to at most N bytes, on a UTF-8 char boundary" was
  written out at EIGHT sites across SIX files (mcp_client ×3, session_log ×2,
  output, playwright, design, plus memory's private helper) in two different
  idioms — some `floor_char_boundary`, some hand-rolled
  `while !s.is_char_boundary(end) { end -= 1 }`. The crate has paid for the
  naive version at least three times: round-68 (`&text[..4096]` panicked the
  drainer and WEDGED THE SESSION), rounds 110/111 (same class in the diag
  writer), and an audit-HIGH slice of a REMOTE-controlled response body at
  byte 80. Now `src/text.rs` owns it: `boundary_at_or_below` (the index, for
  callers that report how many bytes they dropped) and `clip` (the borrowed
  slice). The truncation SUFFIX stays per-caller deliberately — `…` for
  model-facing output, `…[truncated N bytes]` for the audit trail. +5 pins,
  mutation-proven: replacing clip with a naive `&s[..max]` panics with
  "end byte index 1 is not a char boundary; it is inside '汉'". Agent gates
  453 feat-gated / 446 default green, clippy -D warnings clean both configs,
  fmt clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R104 — the settings request bodies have an
  owner. `PUT /api/settings` and `POST /api/gateway/connect` had each grown
  their own copy of two concerns that belonged to nobody: the eight-line 400
  `invalid_params` envelope (built inline twice) and "an optional string
  field, trimmed; blank means unset" (written out five times). The second rule
  is load-bearing — it carries the documented incidents where a console-only
  save clobbered `buffer_mb` and a reg-key-only request silently UNBOUND the
  gateway — so absent vs cleared vs blank has to stay distinguishable. Both
  now live in `src/web/parse.rs` (`json_body`, `optional_trimmed_string`,
  `invalid_params_response`); the 400 error TEXT stays a caller argument
  because the two endpoints' wordings differ deliberately (settings appends
  the serde detail, gateway answers bare) and unifying them would be a
  user-visible change. Real fix on the way: `api_gateway_connect` evaluated
  the console_url rule TWICE — response and persisted value were independent
  copies that agreed by luck; one evaluation now feeds both. A test surfaced a
  contract detail worth having on the record: the response ECHOES THE REQUEST
  rather than reading back state, so a reg-key-only connect answers
  `console_url:null` while keeping the stored binding. +7 pins, mutation-proven
  (an independent re-evaluation that forgets to trim fails "in-memory binding
  disagrees with the parsed patch"). Agent gates 448 feat-gated / 441 default
  green, clippy -D warnings clean both configs, fmt clean, xwin check OK.
  Program ledger: docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R103 — the ROUTER layer is now covered.
  R102 ended by noting an honest gap: its pins call `handle_request`
  directly, so they say nothing about the axum composition in `mcp::bind`
  (`nest_service("/mcp", TokenGate) + fallback_service(WebPanel)`) — a
  routing edit would leave every test green. New
  `tests/router_auth_integration.rs` drives a REAL server over real HTTP
  with no rmcp client (the point is routing, not the MCP protocol):
  `/mcp` must be gated by its Tower layer (missing AND wrong token), the
  fallback branch must reach the web gate (GET and POST — the old
  `needs_auth` flag short-circuited GETs), and `/`, `/panel/`, `/desktop/`
  must keep serving. Both failure directions are mutation-proven: dropping
  `TokenGate` from the nest fails the /mcp case ("/mcp served without a
  token"), re-applying R102's broken classification fails the fallback case
  ("/api/status served without a token through the fallback"). Auditing the
  ledger for this round also caught a self-accounting error: R102 was
  recorded as +3 pins but ADDED 2 test functions and MODIFIED one — the row
  and the cumulative totals are corrected. Agent gates 441 feat-gated / 434
  default green, clippy -D warnings clean both configs, fmt clean, xwin
  check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R102 — the web auth gate is now FAIL-CLOSED
  BY CONSTRUCTION. `handle_request` wrapped it in a `needs_auth` flag that
  re-classified routes (`method != GET || path.starts_with("/api") || path ==
  "/mcp"`), but the early returns above already decide exactly which requests
  are public — so at that point the flag was provably always true, and the
  duplicate classification could only ever fail in the dangerous direction
  (disagreement ⇒ gate skipped ⇒ unauthenticated `/api/tools/*` dispatch ⇒
  SYSTEM-level device control). The gate is now unconditional: anything
  reaching the dispatcher is authenticated, full stop. Two coverage holes
  found and closed on the way: `auth_401_without_token` used `req()` (which
  carries a WRONG token) so the genuinely-missing-header path was never
  exercised, and NO test enumerated the route surface — now
  `every_dispatch_route_is_auth_gated` walks 20 routes under both failure
  modes and `deliberately_public_routes_stay_public` pins `/`, the panel
  SPA and the static assets so an auth tightening cannot silently lock them
  out. Both pins mutation-proven (a broken classification is caught with
  "GET /api/spec served WITHOUT an Authorization header"; gating above the
  public returns is caught with "GET / must stay public"). Agent gates 438
  feat-gated / 431 default green, clippy -D warnings clean both configs, fmt
  clean, xwin check OK. Program ledger: docs/solid-program.md.
  No device rollout this round.

Previous round: 2026-09-10 SOLID-R101 — the device-tool FAILURE envelope
  (`{"ok": false, "error": msg}`) has an owner: `plugins::tool_error`. It was
  hand-written at 46 sites across four plugins (system 36, memory 7,
  connections 2, update 1); the migration is proven byte-identical
  MECHANICALLY (a string-aware extractor compared all 46 message expressions
  from HEAD against the new `tool_error(...)` arg — identical). Pinning the
  shape surfaced an undocumented cross-layer fact, now on record and tested:
  an in-band `Ok({"ok":false})` renders at `/api/tools` as
  `{"ok":true,"result":{"ok":false}}` — outer ok TRUE, no top-level `code` —
  while a typed `Err(DeviceError)` renders `{"ok":false,"error","code"}`. The
  gateway's round-58 check therefore classifies only the TYPED family as a
  failure; the in-band one is the long-standing MCP behaviour (the model reads
  the envelope as content) and is left unchanged, pinned so a future change is
  a visible decision. Agent gates 435 feat-gated / 428 default green, clippy
  -D warnings clean both configs, fmt clean, xwin check OK.
  Program ledger: docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R100 — the session-mode result cap is now a
  pure, tested unit. `bounded_append(result, truncated, s, max)` was the
  `append_result` closure inside the 622-line `tool_execute` wait loop, and it
  carried THREE incidents with zero coverage: round-105 (uncapped result
  growth OOM'd the agent on `yes`), round-113 (one oversized chunk bypassed
  the cap until the next append), and two char-boundary panics (round-106
  `String::drain`, review-#1 slice start) that abort the loop PAST
  `term_release_execute` — wedging the session busy flag forever. Now pure and
  unit-pinned by 7 tests; both boundary walks are mutation-proven (removing
  the walk-forward panics `start byte index 7 is not a char boundary ... inside
  '汉'`; removing the walk-back panics in `String::drain`). The wait-loop state
  machine stays inline deliberately — its rules read live session state and
  the 50 ms poll cadence. Agent gates 432 feat-gated / 424 default green,
  clippy -D warnings clean both configs, fmt clean, xwin check OK.
  Program ledger: docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R99 — the update BUSY MARKER is now
  one defined thing. Its path was spelled out twice (a Rust PathBuf join in
  `agent_update` + two hand-written string literals inside the generated
  PowerShell swap script), and the acquire/reclaim decision sat inline in the
  300-line handler closure with ZERO test coverage despite three recorded
  incidents. Now `BUSY_MARKER_REL` is the single definition behind
  `busy_marker_path()` (the acquirer) and `busy_marker_ps()` (the script),
  with a contract test pinning that both name the same file; the decision is
  `acquire_busy_marker(path, stale_after)` (atomic `create_new`, reclaim the
  stale marker at MOST once so a locked marker cannot spin). +4 pins,
  mutation-proven (dropping the reclaim-once flag HANGS the suite — timeout
  exit 124; changing the relpath or the join shape each fails the contract
  test). Behavior unchanged; agent gates 425 feat-gated / 417 default green,
  clippy -D warnings clean both configs, fmt clean, xwin check OK.
  Program ledger: docs/solid-program.md. No device rollout this round.

Previous round: 2026-09-10 SOLID-R98 (`28c7c71f`) — the pwout AI-evidence feed
  is now ONE owned module (`src/evidence.rs`, crate-private): actions.jsonl
  append + newest-first read, shot listing, basename guard and the
  `browser-actions-changed` push, replacing two inline producers (playwright
  `browser_run_script` + a mcp-client private helper), a mcp-client-private
  bus OnceLock and a hand-mirrored reader in web/mod.rs. The evidence dir is
  a PARAMETER now, so the contract is unit-tested against a temp dir (+9
  pins) while paths.rs keeps resolving it. Behavior unchanged; agent gates
  375 feat-gated / 368 default lib green, clippy -D warnings clean both
  configs, fmt clean, xwin check OK. Program ledger: docs/solid-program.md.
  Release/d1 state below is unchanged by this round (no device rollout).

Last release round: 2026-09-09 round-556 — current release **1.2.307 LIVE on d1
  (package.json + CDN version.json + GitHub release; last-5-per-minor prune
  active; Windows self-contained installer ValeAgent-Setup.exe on the CDN)**;
  e2e suite 47 checks; all matrices green. Rounds 273-317 in this log; the
  round log continues below (ROUND-319..556 inlined under "Current
  release"). ROUND-556 = first REAL installer log analyzed: the ValeDesktop
  step never ran on any version (PS argument-mode '+' bug — cmdlet args
  don't concat, both Set-Content -Value lines failed identically before and
  after the scripts\ move; d1's task came from update/Electron/manual),
  fixed by parenthesizing + line numbers in the catch; npm installs now
  register the control-panel entry (conditional UninstallString, elevated
  relaunch); console strings ASCII-only for GBK consoles; signing pipeline
  wired (cert-pending); playwright-zip box confirmed unbuilt by anything
  (fresh installs run browser-less by design so far — needs a 308-sized
  decision). 307 installer rebuilt (ps1-only, tgz untouched) + smoke green.
  NOT yet on a device: v2 migration + rollback + autostart ship as 1.2.308
  once the Windows sandbox run is green. Rounds 273-317 in this log.

### OPEN decisions (product sign-off needed — do NOT change without one)
- **settings_put invalid-JSON envelope: RESOLVED 2026-09-08** (was HTTP
  200 since the round-69 extraction; unified to HTTP 400 with product
  sign-off — api_settings_put now matches api_gateway_connect; test
  renamed to settings_put_invalid_json_returns_http400_envelope).
- **messages-passthrough og body-failure: RESOLVED 2026-09-08** (was a
  historical gap — relayUpstreamResult recordOgBodyFailure=false only on
  that arm; unified to true with product sign-off, all three arms now
  count body failures toward the breaker).
- **F3 relay-token scoping — STEP 1 SHIPPED 2026-09-08** (docs/adr/0007-
  scoped-relay-token.md, Option B approved): per-user relay credential
  (`role: "relay"`, `POST/DELETE /api/me/token/relay`); dual-accept on
  relay paths, /mcp + recovery stay admin-only. **Step 3 (revoking the
  admin token from relay paths) is still an operator cutover — do NOT
  code it without a new explicit sign-off + announced window.**

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
  ROUND-303 (2026-09-04): GitHub release synced to 1.2.275 — v1.2.272
  was the last CI-built release (round-289); 273/274/275 were CDN-only
  manual publishes. Tag v1.2.275 pushed via API -> release.yml ran GREEN
  (the round-299 tsc-compile-bin step's FIRST real run) -> gh release
  created with the 6.4MB tgz; keep-latest deleted v1.2.272 release+tag.
  Local tags re-synced (v1.2.272 backup dropped, v1.2.275 backed up).
  Lesson: after manual CDN publishes, mirror to GitHub via the tag API so
  the release chain + keep-latest stay current.
  ROUND-304 (2026-09-04, 1.2.276 LIVE on d1): /api/status now reports the
  npm RELEASE version — "version" was the Cargo crate version (1.0.145,
  protocol anchor) and never changed, so consumers saw 1.0.145 forever
  while the device ran 1.2.x. status adds "release" = <install>/.vale-
  release (written by BOTH swap paths, round-298/298b), omitted when
  absent. Device-verified: version=1.0.145 release=1.2.276.
  ROUND-305 (2026-09-04, 1.2.278 LIVE on d1): http auto-select session-
  recycle fix — 1.2.276's mcp e2e was 7/8 (http "drives embedded view"
  FAIL, stdio PASS). Diag ([select] RAW list result: null) showed the
  http arm's browser_tabs returned NULL on a recycled session (round-137
  reap) — auto-select lacked mcp_client_call's heal-first behavior, so
  every retry listed on the DEAD session forever. Fix: empty http list
  result -> heal_and_restore (re-handshake) before the next retry.
  1.2.277 shipped the raw-result diag; 1.2.278 the fix. Device-verified
  mcp 8/8 (http drives embedded view PASS again).
  ROUND-306 (2026-09-04): e2e mcp probes now disconnect BEFORE connect —
  a leftover connection from a previous run made connect return
  already_connected and the check fail spuriously (observed repeatedly on
  long-running devices during round-305). Each probe starts clean
  (disconnect + 1.5s settle). Device-verified: mcp e2e 8/8 TWICE in a row
  (repeated runs no longer accumulate state).
  ROUND-307 (2026-09-04): release-chain housekeeping — v1.2.278 GitHub
  release built GREEN by CI (round-299's tsc-compile step now proven on
  3 real releases: 275/276/278); keep-latest deleted v1.2.275+276
  releases AND tags; GitHub + local now hold ONLY v1.2.278. Full chain
  (CDN manual publish -> GitHub tag API -> CI build -> keep-latest) ran
  end-to-end for a multi-release week.
  ROUND-308 (2026-09-04): full e2e suite 26/26 on 1.2.278 — first
  complete run after the round-305/306 mcp fixes (terminal/file/workflow
  12 + panel/mcp/evidence 12 + browser 2). auto-select drives the
  embedded view on BOTH transports, evidence self-cleans, panel xterm
  shows AI output. All green on the current release.
  ROUND-309 (2026-09-04): CDN asset prune — index/public/vale-agent had
  accumulated 46+ old tgz (229-269 + 274-278; round-230's last-5 policy
  was never enforced on manual publishes — every release only cp'd the
  new file). Deleted 229-273 locally + wrangler deploy synced the CDN:
  old versions now 404, only 274-278 + latest remain. LESSON: run the
  last-5 prune on EVERY release; and shell case patterns for dotted
  versions must be exact (*-274.tgz does NOT match 1.2.274 — dot vs
  hyphen; 274-278 were briefly deleted locally, restored from CDN before
  deploy).
  ROUND-310 (2026-09-04): publish-release.sh — the round-309 prune lesson
  is now FORCED by tooling: scripts/publish-release.sh <ver> wraps the
  whole CDN publish (npm pack -> stage + latest alias -> version.json with
  sha256 -> last-5 prune -> commit -> wrangler deploy) with guards
  (package version match, staged exe). Prune uses a mapfile array — a
  space-padded string match fails on newline-separated items (caught the
  bug in verification before it could delete the wrong files).
  ROUND-311 (2026-09-04): publish-release.sh component-verified (guard
  rejects version mismatch exit 1; pack+stage+version.json update works;
  prune 0 false-deletes) + device consistency: electron main.js on d1
  (sha 4168c9e5, 54143B) byte-identical to the repo npm-package copy —
  no desktop-source drift after the 272->278 release week.
  ROUND-312 (2026-09-04): gateway + device hygiene sweep — gateway
  unchanged since 7f35c95b (no unpushed commits), tests 250/251 (1 skip =
  CF runtime), wrangler dry-run compiles, live /api/health all 20 channels
  ok. Device: 1 node proc only (9229 resident playwright), /api/sessions
  344 records 0 live zombies, agent 1.2.278 stable.
  ROUND-313 (2026-09-04): e2e mcp section now proves AI CLICK interaction
  drives the embedded view — not just navigation: each probe navigates to
  the example.com homepage, snapshots, clicks "Learn more" (browser_click
  {target}=snapshot ref) and verifies the view follows to iana.org. Suite
  26 -> 30 checks (mcp stdio 6 + http 6). Device-verified 12/12. Iteration
  lessons: marker URLs (example.com/<marker>) are 404 pages with no links
  — navigate home first; JSON.stringify double-escapes quotes (match the
  ref after the text, not the quoted literal).
  ROUND-314 (2026-09-04): post-round-313 hygiene — CI cdc25ccc GREEN
  (e2e changes don't affect CI jobs), device clean after the 30-check
  suite (1 node proc, 5 electron, no e2e png leftovers — pwout holds only
  real operation evidence), e2e.js identical across repo/GitHub/device
  (24048B @ a6a2bd84).
  ROUND-315 (2026-09-04): full 30-check e2e suite verified on 1.2.278 —
  terminal/file/workflow 12 + mcp 12 (incl. the round-313 click
  interaction) + panel/evidence/browser 6. All green; the expanded suite
  runs clean end-to-end on the current release.
  ROUND-316 (2026-09-04): gateway browser-click tests — round-138's
  element_ref->target conversion (old callers pass integer refs,
  playwright-mcp wants "eN" snapshot refs) had ZERO test coverage.
  Added 4: click int 7 -> target e7, click "e7" passthrough, click no
  element_ref forwards unchanged, type converts + keeps text. Gateway
  255 tests / 254 pass. (Real AI clients reach the device THROUGH this
  gateway path — the round-313 e2e click checks the direct path.)
  ROUND-317 (2026-09-04): CI 9d096d53 GREEN — round-316's gateway click
  conversion tests pass on CI (all 5 jobs incl. gateway test/typecheck).
  Local tsc --noEmit clean too.
### Current release
- npm **1.2.297 LIVE on d1 (round-308+; package.json)** — MCP connect auto-selects the
  embedded-view tab on BOTH transports (stdio 1.2.271 + http 1.2.278:
  desktop-CDP + browser_tabs guard, http arm heals recycled sessions
  round-305); /api/status reports the npm release (round-304). E2E suite
  agent/scripts/e2e/e2e.js 30 checks on d1 (round-315: terminal/file/
  workflow 12, mcp stdio+http 12 incl. click interaction, panel/evidence/
  browser 6). Release chain: publish-release.sh (round-310) + GitHub tag
  API -> CI-built release; CDN pruned to last-5 (round-309).
  ROUND-319 (2026-09-04): index download-page DEAD LINK fixed — the
  landing page's install command pointed at the DELETED 1.2.141 tgz on
  the Vercel mirror; every copy-paste install failed. Now uses the
  versionless latest alias (agent.saisi.online/vale-agent/
  vale-agent-latest.tgz, mirrored on every release). Deployed + verified
  (page shows working command, alias 200). No other dead dl refs remain.
  ROUND-320 (2026-09-04): build-installer.sh RETIRED (round-318 audit
  follow-up) — it always FAILED on the current architecture: required the
  retired Tauri vale-desktop.exe + vale-tray.exe, rewrote index/src/
  index.js (version constant / static sha256 / URL sed — obsolete since
  round-297's version.json manifest), staged to the dead Vercel mirror.
  build.sh deploy now deploys workers only (vercel-proxy kept: its
  /api/git mirror is LIVE; its dead dl/ staging of retired installers
  removed). All doc refs repointed at publish-release.sh; index/README
  rewritten for the npm-only architecture. -261 lines dead code.
  ROUND-321 (2026-09-04): electron src freshness GATE in release.yml —
  main/preload/url-policy .js are COMMITTED tsc artifacts (outDir=dist,
  package ships src/*.js) with NO freshness guard — a .ts edit without
  recompiling silently shipped the old main.js. Pack step now recompiles
  electron TS with the CI-installed tsc (typeRoots -> vale-agent-npm's
  @types) and FAILS if committed src/*.js differ. Verified locally: all
  3 identical (no drift). ALSO dropped the dead "vale-desktop.exe" entry
  from the npm files list (retired Tauri exe never enters CI tgzs);
  vale.ts keeps its existsSync-guarded optional paths. Cleaned 178
  local pack tgz junk.
  ROUND-322 (2026-09-04): round-321 gate cwd FIXED before it ever ran —
  the electron freshness gate invoked ./node_modules/.bin/tsc from
  agent/ (parent dir) where no tsc exists — would have failed every
  release. Now (cd vale-agent-npm && tsc -p ../vale-desktop-electron/
  tsconfig.json --typeRoots ./node_modules/@types) like the bin/vale.js
  compile. Full CI-equivalent simulation (typescript@5 @types/node@22
  installed): tsc exit 0, 3 artifacts IDENTICAL; stale artifact caught.
  ROUND-323 (2026-09-04): release.yml full-chain audit + pack simulation —
  walked every step's cwd assumptions (no further bugs; 85's bare `cd`
  is the only cwd change and everything after is npm-relative). Simulated
  the WHOLE pack chain locally: bin/vale.js compile+marker, electron
  freshness (3 IDENTICAL), npm pack, tgz 5/5 content gate — all PASS.
  Device health: release 1.2.278, cpu 1.3%, mem 67.6%, uptime 3974s.
  CI 9262ae6a GREEN. NOTE: /api/status fields are cpu_pct/mem_pct.
  ROUND-324 (2026-09-04): two build.sh deploy bugs found + fixed —
  (1) the index post-publish smoke grepped static version/sha256
  constants out of index/src/index.js that round-297 removed — EVERY
  build.sh index/deploy failed at the smoke (empty want_sha). Now reads
  index/public/vale-agent/version.json (the served source of truth);
  verified version+sha match live /api/version. (2) the gateway /code/
  source-viewer mirror drifted 17/17 files stale after round-320 deleted
  build-installer.sh (its only sync path). deploy_worker now syncs
  gateway/src into public/code/files/vale-gate before deploy; mirror
  synced to current immediately.
  ROUND-325 (2026-09-04): round-324 fixes DEVICE/DEPLOY-VERIFIED — real
  `build.sh gateway` run: code-viewer sync + wrangler deploy succeeded
  (7.47s, Version c07a2225). Live /code/ viewer on api.saisi.online now
  serves the CURRENT sources — sha256 of live mcp.ts and plugins/admin.ts
  IDENTICAL to the repo files (was 17/17 stale before round-324).
  ROUND-326 (2026-09-04): index deploy smoke VERIFIED live + dead exe
  purge — real `build.sh index` twice: smoke passed both times
  ("v1.2.278, binary sha verified", Versions 700375b1/fd27b0c2).
  ALSO: index/public/vale-agent held 3 dead non-git STAGING exes
  (vale-desktop.exe 8.5MB Tauri + vale-tray.exe 896KB + vale-agent.exe
  16MB — build-installer.sh leftovers, round-320 missed them). Deleted;
  assets now hold only tracked files + release tgzs (last-5 + latest).
  Redeploy synced: all 3 exes now 404 on the CDN.
  ROUND-327 (2026-09-04): product-side health round — panel vitest 82/82
  (16 files, Node 24 = CI panel job version) after the deploy-chain
  rounds; evidence feed healthy on d1 (actions 50 + pwshots 17, latest =
  the round-315 e2e browser_run_script with stdout TITLE=Example Domain);
  CI fc4e24d2 GREEN. No product regressions from the round-318..326
  release-chain cleanup.
  ROUND-329 (2026-09-04): iteration-log ORDER fixed — ROUND-287/288
  (release 1.2.272 CI fixes) sat after ROUND-299 (misplaced by an old
  edit); moved between 286 and 289. Live log now runs 273..317 in exact
  chronological order.
  ROUND-330 (2026-09-04): RETIRED CRATES DELETED — vale-tray/ and
  vale-desktop/ (Tauri) source trees removed (19 tracked files; git
  history retains them) + their 5.7GB of xwin target caches. build.sh
  agent no longer builds either (was minutes of dead work per run; CI
  builds vale-agent only). All four agent-facing docs updated.
  ROUND-331 (2026-09-04): vale.ts Tauri staging dead code removed —
  setup/update still staged vale-desktop.exe (retired Tauri shell) with
  existsSync guards that never fired (npm package stopped shipping it
  round-75; crate deleted round-330). -49 lines; bin/vale.js recompiled
  (round-298 discipline), tsc clean. taskkill lines stay as defensive
  cleanup for stale processes. Workflows verified free of retired refs.
  ROUND-332 (2026-09-04): round-331 verified end-to-end — npm CLI tests
  2/2 (node --test), bin/vale.js loads + syntax OK + exports intact
  (psq/busyIsFresh via require.main guard). Retired-ref scan complete:
  electron main/preload/url-policy clean (40 tray hits = the Electron
  SYSTEM TRAY feature, not vale-tray), workflows/build.sh clean, only
  historical refs remain (deploy/retired/, specs, memory client-id
  strings). Committed bin matches working tree.
  ROUND-333 (2026-09-04): repo hygiene — committed docs/agents/
  dsh-ops-troubleshooting.md (2026-08-27 dsh Web stability record: Node
  22 zstd leak, cloudflared pm2 recovery, CORS, anycast latency) and
  added .gitignore rules (.dsh-tmp-*, .zcode/, cloudflared-run.sh local
  pm2 launcher). Untracked files now ZERO.
  ROUND-334 (2026-09-04): full 30-check e2e suite re-verified on d1 after
  the round-318..333 cleanup marathon (mcp 12 + terminal/file/workflow
  12 + panel/evidence/browser 6 — all PASS, exit 0). Device hygiene:
  1 node + 5 electron, 0 e2e png leftovers (self-cleaning), release
  1.2.278. Repo-side cleanup caused ZERO product regressions.
  ROUND-335 (2026-09-04): stale-doc sweep — agent/README.md DELETED
  (retired Vale Command era: vale-tray build steps for a deleted crate,
  stale module map; no refs, zero unique info). gateway/
  DEVICE-INTEGRATION.md marked SUPERSEDED (2026-08 extension-era v2
  design) with banner → current design is
  docs/superpowers/specs/2026-08-28-vale-desktop-core-design.md; root
  AGENTS.md/CLAUDE.md design-doc refs updated. docs/research/* keep
  their Tauri-era notes (historical research records).
  ROUND-336 (2026-09-04): root README stale points fixed — install
  example pinned the DEAD vale-agent-1.2.179.tgz (→ versionless latest
  alias); "update (exe + bridge + electron)" (bridge removed round-265);
  extension row → Vale Studio Links (round-262); design-doc pointer →
  current desktop-core spec. "bridges to playwright" in the mcp-client
  description is the LIVE architecture (verb, not the bridge component).
  ROUND-337 (2026-09-04): doc-link integrity check — extension/README +
  index/README verified current (both clean); no dead cross-refs in any
  guide/README (remaining vale-agent-1.2.179 mentions are round-336's
  own history log). Live download paths all 200 (/, version.json,
  latest.tgz). CI 01f16da1 GREEN.
  ROUND-338 (2026-09-04): README tool-count drift fixed — claimed "37
  MCP tools"; the registry test (mcp_integration.rs) asserts 49 (system
  grew to 9 in round-340/341). Breakdown: terminal 26 + memory 6 +
  system 9 + mcp-client 4 + playwright 2 + update 1 + design 1; no
  other numeric claims drift in README.
  ROUND-339 (2026-09-04): gateway dead extension path removed from
  mcp.ts — callTool already returned for every tool name (round-161
  browser_* → playwright bridge); the trailing PluginHubDO → WS →
  browser-extension block was UNREACHABLE since round-262 deleted the
  extension. -38 lines + EXTENSION_OFFLINE constant. mcp-tools.ts head
  comment now describes the real path. Gateway 254 pass + tsc clean.
  OPEN: devices.ts still hosts extension-era pairing endpoints
  (pair/claim, ws-ticket, /ws, revoke, proxy plugin-token auth) — dead
  surface, larger removal, separate round.
  ROUND-340 (2026-09-04): gateway extension pairing endpoints REMOVED
  from devices.ts — handlePairClaim/handleRevoke/handleWsTicket/handleWs
  (public pair/claim, ws-ticket, ticket-gated /ws) + routes, all
  unreachable since round-262 deleted the extension. -107 handler lines
  + -188 total. Store helpers stay (admin handlePair + proxy
  getPluginByToken); plugins.test.mjs trimmed (13 remain, 251 pass);
  tsc clean. OPEN: console UI (DevicesPanel/app.js) still renders the
  Pair-extension button + download hint — user-visible dead feature,
  next round.
  ROUND-341 (2026-09-04): extension-era UI + PluginHubDO REMOVED — the
  round-262 extension deletion's last gateway surface: DevicesPanel Pair
  button/modal/Extension signal row, client.ts pairDevice, i18n pair/ext
  keys; /api/plugins/status dropped the PluginHubDO `online` field
  (agent_up/tunnel_up stay); devices.ts hub close-all calls; PluginHubDO
  class + wrangler binding/migration + tests deleted (BreakerDO/RouteDO
  stay); public/ pruned to the 2 referenced assets (17 stale bundles +
  dead app.js removed). -1831 lines. 243 gateway tests pass, tsc clean,
  render smokes OK. NOTE: gateway deploy needed for the binding removal
  to take effect (build.sh gateway). Round-340's proxy plugin-token auth
  path stays (defensive; device-token links still meaningful for delete/
  rename revocation).
  ROUND-342 (2026-09-04): round-341 gateway deploy — the first deploy
  FAILED: Cloudflare rejected the upload because the code no longer
  exports PluginHubDO while the DO class still exists remotely
  (code 10064 — needs an explicit delete-class migration). Added
  migration tag v4-delete-plugin-hub (deleted_classes) → deploy
  succeeded (Version ced6e1c7, 4.07s). Live verified: /api/health all
  channels ok, plugins/status 401-gated, /code/ viewer mirror 3/3
  byte-identical to repo (devices.ts/mcp.ts), routes normal. LESSON:
  removing a DO class requires a deleted_classes migration step in the
  SAME deploy — code-only removal fails upload.
  ROUND-343 (2026-09-04): spec currency pass — the two design specs
  still cited as current postdated the architecture: 2026-08-28-vale-
  desktop-core-design (Approved) gained a POST-APPROVAL CHANGES banner
  (round-264 real-browser replaced the ws-ticket JPEG stream; round-330
  Tauri shell deleted; round-341/342 gateway extension removed — the
  UI/dependency/install decisions still hold, agent/AGENTS.md is the
  current truth); 2026-08-06-device-ops-v2 (extension era) marked
  SUPERSEDED. Code-viewer mirror committed after round-341/342
  (4c5c25a6).
  ROUND-344 (2026-09-04): post-round-341/342 LIVE CHAIN VERIFICATION —
  console 302 (login), gateway /api/health 200 all channels, /mcp 401
  gate, d1 agent healthy (release 1.2.278, cpu 0.5%, mem 68.9%);
  device mcp e2e 12/12 (stdio+http auto-select + click) — gateway
  cleanup zero regression on the device path; live console UI assets
  byte-identical to repo + 0 pair code (new UI shipped with the
  round-342 deploy).
  ROUND-345 (2026-09-04): gateway dead pair/unpair + pair-code store
  functions REMOVED — handlePair/handleUnpair (admin /api/plugins/pair +
  /unpair) survived round-341's UI removal with no callers; store.ts
  addPluginLink/createPairCode/consumePairCode/createWsTicket/
  consumeWsTicket had zero src callers (links were only ever created by
  extension pairing). Link map (list/get/remove/save) stays — device
  delete/rename revocation + proxy getPluginByToken auth still use it.
  plugins.test.mjs: pair/ticket tests removed, link tests KV-seed with
  cache clears (11). 241 gateway tests pass, tsc clean. OPEN
  (conservative): proxy plugin-token auth branch stays until 30-day
  link TTLs expire.
  ROUND-346 (2026-09-04): round-345 gateway DEPLOYED (Version 52cd0dbc,
  6.77s) + live-verified: /api/health 20 channels ok, /api/plugins/pair
  now 404 (endpoint gone), /api/devices 401-gated. Code-viewer mirror
  committed (020931f7, -82 lines).
  ROUND-347 (2026-09-04): post-deploy e2e re-verification on d1 —
  terminal/file/workflow 12/12 + mcp stdio 6/6 + panel/evidence/browser
  6/6 (24/24 total; mcp http portion cut by terminal session timeout,
  device MCP path unchanged since round-344 full 12/12, not a regression).
  Device hygiene: 1 node + 5 electron, 0 e2e png leftovers, release
  1.2.278, uptime 10187s. Gateway cleanup fully verified on the device
  path.
  ROUND-348 (2026-09-04): FINAL dead-code scan — all gateway
  extension/pair/plugin-hub references are historical comments (round-340/
  341 deletion records, defense-in-depth notes); no live dead code remains.
  Proxy plugin-token auth branch (devices.ts:270-330) stays as conservative
  defense; no new links can be created (addPluginLink/handlePair deleted),
  existing links expire via 30-day TTL. OPEN item closed as "intended
  natural expiration".
  ROUND-349 (2026-09-04): full-repo stale-ref sweep — all Tauri/bridge/
  extension/vale-tray references are in historical docs (.superpowers/sdd/
  task reports, superseded DEVICE-INTEGRATION.md) or gitignored build
  artifacts; zero live code references. Cleanup marathon (round-318..349)
  VERIFIED COMPLETE.
  ROUND-350 (2026-09-06): register.rs unit tests committed (were uncommitted
  in tree) — self_register_plan url/body, pure-local None, name fallback;
  197 lib + feature-gated 201 pass, clippy/fmt clean. NOTE: box CC env
  points at a broken gcc10-root (missing cc1) — cargo needs
  env -u CC -u CXX -u CFLAGS (the gcc10-root note in root AGENTS.md is
  dsh-upgrade-only, NOT vale).
  ROUND-351 (2026-09-06): xwin RED -> GREEN — A7 refactor (d35873b0) moved
  self_heal/setup_child_reaper_job/ffi_service_main into winmain.rs as
  PRIVATE fns while main.rs called them unqualified: 3x E0425 on the
  Windows target. Linux test/clippy never saw it (cfg(windows) elided) and
  the 58-commit local stack was never pushed so CI never checked it.
  Fix: pub(crate) + winmain:: qualified calls; SCM dispatch wrapped as
  winmain::started_by_scm() (macro fn can't carry visibility) so main.rs
  no longer touches windows_service directly; dropped the unused LOG_FILE
  import. xwin check + full matrix green.
  ROUND-352 (2026-09-06): gateway matrix green (295/295 node --test, tsc,
  prettier, eslint) + code-viewer mirror re-synced. The mirror had drifted
  since the store/ + lib/ refactors: sync script copied only top-level +
  plugins/*.ts (subdirs silently dropped), dead sse-guard.ts still served,
  and the fail-closed redaction aborted on store.ts (the d1-host comment
  moved to store/devices.ts:30 in the split). Script now copies store/ +
  lib/ explicitly and redacts the new path; mirror verified byte-identical
  except the 3 intended comment redactions (error-copy strings keep the
  real host by design). Manifest 39 files, sse-guard gone.
  ROUND-353 (2026-09-06): full-repo matrix sweep, zero code changes — every
  suite green: index 54/54, panel vitest 90/90 (16 files, up from 82),
  proxies 12+7+7 (zen-go/zen-us/openrouter), npm CLI 3/3, extension
  node --check 3/3 + vercel-proxy gate 5/5 (mirrored from ci.yml),
  gateway/ui build + render smoke + devices render smoke OK, tree clean
  after builds. Combined with rounds 350-352 (agent 197/201 + xwin,
  gateway 295 + gates), ALL CI jobs now have a same-day local green.
  ROUND-354 (2026-09-06): ARCHITECTURE.md snapshot-vs-tree audit — 6 drift
  items fixed: +winmain.rs verdict row (A7 never updated the snapshot, rule
  breach), +device-fetch.ts to the gateway foundation list (5a54a804 only
  updated AGENTS/CLAUDE), studio retirement leftovers (overview line,
  foundation row, harness row, trade-off row, gate count all still
  described it as live; studio/ has zero tracked files), agent gate count
  221->233 (197 lib + 27 + 2 + 6 + 1), plugin breakdown 49 tools in the
  overview, orphaned studio comment in ci.yml above the proxies job.
  BONUS CATCH from mirroring the pack-chain job locally: npm-package
  electron copies of main.js/url-policy.js were STALE — missing the
  parsed-origin tripwire fix + portBusy probe (a security fix devices
  would never have received via vale update, which swaps these files).
  Synced from the tsc-fresh src/ copies; release-lib 11/11, bin marker +
  freshness + pack 6/6 all OK.
  ROUND-355 (2026-09-06): 65-commit stack PUSHED to GitHub (direct token
  URL, HTTP/1.1; ls-remote confirms main == local HEAD) — CI immediately
  paid off: 8/9 green incl. xwin check (round-351 fix validated) but
  gateway FAILED on install-chain test 140. Root cause: the posix test
  runs `vale check` with ambient HOME — vale reads settings FIRST and the
  box HAS ~/.claude/settings.json, so locally it reached the health probe
  while CI runners (no such file) died at the settings read. Fix: temp
  VALE_SETTINGS ({env:{}}) in the check-run env; verified locally AND
  with empty HOME (CI simulation), full gateway 295 green. Pushed via the
  proxy (small increment) and discovered the sync is BIDIRECTIONAL —
  GitHub picked it up without a second push. Re-run CI: SUCCESS (9/9).
  LESSON: any CLI test that reaches past readSettings must pin
  VALE_SETTINGS — ambient HOME is a hidden test dependency.
  ROUND-356 (2026-09-06): F3 decision material ready —
  docs/adr/proposal-scoped-relay-token.md (unnumbered proposal per ADR
  convention, NOT 0007). Tree-verified blast radius: the admin token is
  relay x-api-key (translate.ts:183) + /mcp Bearer admin
  (terminal_execute/secret_*/browser on any device, mcp.ts:32-45) +
  session-less password bootstrap/reset (admin.ts, auth.ts:192-214), all
  seeded from legacy CLIENT_KEY (store/admin.ts:57,95). Per-user BYOK is
  correctly scoped (own-keys-only reveal, masked admin lists) — out of
  scope. Options A–D with B (scoped relay role, staged dual-accept)
  recommended; 3 explicit questions for the human. No behavior changed —
  implementation waits for sign-off. Also fixed ADR README drift (missing
  0006 row, singular proposal-* wording) and repointed the F3 Next line.
  ROUND-357 (2026-09-06): memory capacity policy actually works end to end.
  Found: config `memory:` (max_entries/max_bytes/retention_days) was
  documented-but-never-read (state.rs always passed MemoryLimits::default)
  AND the retention branch had zero tests AND retention only ran on
  mutation (quiet devices kept expired records forever). Fix:
  MemoryConfig{all-Option}+effective() in core (0 treated as absent),
  state.rs builds limits from it, new() enforces on open before compact.
  Tests: config parse/partial/zero + cross-crate default-twin pin +
  retention on insert/on open/None-keeps-old. Matrix: lib 201 (+4),
  feat-gated 205, clippy x2 + fmt + xwin clean; snapshot count 233->237.
  Self-caught mid-round: a truncated edit fragment (fixed immediately) and
  clippy derivable_impls on the manual Default (derived instead). OPEN
  (later round): memory limits not yet in GET/PUT /api/settings panel GUI.
  ROUND-358 (2026-09-06): closed the round-357 OPEN item — memory capacity
  editable in Settings end to end. Agent: MemoryStore.limits behind RwLock
  (+limits()/set_limits() with documented no-nesting lock order), GET
  reports memory_max_entries/_bytes_mb/_retention_days, PUT accepts the
  same keys (absent = unchanged, 0/null/"" clears retention) with live
  retune + config.yaml persist in one step; web test covers roundtrip +
  clear + restore (sole-writer discipline, restores shared defaults).
  Panel: Memory card gains 3 inputs + validated Save (PUTs retention null
  when cleared), GET prefill, copy updated; new SettingsPage.test.tsx 3/3.
  Matrix: agent lib 202, clippy x2 + fmt + xwin clean, panel 93/93 (17
  files) + build clean incl. committed panel.js; snapshot 237->238.
  Round-7 CI (memory wiring) SUCCESS on GitHub.
  ROUND-359 (2026-09-06): terminal error-propagation audit. Production
  terminal code has zero unwrap/expect (all in tests); SFTP IO as Internal
  is legitimate; one misclassification found: terminal_connect_saved
  "unknown saved connection" used Internal for a caller error (exec's
  "unknown job_id" correctly uses InvalidParams). Fix: InvalidParams +
  known-id list for self-recovery (mirrors ctx::session_lost), incl. the
  empty-store hint. Tests: 2 feature-gated cases via a new
  #[cfg(all(test, feature))] TEST_DIR re-export (follows the file's cfg
  boundary rule); default suite unaffected (202), feat-gated 206->208,
  clippy x2 + xwin clean; snapshot feat count updated.
  ROUND-360 (2026-09-06): gateway translate-domain audit — routing/breaker/
  401 coverage was deep (67 tests) but TWO security properties had zero
  pins: disabled-user relay access and cross-user key isolation (the exact
  property the F3 proposal claims is "correctly scoped"). Added 4 tests in
  gateway.test.mjs with a two-user isoEnv (distinct tokens — module cache
  + F1 buckets forbid reuse): alice/bob header-level key proof on the og
  translate path, no-borrow 502 (alice keyless while bob keyed, upstream
  never called), disabled → 401 with no upstream call. Suite 295->299,
  prettier clean; snapshot count updated. Round-9 CI SUCCESS on GitHub.
  Tooling note: a heredoc append silently went nowhere once this round —
  file-tool edits only for test appends from now on.
  ROUND-361 (2026-09-06): device-proxy domain audit — deviceHostError IP
  forms had 5 tests but deviceFetch ITSELF (the round-120/121 SSRF fix:
  authority-prefix gate, hostname-equality, header hygiene) had zero
  direct tests (only indirect mcp-handler exercise). Added 7 in
  device-fetch.test.mjs via a globalThis.fetch stub (works through
  fetchWithTimeout): @evil + scheme → 400 with upstream never called,
  query-@ passes verbatim (round-121 narrowing), host/cookie stripped +
  device Bearer injected + other headers pass, uppercase registration
  hostname dials, private hostname 400, unreachable → 502 with reason.
  Suite 299->306, tsc/eslint/prettier clean; snapshot count updated.
  ROUND-362 (2026-09-06): session_log audit — 8 tests covered torn repair,
  prune, seq, recovery, writer cap, output cap, but trim_file (rounds
  98-100/116: streaming tail, last-start preservation, atomic temp+rename)
  and list_sessions (the /api/sessions surface) had ZERO tests. Added 2:
  close-trim (first command drained, last start kept, 2002-line cap =
  header + 2000 + preserved start, head drops from index 1, recovery still
  flags interrupted) + list_sessions row shape (2 rows, non-jsonl ignored,
  exit_code/status folded). Caught my own off-by-one in the cap bound
  (2001 vs 2002) before committing. Matrix: lib 204, feat-gated 210,
  clippy x2 + fmt + xwin clean; snapshot 238->240.
  ROUND-363 (2026-09-06): pack-chain periodic replay (round-4's catch
  still holding, zero drift): release-lib 11/11, bin round-298 marker OK,
  electron tsc-fresh 3/3 + npm-package copies in-sync 3/3, bin/vale.js
  fresh, npm pack 6/6 subset gate (artifacts cleaned, tree verified
  clean), npm CLI 3/3. No code changes — pure verification round.
  Rounds 10–11 CI SUCCESS on GitHub (round-12 queued at push time).
  ROUND-364 (2026-09-06): devices TokenGate consistency audit — all 10
  devices.ts handlers gate uniformly (requireSession + 401/403), verified
  by reading each head; only rename/install-cmd had per-route gate tests.
  Added one matrix test over all 9 admin routes (list/add/mcp/delete/
  panel-grant-mint/register-keys/revoke/install-cmd/register-key):
  no-session → 401, non-admin → 403, plus a no-mutation assertion on the
  shared env. Fixed my own undici GET-with-body slip before committing.
  Suite 306->307; snapshot count updated.
  ROUND-365 (2026-09-06): mcp_client framing audit — every MCP call flows
  through parse_envelope/check_envelope/is_session_gone/truncate, all four
  had ZERO tests. Added 7 (direct result, SSE id-match + stale-only miss,
  error/garbage/notification, check arms, session-gone signals,
  char-boundary truncate). REAL FIND: the direct arm never checked the
  response id (SSE arm does) — a stale frame with the wrong id was
  accepted. Fixed with the same id discipline both arms + regression
  test. Matrix: lib 211 (+7), feat-gated 217, clippy x2 + fmt + xwin
  clean; snapshot 240->247.
  ROUND-366 (2026-09-06): panel-auth TokenGate review — found a latent
  split: TokenGate held a BOOT-time token clone while /api/* reads the
  live snapshot (audit A4), so a runtime rotation would stale-accept the
  old token on /mcp and reject the new one. Verified no production path
  rotates the token today (PUT/gateway-connect preserve by construction),
  then removed the hazard anyway: TokenGate now holds Arc<AppState> and
  reads config_snapshot() per request. Proof: new
  mcp_gate_follows_runtime_token_rotation integration test (ephemeral
  bind, old works → update_config rotate → old 401s + new works; fails
  on the old code by construction). Matrix: integration 6->7, clippy x2
  + fmt + xwin clean; snapshot 247->248.
  ROUND-367 (2026-09-06): gateway mcp.ts dispatch audit — auth/initialize/
  call-mapping/error-codes deeply covered but 6 dispatch arms had zero
  pins: ping echo, unknown method (-32601), unknown tool (-32602, no
  network touched), no-devices guidance (-32602, no dial), unparseable
  body (-32700), non-GET/POST (405). Added 6 in mcp-handler.test.mjs
  (existing post()/makeEnv harness). Suite 307->313; snapshot updated.
  ROUND-368 (2026-09-06): desktop-core spec currency pass — verified the
  cited backend contract first (/api/sessions/{sid} exists and is live).
  Fixed 5 drift items: §3 Settings row (memory "notes" → editable
  entries/MiB/retention, round-358), §7 journey 6, §2 contract (web.rs →
  web/ + /api/sessions list), §9 registry writer (NSIS → vale setup),
  §11 Tauri bullet moot (deleted round-330); banner gains the 357/358
  line. Docs-only, no gates affected. (Log hygiene: this entry first
  landed as a duplicate ROUND-367 and was renumbered on sight.)
  ROUND-369 (2026-09-06): mcp-browser bridge audit — routing/self-heal/
  click-conversion covered, but the documented guardrails had zero pins:
  timeout_secs clamp (M2), unknown-tool passthrough, private-hostname
  gate, and the 4-slot SESSION_BUSY semaphore. Added 4 in
  mcp-browser.test.mjs (direct callTool harness, existing makeFetch):
  clamp 99999→300 / 0→1 / 12.9→12, verbatim passthrough, hostname gate
  fires pre-fetch with DEVICE_UNREACHABLE, deterministic 5th-call
  SESSION_BUSY via a gated stub (no timers). Suite 313->317; snapshot
  updated.
  ROUND-370 (2026-09-06): system plugin audit — file_upload (round-341)
  and process_kill had ZERO tests (only name-presence in the build
  test). Added 5: upload missing/dir rejects, full POST roundtrip
  against a single-shot local HTTP stub (Bearer + multipart + bytes +
  manifest echo), unreachable-gateway fail-closed, kill arg validation +
  bogus pid/name fail-clean. Caught real issues pre-commit: parallel env
  cross-talk (fixed with ONE module-level tokio Mutex — fn-local statics
  would be distinct locks) + clippy type_complexity/await_holding_lock
  (CapturedUploads alias + async mutex). Stable 15/15 x3. Matrix: lib
  216 (+5), feat-gated 222, clippy x2 + fmt + xwin clean; snapshot
  248->253.
  ROUND-371 (2026-09-06): web/sse.rs contract audit — the loss-tolerant
  stream (epoch-first, lagged fallback, headers) + guard cycle had ZERO
  tests. Added 6 (pre-queued broadcast + sender-drop, zero timers; the
  30s heartbeat arm stays untested by design): SSE headers, epoch-first
  then Closed ends stream, FIFO order, lagged(3) + surviving tail
  (corrected my broadcast assumption pre-commit: lagged receivers keep
  the newest 2), guard acquire/release + dual-hold. Deliberately no
  drain-to-None test — the pool is process-global and endpoint tests
  (term_sse_streams_output) hold real guards. Stable 37/37 web x3.
  Matrix: lib 222 (+6), feat-gated 228, clippy x2 + fmt + xwin clean;
  snapshot 253->259.
  ROUND-372 (2026-09-06): memory sanitize audit — strategies partly
  unpinned + docs overstated. Added 3 (bare Bearer arm, trailing-newline
  contract, JSON arrays + typed values) and split a weak || into per-arm
  asserts — which immediately caught TWO stale claims: "authtoken abc123"
  (space, no separator) never redacted, and "masterkey" is NOT matched
  by compact-ends-with ("key" alone can't be a signal — monkey/turkey).
  Fixed both comments to the honest contract (prose-safe by design,
  precision over recall). Matrix: lib 225 (+3), feat-gated 231, clippy
  x2 + fmt + xwin clean; snapshot 259->262.
  ROUND-373 (2026-09-06): state.rs A4 audit — config_snapshot/update_config
  are load-bearing for TokenGate + PUT /api/settings yet had ZERO tests.
  Added 6: boot snapshot, memory-only swap, persist-without-path no-op,
  file roundtrip (disk yaml matches memory), failed-persist atomicity
  (dead dir → Err + memory stays at old value — the write-through
  guarantee), poisoned-writer recovery. All green first try. Matrix:
  lib 231 (+6), feat-gated 237, clippy x2 + fmt + xwin clean; snapshot
  262->268.
  ROUND-374 (2026-09-06): bootstrap.rs boot-path audit — create/quarantine/
  token-recovery carries SIX incident fixes (57/104/119/121/138/140) with
  ZERO tests. Added 8: missing→create+mint-once (second boot no rotation),
  valid untouched, missing-token mint+persist, corrupt→quarantine+line
  recovery, device_token>auth_token + space-colon + last-wins + comment
  strip, proxy_secret carried, secret-less recovery mints+persists,
  atomic_write roundtrip. All 8 green first try — every incident claim
  holds. Matrix: lib 239 (+8), feat-gated 245, clippy x2 + fmt + xwin
  clean; snapshot 268->276.
  ROUND-375 (2026-09-06): mcp/server.rs surface audit — get_info, tool
  conversion, bind DNS had only get_tool presence pins. Added 4: handshake
  identity (name/version/instructions/static-tools cap), schema
  passthrough on a real tool, localhost→loopback bind, unresolvable host
  fails loud (the dark-device fix). Also corrected a FALSE comment
  claiming panic isolation was "verified by list_tools_via_http" (it
  never exercised call_tool; the arm is defensive-only — zero unwrap in
  production per round-359). Fixed my own Cow as_ref ambiguity
  pre-commit. Matrix: lib 243 (+4), feat-gated 249, clippy x2 + fmt +
  xwin clean; snapshot 276->280.
  ROUND-376 (2026-09-06): mcp_client http-arm audit — rpc_ref_http
  (session capture, header hygiene, 16MiB cap, empty/500 mapping) +
  track_page_url had ZERO tests (only framing/summary pins). Added 7
  against single-shot local stubs: initialize captures session id,
  caller headers ride but mcp-session-id/content-type never override,
  empty→Null, 500→truncated error, >16MiB rejected, track sets http
  last_url on marker + ignores ftp/absent. Fixed pre-commit: owned stub
  headers (spawn 'static), Arc clone, parse_envelope returns the result
  body (not the envelope). Stable 20/20 x3. Matrix: lib 250 (+7),
  feat-gated 256, clippy x2 + fmt + xwin clean; snapshot 280->287.
  ROUND-377 (2026-09-06): filelog rotation audit — only the size trigger
  was pinned; prune cap, append-resume accounting, day buckets untested.
  Added 3: 900 KiB pre-existing + 200 KiB write rotates (metadata seeds
  the cap — no fresh megabyte per restart), 5 priors + 1 rotation prunes
  to exactly 3 (newest priors + live stamp survive), day_bucket UTC
  boundaries. Matrix: lib 253 (+3), feat-gated 259, clippy x2 + fmt +
  xwin clean; snapshot 287->290.
  ROUND-378 (2026-09-06): metrics audit — the CPU-delta math lived inline
  in cfg(windows) code (untestable on Linux; xwin only compiles).
  Extracted pure cpu_busy_pct (same saturating semantics) + tests: 50%/
  0%/100% bounds, zero-tick→None (not NaN), counter-regress→None; plus
  the non-Windows all-None degradation contract (was vacuously covered).
  xwin confirms the refactor compiles on Windows. Matrix: lib 255 (+2),
  feat-gated 261, clippy x2 + fmt + xwin clean; snapshot 290->292.
  ROUND-379 (2026-09-06): web/panel.rs surface audit — whitelist, hash
  stamping, token escaping, grant shape/redeem had zero DIRECT tests
  (only endpoint-level). Added 6: content-type map, 6 known files 200 +
  8 hostile names 404 (traversal/query/whitespace), exactly-once hash
  stamp with vendor css untouched, token shape (200/html/no-store) +
  </script> breakout escape, grant 16..128 hex bounds, redeem true ONLY
  on explicit ok:true (false/missing/500/dead-gateway all false). All
  green first try. Matrix: lib 261 (+6), feat-gated 267, clippy x2 +
  fmt + xwin clean; snapshot 292->298.
  ROUND-380 (2026-09-06): paths.rs resolution audit — the registry-first
  chain (install/data/sessions/node) had only the unix harden pin.
  Added 6: exe-dir non-empty, install→exe fallback, data→install
  default, sessions nesting, node None, harden-missing errors (plus two
  doc lines that read as if `vale setup` itself were retired). Cached
  public fns untestable repeatedly → pins target compute_* + structure.
  Matrix: lib 267 (+6), feat-gated 273, clippy x2 + fmt + xwin clean;
  snapshot 298->304.
  ROUND-381 (2026-09-06): update plugin audit — version/newer/hex pinned
  but cleanup_staged (the never-mix-versions guard) + version_url had
  zero tests. Added 3: staged .new files + .vale-update gone while all
  4 live files stay byte-identical, empty-dir noop, manifest URL shape.
  Matrix: lib 270 (+3), feat-gated 276, clippy x2 + fmt + xwin clean;
  snapshot 304->307.
  ROUND-382 (2026-09-06): playwright supervisor audit — manager + bundle
  discovery had ZERO tests (spawning untestable in CI, but the no-spawn
  paths weren't pinned either). Added 8: one sequential status test
  (fresh→stopped→external-running→released, round-132 branch),
  stop-noop, bundle/node resolution errors, now_ms, pw_version shapes,
  node path join, 2-tool build. Caught my own 9229 parallel flake
  pre-commit (merged + documented). Stable 9/9 x5. Matrix: lib 278
  (+8), feat-gated 284, clippy x2 + fmt + xwin clean; snapshot 307->315.
  ROUND-383 (2026-09-06): design plugin audit — REAL DRIFT FOUND: the
  page_view schema enum + description still advertised the 10
  round-262-deleted extension pages (every selection a guaranteed
  "unknown page" error). Fixed enum + description + stale doc line to
  the 9 live pages. Added 5 tests: loopback-only gate (incl. IPv6/empty
  rejects), token redaction (multi/unterminated), table uniqueness +
  schema-enum parity (fails on any future drift), HTTP truncation +
  redaction over a stub, unknown/remote-unconfigured fail-closed.
  Matrix: lib 283 (+5), feat-gated 289, clippy x2 + fmt + xwin clean;
  snapshot 315->320.
  ROUND-384 (2026-09-06): vale-command-core EventBus audit — seq/ring/
  eviction/epoch/hook contract had ZERO tests despite feeding /api/
  events + SSE. Added 9: monotonic seq, cursor filters + zeroed empty,
  poll_after snapshot, 256-ring eviction with detectable gap (+ the
  RING_CAP>=broadcast-cap invariant), hook args, per-boot epoch nonce,
  term fan-out, wire shape, in-order broadcast. Snapshot formula now
  counts the core binary explicitly (was silently 2): 320->331 (+11
  core). Clippy x2 + fmt + xwin clean.
  ROUND-385 (2026-09-06): core remainder audit — DeviceError code table
  (the gateway's retry-routing contract) + recover_guard (the
  codebase-wide poison path) had zero pins. Added 4: all 9 codes,
  Display detail, clean lock, poisoned recovery preserving data.
  Snapshot core 11->15 (total 331->335); agent matrix unchanged green.
  ROUND-386 (2026-09-06): gateway auth.ts primitives audit — PBKDF2,
  safeEq, CSRF predicate, HMAC sessions, cookie helpers had zero DIRECT
  tests (only handler-level). Added 13 in auth.test.mjs: hex shape,
  hash determinism + verify accept/reject/salt-bound, safeEq arms, CSRF
  matrix (safe methods/bearer path/same-origin+none+missing pass,
  same-site+cross-site fail, vale_pt_ family), session roundtrip +
  wrong-secret/tamper/malformed/expiry-distinct, padding restore,
  cookie parse/headers. Suite 317->330; tsc/eslint/prettier clean;
  snapshot updated.
  ROUND-387 (2026-09-06): gateway session.ts flow audit — secret
  preference, fail-closed issuance, cookie accept/revoke/tamper/
  disabled/rotation, admin triple had zero DIRECT tests. Added 11 in
  session.test.mjs (distinct ids for the module cache). Suite 330->341;
  tsc clean; snapshot updated.
  ROUND-388 (2026-09-06): panel-grant store audit — handler paths dense
  but store edges (TTL, uppercase, shape-no-read, corrupt records,
  delete) had only indirect coverage. Added 7: ~120s TTL on the KV
  record, keyless mint no-throw, uppercase normalization, malformed
  codes cost zero KV reads, corrupt/empty records → null (mintedAt 0),
  keyless get/delete no-throw, delete removes. Suite 341->348;
  tsc/eslint/prettier clean; snapshot updated.
  ROUND-389 (2026-09-06): full-repo matrix sweep, zero code changes —
  every suite green same-day: agent lib 283 + core 15 + 27+2+7+1,
  feat-gated 289, clippy x2 + fmt + xwin clean; gateway 348 + tsc +
  eslint + prettier; index 54/54; panel vitest 93/93 (17 files);
  proxies 12+7+7 (node --test per CI, no npm-test script exists);
  npm CLI 3/3; extension 3-file node --check; vercel-proxy 5/5 syntax
  gate; gateway/ui build + render smoke + devices smoke OK; tree clean
  after builds. (Wrangler dry-runs left to CI — needs account creds.)
  No code changes — pure verification round.
  ROUND-390 (2026-09-06): store/users.ts helpers audit — token shape,
  username lookup, invites, masking, registration guards had zero
  direct pins (only cache-behavior + handler paths). Added 6:
  48-hex unique tokens, trim+cache username lookup, 10-char invite
  with 7-day TTL (opts captured), maskKey shapes, status parity over
  all managed keys (unmanaged never appear), registration fail-closed
  chain (name/password/duplicate/invite). Suite 348->354;
  tsc/eslint/prettier clean; snapshot updated.
  ROUND-391 (2026-09-06): regkeys/settings edges audit — create shape/
  TTL, delete edges, listRegKeys live-filter, globalSettingEnabled
  matrix unpinned. Added 4 (TTL opts captured, empty/keyless no-ops,
  expired-but-unreaped filtered via _expiry backdate, on/off matrix).
  Self-caught a whitespace-merge slip mid-round (reverted clean, tree
  verified). Suite 354->358; tsc/eslint/prettier clean; snapshot
  updated.
  ROUND-392 (2026-09-06): plugin-link map audit — lifecycle covered but
  sweep persistence, legacy expiry, corrupt blobs, write-through only
  had return-value pins. Added 4: expired get DELETES the KV record
  (30d const pinned), missing-expiresAt legacy sweeps (round-122 hole),
  corrupt blob → all five helpers safe, save write-through serves
  post-KV-yank. Fixed a dynamic-import slip pre-commit. Suite 358->362;
  tsc/eslint/prettier clean; snapshot updated.
  ROUND-393 (2026-09-06): device-registry store audit — upsert secret
  preservation (106), insert takeover guard (122), rename rules,
  seen write-budget, corrupt KV tolerance, cf token had zero DIRECT
  tests. Added 8 in devices-store.test.mjs: corrupt/non-array/missing
  → empty, secret keep/replace, duplicate insert refused, delete
  booleans, rename preserve + guards, seen writes only on
  version-change/hour-stale (put-counter pinned), cf roundtrip/clear/
  keyless, keyless save no-op. Suite 362->370; tsc/eslint/prettier
  clean; snapshot updated.
  ROUND-394 (2026-09-06): admin-seed audit. REAL FIND (test-caught):
  seedAdmin's v1 migration moved user:u-admin → user:admin + remapped
  the token + moved ukeys, then fell through to the fresh-mint block
  (no marker on v1 upgrades) which CLOBBERED it all — new random token,
  ukeys reset to {}, orphaned token:V1TOK mapping still authenticating.
  Fix: mint only when no user:admin exists post-migration/backfill.
  Added 4: legacy CLIENT_KEY honored, random mint, v1 migration keeps
  token + keys (regression), process-once + keyless no-op. Suite
  370->374; tsc/eslint/prettier clean; snapshot updated.
  ROUND-395 (2026-09-06): Access SSO audit. REAL FIND: disabled
  Access-bound users still resolved — bound path fell through to the
  provision re-check with no enabled check (cookie path rejects
  disabled; Access users unsuspendable). Fix: null on disabled, no
  re-provision (fresh suffix would defeat suspension). Added 2: disabled
  stays out + no shadow account, JWT malformed matrix (parts/garbage/
  kid/iss/email/unconfigured). Suite 374->376; gates clean; snapshot
  updated; pushed.
  ROUND-396 (2026-09-06): body-scan injector audit — rawWithTopLevelField
  + provider/reasoning injectors (hot-path string surgery on every
  relayed body) had zero DIRECT tests. Added 7: string/object replace,
  append separators (empty/bare/spaced), nested same-name untouched,
  in-string field-name trap, non-object passthrough, provider +
  reasoning shapes incl. client-sent respected. Suite 376->383; gates
  clean; snapshot updated; pushed.
  ROUND-397 (2026-09-06): limiter boundary audit — factory KV semantics
  pinned but trip point, window reset, unknown-bucket, fail-open, 4096
  cap unpinned. Added 4 (limit+1 trips + per-IP isolation, rollover
  resets, headerless shares unknown + null/throw fail open, eviction
  restarts count). Caught my own shared-bucket slip pre-commit (fresh
  instance for fail-open probes). Suite 383->387; gates clean; snapshot
  updated; pushed. CI: 396 run SUCCESS.
  ROUND-398 (2026-09-06): MCP resolution audit. REAL FIX (small): no-name
  + several devices answered "No devices registered" — wrong guidance.
  Now names them ("specify device: d1, d2", round-160 spirit). Added 5:
  single-device fallback executes, typo'd name never executes (I6a),
  multi-device guidance (regression), tools/list shape, dial failure →
  -32603 + {code} data (corrected my data-shape assumption pre-commit).
  Suite 387->392; gates clean; snapshot updated; pushed. CI: 397 SUCCESS.
  ROUND-399 (2026-09-06): heal-layer remainder audit — zero-live/multi-
  live guidance, data-URL image unwrap (118), timeout-vs-unreachable
  mapping had zero direct pins. Added 4: zero-live points at
  terminal_open, multi-live lists without guessing (no retry asserted),
  image block shape, TIMEOUT vs DEVICE_UNREACHABLE. Suite 392->396;
  gates clean; snapshot updated; pushed.
  ROUND-400 (2026-09-06): bridge remainder audit — "session not found"
  heal arm (132), non-JSON failure shape, slot release after failure
  unpinned. Added 3: idle-reclaim heals start→connect→retry, 502 body
  → "mcp_client_call failed: 502", 4 failures release slots (next call
  serves, not BUSY). Suite 396->399; gates clean; snapshot updated;
  pushed.
  ROUND-401 (2026-09-06): agent main.rs audit — binary target had ZERO
  tests. Extracted mask_token + unknown_key_warnings (pure text list;
  wrapper only logs), removed a stale audit-row comment, added 5 bin
  tests (mask long/short/boundary, clean silent, top+nested flags,
  non-mapping/missing/invalid/list safe). Full matrix: lib 283 + bin 5
  + 27+2+7+1, core 15, feat 289, clippy x2 + fmt + xwin clean; snapshot
  335->340; pushed.
  ROUND-402 (2026-09-06): upstream route-table audit — pickRoute/
  stripBracket/passthroughHeaders (every /v1 call flows through) had
  ZERO direct tests. Added 5 in upstream.test.mjs: bracket strip,
  per-prefix kind/upstream incl. qw/ format split + default no-strip,
  amd/ always direct under egress, F4 injection encoding, header modes.
  Fixed my own via()-base slip pre-commit (usProxyBase, not the param).
  Suite 399->404; gates clean; snapshot updated; pushed.
  ROUND-403 (2026-09-06): degraded-cache audit — isChannelDegraded TTL,
  trip invalidation, fail-open, reset/success paths unpinned (only the
  classifier had unit pins). Added 5: 5s verdict cache + re-read, closed
  + DO-error fail-open false, trip invalidates immediately, reset hits
  endpoint + keyless no-throw, upstreamTimeoutMs direct. Suite 404->409;
  gates clean; snapshot updated; pushed.
  ROUND-404 (2026-09-06): proxy rewriter audit — decodeDeviceName +
  rewriteDeviceBody (every proxied panel asset flows through) had zero
  direct pins. Added 2: decode/decoded/malformed, mount insert for
  quote/backtick/`}` + token scrub both quotes + no double-prefix +
  bare-text untouched. Rewrote my own convoluted draft pre-commit (use
  the file's static imports). Suite 409->411; gates clean; snapshot
  updated; pushed.
  ROUND-405 (2026-09-06): front-door audit — bare /models + /chat/
  completions aliases, http→https 308, never-leak 500 had zero direct
  pins. Added 4 in frontdoor.test.mjs: alias parity (list deep-equal,
  chat status+body identical), 308 Location shape, 500 message + no
  CONSOLE_HOST leak. Suite 411->415; gates clean; snapshot updated;
  pushed.
  ROUND-406 (2026-09-06): model-usability audit — isModelUsable (every
  model=auto resolution flows through it) had zero DIRECT tests. Added
  4: whitelist + env-key channels, round-68 user-key-counts, nv/gmi
  pure-BYOK ignores env, og breaker + cm/amd keyed/keyless. Fixed my own
  guessed-id tautology pre-commit (real MODELS ids). Suite 415->419;
  gates clean; snapshot updated; pushed.
  ROUND-407 (2026-09-06): fallback-chain audit — resolveAutoModel's
  round-100 first-usable loop only had the default-ds path pinned.
  Added 5 (chainEnv harness): no-ds→qw, og-only→flash, or-only→luna,
  keyless last-line guarantee, chosen-but-unusable enters the chain.
  Suite 419->424; gates clean; snapshot updated; pushed.
  ROUND-408 (2026-09-06): RouteDO audit — auth gates pinned but CRUD +
  error paths (roundtrip, null-delete, 400s, 404, 500, unauth) had zero
  direct pins. Added 5 in route-do.test.mjs. Suite 424->429; gates
  clean; snapshot updated; pushed.
  ROUND-409 (2026-09-06): saved-connection edges — corrupt-file recovery
  + list sort/id shape unpinned (3 tests covered dedup/scrub/forget).
  Added 2 (feat-gated): torn file lists empty + remember heals, 3-entry
  sort order + kind/target/id shape. Full matrix: feat lib 289->291,
  clippy x2 + fmt + xwin clean; snapshot 340->342; pushed.
  ROUND-410 (2026-09-06): panel stripAnsi audit — the ANSI scrubber all
  text surfaces depend on had ZERO tests. Added 5: SGR, cursor/clear,
  OSC titles + 133 markers, unterminated-OSC-at-EOF, stray ESC +
  undefined. Panel suite 93->98 (17->18 files); test-only, no panel.js
  rebuild; pushed.
  ROUND-411 (2026-09-06): BreakerDO remainder — half-open single-failure
  re-trip (round-118), stale-window re-anchor, storage-throw 500 had
  zero pins. Added 3 in reliability.test.mjs. Suite 429->432; gates
  clean; snapshot updated; pushed.
  ROUND-412 (2026-09-06): secrets key_of audit — normalization only
  exercised indirectly via CRUD. Added 1 direct pin: :22 collapse both
  ways + trim, non-22 distinct, userless→root. BONUS: build.rs STALE-
  panel gate fired on round-410's test file (watches whole src dir) —
  rebuilt, panel.js byte-identical, gate honest. Matrix: lib 283->284,
  feat 291->292, clippy x2 + fmt + xwin clean; snapshot 342->343;
  pushed.
  ROUND-413 (2026-09-06): panel theme audit — get/set/toggle/subscribe
  had ZERO tests. Added 5: default light, stored dark, garbage→light,
  persist+body+event+unsub, toggle both ways, storage-throw fail-safe.
  Self-caught: vitest toEqual takes no message arg (tsc gate). Panel
  98->103 (18->19 files); rebuilt, panel.js identical; pushed.
  ROUND-414 (2026-09-06): panel ErrorBoundary audit — the round-161
  white-panel fix had ZERO tests. Added 4: healthy passthrough, crash
  card + message, empty-message fallback, reload wiring + state reset
  (reload mock clears the fault, standing in for the remount). REAL
  FIND (test-caught React behavior): React retries a once-throwing
  mount before the fallback commits — transient first-render throws
  self-heal, boundary trips only on persistent throws. Panel 103->107
  (19->20 files); rebuilt, panel.js identical; pushed.
  ROUND-415 (2026-09-06): panel CommandCard audit — duration/state
  helpers + card/stream interactions had ZERO tests. Added 9:
  fmtDuration edges, cardState matrix, running auto-expand, ended
  collapsed + toggle, select vs toggle stopPropagation, selected class,
  clipboard copy + execCommand fallback, stream empty/count/select.
  Self-caught mid-round: overwrote 414's ErrorBoundary file with my
  stale draft — reverted immediately, verify-exists-before-write from
  now on. Panel 107->116 (20->21 files); rebuilt, panel.js identical;
  pushed.
  ROUND-416 (2026-09-06): panel TabBar audit — tab activate/export/
  close-confirm/view-switch had ZERO tests. Added 5: closed-tab no-op
  + honest title, export stopPropagation, two-step close arm/execute/
  cancel, no close affordance for savedOnly/closed, view-switch gated
  on active session. Panel 116->121 (21->22 files); rebuilt, panel.js
  identical; pushed.
  ROUND-417 (2026-09-06): panel IconRail audit — page buttons, theme
  toggle, conn dot had ZERO tests. Added 5: 5 pages + active marking,
  page notify, toggle flip + persist + remount-read, dot on/off,
  desktop density classes. Panel 121->126 (22->23 files); rebuilt,
  panel.js identical; pushed.
  ROUND-418 (2026-09-06): panel Icon-set audit — the single glyph set
  had ZERO tests (a name without a PATHS entry renders an empty svg).
  Added 3: all-19-names completeness, size/stroke contract, BrandMark
  gradients. Panel 126->129 (23->24 files); rebuilt, panel.js
  identical; pushed.
  ROUND-419 (2026-09-06): panel DetailsPanel audit — inspector rows had
  ZERO tests. Added 4: empty hint + close wiring, ended-card rows
  (command/status/exit/duration/params/output/copy), running
  placeholders, failed exit+reason. Panel 129->133 (24->25 files);
  rebuilt, panel.js identical; pushed.
  ROUND-420 (2026-09-06): panel Shell audit — density layout + page
  contract had ZERO tests. Added 4: PAGES/labels, panel rails +
  bottom-bar status (round-161), optional-rail omission, desktop hides
  ctx/status. Panel 133->137 (25->26 files); rebuilt, panel.js
  identical; pushed.
  ROUND-421 (2026-09-06): panel PluginsPage audit — catalog + playwright
  card had ZERO tests. Added 6: loading, search + filtered pill
  (round-161), singular/plural + enabled, load error, card states
  (pending/stopped/running + port + Start wiring), busy labels +
  verbatim error log. Self-caught x2: clicked disabled Start (mock
  never fires — click the enabled one), helper missed top-level
  playwright field (tsc gate). Panel 137->143 (26->27 files);
  rebuilt, panel.js identical; pushed.
  ROUND-422 (2026-09-06): panel ContextRail audit — side rail had ZERO
  tests. Added 6: null on context-less pages, plugins inventory +
  loading, open-first/newest sort + closed no-op + Enter, 4-kind menu,
  inline rename (commit/cancel/blank), archive + relTime. Self-caught:
  button/input share aria-label — locate inputs by display value.
  Panel 143->149 (27->28 files); rebuilt, panel.js identical; pushed.
  ROUND-423 (2026-09-06): panel TerminalWorkspace audit — the shared
  terminal page had ZERO tests. Added 6: empty state, reconnect
  banner, view-switch + notify, Logs drawer select/deselect/close,
  desktop density (no tab bar), controlled-view honor. Self-caught a
  vacuous final test pre-commit (replaced with a real controlled-value
  assertion). Panel 149->155 (28->29 files); rebuilt, panel.js
  identical; pushed.
  ROUND-424 (2026-09-06): gateway admin-ops audit — cf-token/invite/
  enable had ZERO pins (password paths were covered). Added 3:
  token shape 400s + masked roundtrip + clear, invite code + 401,
  malformed-id/admin/bob enable guards. Suite 432->435; gates clean;
  snapshot updated; pushed.
  ROUND-425 (2026-09-06): round-366 follow-up — the TokenGate boot-clone
  FIX had zero regression pins. Added 1: rotate via update_config →
  old Bearer 401 + new 200 on BOTH check_auth (/api) and TokenGate
  (/mcp, stub inner). Fix verified still in place (live snapshot).
  Matrix: lib 284->285, feat 292->293, clippy x2 + fmt + xwin clean;
  snapshot 343->344; pushed.
  ROUND-426 (2026-09-06): tunnel parser audit — hand-rolled UUID scanner
  + NAME-column matcher were nested inside provision_tunnel (ZERO
  tests, unreachable). Hoisted both to module level verbatim, added 3:
  canonical find (create + table shapes), 5 reject shapes, name-column
  match/miss/header/garbage-id. Matrix: lib 285->288, feat 293->296,
  clippy x2 + fmt + xwin clean; snapshot 344->347; pushed.
  ROUND-427 (2026-09-06): filelog remainder — day-change rotation arm +
  flush path had ZERO pins (cap/prune/resume/bucket covered). Added 2:
  backdated-bucket rotates under cap + live content intact, flush
  persists. Self-caught a bad edit mid-round (deleted 2 comment lines
  — restored immediately, diff-verified no-op). Matrix: lib 288->290,
  feat 296->298, clippy x2 + fmt + xwin clean; snapshot 347->349;
  pushed.
  ROUND-428 (2026-09-06): gateway http-helpers audit — jsonOk/jsonError/
  readJson (every plugin builds on these) had ZERO direct pins. Added
  3 in cors.test.mjs: shape + header merge, error envelope, valid/
  empty/invalid bodies. Suite 435->438; gates clean; snapshot updated;
  pushed.
  ROUND-429 (2026-09-06): gateway registry audit — the MODELS whitelist
  + health/US-proxy/route tables had ZERO structural pins (a typo'd id
  misroutes silently). Added 5 in registry.test.mjs: unique/owned/
  known-prefix ids, health cards ⊆ whitelist, US-proxy ⊆ whitelist,
  priority coverage + https endpoints, ROUTE_INFO prefix cover. Suite
  438->443; gates clean; snapshot updated; pushed.
  ROUND-430 (2026-09-06): panel MemoryPage audit — the knowledge UI had
  ZERO tests. Added 7 (mocked callTool): mount list, search tag-pass
  (round-161) + empty→list, two-step delete + toast, inline edit save,
  create required-fields + memory_save, export lines + copy toast,
  backend-error surface. Panel 155->162 (29->30 files); rebuilt,
  panel.js identical; pushed.
  ROUND-431 (2026-09-06): panel EmbeddedBrowserPane audit — the real-
  browser controller had ZERO tests. Added 7 (mocked valeEmbedded):
  init state + bounds report, nav-event sync, https-default submit +
  scheme reject, back/fwd wiring, crash banner + recover, zoom factor,
  bridgeless placeholder. Panel 162->169 (30->31 files); rebuilt,
  panel.js identical; pushed.
  ROUND-432 (2026-09-06): panel TerminalPane audit — mount/wiring plus
  overlays had ZERO tests. Added 5 (real xterm, mocked callTool):
  registerWrite + adopt read, write callback reaches terminal, font
  persist + 9/22 clamp + reset, searchbar open/Esc close, inactive
  hides + drops overlays. tsc gate caught 2 slips (Session fields,
  mock.calls tuple) before commit. Panel 169->174 (31->32 files);
  rebuilt, panel.js identical; pushed.
  ROUND-433 (2026-09-06): panel remainder sweep — StatusBar + BrowserPage
  were the last two components with ZERO tests (all others covered).
  Added 4: live count singular/plural/hidden, error styling + reconnect
  chip, bridge→embedded controller, bridgeless→desktop hint. Panel
  174->178 (32->33 files); rebuilt, panel.js identical; pushed.
  ROUND-434 (2026-09-06): gateway mcp-errors audit — the stable failure
  code family clients retry on had ZERO direct pins. Added 1 in
  mcp.test.mjs: codes distinct + UPPER shape, ToolErr instanceof Error
  with code + message. Suite 443->444; gates clean; snapshot updated;
  pushed.
  ROUND-435 (2026-09-06): pack-chain periodic replay (last 363) — REAL
  FIND: `npm run build` (the documented sole build path, born 4.5h ago
  in 3825c0df) NEVER worked: `npx -y typescript@5 -p <proj>` lets npx
  eat tsc's -p/outDir flags (npm 11: "must supply a command"; --package
  form can't resolve the tsc bin either). Only bash -n had ever checked
  it. Fix: `npm exec --yes --package typescript@5 -- tsc -p …` (verified
  exit 0; rebuilt artifacts byte-identical = zero drift). Replay otherwise
  green: electron url-policy 4/4, npm CLI 3/3, pack dry-run 6/6 files,
  stale local tgz 293-296 cleaned; pushed.
  ROUND-436 (2026-09-06): console UI audit — zero unit tests (CI only
  tsc+build+smoke). Beachhead: maskToken pin in ui/test/format.test.mjs
  (empty/short/long/no-middle-leak; self-caught a wrong short-shape
  expectation) + `"test": "node --test"` script + CI ui job unit step.
  Caught the repo convention along the way: bare `node --test` (gateway/
  index style) — `node --test test/` dies MODULE_NOT_FOUND. Pre-existing
  nit noted, untouched: ui/package.json lacks trailing newline (gate only
  covers src/). Pushed.
  ROUND-437 (2026-09-06): coverage-driven auth audit — node coverage
  flagged plugins/auth.ts (45%). PUT /api/me/keys (BYOK save) had ZERO
  pins. Added 2 in plugins.test.mjs: 401/400×3 validation, save-trimmed
  + masked echo + reveal roundtrip. Suite 444->447; gates clean.
  COUNTING CLARIFIED (worktree-verified): bare `npm test` also counts
  test/helpers.mjs as a pseudo-test and now discovers ui/test/ — 447 =
  445 files + helpers + ui. True file sum HEAD 443 -> 445 (+2 mine).
  Snapshot updated; pushed.
  ROUND-438 (2026-09-06): register-route audit — POST /api/auth/register
  had ZERO route pins (store-level createUser covered, handler not).
  Added 2 in plugins.test.mjs: invite→200 + cookie + login roundtrip,
  bad-invite/short-pw/duplicate→400, no-secret→500 fail-closed. Rate
  budget checked (16 < 30/min shared IP bucket). Suite 447->449
  (counting model from 437 holds exactly); gates clean; snapshot
  updated; pushed.
  ROUND-439 (2026-09-06): settings write-path audit — setGlobalSetting
  had ZERO pins. REAL FIND while pinning: boolean true persisted as "0"
  (String(true)="true" ≠ "1") — a silent toggle inversion for any
  boolean caller. Fixed truthfully (no live bytes change: sole caller
  passes "1"/"0"). Added 2 in store.cache.test.mjs: 1/0/null/""/delete
  canonical chain + write-through read + env-var fallback. Suite
  449->451; gates clean; snapshot updated; pushed.
  ROUND-440 (2026-09-06): self-register audit — handleSelfRegister
  (round-158 anti-hijack endpoint) had ZERO route pins. Added 4 in
  devices.test.mjs: 400/403/400 validation + no-mutation, new-device
  insert + idempotent refresh, hostname-move/unproven-rotation 409s,
  stored-tunnel proof rotates (date kept). Suite 451->455; gates clean;
  snapshot updated; pushed.
  ROUND-441 (2026-09-06): register-chain audit — /api/register +
  /api/install/tunnel-token had ZERO route pins. Added 3 in
  devices.test.mjs: garbage-403 zero-write + spend-once, existing-name
  409 (round-68), tunnel-token once-only + grant-fed register. Caught
  mid-round: shared 10/min/IP gate 429'd my own tests — per-test IPs
  via cf-connecting-ip (req() gained an ip option). Suite 455->458;
  gates clean; snapshot updated; pushed.
  ROUND-442 (2026-09-06): logout-write audit — the blacklist write had
  ZERO direct pins (only verify-side). Added 1 in plugins.test.mjs:
  sess-revoked record + 24h-capped TTL (round-122/124 lessons) +
  client-cookie clear + revoked cookie 401s a gated route. Suite
  458->459; gates clean; snapshot updated; pushed.
  ROUND-443 (2026-09-06): me-routes audit — /api/me/usproxy +
  /api/me/token/regenerate had ZERO route pins. Added 2 in
  plugins.test.mjs: 401/403 + toggle roundtrip + explicit-OFF persist
  (round-94 e2e), rotate-kills-old. Self-caught: helper dropped env
  (500s, isolated-probe comparison found it). Suite 459->461; gates
  clean; snapshot updated; pushed.
  ROUND-444 (2026-09-06): keys-DELETE audit — DELETE /api/me/keys had
  ZERO route pins (store-level covered, handler not). Added 1 in
  plugins.test.mjs: 401/400 + query-param delete empties the key map.
  Suite 461->462; gates clean; snapshot updated; pushed.
  ROUND-445 (2026-09-06): me-route audit — GET/PUT /api/me/route had
  ZERO route pins. Added 1 in plugins.test.mjs: 401s, whitelist 400,
  store→GET→clear roundtrip, effective-mirrors-stored. Self-caught:
  effective is null without stored route (no resolver wiring in test).
  Suite 462->463; gates clean; snapshot updated; pushed.
  ROUND-446 (2026-09-06): keys-test audit — POST /api/me/keys/test had
  ZERO route pins (per-provider live probes). Added 2 in
  plugins.test.mjs: gates + missing-key + deepseek/amd/openrouter
  shapes, og SSE ok/no-data/throw arms. Suite 463->465; gates clean;
  snapshot updated; pushed.
  ROUND-447 (2026-09-06): admin-fallback audit — getAdminPassword's
  keyless-env branch had ZERO pins. Added 1 in
  admin-seed-backfill.test.mjs: empty→"", secret→legacy:hash +
  verify roundtrip true/false. Suite 465->466; gates clean; snapshot
  updated; pushed.
  ROUND-448 (2026-09-06): sweep-lock audit — the corrupt-fresh-read arm
  had ZERO pins. Added 1 in plugins.test.mjs: racing corrupt re-read →
  null, 2 KV gets, no writeback. Suite 466->467; gates clean; snapshot
  updated; pushed.
  ROUND-449 (2026-09-06): index coverage to 100% lines — safePageUrl's
  catch arm was the last gap. Added page-helpers.test.mjs (https/
  loopback matrix, throw→fallback). REAL FIND while pinning: the
  `host === "::1"` disjunct is dead (WHATWG never yields bare ::1) —
  removed. Index 54->56, page.js 100/100/100; pushed (snapshot tracks
  gateway/agent only).
  ROUND-450 (2026-09-06): provider-arm audit — CMD/GMI/NV/QWEN testKey
  arms had ZERO pins. Added 1 in plugins.test.mjs: ok shapes +
  upstream-401 shape. Suite 467->468; gates clean; snapshot updated;
  pushed.
  ROUND-451 (2026-09-06): register-limiter audit — the 429 arm had ZERO
  pins. Added 1 in plugins.test.mjs: 30×400 then 429 on a fresh
  per-IP bucket. Self-caught: garbage invite is 400 here (403 is the
  devices self-register path). Suite 468->469; gates clean; snapshot
  updated; pushed.
  ROUND-452 (2026-09-06): login-gate audit — burst 429 + unknown-user
  burn arms had ZERO pins. Added 1 in plugins.test.mjs: 10×401 then
  11th 429. Self-caught: jsonError nests the message under
  error.message. Suite 469->470; gates clean; snapshot updated; pushed.
  ROUND-453 (2026-09-06): reset-limiter audit — the 429 arm had ZERO
  pins. Added 1 in plugins.test.mjs: 30×400 then 429 on a fresh
  per-IP bucket. Suite 470->471; gates clean; snapshot updated; pushed.
  ROUND-454 (2026-09-06): me-surface audit — GET /api/me success path
  + logout malformed-cookie arm had ZERO pins. Added 2 in
  plugins.test.mjs: identity + key-status shape, bad-cookie 200 +
  clear. Self-caught×2: key status is {configured, masked}, not bool.
  Suite 471->473; gates clean; snapshot updated; pushed.
  ROUND-455 (2026-09-06): probe-arms audit — testKey OR ok/fail, og
  non-ok, usage throw had ZERO pins. Added 2 in plugins.test.mjs.
  Suite 473->475; gates clean; snapshot updated; pushed.
  ROUND-456 (2026-09-06): usage-map audit — AMD spend-cap + OG window
  mappings had ZERO pins. Added 1 in plugins.test.mjs: exact mapped
  shapes incl. junk-field stripping. Suite 475->476; gates clean;
  snapshot updated; pushed.
  ROUND-457 (2026-09-06): final-arms audit — logout 429+clear, AMD/OG
  usage throws, AMD non-JSON had ZERO pins. Added 2 in
  plugins.test.mjs. plugins/auth.ts now ~98% (rest is route-unreachable
  defense). Suite 476->478; gates clean; snapshot updated; pushed.
  ROUND-458 (2026-09-06): devices-surface audit — list/add/mcp success
  paths had ZERO pins (only gates). Added 1 in devices.test.mjs:
  empty→add→masked list→mcp 404/200 (raw token only in the snippet).
  Suite 478->479; gates clean; snapshot updated; pushed.
  ROUND-459 (2026-09-06): delete/redeem audit — DELETE revocation +
  grant-redeem matrix + KV-fail-closed had ZERO pins. Added 3 in
  devices.test.mjs. Self-caught: req() already prefixes Bearer.
  Suite 479->482; gates clean; snapshot updated; pushed.
  ROUND-460 (2026-09-06): rotation-proof audit — tunnel-proved rotation
  + new-device secret capture had ZERO pins. Added 1 in
  devices.test.mjs: proof accepts, secret/date preserved, capture on
  insert. Suite 482->483; gates clean; snapshot updated; pushed.
  ROUND-461 (2026-09-06): claim-arms audit — key-register 400, rename
  bad-hostname 400, tunnel claim 403 + vanishing-key cleanup had ZERO
  pins. Added 2 in devices.test.mjs. Suite 483->485; gates clean;
  snapshot updated; pushed.
  ROUND-462 (2026-09-06): race/upload audit — insert-race 409 +
  admin-session upload had ZERO pins. Added 2 in devices.test.mjs.
  Suite 485->487; gates clean; snapshot updated; pushed.
  ROUND-463 (2026-09-06): bound/gate audit — upload 413 + public-gate
  429 had ZERO pins. Added 2 in devices.test.mjs. Self-caught: raw
  Request needs the SESSION_COOKIE name, not the bare token. Suite
  487->489; gates clean; snapshot updated; pushed.
  ROUND-464 (2026-09-06): admin-surface audit — public route, password
  set-status, session-gated change arms had ZERO pins. Added 2 in
  security-fixes.test.mjs. Self-caught×3: comma-operator paren slip,
  seed process-once re-arm, sessions sign with SESSION_SECRET. Suite
  489->491; gates clean; snapshot updated; pushed.
  ROUND-465 (2026-09-06): registry-framework audit — dispatch/route/
  emit/on had ZERO direct pins. Added 2 in registry.test.mjs:
  first-match/null/skip + delivery/unsub/throw-swallow. Suite 491->493;
  gates clean; snapshot updated; pushed.
  ROUND-466 (2026-09-06): body-scan audit — escape arms in keys/values
  had ZERO direct pins. New body-scan.test.mjs (3 tests: span, escapes,
  null shapes). Suite 493->496; gates clean; snapshot updated; pushed.
  ROUND-467 (2026-09-06): http-foundation audit — loopback/origin catch
  arms had ZERO direct pins. New http.test.mjs (loopback matrix +
  allowlist/P2 rule). Suite 496->498; gates clean; snapshot updated;
  pushed.
  ROUND-468 (2026-09-06): access-arms audit — JWKS-throw, disabled
  admin-email, provision-race had ZERO pins. Added 3 in
  access.test.mjs. Suite 498->501; gates clean; snapshot updated;
  pushed.
  ROUND-469 (2026-09-06): proxy-nav audit — 302 mint, non-nav 401,
  HTML expiry page, cookie auth/malformed had ZERO pins. Added 4 in
  proxy-auth.test.mjs. Suite 501->505; gates clean; snapshot updated;
  pushed.
  ROUND-470 (2026-09-06): strip-guard audit — the JSON proxy_secret
  strip arms (round-104 escalation guard) had ZERO pins. Added 1 in
  proxy-auth.test.mjs: stripped/intact/verbatim. Suite 505->506; gates
  clean; snapshot updated; pushed.
  ROUND-471 (2026-09-06): csrf-gate audit — the frontdoor 403 arm had
  ZERO route pins (unit-only). Added 1 in frontdoor.test.mjs: cross-site
  403, same-origin 401, reads never gated. Self-caught×2: need a real
  route + seeded password (empty env 500s). Suite 506->507; gates clean;
  snapshot updated; pushed.
  ROUND-472 (2026-09-06): usable-fallback audit — the getUserKeys-throw
  arm had ZERO pins. Added 1 in health.test.mjs: KV outage → unusable,
  never throws. Self-caught: ds has an env-key fallback, assert on qw.
  Suite 507->508; gates clean; snapshot updated; pushed.
  ROUND-473 (2026-09-06): probe-route audit — the /api/vale-probe 429
  arm had ZERO route pins. Added 1 in health.test.mjs: 60×200 then 429
  on a fixed IP. Suite 508->509; gates clean; snapshot updated; pushed.
  ROUND-474 (2026-09-06): timeout-fallback audit — the "timed out"→TIMEOUT
  message arm had ZERO pins. Added 1 in mcp-handler.test.mjs. Suite
  509->510; gates clean; snapshot updated; pushed.
  ROUND-475 (2026-09-06): divert audit — browser_run_script/pw_info
  device path (not the bridge) had ZERO pins. Added 1 in
  mcp-browser.test.mjs. Self-caught×3: real Response stub, Bearer lives
  in deviceFetch, callTool returns the envelope. Suite 510->511; gates
  clean; snapshot updated; pushed.
  ROUND-476 (2026-09-06): static-branch audit — off-host 404 + ASSETS
  proxy arms had ZERO pins. Added 1 in frontdoor.test.mjs. Self-caught:
  a no-op edit merged two lines (fixed immediately after). Suite
  511->512; gates clean; snapshot updated; pushed.
  ROUND-477 (2026-09-06): bootstrap audit — the no-password short-pw 400
  arm had ZERO pins + freshEnv never reset the seed flag (my new test ate
  the next test's seed). Added 1 in security-fixes.test.mjs, freshEnv now
  calls __resetSeedForTests. Suite 512->513; gates clean; snapshot
  updated; pushed.
  ROUND-478 (2026-09-06): coverage-table audit — translate.ts lowest at
  76.5%. Pinned the stream-ignored arms in gateway.test.mjs: JSON
  upstream → one-shot SSE, error envelope → 502. Lesson: no exploratory
  edits (a no-op probe merged lines again — reverted, then read-then-
  edit). Suite 513->515; gates clean; snapshot updated; pushed.
  ROUND-479 (2026-09-06): vision audit — the or/ passthrough arms had ZERO
  pins (only og/zen exercised). Added 2 in translate-vision.test.mjs:
  no-key throw, !ok throw + success insert. Suite 515->517; gates clean;
  snapshot updated; pushed.
  ROUND-480 (2026-09-06): transform audit — toOpenAIRequest had ZERO
  direct pins. Added 3 pure-function tests in reliability.test.mjs:
  system-array/tool_result-array, thinking+tool_use, tools+tool_choice.
  Suite 517->520; gates clean; snapshot updated; pushed.
  ROUND-481 (2026-09-06): retry audit — the billing-guard no-retry arm +
  the trip-failure swallow arm had ZERO pins. Added 2 in
  reliability.test.mjs. Suite 520->522; gates clean; snapshot updated;
  pushed.
  ROUND-482 (2026-09-06): smuggling audit — the URL round-trip mismatch
  arm had ZERO pins. Added 1 in mcp-browser.test.mjs: port/userinfo/path
  hostnames → DEVICE_UNREACHABLE, zero dials. Suite 522->523; gates
  clean; snapshot updated; pushed.
  ROUND-483 (2026-09-06): inspect audit — the retry inspect hook had ZERO
  pins. Added 3 in reliability.test.mjs: reject-then-accept/in-band,
  throwing inspect, response swap. CORRECTION: round-481's billing test
  duplicated an existing pin (lines 62-69) — removed; that round's real
  gain was 1 test, not 2. Suite 523->525; gates clean; snapshot updated;
  pushed. LESSON: grep-read existing tests before pinning an "uncovered"
  arm.
  ROUND-484 (2026-09-06): reasoning audit — reasonTextOf sources +
  tool_use fallback arms had ZERO pins. Added 2 in
  reliability.test.mjs: reasoning/reasoning_details, tool_calls incl.
  malformed/unknown. Suite 525->527; gates clean; snapshot updated;
  pushed.
  ROUND-485 (2026-09-06): dispatch audit — the unknown-/v1/-path 404 arm
  had ZERO pins. Added 1 in gateway.test.mjs. Suite 527->528; gates
  clean; snapshot updated; pushed.
  ROUND-486 (2026-09-06): empty-stream audit — the non-SSE error arm had
  ZERO pins. Added 1 in reliability.test.mjs: explicit error event, no
  message_start. Suite 528->529; gates clean; snapshot updated; pushed.
  ROUND-487 (2026-09-06): mixed-block audit — passthrough + empty-data
  arms had ZERO pins. Added 1 in translate-vision.test.mjs. Noted: the
  failure strip leaves a trailing ")" on all messages (pre-existing
  cosmetic wart, out of scope). Suite 529->530; gates clean; snapshot
  updated; pushed.
  ROUND-488 (2026-09-06): byok audit — the or/ keyless 502 arm had ZERO
  pins. Added 1 in gateway.test.mjs (isoEnv undefined-key trick). Suite
  530->531; gates clean; snapshot updated; pushed.
  ROUND-489 (2026-09-06): og-fail audit — fetch-throw + bad-JSON arms had
  ZERO pins. Added 1 in translate-vision.test.mjs (shared env proves no
  failure caching). Suite 531->532; gates clean; snapshot updated;
  pushed.
  ROUND-490 (2026-09-06): choice audit — the lone-web_search auto-choice
  arm had ZERO pins (explicit choice was covered). Added 1 in
  gateway.test.mjs. Suite 532->533; gates clean; snapshot updated;
  pushed.
  ROUND-491 (2026-09-06): REAL FIND — getGlobalSetting US_PROXY read threw
  on KV outage, failing all vision preprocessing (every other KV read on
  the path is best-effort). Fix: .catch(()=>null) at the caller (direct
  default). Added 1 test (KV-down describe still succeeds). BONUS: mirror
  resync caught 4 files of prior-round drift (access/mcp/store-admin/
  store-settings). Suite 533->534; gates clean; snapshot updated;
  pushed.
  ROUND-492 (2026-09-06): encoder audit — mid-stream error + tail-parse
  arms had ZERO pins. Added 2 in reliability.test.mjs. Discipline slip:
  caught myself starting a pointless async-probe edit twice — reverted
  both, did the real work read-first. Suite 534->536; gates clean;
  snapshot updated; pushed.
  ROUND-493 (2026-09-06): sse-build audit — toSSE thinking +
  server_tool_use arms had ZERO pins (zero direct tests). Added 2 in
  reliability.test.mjs. Slipped into the no-op-probe habit once more
  (trailing-space edit) — reverted before the real edit; the committed
  diff is clean (verified via git diff --stat). Suite 536->538; gates
  clean; snapshot updated; pushed.
  ROUND-494 (2026-09-06): backfill audit — the late id/name arm had ZERO
  pins. Added 1 in reliability.test.mjs (args-first chunk, meta later;
  no "unknown"). Clean round: no probe edits, diff verified. Suite
  538->539; gates clean; snapshot updated; pushed.
  ROUND-495 (2026-09-06): responses audit — the model guard had ZERO pins.
  Added 1 in gateway.test.mjs. Found the route-kind arm unreachable
  (og恒opencode, defensive-only — documented in-test, not pinned).
  Suite 539->540; gates clean; snapshot updated; pushed.
  ROUND-496 (2026-09-06): keyless audit — nv/gmi/amd/cm 502 arms had ZERO
  pins. Added 1 matrix test in gateway.test.mjs (4 arms, no upstream).
  Suite 540->541; gates clean; snapshot updated; pushed.
  ROUND-497 (2026-09-06): pacing audit — the retry-after header arm had
  ZERO pins. Added 1 in gateway.test.mjs. Self-caught×2: the messages
  branch never passes it (chat path only) + Retry-After:7 costs 14s
  (used 1). Suite 541->542; gates clean; snapshot updated; pushed.
  ROUND-498 (2026-09-06): nv-fail audit — the translate failure mapping
  had ZERO pins. Added 1 in gateway.test.mjs (503/message/pacing).
  Self-caught: this branch never adopts upstream types (api_error by
  design). Suite 542->543; gates clean; snapshot updated; pushed.
  ROUND-499 (2026-09-06): dsqw audit — the ds/qw passthrough keyless arms
  had ZERO pins. Added 1 matrix test in gateway.test.mjs (2 arms, no
  upstream). Suite 543->544; gates clean; snapshot updated; pushed.
  ROUND-500 (2026-09-06): REAL FIND — translate-path og-key guard was
  unscoped: cm/ with valid CMD key but no og key 502'd (branch only sends
  cmdKey). Fix: scope to opencode kind. Proven by stash-revert (89/90
  without, 90/90 with). Mirror resynced. Suite 544->545; gates clean;
  snapshot updated; pushed.
  ROUND-501 (2026-09-06): breaker audit — the translate-path circuit-open
  arm had ZERO pins. Added 1 in gateway.test.mjs (open breaker → 502,
  no dial; degraded-cache cleared first). Suite 545->546; gates clean;
  snapshot updated; pushed.
  ROUND-502 (2026-09-06): count audit — the count_tokens keyless guards
  had ZERO pins. Added 1 matrix test in gateway.test.mjs (ds/qw/amd, no
  upstream). Suite 546->547; gates clean; snapshot updated; pushed.
  ROUND-503 (2026-09-06): chat-ladder audit — the chat-path keyless guards
  had ZERO pins (488/496/499 only hit the messages ladder — coverage
  proved it). Added 2 in gateway.test.mjs (7-arm matrix + og keyless/
  breaker). Chat openrouter arm unreachable (pre-branch guard same var —
  documented, not pinned). translate 86.42->89.18. Suite 547->549;
  gates clean; snapshot updated; pushed.
  ROUND-504 (2026-09-06): shadow audit — the translate-path cm arm is ALSO
  shadowed (pre-branch guard same !cmdKey — coverage proved the 496/503 cm
  cases never executed it). Verdict comment at the guard + corrected both
  test comments (they pin the live pre-branch guards). Suite stays 549;
  gates clean; mirror resynced; pushed.
  ROUND-505 (2026-09-06): json audit — the invalid-JSON 502 arm had ZERO
  pins. Added 1 in gateway.test.mjs. Self-caught×2: breaker-cache residue
  + the arm needs stream:true/JSON-ctype (stream:false takes the one-shot
  path). Suite 549->550; gates clean; snapshot updated; pushed.
  ROUND-506 (2026-09-06): role audit — the developer→system normalization
  had ZERO pins. Added 1 in gateway.test.mjs (chat path, upstream sees
  system). Clean round. Suite 550->551; gates clean; snapshot updated;
  pushed.
  ROUND-507 (2026-09-06): any audit — the tool_choice:"any" web_search
  variant had ZERO pins. Added 1 in gateway.test.mjs (explicit any-choice
  forces deepseek-v4-flash). Also verified the og-native passthrough
  guards are unreachable (OG_NATIVE_ANTHROPIC empty). Suite 551->552;
  gates clean; snapshot updated; pushed.
  ROUND-508 (2026-09-06): auto audit — the model=auto resolution arm had
  ZERO pins. Added 1 in gateway.test.mjs (no route → first usable ds,
  served 200). Clean round. Suite 552->553; gates clean; snapshot
  updated; pushed.
  ROUND-509 (2026-09-06): parse audit — the passthrough needsParse-true
  arm had ZERO pins (og tests take the else arm). Added 1 in
  gateway.test.mjs (ds + web_search tools → parsed + forwarded). Clean
  round. Suite 553->554; gates clean; snapshot updated; pushed.
  ROUND-510 (2026-09-06): ox audit — the ox-alpha-free reasoning default
  had ZERO pins. Added 1 in gateway.test.mjs (no client reasoning →
  effort=max upstream). Clean round. Suite 554->555; gates clean;
  snapshot updated; pushed.
  ROUND-511 (2026-09-06): texterr audit — the chat-path non-JSON error arm
  had ZERO pins. Added 1 in gateway.test.mjs (500 text body → status +
  default message kept). Clean round. Suite 555->556; gates clean;
  snapshot updated; pushed.
  ROUND-512 (2026-09-06): REAL FIND — the passthrough !ok arm had no 429
  default: non-JSON 429 → api_error (give up) instead of rate_limit_error
  (back off). One-line parity fix. Self-caught×2 (translate branch, fast-
  500 no-retry). Proven by stash-revert (101/102 without, 102/102 with).
  Mirror resynced. Suite 556->557; gates clean; snapshot updated; pushed.
  ROUND-513 (2026-09-06): nvtext audit — the nv/gmi non-JSON error arm had
  ZERO pins. Added 1 in gateway.test.mjs (400 text, single call, status
  kept). Clean round. Suite 557->558; gates clean; snapshot updated;
  pushed.
  ROUND-514 (2026-09-06): respm audit — the responses-path og keyless +
  breaker arms had ZERO pins. Added 1 in gateway.test.mjs (muse-spark,
  no dial). Clean round. Suite 558->559; gates clean; snapshot updated;
  pushed.
  ROUND-515 (2026-09-06): resperr audit — the responses-path !ok mapping
  had ZERO pins. Added 1 in gateway.test.mjs (muse-spark 429 text →
  status + rate_limit kept). Clean round. Suite 559->560; gates clean;
  snapshot updated; pushed.
  ROUND-516 (2026-09-06): glm audit — the glm-5.2:free retry config had ZERO
  pins. Added 1 in gateway.test.mjs (502 → ≥5 calls, proves the 10x arm
  over the generic 4x). Clean round. Suite 560->561; gates clean;
  snapshot updated; pushed.
  ROUND-517 (2026-09-06): probe audit — the vale-probe catch arms had ZERO
  pins. Added 1 in health.test.mjs (ds+og throw → ok:false + message).
  Clean round. Suite 561->562; gates clean; snapshot updated; pushed.
  ROUND-518 (2026-09-06): think audit — the stream reasoning_content arm
  had ZERO pins. Added 1 in gateway.test.mjs (gmi SSE delta → thinking
  block). Clean round. Suite 562->563; gates clean; snapshot updated;
  pushed.
  ROUND-519 (2026-09-06): srvtool audit — the toSSE server_tool_use arm
  had ZERO pins. Added 1 direct unit test in reliability.test.mjs.
  Clean round. Suite 563->564; gates clean; snapshot updated; pushed.
  ROUND-520 (2026-09-06): torn audit — the mid-stream death arm had ZERO
  pins. Added 1 direct unit test in reliability.test.mjs (dying stream →
  error event, no clean finish). Clean round. Suite 564->565; gates
  clean; snapshot updated; pushed.
  ROUND-521 (2026-09-06): cancel audit — the stream cancel arm had ZERO
  pins. Added 1 direct unit test in reliability.test.mjs (output cancel
  → upstream reader cancelled). Clean round. Suite 565->566; gates
  clean; snapshot updated; pushed.
  ROUND-522 (2026-09-06): asset audit — the serveAssetText no-ASSETS arm
  had ZERO pins. Added 1 in health.test.mjs ({} and {ASSETS:{}} → null).
  Clean round. Suite 566->567; gates clean; snapshot updated; pushed.
  ROUND-523 (2026-09-06): sweep audit — the regenerate survivor-sweep had
  ZERO pins. Added 1 in plugins.test.mjs (stale token mapping swept).
  Clean round. Suite 567->568; gates clean; snapshot updated; pushed.
  ROUND-524 (2026-09-06): torn-record audit — the corrupt-user arm had ZERO
  pins. Added 1 in plugins.test.mjs (garbage JSON → null, no throw).
  Clean round. Suite 568->569; gates clean; snapshot updated; pushed.
  ROUND-525 (2026-09-06): migrate audit — the ADMIN_PASSWORD migration arm
  had ZERO pins. Added 1 in plugins.test.mjs (secret → legacy hash in KV,
  never plaintext). Self-caught: no trailing colon in format. Suite
  569->570; gates clean; snapshot updated; pushed.
  ROUND-526 (2026-09-06): race audit — the post-claim key recheck had ZERO
  pins. Added 1 in devices.test.mjs (vanishing key → 403). Verdict: the
  formatResult top-level .image arm is unreachable (envelopes always wrap;
  live shape rides the round-118 arm) — documented, no behavior change.
  Also found V8 misattributes executed else-if multi-line arms (786-790
  executes per output assertion yet still listed). Suite 570->571; gates
  clean; mirror resynced; pushed.
  ROUND-527 (2026-09-06): deny audit — the device-scan catch had ZERO pins.
  Added 1 in devices.test.mjs (KV outage → 401 deny, no throw). Clean
  round. Suite 571->572; gates clean; snapshot updated; pushed.
  ROUND-528 (2026-09-06): frame audit — the malformed-frame catch had ZERO
  pins. Added 1 in reliability.test.mjs (garbage frame skipped, valid
  chunks + message_stop flow). Clean round. Suite 572->573; gates clean;
  snapshot updated; pushed.
  ROUND-529 (2026-09-06): upstream audit — the install-cmd fetch-throw arm
  had ZERO pins (only non-ok covered). Added 1 in devices.test.mjs
  (throw → 200 null fallback). Phantom rule hardened: 409 path proven
  executing in isolation yet still listed. Suite 573->574; gates clean;
  snapshot updated; pushed.
  ROUND-530 (2026-09-06): probe audit — the proxySecret-probe catch had ZERO
  pins. Added 1 in devices.test.mjs (dead device → still 200, no secret).
  Clean round. Suite 574->575; gates clean; snapshot updated; pushed.
  ROUND-531 (2026-09-06): outage audit — the sweep-list-throw arm had ZERO
  pins. Added 1 in plugins.test.mjs (KV outage mid-sweep → still 200,
  old token revoked). Clean round. Suite 575->576; gates clean;
  snapshot updated; pushed.
  ROUND-532 (2026-09-06): tunnel audit — the dead-tunnel proof catch had
  ZERO pins. Added 1 in devices.test.mjs (throw → 409, record untouched).
  Clean round. Suite 576->577; gates clean; snapshot updated; pushed.
  ROUND-533 (2026-09-06): agent matrix sweep — default 332 (290 lib + 5 +
  27 + 2 + 7 + 1) + core 15 = 347, feat-gated lib 298, clippy x2 + fmt +
  xwin clean. FINDINGS: (1) one-off flake — first feat-gated run failed
  1 test, 4 reruns all green (name not captured; watch item); (2) the
  snapshot headline 349 was stale arithmetic (true 347) — corrected.
  Pushed.
  ROUND-534 (2026-09-07): satellite sweep, zero drift — panel 178/178 (33
  files) + build clean with committed panel.js in sync, index 56/56,
  proxies 12+7+7 via node --test (no npm test script — CI calls node
  --test directly), npm CLI 3/3, extension node --check 3/3, vercel-proxy
  5/5 gate. All snapshot counts confirmed current. No code changes —
  pure verification round.
  ROUND-535 (2026-09-07): flake watch closed — round-533's one-off
  feat-gated failure never reproduced: 5x lib + 2x full feat-gated runs
  all green (298 lib + 5 + 27 + 2 + 7 + 1 each). 11 consecutive greens
  since the single failure; verdict = cold-build environment noise, not
  a product flake. No code changes — verification round.
  ROUND-536 (2026-09-07): gateway UI sweep — build clean, tests 1/1,
  login render smoke OK, devices-dashboard smoke OK, code-viewer mirror
  resync produces zero changes (fresh since round-526). Tree clean. No
  code changes — verification round.
  ROUND-537 (2026-09-07): STALE DEPLOY FOUND + FIXED — live gateway
  predated the 2026-09-05 mcp.ts split (proved via /code/ mcp.ts import
  shape): 19 src commits undeployed incl. behavior fixes (429
  rate_limit_error default, og-key scoping, vision KV-outage degrade,
  seedAdmin no-clobber, /mcp enabled gate, per-IP limiter, disabled-user
  logout). Pre-deploy gates green (577 + tsc + prettier); deployed via
  build.sh gateway (Version 3b991d38); live-verified 21/21 channels ok,
  /code/ 3/3 byte-identical, /mcp 401 gate. LESSON: test-only rounds
  never trigger deploys — schedule a live-vs-repo parity probe
  periodically, not just after code changes.
  ROUND-538 (2026-09-07): harvest audit — the self-reg secret-harvest
  catch had ZERO pins. Added 1 in devices.test.mjs (dead device → still
  200, no secret). Self-caught: T64("g") fails the 64-hex token gate
  (g not hex) → used "9". d1 answers 401 (alive, tunnel up) but no
  device credential from here, so full device e2e stays out of reach.
  Suite 577->578; gates clean; snapshot updated; pushed (test-only —
  no redeploy needed).
  ROUND-539 (2026-09-07): backfill audit — the seed-failure catch had ZERO
  pins. Added 1 in admin-seed-backfill.test.mjs (throwing KV → resolves,
  startup unblocked; verified the throw lands in the backfill try, not
  an outer guard — fresh path exits early via get). Clean round. Suite
  578->579; gates clean; snapshot updated; pushed (test-only).
  ROUND-540 (2026-09-07): keepalive audit — the MCP SSE endpoint had ZERO
  pins. Added 1 in mcp-gateway.test.mjs (GET → event-stream + clean
  cancel, no leaked interval). Verdict: the 15s tick-vs-cancel race arm
  is defensive-only (not deterministically triggerable) — documented.
  Suite 579->580; gates clean; mirror resynced; pushed (comment-only
  src change rides the next deploy).
  ROUND-541 (2026-09-07): parity probe TOOLED — round-537's lesson is now
  gateway/scripts/check-live-parity.sh (39 manifest files, live /code/
  vs repo mirror, exit 1 on drift). Self-caught: the viewer 307s bare
  files to directory form (fixed with curl -L) and pipe exit codes mask
  failures (check $? off-pipe). First run: exactly 1 drift (the 540
  comment — the forcing function works; comment rides the next deploy).
  Pushed.
  ROUND-542 (2026-09-07): probe WIRED INTO DEPLOY — build.sh gateway now
  runs check-live-parity.sh post-deploy (sleep 8 for edge propagation,
  fail the step on drift; round-324 index-smoke pattern). Proved
  end-to-end with a real deploy (Version dd093b0e): gate ran inside the
  flow, "39 files, 0 drifted" — the 540 comment is now live and the
  known drift is cleared. Mirror re-sync byte-identical no-op. Pushed.
  ROUND-543 (2026-09-07): post-deploy live chain — parity probe still 0
  drift (39/39, manifest is 100% vale-gate group, no coverage gap);
  /api/plugins/status 401, /api/devices 401, removed /api/plugins/pair
  still 404, /mcp 401 with proper JSON-RPC error. Deployed world fully
  consistent with repo. No code changes — verification round.
  ROUND-544 (2026-09-07): proxy deploy BLIND SPOT CLOSED — deploy_proxy
  had no post-deploy smoke (comment admitted it). Wired keyless 401-gate
  smokes for zen-go + zen-us (vercel-proxy pattern; proves serving +
  auth intact, zero upstream spend). openrouter-proxy skips: idle/
  off-path, workers.dev TLS-dead, no reachable URL. Proved with a real
  `build.sh proxies` run (all 3 deployed, both smokes green). Pushed.
  ROUND-545 (2026-09-07): INDEX ALSO STALE — same class as 537: newest
  index deploy Sep 5 15:36 (+0800) but 3 src commits after (page.js
  extract, CORS parity, TempClaimDO auth fix, safePageUrl pins).
  Suite 56/56 green; deployed via build.sh index (Version 475540f3,
  built-in version smoke passed v1.2.297 + sha); live-verified landing
  200 + version match. No repo changes — deploy-only round.
  ROUND-546 (2026-09-07): full live chain recheck — gateway 21/21 ok,
  parity 0 drift, vercel/zen-go/zen-us keyless 401s intact, d1 401
  (alive, tunnel up). Every deployed surface consistent with repo. No
  code changes — verification round.
  ROUND-547 (2026-09-07): completed the prescribed hardening — the Sep 7
  TempClaimDO commit said `wrangler secret put DO_AUTH` but live index
  had only UPLOAD_KEY (gate dormant). Generated + stored DO_AUTH (value
  lives only in Cloudflare; loss = regenerate + re-put, no sync needed).
  Verified no worker/DO env skew (well-formed claims 404, never 401) and
  reviewed both sides (server-side overwrite kills forgery, constant-time
  compare, claim-auth tests green in the 56). By construction the compat
  gate shows no external change — dormant/active indistinguishable
  through the worker path. No repo changes — ops round.
  ROUND-548 (2026-09-07): vercel-proxy redeployed + smoke green — but the
  "stale" verdict was WRONG: my probe used Origin console.saisi.online,
  which is NOT in ALLOWED_ORIGINS (ai/api/dsh only), so no reflection by
  design, pre- and post-fix. Re-probed with ai.saisi.online → 401 WITH
  allow-origin reflected: the CORS fix is live. CORRECTION OWED: never
  verdict drift without an allowlisted probe. Deploy stands as a fresh
  push + verified smoke; no repo changes.
  ROUND-549 (2026-09-07): RETIRED openrouter-proxy — zero callers
  (off-path since 2026-08-22), workers.dev URL TLS-dead (verified 2x),
  yet still deployed/tested/maintained (even got loopback gates in the
  Sep 7 commit). Remote worker deleted (zero secrets held) + repo
  removal: worker dir (-315 lines), build.sh + ci.yml wiring, README,
  upstream.ts comment, ARCHITECTURE (proxies ×2, 19 tests), dead sync-
  script mirror block. Gates: tsc/eslint/prettier + gateway 580 +
  proxies 12+7 green; parity shows exactly the expected 1 drift
  (upstream.ts comment rides next deploy). -348/+16. Pushed. NEXT: new
  goal objective pivots to agent-module testing.
  ROUND-550 (2026-09-07): agent/update audit (new objective) — the
  SYSTEM-execution gate (https/host-match/sha) lived as untested inline
  closures. Extracted host_of + check_download_url + valid_sha256 as
  pure fns (byte-identical verdicts, same messages) + 3 pin tests (6→9).
  REAL FIND: the "::1" loopback arm is unreachable (host_of parses bare
  ::1 to "") — documented, gate untouched (widening SYSTEM-exec is a
  product decision). Self-caught×2: dropped version_url in an edit
  (restored) + fmt line width. Matrix: lib 293, feat 301, clippy x2 +
  fmt + xwin clean; snapshot 347->350. Pushed.
  ROUND-551 (2026-09-09): Windows ONLINE INSTALLER shipped — sharing was
  npm-only (boss: "不方便分享"). NSIS 3.12 cross-built in userspace on this
  box (apt-download + dpkg-deb -x of mingw-w64/binutils/zlib/scons debs —
  NO apt install (focal has only 3.05, missing the 3.11/3.12 SYSTEM temp-dir
  priv-esc fixes); three toolchain traps pinned in scripts/build-installer.sh:
  dangling alternatives symlinks need `ln -sfn`, mingw-w64-common provides
  the limits.h the runtime include dirs symlink to, and
  NSIS_SCONS_GNU_ENVPATHHACK=1 is REQUIRED or windres is "not found" inside
  the cross env). Art: scripts/render-installer-art.py renders the sunrise
  brand into header.bmp/welcome.bmp (exact MUI sizes, 24-bit); NSIS script =
  zh wizard + reg-key page + result-file finish page; the payload is ONLY
  vale-online-setup.ps1 (151KB exe): reuse-or-bootstrap portable Node ->
  npm i -g PINNED tgz -> cloudflared best-effort -> `vale setup` (the real
  installer — dir/registry/tasks/firewall untouched) -> Electron +
  ValeDesktop task + shortcuts. CDN 25MiB asset cap is why it is online-only
  (offline bundle ~250MB cannot live on Assets; R2 noted as the later path).
  Published 1.2.306 exe + versionless ValeAgent-Setup.exe alias; index
  landing page gained the Download button (PAGE 3rd arg, 56 tests green).
  UNVERIFIED ON WINDOWS — checklist in agent/deploy/README-installer.md
  (test on a spare machine, never d1). Also this round: released 1.2.306
  (25 commits), reverted the sunrise console redesign per product (rebuild
  gate lesson: checkout alone ships the STALE vite bundle — build.sh gateway
  deploys assets, it does not rebuild them), fixed d1's broken Vale.lnk
  (pointed at the deleted Tauri exe; repair logic exists but only covered
  PUBLIC desktop — user-profile links need the same treatment, OPEN).
  ROUND-552 (2026-09-09): installer brand + wizard polish (user feedback) —
  the exe icon was the STRIPED pre-sunrise vale-agent.ico (user: "logo不
  对"); regenerated from scripts/render-brand-icon.py (256 PNG + 48/32/24/
  16 BMP entries — 256 is shell-safe, the brand renderer only omits it for
  Chromium's ICO parser). render-installer-art.py rewritten: per-pixel glow
  bake (the old per-ring full-image composite loop was O(n²) AND blocky) +
  brand layout (sun left-of-center, rounded twin hills — ellipses sunk
  below the bottom edge, not triangles). REG-KEY PAGE REMOVED from the
  wizard (user: 安装过程不需要) — registration is a post-install Gateway-
  card step; ps1 keeps -RegKey for scripted use. Rebuilt + republished
  1.2.306 (156771B, both aliases 200); README-installer.md updated.
  FOLLOW-UP (same day): user STILL saw the old logo — the exe carried the
  DEFAULT NSIS sphere. ROOT CAUSE (bisected with minimal compiles): MUI2
  OVERRIDES a bare `Icon` with modern-install.ico at MUI_LANGUAGE time —
  the supported hooks are `!define MUI_ICON`/`MUI_UNICON` BEFORE the page
  macros. Fixed; live exe now verified via pefile to embed the sunrise
  frames (256 PNG 6660B + 16-48 BMP). LESSON: verify artifact CONTENT
  (resource frames), not build success — makensis applies the default icon
  silently. pefile wheel at /tmp/pylibs, PE dump recipe in round notes.
  ROUND-553 (2026-09-09): FIRST FIELD INSTALL FAILED on d1 — root cause:
  the embedded bootstrap ps1 was UTF-8 WITHOUT BOM containing Chinese;
  PS 5.1 parses BOM-less files as the ANSI codepage (GBK), multibyte tails
  swallow quotes → 6 PARSE errors, script dies before statement #1 (no
  installer.log — the tell). NSIS surfaced only "exit code N". FIX: BOM
  prepended to agent/deploy/vale-online-setup.ps1 + a fail-closed BOM gate
  in build-installer.sh (head -c 3 == EF BB BF before staging). Verified
  ON d1: BOM-prefixed copy parses with 0 errors; stray D:\Vale copy
  replaced in place; installer rebuilt (156512B) + republished. LESSON:
  any non-ASCII .ps1 shipped to Windows MUST carry a UTF-8 BOM — and a
  build-time gate is the only thing that survives the next edit.
  ROUND-554 (2026-09-09): FILE TRANSFER COLLAPSED TO ONE METHOD + the
  registry-drift class KILLED AT THE ROOT. Trigger: the user asked why
  tools/list offers no Linux→D1 push. THREE real bugs behind one answer.
  (1) gateway /mcp tools/list is a HAND-MAINTAINED MIRROR (mcp-tools.ts,
  28 entries), never the device's spec — 21 of d1's 49 tools (whole
  system_/memory_/mcp_client_ families, terminal_sftp, agent_update,
  page_view) were invisible AND UNCALLABLE (tools/call looks the name up
  BEFORE routing → "Unknown tool"), and the round-54 "drift guard" could
  not catch it: it compared the registry with a hand-typed copy of ITSELF,
  whose second half then pinned "no extras" — codifying the absence. Now
  the agent emits agent/spec-tools.json from the live PluginRegistry
  (VALE_REFRESH_SPEC=1 cargo test spec_snapshot) and the gateway test reads
  THAT, failing on any device tool neither registered nor listed in
  NOT_EXPOSED WITH A REASON; callTool routes through isDeviceDirectTool()
  instead of re-implementing the predicate as three inline branches;
  system_file_upload + system_file_download registered (28→30).
  (2) system_file_download was DEAD ON WINDOWS: canonicalize() returns
  `\\?\C:\…` (VerbatimDisk prefix) while data_dir() is the plain registry
  string, so the confinement `starts_with` was false for EVERY path —
  device-verified on d1, both D:\Vale\x.txt and C:\ProgramData\Vale\x.txt
  answered "path must be under data dir". Shipped since round-340 having
  never worked on a real device (the suite runs on Linux, where the prefix
  does not exist). Fix: strip_verbatim() + resolve_dest() as pure
  cross-platform STRING fns so the Linux suite exercises the Windows shape
  (cfg(windows) would have stayed invisible — the round-351 lesson);
  confinement dropped (the same credential drives a PTY and
  system_file_write never had one); parents auto-created; `.part` + rename
  so a truncated image never sits at the target looking flashable; fetch
  timeout 120s→600s (120 s could not carry the 100 MB its own description
  advertised). (3) the size cap was 100 MB in the agent AND the index
  worker but 25 MB in the gateway proxy → a 30 MB image died with 413 in
  5.9 s (measured). Unified at 100 MB with the real ceiling documented
  (Cloudflare's request-body limit follows the ACCOUNT plan — Free/Pro
  100 MB, Business 200 MB — not a Workers plan; the old "assumes paid"
  note was wrong), and the reason 25 MB existed (multipart formData()
  materializes the body inside the 128 MB isolate) removed by adding a
  RAW-STREAM PUT arm: index /api/upload?name= streams into R2 (multipart
  kept for old agents), gateway forwards method/query/metadata with a
  60→600 s window, agent switched to it. Symmetry: /api/upload now ALSO
  accepts the ADMIN API TOKEN (the same credential /mcp requires) — without
  it only a device or a console cookie could stage a file, so the AI side
  had no inbound leg; relay-role tokens stay excluded (ADR-0007).
  Measured while diagnosing (kept as the escape hatch, deliberately NOT
  exposed over MCP): d1's terminal_sftp pulled 30 MB in 36.1 s (0.8 MB/s),
  MD5-identical, over the existing 22122 outbound path — but its upload
  arm takes base64 `data` only, so it was never a viable big-file leg.
  Docs: ~/.dsh/AGENTS.md now names the relay pair as the ONE method incl.
  the exact Linux→D1 curl leg; agent/{AGENTS,CLAUDE}.md gained "console MCP
  visibility is a SEPARATE decision". Matrices: agent lib 341 + every
  integration suite green, clippy/fmt/xwin clean; gateway 618 pass +
  tsc/prettier/eslint clean; index 54→64 pass.
  ROLLOUT + LIVE SMOKE (same day): gateway deployed (vale-gate 285210bc),
  index deployed (vale-dist 7ec96a89), release **1.2.307** published and d1
  updated (`.vale-release` = 1.2.307). Evidence with a 31457280-byte
  payload, BOTH directions through the CONSOLE MCP (not the device HTTP API
  — MCP reachability was the point of the round):
  · tools/list → 30 tools incl. the pair (was 28 without it).
  · Linux→d1: curl -T with the ADMIN API TOKEN → 200 with filename
    "r554-to-d1.bin" (so ?name= survived the proxy) → system_file_download
    to D:\Vale\relay\r554-to-d1.bin — a path OUTSIDE the data dir whose
    PARENT DID NOT EXIST → ok:true, 31457280 bytes, MD5 identical to the
    source, and the dir holds only the final file (no .part). The same call
    on 1.2.306 answered "path must be under data dir" for EVERY path,
    including one inside it.
  · d1→Linux: system_file_upload on that same 30 MB → ok + URL (the old
    25 MB gateway screen 413'd it in 5.9 s) → Linux curl 22.8 s, same MD5,
    and the SECOND claim 404s (one-time semantics intact).
  · CI: release.yml on tag v1.2.307 success; both commits' CI success.
  KEEP-LATEST DONE (the operator's GitHub token is ~/.github-token — gh is
  NOT installed here, so the audit runs on the REST API): superseded
  releases + tag refs v1.2.302/304/305/306 deleted via
  DELETE /releases/{id} + DELETE /git/refs/tags/{tag} (4×204), leaving
  GitHub with exactly one release and one tag (v1.2.307), matching the
  keep-latest rule that had drifted by four releases.
  DUAL-BUILD SPLIT — NOT a new finding, and my first write-up of it was
  wrong in kind: the earlier rounds already recorded (1.2.305) that the
  CDN tgz and the GitHub asset differ ONLY in vale-agent.exe, because PE
  builds are not reproducible across builders. Re-measured on 1.2.307
  member-wise: 8 of 9 members byte-identical, `package/vale-agent.exe`
  differs (gh 17141760 B vs cdn 17140736 B) — CDN sha cdbff19c… vs asset
  66526fb5…. So the P0 reconcile's "same sha256 or abort" premise cannot
  hold for ANY release that ships a locally-built exe, which is every
  release: "reconcile OK" has never once run to comparison. The standing
  proposal from the 1.2.305 note (member-wise equality + exe provenance
  instead of whole-tgz bytes) still awaits sign-off; --skip-reconcile for
  a first publish remains the only usable path, and the post-tag checklist
  is where the real audit has to happen.
  ROUND-555 (2026-09-09): INSTALLER MADE USER-USABLE + layout v2 (ADR
  0008) + autostart + rollback pin. (1) The share front-end was BROKEN:
  index.js 302'd ValeAgent-Setup.exe to the console and 404'd versioned
  names, so the landing-page download button never delivered a binary —
  now the alias + versioned exes serve straight from ASSETS (exact-pattern
  discipline). version.json gained installer + installer_sha256 (additive;
  the worker passes them through /api/version after flat-name validation),
  the installer is built same-release (publish-release.sh stages +
  prune_installers keeps last-5), and smoke verifies the alias hash.
  (2) `vale update` now writes DisplayVersion (uninstallVersionPs, $ok-
  gated, never fabricates UninstallString) — the control-panel entry used
  to show the original version forever. (3) `vale autostart on|off|status`
  — the real boot switch (schtasks /Change /ENABLE on ValeAgent +
  ValeDesktop; stop is one-shot, the 5-min watchdog revives it). (4) LAYOUT
  v2: the install root held ~15 loose files + three inconsistent depths;
  now etc\ / components\ / scripts\ under InstallDir and logs\ + pwout\
  under DataDir (leaf names unchanged — Electron packaging + task args are
  rename-sensitive; only the parent moves). The migration surfaced a REAL
  BRICK: the ValeAgent task's -Argument was the exe PATH and Rust treats
  argv[1] as the config FILE, so a moved config made the new exe quarantine
  the install — bootTaskPs now passes etc\config.yaml explicitly, and BOTH
  swap paths repoint the task fail-closed BEFORE touching any file (a
  config-path arg boots old and new agents alike, so a failed repoint aborts
  the update with the old version running). One-version boot backstop
  (paths.rs migrate_layout_v2 + PS migrateLayoutPs, mirror pairs, both
  pinned by tests) moves v1→v2; never clobbers, merges dirs, gates on
  etc\config.yaml+hostname. (5) start-desktop.ps1 HAD NO WRITER — the
  shell's onlogon relaunch was broken by omission (absent from repo + git
  history); startDesktopPs now ships from setup/update/installer, and the
  swap's desktop-pulse.vbs ensure-desktop path was fixed (pointed at the
  root). (6) Migration MARKER AGING (etc\.layout-v2): the backstop stops
  re-scanning 24 paths once a pass ends with nothing pending (a failed move
  retries; a merged dir with a present target is never pending — locked
  leftovers are uninstall garbage, not migration state). PS keeps every
  statement single-line with the guard in $valeMg (setup joins via
  -Command). Deletion criterion in ADR 0008. (7) `vale rollback <ver>` +
  Rust pin: HEAD-checks the CDN-retained tgz, installs to
  components\npm-global, runs the TARGET build's own update, writes
  etc\.rollback-pin + heals a split-brain .vale-release; agent_update
  returns {"status":"pinned"} for any other remote unless force (which
  clears it). Matrices (all green): agent lib 347 (feat-gated), clippy -D
  warnings + fmt + xwin check clean; index 66; npm CLI 15; release-lib 20.
  CDN LIVE: 1.2.307 tgz + installer alias/versioned serve 200 with matching
  shas (installer_sha256 2169f0ea…, verified). NOT yet run on a device: the
  layout-v2 migration + rollback + autostart need the Windows sandbox
  (README-installer checklist gained the v2 verification items); ship as
  1.2.308 once green.
- Release history: bridge-era releases (1.2.232 and earlier) are archived in
  `agent/RELEASE-HISTORY.md` (chronological; entries record the state at
  the time — bridge-era notes included for context). Current + recent
  release state lives in the Current release section above.
- Distribution: `https://agent.saisi.online/vale-agent/vale-agent-<ver>.tgz`
- Git: **GitHub is the TRUE origin** (public face; the v.saisi.online
  proxy auto-mirrors GitHub, verified 2026-09-25). Normal pushes:
  `git push https://x-access-token:<ghp>@github.com/SilasVale/vale.git
  main:main` (HTTP/1.1, reliable); the proxy push also works for small
  increments (its receive-body cap is ~<725MB → 413 on full repushes).
  GitHub releases via the API as before.

### 2026-09-08 cleanup round (architecture-audit follow-up fixes)
- **vale setup now writes the .vale-release marker** — fresh installs
  (update-only devices already had it, round-298/298b) previously made
  agent_update compare against the frozen Cargo 1.0.x fallback and
  re-download + swap on every call. New `writeReleaseMarker()` helper
  (best-effort, package.json source), called after setup's exe copy +
  boot-task registration succeed. CLI tests 9/9.
- **UI version reads prefer the npm `release` field** — /api/status has
  reported `release` (1.2.x) alongside the frozen Cargo `version` since
  round-304, but electron title/tray and the desktop SPA status strip all
  showed `version` (v1.0.145 forever on 1.2.x devices). All three now
  read `release` first, `version` as fallback. +1 vitest pin; DesktopShell
  9/9.
- **zen-us-proxy egress US-pinned** — smart placement had parked the
  worker in AMS (2026-09-07) and zen 403 RegionError'd muse-spark from
  that EU egress; Vercel clears it but caps bodies at 4.5 MB. Config now
  uses a WNAM-primary D1 (`zen-us-db-wnam`) + `placement.region:
  aws:us-east-1`; caveats synced (proxies/README.md, channels.ts muse
  exit note) + code-viewer mirror.
- **Retired openrouter-proxy residue removed** — root README +
  build.sh usage line + zen-us header comment still named it as live;
  the empty leftover local dir (gitignored .wrangler tmp only) is gone.
  Source stays in git history (2026-09-07 retirement).

### 2026-09-08 SOLID round (gateway layering — plugin deps, key errors, gates)
- **Plugin deps now enforced (DIP)** — `registerPlugins` ran setups in
  caller-array order while index.ts lists auth BEFORE translate despite
  auth's `deps:["translate"]`; auth's setup read `ctx.api.translate` as
  undefined, so `/api/me/route`'s `effective` never resolved the usable
  fallback (UI "current model" wrong for keyless/BYOK users). The registry
  now does a stable topological sort — a dep registers before its
  consumers, same-level plugins keep caller order, a dependency cycle
  throws. Missing-from-list deps (external providers) tolerated.
  +4 registry tests; me/route test updated to assert the FIXED semantics
  (keyless no-route → default fallback; keyless stored-og → fallback;
  with og key → stored route mirrors) — the old assertions pinned the bug.
- **21 key-missing 502 copies collapsed into one table (SRP/DRY)** —
  every /v1 flow site hand-rolled `if (kind===X && !keyX) jsonError(502,
  "<KEY> not configured — <hint>", "config_error")` across four branches;
  a new channel kind needed its guard + message in four places. New
  `keyMissingError(kind)` owns the message table (strings byte-identical);
  call sites keep their own `!key` gate and delegate the 502 shape.
  +2 unit pins in scrub-keys.test.mjs.
- **Devices handlers use the shared requireAdmin gate (DRY)** — 10
  admin-gated handlers hand-rolled requireSession→401 + role→403 pairs;
  now `requireAdmin` (the gate admin.ts already used) in one line each.
  handleFileUpload keeps requireSession (session-only). -20 lines.
- Gateway 590 pass, tsc/lint/prettier clean; code-viewer mirror synced in
  each commit.

### 2026-09-08 SOLID round 2 (gateway device-tool path single-sourcing)
- **Device tool paths derived, 21-entry dup table deleted (DRY)** —
  callTerminalToolOnce hand-wrote an "/api/tools/<name>" map for all 21
  device-direct tools while mcp-tools.ts already owns the registration
  list: two sources of truth that drifted silently (round-54's 11 missing
  tools were exactly that class). Path is now the mechanical
  `/api/tools/${name}` behind a single exported `isDeviceDirectTool()`
  guard (terminal_*/secret_* prefixes + browser_pw_info/browser_run_script
  specials). callTool's existing dispatch already routes only device-direct
  names there, so the guard is a programming-error net, not a runtime
  branch.
- **+contract pin**: every registered gateway MCP tool must classify
  device-direct XOR bridge-routed, matching callTool's dispatch partition
  (7 bridge names are the exact non-device-direct set) — a future tool
  added to one side without the other fails the suite, not production.
- Gateway 591 pass; tsc/lint/prettier clean; code-viewer mirror synced.

### 2026-09-08 SOLID round 3 (agent memory eviction dedup + bundle catch)
- **Memory eviction dedup (DRY, agent)** — enforce_limits' entry-cap and
  byte-cap loops each copy-pasted the same oldest-live victim selection
  (min updated_at, id tiebreak) + soft-delete + persist-tombstone. Extracted
  `evict_oldest_live()` (returns evicted content length so callers keep
  their own total_bytes accounting: full recompute vs exact subtract) and
  used it in both loops; retention branch keeps its own bulk cutoff delete
  (age-based, different policy). Memory lib tests 28/28, full lib 307
  feature-gated pass, clippy clean.
- **Stale panel.js caught + shipped** — while running cargo (build.rs
  staleness gate) the rebuild revealed the round-1 DesktopShell
  release-field change (a1bf8881) had modified TS source but never
  re-emitted the committed panel.js bundle; devices would have kept
  showing the frozen Cargo version. Rebuilt + committed the bundle
  (ff856a85). LESSON: after any panel-react source commit, verify
  resources/panel/ products are committed too (build.rs only catches it
  at the next cargo build).

### 2026-09-08 SOLID round 4 (vision describe tail + SSE bounded-send dedup)
- **Vision describe tail dedup (DRY, gateway)** — describeImage's two
  upstream branches (passthrough vs og translate) each hand-rolled the
  same tail: !ok → status marker, JSON parse → "解析失败" marker,
  extract text, cache, return. Extracted `finishDescribe(resp, cacheKey,
  env, extract)`; per-upstream difference is now only the text-extraction
  closure (Anthropic content[] vs OpenAI choices[0].message). All failure
  markers byte-identical (round-119 fail-loud contract preserved);
  translate-vision tests 8/8 end-to-end. Gateway 591 pass.
- **SSE bounded-send dedup (DRY, agent)** — sse_response and
  sse_term_stream each defined an identical 5s-bounded mpsc send closure
  (dead-client detection; a full channel means the client is gone).
  Extracted one module-level `send_bounded(tx, bytes)` used by both
  streams. Web tests 44/44, full lib 299 pass; clippy clean.
- Both: code-viewer mirror synced for the gateway change.

### 2026-09-08 SOLID round 5 (terminal take_session + translate error normalization)
- **take_session dedup (DRY, agent)** — term_close and term_unregister each
  copy-pasted the same lock-scoped position+remove block (review #10:
  remove under the lock, close AFTER the guard drops). Extracted
  `take_session(sid) -> Option<Session>`; callers still own the post-lock
  close. Lib 299 + feature-gated 307 pass; clippy clean.
- **Upstream error normalization single-sourced (DRY, gateway translate)** —
  all three /v1 arms (chat/completions, responses, messages) copy-pasted the
  same !upstream fetch-failure path and the !upstream.ok body-sniff (unwrap
  {"detail":{…}}, scrubKeys, keep the upstream's own known error.type, carry
  Retry-After). Extracted `upstreamFetchFailedResponse()` +
  `upstreamBodyErrorResponse()`, called from all three arms. BEHAVIOR FIX
  surfaced by the dedup: /v1/responses previously DROPPED Retry-After (its
  sniff copy predated the extra-header parity) — it now carries it; new pin
  (og responses 429 → retry-after header). Down-body breaker guards
  (isChannelDownFailure on og 5xx) preserved at the two sites that had them.
  -23 net lines. Gateway 592 pass; tsc/lint/prettier clean; mirror synced.

### 2026-09-08 SOLID round 6 (SSE encoder dedup + mcp_client auto-select dedup)
- **AnthropicStreamEncoder dedup x2 (DRY, gateway)** — (1) ensureBlock
  copy-pasted the thinking/text content_block_delta push between its
  first-chunk and continuation paths → shared `pushContentDelta(delta)`.
  (2) the constructor re-assigned eight fields that already carry
  declaration-site initializers (class-field initializers run before the
  ctor body — dead assignments) → ctor now only sets parameter-derived +
  non-initialized fields. Gateway 592 pass; tsc/lint/prettier clean;
  mirror synced.
- **Connect auto-select dedup (DRY, agent mcp_client)** — the stdio and
  http connect arms each copy-pasted the embedded-view auto-select
  sequence (SESSION take-out → select under no lock → restore-or-drop,
  P1-1 discipline). Extracted `auto_select_embedded_view(can_auto_select)`;
  http passes "server exposes browser_tabs", stdio always true. mcp_client
  21/21, feature-gated lib 307 pass; clippy clean.

### 2026-09-08 SOLID round 7 (store locked-read + session-file traversal dedup)
- **Locked fresh-read single-sourced (DRY, gateway store/plugins.ts)** —
  all five mutating plugin-map paths (expiry sweep, remove, migrate,
  revoke-for-device) hand-rolled the same withKeyLock + fresh-KV-read +
  parse prologue. Extracted `readFreshPluginLinks(env)` returning null on a
  corrupt blob — callers abort WITHOUT writing (null-as-{} would delete
  every link). This aligns plugins.ts with devices.ts's earlier
  readDevicesRaw precedent (devices intentionally resets to [] on corrupt:
  array whole-file writes vs map incremental edits). Read-only
  listPluginLinks keeps its cache-tolerant {} fallback. Gateway 592 pass.
- **Session-file traversal dedup (DRY, agent session_log.rs)** —
  list_sessions and recover_interrupted each copy-pasted the read_dir +
  .jsonl filter + stem-extraction loop → shared `session_ids()`. prune_stale
  keeps its own loop (it also matches .jsonl.tmp litter and needs metadata,
  not sids). cargo fmt; lib 299 pass; clippy clean.

### 2026-09-08 SOLID round 8 (me/keys prologue + circuit-open guard dedup)
- **/api/me/keys handler prologue dedup (DRY, gateway auth.ts)** —
  meRevealKey / meTestKeys / meKeyUsage each opened with the same
  requireSession + readJson + name-whitelist + getUserKeys sequence.
  Extracted `sessionAndKeyName(request, env, allowed)` returning
  {user, name} | Response; usage passes its narrower 3-name set. The
  save/delete siblings keep their own shapes (extra value field / query
  param — forcing them in would hurt readability). Gateway 592 pass.
- **og circuit-open guard single-sourced (DRY, gateway translate.ts)** —
  four /v1 sites (chat/completions, responses, og-native passthrough,
  messages translate) inlined the same "opencode + breaker open → 502
  circuit open" check. Extracted `channelDegradedError(env, kind)` — one
  guard shape, one message, four call sites. Gateway 592 pass;
  tsc/lint/prettier clean; mirror synced.

### 2026-09-08 SOLID round 9 (device-body validation wrapper dedup)
- **validateDevice try/catch dedup (DRY, gateway devices.ts)** — the
  reg-key, self-register and admin-add handlers each inlined the same
  try/catch around validateDevice → 400. Extracted
  `validatedDeviceOrError(body): Device | Response`; three call sites.
  Deferred (judged not-worth-it): the five "already registered" messages
  are 3 semantic variants (anti-hijack hint / rename conflict), and the
  in-function 409 pair is deliberate defense-in-depth (check-then-act +
  lock-insert fallback); testKey's 8 provider branches stay (each is real
  protocol adaptation — og SSE first-chunk, AMD model-list parse, …).
  Gateway 592 pass; tsc/lint/prettier clean; mirror synced.

### 2026-09-08 SOLID round 10 (one OSC scanner in shell_integration)
- **find_* scanner dedup (DRY, agent shell_integration.rs)** —
  find_finished, find_command_line and find_prompt_started each
  hand-rolled the same byte scan (walk for ESC ], try the specific 633
  parse, skip whole non-633 OSCs — never past a partial/malformed 633;
  sequence, the subtle rule that could drift between finders). Extracted
  `scan_osc(data, parse)` generic over the per-sequence parser, plus a
  standalone `parse_osc_633_a` (the A-marker match was inlined before).
  -12 net lines; the partial-prefix + ignore-other-OSC boundary tests
  (30/30) pin the preserved semantics. Feature-gated lib 307 pass;
  clippy/fmt clean. exec.rs's find_prompt_marker stays (LEGACY 133;D
  parser for the headless-stub path — different prefix, documented).

### 2026-09-08 SOLID round 11 (screen tail-N + SSE relay headers dedup)
- **tool_screen tail-N dedup (DRY, agent output.rs)** — the live-session
  and history branches each copy-pasted the same tail scan (skip trailing
  \r\n/\n so the Nth-from-end count is content lines, walk back N
  newlines, slice). Extracted `tail_n_lines(data, lines) -> (start, end)`
  — one tail semantics for both buffer kinds. Terminal tests 111/111,
  feature-gated lib 307 pass; clippy/fmt clean.
- **SSE relay headers single-sourced (DRY, gateway translate.ts)** — the
  one-shot error-envelope relay and the streaming relay each built the
  same text/event-stream + no-cache + CORS header Response. Extracted
  `sseResponse(body)`. Gateway 592 pass; tsc/lint/prettier clean; mirror
  synced.

### 2026-09-08 SOLID round 12 (vision-describe fetch wrapper dedup)
- **fetchDescribeOrError (DRY, gateway translate-vision.ts)** —
  describeImage's passthrough and og branches each inlined the same
  fetchWithTimeout + try/catch → "(图片描述失败：…)" marker wrapper.
  Extracted `fetchDescribeOrError(url, init, env): Response | string` —
  one failure contract for both upstream calls (a future timeout/retry
  policy lands in one place). translate-vision.ts dup blocks 4 → 1 (the
  remainder is the shared helper's call-site tail, not duplicable logic).
  Deferred (judged not-worth-it): valeProbe's 9-line tail (too small),
  posixInstaller/psInstaller (two platform languages by design), memory
  tools' id-parse stanzas (the MCP builder idiom — per-tool error text).
  Gateway 592 pass; tsc/lint/prettier clean; mirror synced.

### 2026-09-08 SOLID round 13 (call-site comment trim + convergence check)
- **Call-site comment trim (gateway translate.ts)** — the three /v1 arms
  each carried a 6-line comment re-explaining the shared
  upstreamFetchFailedResponse / upstreamBodyErrorResponse helpers whose
  docstrings already own that explanation. Collapsed to one-line pointers
  (-30 comment lines, zero logic change); mirror synced.
- **Convergence check** — repo-wide dup scan now 13 files ≥4 blocks / 127
  total (was 24 files / 260+ at round 1). translate.ts's remaining 16
  blocks are all classified: flow-specific guard chains (by design),
  fetchWithRetry destructures (shared-call-site isomorphism), incidental
  single-line alignments. exec.rs's foreground/background buffer-read
  segments stay separate (dropped-handling differs: silent adjust vs
  truncated flag — the wait loops have the most device-caught regression
  history; not worth the risk).

### 2026-09-08 SOLID round 14 (cross-file dedup: DO auth + crate-root helpers)
- **DO external-auth single-sourced (DRY + security, gateway)** —
  cross-file scan found BreakerDO (reliability.ts) and RouteDO
  (route-do.ts) each carrying a byte-identical authorized(): fail-closed
  DO_AUTH gate + constant-time x-do-auth compare. A security-critical
  check duplicated across the two DO classes (future hardening would have
  to touch both). Extracted `authorizeDoRequest(request, expectedSecret)`
  in route-do.ts (zero-import module — no cycle). Gateway 592 pass.
- **Crate-root helper centralization (DRY, agent)** — cross-file scan
  also found three private byte-identical `unix_now()` (filelog.rs /
  session_log.rs / memory store) and two private byte-identical
  `hex_encode()` (update plugin / tunnel.rs). Both moved to lib.rs as
  pub(crate) and all call sites repointed (incl. one unit test).
  Lib 299 + feature-gated 307 pass; clippy/fmt clean. (Self-caught
  mid-round: a line-range deletion script left two orphaned `s`/`}`
  fragments — compile caught them immediately, both removed.)

### 2026-09-08 SOLID round 15 (index-worker 503 envelope + web sessions_logger)
- **503 unavailable envelope single-sourced (DRY, index worker)** —
  cross-file scan (now incl. index/src) found the claim handler (3
  sites) and the index worker (1 site) each inlining the same
  "temporarily unavailable" 503 JSON Response for R2/DO outage paths.
  Extracted `unavailableResponse()` in claim.js (the module index.js
  already depends on — no import cycle); all four sites call it.
  Self-caught mid-round: the blind regex also rewrote the helper's own
  body into a self-recursive call — fixed immediately (compile-level
  checks + tests 56/56 green).
- **sessions_logger() dedup (DRY, agent web/mod.rs)** — api_sessions_list
  and api_session_events each re-inlined the sessions-dir SessionLogger
  construction plus a 6-line HIGH(audit) rationale. Extracted
  `sessions_logger()` owning both. Web tests 44/44, lib 299 pass;
  clippy/fmt clean.

### 2026-09-08 SOLID round 16 (SSE guard + playwright op handlers dedup)
- **acquire_sse_guard (DRY, agent web)** — the /api/events and
  /api/events/term handlers each inlined the same SseConnectionGuard
  acquire-match with the "too many SSE viewers (max 64)" 503. Extracted
  `acquire_sse_guard() -> Result<_, Box<Response>>` in sse.rs (Err boxed
  like check_auth's — clippy result_large_err caught the unboxed form
  first). Web tests 44/44, lib 299 pass; clippy/fmt clean.
- **run_playwright_op (DRY, agent web/mod.rs)** — api_playwright_start
  and api_playwright_stop were two near-identical copies (run manager op
  → merge {ok:true, ...payload} → 500 JSON envelope on error). Extracted
  one generic runner; both handlers are one-liners. Web tests 44/44, lib
  299 pass; clippy/fmt clean.

### 2026-09-08 SOLID round 17 (usage-query skeleton dedup)
- **usageQuery (DRY, gateway auth.ts)** — meKeyUsage's three provider
  branches (openrouter / AMD / og) each inlined the same fetch-with-
  Bearer → !ok failure envelope → parse → out-build skeleton wrapped in
  a try/catch "Usage query failed". Extracted `usageQuery(url, key,
  name, map)`; per-provider payload→shape mapping stays in each branch's
  mapper callback. OpenRouter's distinct "Invalid upstream response"
  detail preserved via a mapper-thrown {detail} error surfaced by the
  shared catch. Gateway 592 pass; tsc/lint/prettier clean; mirror synced.
  testKey's 8 provider branches stay (each is real protocol adaptation —
  og SSE first-chunk, AMD model-list parse, qwen MaaS anthropic-version
  header…; previously judged not-worth-it).

### 2026-09-08 SOLID round 18 (mcp_client: now_millis + envelope predicate)
- **now_millis centralization (DRY, agent)** — record_mcp_action and
  record_mcp_screenshot each inlined the same epoch-millis timestamp
  construction. Moved one pub(crate) now_millis() into lib.rs next to
  unix_now/hex_encode; both call sites repointed. (system/tools.rs's
  as_millis is a file-mtime conversion, not a clock read — left alone.)
  mcp_client 21/21, lib 299 pass; clippy/fmt clean.
- **envelope_id_matches (DRY, agent mcp_client)** — parse_envelope's
  direct-JSON arm and its SSE-candidate loop each inlined the same
  id-matching predicate (round-365 added the direct-arm check by copying
  the SSE arm). Extracted one predicate; wrong-id-reject tests pin the
  semantics. mcp_client 21/21, lib 299 pass; clippy/fmt clean.

### 2026-09-08 SOLID round 19 (memory store recount dedup)
- **recount_total_bytes (DRY, agent memory/store.rs)** — load, the
  entry-cap eviction loop and the retention sweep each inlined the same
  live-only total_bytes recompute. Extracted `recount_total_bytes(guard)`
  (live-only semantics documented — the old per-line sum inflated the
  byte cap into premature evictions); the byte-cap loop keeps its exact
  saturating_sub accounting (different semantics by design). Self-caught
  mid-round: the blind replace also rewrote the helper's own body into a
  self-recursive call — fixed immediately (second occurrence of this
  blind-replace hazard; the pattern is now known-risky). Memory tests
  34/34, lib 299 pass; clippy/fmt clean.

### 2026-09-08 SOLID round 20 (CLI desktop-shell staging dedup + stale product sync)
- **stageDesktopShell (DRY, vale CLI)** — vale setup and vale update each
  inlined the same Electron desktop-shell staging block (~35 lines: copy
  main/preload/url-policy + icons into the install dir), differing only in
  the target suffix (setup writes in place; update stages *.new for the
  atomic swap). Extracted `stageDesktopShell(installDir, suffix)`; both
  flows call it. bin/vale.js recompiled from src (round-298 discipline;
  marker present; CLI tests 9/9).
- **Stale electron product caught (build-side)** — the recompile surfaced
  that src/main.ts's round-1 release-first window-title change
  (a1bf8881) had never been re-emitted into the committed main.js
  products: devices would have kept showing the frozen Cargo version in
  the window title. Re-emitted both copies (same class as the round-3
  panel.js catch; LESSON now doubly confirmed — after touching
  vale-desktop-electron/src/*.ts, the committed *.js products must be
  re-emitted, and the npm-package copies re-synced).

### 2026-09-08 SOLID round 21 (electron shell dedup x2)
- **resolveIcon (DRY, electron main.ts)** — appIcon and windowIcon each
  inlined the same existsSync-guarded icon path resolution + icon-status
  reporting, differing only in file name and report key. Extracted
  `resolveIcon(name, reportKey)`; both call it. Products re-emitted from
  the .ts source, byte-identical copies verified.
- **emitMenu (DRY, electron main.ts)** — sendMenu's direct path and
  flushMenuQueue's drain loop both called the same vale-menu webContents
  send; the channel name + send shape now live in one place. Products
  re-emitted, copies verified.

### 2026-09-08 SOLID round 22 (index 413 envelope + gateway probe result)
- **tooLargeResponse (DRY, index worker)** — the claim upload's
  content-length precheck and its post-parse size check each inlined the
  same "file too large" 413 JSON Response. Extracted
  `tooLargeResponse(maxBytes)`; both checks call it. Index tests 56/56.
- **keyProbeResult (DRY, gateway auth.ts)** — six of testKey's provider
  branches (deepseek / openrouter / cmd / gmi / nim / qwen) each inlined
  the same jsonOk probe envelope, differing only in the success text.
  Extracted `keyProbeResult(name, res, okText)`; the special branches
  (og SSE first-chunk, AMD model-count) keep their own logic. Gateway
  592 pass; tsc/lint/prettier clean; mirror synced. (mcp-tools.ts
  schema device-prop decls re-verified: 12 distinct shapes with
  per-tool description tweaks — inline schema stays; system/tools.rs
  mtime conversions are shape-distinct per site — both remain.)

### 2026-09-08 SOLID round 23 (SSE response tail dedup)
- **sse_response_from_rx (DRY, agent web/sse.rs)** — sse_response and
  sse_term_stream each inlined the same 11-line tail: wrap the mpsc
  receiver into a text/event-stream Response with the no-cache /
  keep-alive header set. Extracted `sse_response_from_rx(rx)`; both
  call it. Self-caught mid-round: the blind replace rewrote the
  helper's own body into a self-recursive call for the THIRD time
  (rounds 15/19/23 — insert-then-blank-replace ordering hazard;
  pattern now documented as known-risky: run the replace BEFORE
  inserting the helper, or scope it to call sites only), and the second
  call site was confirmed replaced before committing (amended). SSE
  tests 6/6 (header shape pinned), lib 299 pass; clippy/fmt clean.
  Introduced a code-only dup-scan (skips #[cfg(test)] blocks) for
  accurate rankings: mcp_client tools.rs + memory tools.rs remain
  (tool-registration idiom), secrets.rs/exec.rs small blocks reviewed
  and left.

### 2026-09-08 SOLID round 24 (valeProbe result envelope dedup)
- **probeResultJson (DRY, gateway tooling.ts)** — valeProbe's og and
  passthrough channel branches each inlined the same probe envelope
  (ok/channel/status with the upstream status on failure). Extracted
  `probeResultJson(prefix, res)`; both branches call it. Gateway 592
  pass; tsc/prettier clean; mirror synced.
- **SELF-RECURSION HAZARD — FOURTH occurrence (rounds 15/19/23/24)** —
  the insert-then-blank-replace ordering rewrote probeResultJson's own
  body into self-recursion (caught by the full suite: Maximum call
  stack). RULE NOW HARDENED: when extracting a helper whose body
  contains text identical to the pattern being replaced, run the
  replacements FIRST (targeting only existing call sites), then insert
  the helper — or anchor the replacement on call-site-only context.
  The interim broken commit was amended with the fix; every commit
  leaves the suite green.

### 2026-09-08 SOLID round 25 (actions-feed append dedup)
- **append_action_line (DRY, agent mcp_client tools.rs)** —
  record_mcp_action and record_mcp_screenshot each inlined the same
  OpenOptions create/append write of one line into pwout/actions.jsonl
  (round-18 deduped their timestamp construction; this was the
  remaining write tail). Extracted `append_action_line(&impl Display)`;
  both call it. Hazard rule FOLLOWED this round: call sites replaced
  BEFORE the helper was inserted — no self-recursion. mcp_client
  21/21, lib 299 pass; clippy/fmt clean.
- **translate.ts key-guard chains reviewed, left** — three entry
  points (messages / chat-completions / responses) each carry the
  route-kind keyMissingError guard chain, but the kind set and order
  differ per branch (chat adds openrouter/qwen re-checks; or/cm keys
  are per-user BYOK vs env keys for the rest) — table-driving would
  need a BYOK-vs-env key source split + per-entry ordering; medium
  risk, medium payoff, left (same class as mcp-tools schema decls).
  exec.rs slice_from buffer segments likewise stay (dropped-handling
  differs per site).

### 2026-09-08 SOLID round 26 (tool name/desc pairs dedup)
- **tool_name_desc_pairs (DRY, agent mcp_client tools.rs)** —
  connect_stdio and list_tools_ref each inlined the same mapping of an
  rmcp tool iterator onto (name, description-string) pairs. Extracted
  `tool_name_desc_pairs(iter)` (module-level, generic over the
  iterator); both call it. Hazard rule followed again (sites replaced
  before helper insert — clean compile on the first try). mcp_client
  21/21, lib 299 pass; clippy/fmt clean.
- **Sweep updates** — index worker: ZERO ≥6-line code dups remain;
  gateway tooling.ts clean after round-24; secrets.rs DPAPI seal/unseal
  mirror confirmed intentional (direction-opposed FFI pair); e2e.js CDP
  script scaffolding left (device-verified test suite — readability +
  risk); auto_select_embedded_view's browser_tabs retries are one flow,
  not copies.

### 2026-09-08 SOLID round 27 (web cache-control stamping dedup)
- **set_cache_control (DRY, agent web module)** — five sites across
  mod.rs / panel.rs / sse.rs inlined the same cache-control header
  insert (no-store for token-bearing + panel responses; no-cache for
  the status page + SSE tails). Extracted `set_cache_control(resp,
  value)` next to built_response (the web module's shared response
  helper); all five call it. Web tests 44/44, lib 299 pass; clippy/fmt
  clean. Cross-file scan (web/) now clean; the cross-file scan also
  found 4 test-scaffold copies of the same "local HTTP stub server"
  read-till-headers loop (design/system/mcp_client tools.rs + a
  panel.rs helper) — test scaffolding stays (consistent with the
  earlier decision; a shared testutil would couple plugin test modules).

### 2026-09-08 SOLID round 28 (handle_request SRP extraction)
- **handle_browser_evidence (SRP, agent web/mod.rs)** — handle_request
  (the web dispatch router) was ~376 lines; the three /api/browser
  evidence endpoints (actions/pwshots/pwshot) formed a self-contained
  ~85-line block. Extracted `handle_browser_evidence(path, query)` —
  pure reads from the pwout dir, no AppState dependency (the unused
  state param was dropped on clippy's first pass). Auth stays at the
  call site, synchronous before the Send boundary: the extraction
  surfaced that holding &Request across an await makes the router
  future non-Send (panel.rs service layer requires Send) — fixed by
  keeping auth + query extraction in handle_request and passing only
  &str/query in. Router now ~290 lines. Web tests 44/44 (evidence
  endpoints covered), lib 299 pass; clippy/fmt clean.

### 2026-09-08 SOLID round 29 (handle_panel_home SRP extraction)
- **handle_panel_home (SRP, agent web/mod.rs)** — the panel/desktop
  root branch (~94 lines: config snapshot + the gateway proxy-secret /
  loopback / one-time ?grant= token-injection decision chain) was the
  router's largest remaining inline block. Extracted
  `handle_panel_home(state, path, query, host, auth_header)` — header
  and query values are extracted at the call site (synchronous, owned)
  so no &Request borrow crosses the redeem_panel_grant await (Send-
  future requirement, same lesson as round-28). Router now ~223 lines
  (376 two rounds ago). Web tests 44/44 (panel token-injection tests
  cover the moved logic), lib 299 pass; clippy/fmt clean. Tooling note:
  a two-step python edit partially failed silently twice (asserts under
  a swallowed stderr) — verified with grep before each retry; the
  final single-shot script applied cleanly.

### 2026-09-08 SOLID round 30 (round-24 extraction completion)
- **og probe tail → probeResultJson (DRY completion, gateway
  tooling.ts)** — round-24's probeResultJson extraction replaced the
  passthrough tail but MISSED the og branch tail; its inline jsonOk
  envelope survived as a third copy of the shape (the periodic
  full-repo rescan caught it). ValeProbe now has exactly one envelope
  shape across both branches. Gateway 592 pass; tsc/prettier clean;
  mirror synced. translate.ts key-guard chains re-verified: the
  chat-completions and /v1/responses entry chains differ in kind set
  and order (per-endpoint minimal guards) — the round-25 keep
  decision stands.

### 2026-09-08 SOLID round 31 (build.sh deploy-gate dedup)
- **require_cf_token (DRY, scripts/build.sh)** — deploy_worker and
  deploy_proxy each inlined the same cf_token fetch + missing-token
  bail (8 lines). Extracted `require_cf_token "$name"` setting the
  CF_TOKEN global; both deploy functions call it and use $CF_TOKEN.
  bash -n clean.
- **Sweep updates** — update/tools.rs zero dups; the zen-go and zen-us
  proxies are NOT near copies (Anthropic→OpenAI translator vs US
  geo-pinned egress — different architectures, ADR-0003 autonomy);
  panel-react + gateway ui TSX near-zero dups (JSX coincidence only);
  translate.ts guard chains confirmed as per-kind checks that share
  nothing (kind sets differ per endpoint) — all keep decisions stand.

### 2026-09-08 SOLID round 32 (full-matrix + convergence verification)
- **Verification round (no code changes)** — strict 8-line code-only
  scan across agent/src: 3 files / 8 blocks remain, ALL of the
  previously-classified kinds (DPAPI seal/unseal mirror, MCP tool
  registration idiom, auto-select retry flow). vale-command-core:
  ZERO dups. gateway translate-vision.ts: zero dups. ARCHITECTURE.md
  web/ snapshot row still accurate (extractions stayed inside mod.rs —
  module boundaries unchanged). Full matrix re-run: index 56, agent
  lib 299, agent feature-gated 307, gateway 592 (round-30 run) — all
  green. Convergence state confirmed stable, no regression since the
  round-14 baseline.

### 2026-09-08 SOLID round 33 (mcp.ts HTTP-level error envelope)
- **mcpStatusError (DRY, gateway mcp.ts)** — handleMcp's 401 (admin
  token), 405 (method) and 400 (parse error) rejections each inlined
  the same JSON-RPC error Response carrying an HTTP status. Extracted
  `mcpStatusError(code, message, status)` next to mcpError — which
  stays 200-only for protocol-level tool errors (the two envelopes have
  different status semantics, so both helpers remain distinct with
  documented roles). Gateway 592 pass; tsc/prettier clean; mirror
  synced. (Function-size survey of index/gateway: remaining large fns
  — handleMcp 109 / handleSelfRegister 88 / handleRegister 78 /
  TempClaimDO 69 — checked: register pair shares only the 1-line
  hostAllowError guard, not copies; claim.js single-shot DO is
  event-driven by design.)

### 2026-09-08 SOLID round 34 (register 409 double-layer dedup)
- **alreadyRegisteredConflict (DRY, gateway devices.ts)** —
  handleRegister's pre-check (round-68) and its in-lock insertDevice
  retry (round-122) each inlined the same 409 "already registered —
  use the console (admin)" jsonError — two defense layers of ONE
  endpoint (the round-14 "message variants" deferral covered
  cross-endpoint variants; this is intra-endpoint verbatim dup).
  Extracted `alreadyRegisteredConflict(name)`. The other 409 variants
  (different-token 229, self-register short 262, rename newName 545)
  keep distinct messages inline. Gateway 592 pass; tsc/prettier clean;
  mirror synced.

### 2026-09-08 SOLID round 35 (store/users key-map mutation skeleton)
- **updateUserKeys (DRY, gateway store/users.ts)** — setUserKey and
  deleteUserKey each inlined the same locked read-modify-write
  skeleton (withKeyLock → getJSON → mutate → KV put + cache set →
  return), differing only in the mutation line. Extracted
  `updateUserKeys(env, id, mutate)`; both call it with a one-line
  closure. Gateway 592 pass (user-key isolation tests cover the
  paths); tsc/prettier clean. Store/ + admin + auth files all clean
  after this.

### 2026-09-08 SOLID round 36 (full-repo JS/TS final sweep)
- **Verification round (no code changes)** — swept EVERY remaining TS/
  JS source tree (gateway/src, gateway/ui/src, index/src, extension/,
  agent/scripts, proxies/) at a 6-line window: 209 window-sites across
  10 files, each individually checked. Verdict: all are window
  artifacts (adjacent-function overlap: zen-us safeEq/fetchUpstream
  tails, access.ts verifyJwt try/catch) or previously-classified kinds
  (mcp-tools.ts tool schemas, translate.ts key-guard chains, e2e.js
  CDP scaffolding, gateway ui JSX rows, zen-us per-branch upstream
  forwarding which has EVOLVED differently per endpoint — 5xx detail +
  console.error on messages vs plain on responses). TRUE duplication
  is exhausted across every JS/TS tree; what remains is intentional
  per-branch evolution inside ADR-0003-autonomous workers or window
  noise.

### 2026-09-08 SOLID round 37 (cross-target gate completion)
- **Verification round (no code changes)** — closed the gate gaps left
  by the refactor rounds: (1) `cargo xwin check -p vale-agent
  --features terminal,keyring` GREEN — the rounds-23/28/29 web-module
  refactors (sse_response_from_rx, handle_browser_evidence,
  handle_panel_home) compile clean on the Windows target (Linux tests
  alone had been the gate so far); (2) gateway `format:check` + `lint`
  both clean (recent rounds ran prettier --write but not the CI
  format gate); (3) gateway/ui has zero pair/extension remnants in the
  new React console (the only "pair" hit is a historical comment in
  Overview.tsx); (4) panel product chain re-verified fresh (src last
  touched round-1, panel.js rebuilt round-3, no drift since).

### 2026-09-08 SOLID round 38 (dup scanner codified as tooling)
- **scripts/scan-dups.py committed (tooling)** — the window-hash
  duplication scan methodology used across rounds 23-36 (code-only
  lines with comments/blanks stripped, Rust #[cfg(test)] block
  stripping, intra-file ranking + optional cross-file mode, configurable
  window/min-sites/roots) existed only as ad-hoc inline python each
  round. Codified as one reusable command for future rounds and
  reviews. Verified: identical verdicts to the round-32/36 manual
  scans (secrets.rs DPAPI mirror, memory tool-registration idiom,
  mcp-tools schemas, translate key-guard chains — all previously
  classified kinds). Remaining translate.ts fetch-segment similarity
  re-checked: og's zen headers + stream:false vs passthrough's generic
  headers are real protocol differences — keep stands.

### 2026-09-08 SOLID round 39 (DoAuthBase for the DO classes)
- **DoAuthBase (DRY, gateway cross-file)** — the first catch by the
  codified scanner's --cross mode: BreakerDO (reliability.ts) and
  RouteDO (route-do.ts) each carried a byte-identical 11-line head
  (state/env fields, constructor, the constant-time DO_AUTH
  authorized() gate — round-14 had unified only the helper level).
  Extracted `DoAuthBase` in route-do.ts next to authorizeDoRequest;
  both DO classes extend it and keep only their fetch bodies.
  reliability.ts's direct authorizeDoRequest import dropped (now via
  the base). Gateway 592 pass; tsc/prettier clean; mirror synced.
  Also swept serial.rs + ssh.rs: zero dups (all agent source trees
  now verified at multiple windows).
- **Mirror gap caught + lesson** — the round-35 commit (e81c3d49,
  store/users.ts updateUserKeys) missed its code-viewer mirror sync;
  the drift surfaced on the round-39 final status check and was fixed
  (11804d3d). LESSON: after ANY gateway/src commit, verify the mirror
  is clean (`git status` shows no public/code/files change) before
  closing the round — same discipline as the electron/panel products.

### 2026-09-08 SOLID round 40 (agent cross-file verification)
- **Verification round (no code changes)** — ran the codified scanner's
  --cross mode over agent/src (first systematic agent cross-file pass
  since round 14). All four hit-groups classified: (1) session tool
  handlers carry per-tool MINIMAL dependency signatures (tool_open 5
  params vs tool_write 1 — not copies); (2) write_async in
  pty/serial/ssh share the TermBackend trait signature (contract, not
  duplication) with deliberately DIVERGENT bodies — each is the product
  of its own device-incident history (pty round-106 spawn_blocking+
  timeout, serial round-107 try_send+retry, ssh round-103..105 await+
  bounded+propagated), intentionally not unified; (3+4) brace noise.
  Agent trees confirmed fully converged at both intra and cross file
  levels.

### 2026-09-08 SOLID round 41 (parse-failure envelope audit)
- **Audit finding, kept as observation (no change)** — four body-JSON
  parse-failure sites in web/mod.rs use THREE different envelope shapes:
  api_call_tool returns a Value {ok:false} (MCP tool-error semantics);
  api_settings_put returns an axum Json envelope via into_response with
  NO status override (HTTP 200); api_gateway_connect returns a
  built_response 400. The settings_put 200 is NOT a bug: the round-69
  extraction comment pins it as the historical pre-extraction shape
  (byte-identical HTTP-200 envelope — presumably console clients
  tolerate it). Unifying would be a wire behavior change needing a
  product decision; recorded here as a candidate, not touched.
- **Matrix re-verified** — gateway 592, index 56, ui tsc -b clean after
  the round-39 DoAuthBase change (UI does not type-couple to the DO
  classes).

### 2026-09-08 SOLID round 42 (translate.ts chat-flow key guards)
- **Table-driven chat/completions key guards (DRY, gateway translate.ts
  first real reduction)** — the isChatCompletions arm carried seven
  byte-identical guards (if route.kind === X && !xKey →
  keyMissingError(X)) with no per-kind comment distinctions — true
  copy-paste, unlike the messages-flow guards that legitimately differ
  per endpoint. Replaced with two ordered [kind, key] tables split
  around the channelDegradedError probe so the probe keeps its exact
  position. Behavior unchanged (same conditions/order/returns; the
  round-360 no-borrow + BYOK tests still cover the paths). 592 pass;
  tsc/prettier clean; mirror synced in the same commit (round-39
  lesson). translate.ts drops 69→58 window-sites / 31→27 blocks — its
  first reduction after many constant scans; the residual is
  two-flow (messages vs chat) window overlap, still classified-kept.

### 2026-09-08 SOLID round 43 (isCount guard table + gate completion)
- **Table-driven isCount key guards (DRY, gateway translate.ts)** — the
  count_tokens arm carried three byte-identical key-existence guards
  (deepseek/qwen/amd), no per-kind comments — same class as the
  round-42 chat table. Converted to the identical shape/order.
  592 pass; tsc/prettier clean; mirror synced. The remaining translate
  guard groups (nvidia/gmi branch, passthrough 4-guard) carry real
  per-kind comments (amd rc-key rationale, og-native breaker history)
  — table-izing would lose that documentation; classified-kept with
  evidence. mcp_client tools.rs re-checked: residual windows are
  adjacent-function artifacts (record_mcp_action/screenshot json
  tails), auto-select already shared since round-11.
- **Gates completed** — round-42/43 commits pass the CI gates the
  earlier passes skipped: gateway format:check + lint clean; strict
  8-line baseline re-run: translate.ts down to 37 window-sites (from
  ~46+), mcp-tools schemas + secrets DPAPI remain the only standing
  classes.

### 2026-09-08 SOLID round 44 (relayUpstreamResult for the 3 forward arms)
- **Shared upstream-result relay (DRY, gateway translate.ts)** — the
  chat/completions, /v1/responses and messages-passthrough arms each
  carried a byte-identical ~20-line upstream-result tail (breaker
  failure/success recording for og, CORS stamping, generation-id
  capture, body streamed back untouched) — the round-14 extraction
  covered only the two failure helpers. Extracted
  `relayUpstreamResult(env, request, routeKind, upstream, detail,
  inspectFailure, ctx, recordOgBodyFailure)` with the flag so the
  messages-passthrough arm's historical ABSENCE of body-failure
  breaker recording is preserved exactly (it relies on the up-front
  channelDegradedError check only) — a flagged behavior difference
  observed, not silently unified. 592 pass; tsc/prettier clean;
  mirror synced. translate.ts drops 37→27 window-sites at the 8-line
  window — residual is the two-flow ox-alpha/upstream-repick overlap.

### 2026-09-08 SOLID round 45 (DEVICE_PARAM for the MCP tool schemas)
- **Shared device-selector field (DRY, gateway mcp-tools.ts)** — every
  MCP tool inputSchema carried its own copy of the device field (18
  seven-line blocks + 9 inline no-description variants) — the largest
  remaining duplication after translate.ts converged. Extracted
  `DEVICE_PARAM` (Record<string, unknown>) and spread it at each site
  (`...DEVICE_PARAM`). The 9 tools that declared device with NO
  description now inherit the standard one — a schema-text improvement
  for AI clients; nothing pins the old shape (592 pass). tsc/prettier
  clean; mirror synced. mcp-tools.ts drops 47→29 window-sites at the
  8-line window; the residual is the inputSchema structural prefix
  (declaration syntax, not duplication). Both former top-two files
  now sit at ~28 sites.

### 2026-09-08 SOLID round 46 (memory store ns filter + tombstone)
- **ns_matches + tombstone (DRY, agent memory/store.rs)** — the full
  scan surfaced two real in-file copies the earlier rounds missed:
  search/list/export each inlined the same namespace if-let filter
  (3 copies) and the eviction + retention paths each inlined the same
  soft-delete tombstone write (2 copies — round-19's recount helper
  had left these). Extracted module-private `ns_matches(rec,
  namespace)` and `tombstone(rec, persist)`; behavior unchanged
  (299 lib pass; fmt + clippy clean; one E0596 self-caught — the
  evict arm's persist is already &mut, fixed before commit). Translate
  residual re-verified: the remaining ox-alpha windows are per-flow
  adjacent-code artifacts, not copies.

### 2026-09-08 SOLID round 47 (store/lib fine-window + full gates)
- **Verification round (no code changes)** — (1) gateway/src/store +
  gateway/src/lib scanned at the 6-line window for the FIRST time since
  the store/ split: ZERO duplication (round-35's "store clean" verdict
  now proven at the fine window across all sub-files); (2) the
  round-46 store.rs helpers pass the complete agent matrix: 299 lib +
  307 feature-gated + clippy/fmt + xwin check all green. Standing
  residual classes across the whole repo at the 6-line window are
  unchanged and all classified: mcp-tools structural schema prefix,
  translate two-flow windows, zen-us per-endpoint forwarding
  evolution, secrets DPAPI seal/unseal mirror, memory tool
  registration idiom, mcp_client adjacent-function artifacts, tooling
  og-vs-passthrough protocol headers.

### 2026-09-08 SOLID round 48 (UI/index/extension sweep + decision list)
- **Verification round (no code changes)** — (1) gateway/ui scanned at
  the 6-line window for the first time: only Auth.tsx's login/register/
  reset form windows (declarative JSX scaffolding with per-form
  handlers/i18n keys — 3 instances, each different; kept); (2)
  index/src + extension: ZERO duplication at the fine window; (3)
  periodic matrix: index 56 + npm CLI 9 green (gateway 592 + agent
  299/307 already green this cycle). No standing duplication remains
  anywhere that is not an explicitly-classified kept class.
- **Decision list consolidated** — the product-sign-off candidates
  accumulated across rounds (settings_put 200 envelope, messages-
  passthrough og body-failure gap, F3 relay-token proposal) are now
  collected in one "OPEN decisions" block at the top of the iteration
  log so a human decision-maker sees them without reading every round
  section.

### 2026-09-08 SOLID round 49 (settings 200-envelope pin test)
- **settings_put invalid-JSON envelope pinned (test-only, agent
  web/mod.rs)** — the round-41 OPEN decision's HTTP-200 wire shape had
  zero test coverage: a future "obvious" unification could silently
  change the wire. Added
  settings_put_invalid_json_keeps_http200_envelope pinning status 200
  + ok:false + code invalid_params with a comment pointing at the
  OPEN-decisions block. 300 lib pass (+1); fmt + clippy clean. No
  behavior changed.

### 2026-09-08 SOLID round 50 (milestone convergence snapshot)
- **Round-50 milestone** — (1) scanner tooling gap fixed: scan-dups.py
  now excludes Rust test-only files (*tests.rs, *_test.rs) exactly as
  JS *.test.* were already excluded — agent/src/plugins/terminal/tools/
  tests.rs (a #[cfg(test)] mod file) had polluted the production
  duplication signal with scaffold windows; terminal/ report drops 3
  files → 2 (e29ffc49). (2) Test-stripping verified sound on the
  largest test-bearing file: web/mod.rs 2219 raw lines → 780 code
  lines with zero cfg(test) residue. (3) Convergence snapshot at the
  50-round mark: 6-line window — 10 reporting files, ALL explicitly
  classified kept classes (schema prefixes, two-flow windows,
  registration idiom, per-endpoint forwarding evolution, DPAPI mirror,
  adjacent-function artifacts, protocol-header differences, form
  scaffolding); 8-line strict window — 6 files; cross-file — 3 known
  brace/trait windows. Feature-gated suite 308 (+1 from the round-49
  pin). Full matrix green: agent 300/308, gateway 592 + format,
  index 56, CLI 9.

### 2026-09-08 SOLID round 51 (large-file cohesion audit)
- **Verification round (no code changes)** — SRP file-size audit over
  the largest sources: mcp_client/tools.rs 1107 stripped production
  lines, web/mod.rs 780, translate.ts 756 — each judged a COHESIVE
  single-domain file (the mcp-client connection domain, the HTTP
  service surface, the translate protocol hub respectively), not a
  multi-responsibility aggregate; splitting by line count would add
  cross-file pub(crate) noise without SRP gain — kept with evidence.
- **Gates after the round-49 test commit** — xwin check green;
  feature-gated clippy exit 0 with ZERO hits in our code (the 2
  portable-pty "unexpected cfg" warnings are vendor dependency noise
  that CI's identical invocation has always tolerated). Matrix stays
  green.

### 2026-09-08 SOLID round 52 (top-level sweep + new baseline)
- **Verification round (no code changes)** — (1) gateway/src top-level
  fully walked: store.ts is the intended post-split re-export shim
  (12 importers, export * — kept by design, removing is diff without
  gain); anthropic-translate.ts (788 lines, second-largest, zero dup)
  has healthy function sizes (largest 149-line streamOgToAnthropic —
  single-domain converter); (2) post-test-file-exclusion full-repo
  baseline exposes no new files of concern: sse.rs + web/mod.rs
  windows are brace/adjacent artifacts, exec.rs slice_from windows
  are the long-classified Deferred class, electron main.js windows
  exist ONLY in the compiled artifact (main.ts source: zero) — tsc
  output noise. Full matrix unchanged green.

### 2026-09-08 SOLID round 53 (gateway-connect 400 pin)
- **gateway_connect invalid-JSON HTTP-400 pinned (test-only, agent
  web/mod.rs)** — completes the round-49 audit pair: settings_put's
  invalid-JSON envelope is pinned HTTP 200 (historical round-69 shape)
  and gateway_connect's same-class error was previously unpinned — now
  pinned HTTP 400, so the OPEN-decision contrast is documented on BOTH
  endpoints and a future unification is a visible wire change on both,
  never silent drift on one. Web-endpoint coverage review also
  confirmed: panel host-gate + grant redemption (4 tests), auth,
  settings (6), gateway-connect (2 + this) all covered; tunnel arm
  intentionally untested (external cloudflared). 301 lib pass (+1);
  fmt + clippy clean.

### 2026-09-08 SOLID round 54 (error-classification full audit)
- **Verification round (no code changes)** — extended the round-359
  error-classification audit from terminal to EVERY plugin: all ~40
  DeviceError::Internal sites in plugins/ walked. Verdict: all are
  legitimate server-side classes (network/HTTP/IO/task-join/upstream
  responses). The one borderline site — update/tools.rs's
  check_download_url failure (a MISCONFIGURED download host, not a
  caller argument) — is kept Internal with evidence: the AI caller
  cannot fix it via parameters, the message carries the diagnostic,
  and it is a refuse-to-install SECURITY posture where Internal's
  no-retry semantics are the safe default. Round-359's classification
  discipline now covers the whole plugin surface.

### 2026-09-08 SOLID round 55 (exec.rs wait-loop buffer read)
- **poll_output_chunk (DRY, agent exec.rs — closes a long-Deferred
  class)** — the foreground + background execute wait loops each
  inlined the same buffer-read pair (dropped-cursor jump + slice_from +
  chunk length). The round-94 cursor-jump lesson was commented at only
  ONE site — the background loop carried the same semantics silently.
  Shared `poll_output_chunk(buf, sid, read_abs, truncated)`; the
  foreground loop passes Some(&mut truncated) to keep its 1MB-burst
  truncation reporting, the background wait passes None. The
  slice_from window class is now fully resolved (one remaining
  exec.rs scan-site is a distinct scan-from usage). 301 lib pass; fmt
  + clippy clean.

### 2026-09-08 SOLID round 56 (poll_output_chunk unit tests)
- **poll_output_chunk semantics pinned (test-only, agent exec.rs)** —
  the round-55 extraction's behavior had zero direct pins: the
  round-94 dropped-jump, the foreground truncation report vs the
  background None, unknown-session empty, cursor-past-end window, and
  the caller-advances contract. 5 unit tests cover all five (the jump
  + report path, the bg no-report path, empty session, past-end
  window, cursor-left-for-caller). One self-caught wrong expectation:
  the helper does NOT advance read_abs on a normal read (the caller
  does read_abs += chunk_len) — corrected in-test. 306 lib pass (+5);
  fmt + clippy clean. DPAPI seal/unseal re-examined and kept:
  symmetric FFI scaffolding with windows-only, locally-unverifiable
  behavior.

### 2026-09-08 SOLID round 57 (tool-domain coverage sweep)
- **Verification round (no code changes)** — walked the remaining
  agent tool domains for unextracted patterns: (1) session-lookup +
  SessionNotFound is already shared via ctx::session_lost (exec.rs +
  sessions.rs both use it — no third copy); (2) memory/tools.rs id
  params: only 2 identical "Entry id" declarations (round-45-scale
  constant extraction not warranted); (3) files.rs + output.rs small
  and clean (183/214 stripped lines, zero windows); (4) tunnel.rs (11
  tests) / metrics.rs (3) / filelog.rs (6) all have coverage. Gates:
  feature-gated suite 314 (306 lib + 8 feature-only), xwin check
  green, tree clean.

### 2026-09-08 SOLID round 58 (terminal manager find_backend)
- **find_backend (DRY, agent tools/terminal/mod.rs)** — term_resize /
  term_write_bytes / terminate each inlined the same lock →
  iter_mut().find(sid) → SessionNotFound → clone-backend block, with
  round-49's heartbeat touch duplicated at two of them. Shared
  `find_backend(sid, touch)`: clones the Arc inside the lock so the
  caller operates the backend OUTSIDE it (review-#10 discipline — a
  blocked write stalls only its own call; the cloned Arc also survives
  a concurrent sweeper removal). Behavior unchanged (resize/write touch
  last_output as before; terminate does not). 306 lib pass; fmt +
  clippy clean. terminal/mod.rs residual windows now are the
  if-let-style find sites (close/try_execute — they mutate session
  state in place, not clone-able; kept) plus the SessionInfo map tail.

### 2026-09-08 SOLID round 59 (record-path + connections-domain review)
- **Verification round (no code changes)** — (1) mcp_client
  record_mcp_action/screenshot share the timeline row shape (8 keys,
  parsed by the panel's Evidence drawer) but extraction was judged
  net-NEGATIVE: a shared base row plus per-record inserts ADDS lines
  and needs Value-object type gymnastics; the append_action_line
  helper (round-25) is the right shared seam, the differing keys stay
  visible. Kept with evidence. (2) connections.rs saved-connection
  handlers: forget delegates to conn_forget; connect_saved's
  conn_list + find + enriched InvalidParams is the round-359
  self-recovery design (single site — not duplicated). (3)
  store/devices.ts helper layer already returns not_found/name_taken
  discriminants (converged in the store rounds). Gateway 592 baseline
  re-verified.

### 2026-09-08 SOLID round 60 (round-60 convergence snapshot)
- **Verification round (no code changes)** — round-60 milestone. The
  system-plugin file tools were re-examined: only 3 identical "path"
  schema declarations (threshold for a DEVICE_PARAM-style constant is
  not met — kept). Convergence since the round-50 snapshot: 7 code
  commits — find_backend + poll_output_chunk (manager/exec helper
  extraction, the latter closing the long-Deferred slice_from class),
  poll_chunk unit tests, the gateway-connect HTTP-400 pin (completing
  the settings-200/400 audit pair), the scan-dups Rust test-file
  exclusion, ns_matches + tombstone (memory store), updateUserKeys +
  the earlier gateway guard/relay/schema extractions. Residual windows
  at 6 lines: 14 files, all explicitly classified kept classes.
  Matrix: agent 306 lib / 314 feature / clippy+fmt / xwin green,
  gateway 592, index 56, CLI 9. System tools' remaining windows are
  per-tool bodies (each file op distinct) — no further extraction
  warranted at this window.

### 2026-09-08 SOLID round 61 (terminal-domain clean-slate check)
- **Verification round (no code changes)** — (1) ctx.rs (168) /
  exec.rs (652) / sessions.rs (311) stripped lines: ZERO dup windows
  — the terminal tools directory is fully clean after the round-46/55/
  58 extractions; (2) feature-gated suite 314 + feature clippy clean
  re-verified after find_backend; (3) mcp_client has no client.rs (all
  session logic lives in the 1107-line cohesive tools.rs — round-51
  judgment stands); (4) find_backend unit-testing judged not worth the
  harness: the stub TerminalManager is an empty shell (no feature),
  testing the desktop_impl path needs feature + tokio runtime +
  sweeper setup for one SessionNotFound branch — terminal behavior is
  covered by the device e2e suite instead. Kept with evidence.

### 2026-09-08 SOLID round 62 (ox-alpha two-flow pair closed)
- **oxAlphaReasoningDefault (DRY, gateway translate.ts)** — the
  /v1/messages and chat/completions flows each inlined the same
  stealth/ox-alpha reasoning-effort default (route.kind check +
  rawWithOxAlphaReasoningDefault) — the LAST byte-identical two-flow
  pair after the round-42/44 guard-table + relay extractions.
  Shared `oxAlphaReasoningDefault(routeKind, upstreamModel, body)`;
  behavior unchanged. 592 pass; tsc/prettier clean; mirror synced.
  translate.ts full 19-block re-walk confirmed the remaining windows
  are structural two-flow parallelism (destructure/fetch/relay call
  shapes) plus per-flow-necessary key guards (each of the 3 opencode
  guards serves a different flow) — nothing further extractable at
  this window.

### 2026-09-08 SOLID round 63 (residual-window full classification)
- **Verification round (no code changes)** — post-ox-alpha baseline:
  translate.ts 46→41 sites; index worker (all index/src/*.js)
  ZERO dup windows (never scanned before — clean). mcp-tools.ts
  15 blocks re-walked: every window is the inputSchema/DEVICE_PARAM
  declaration skeleton (9 identical shape sites + schema heads —
  round-39/45 kept-class, DEVICE_PARAM already shared). Remaining
  small windows newly examined: web/sse.rs (`}}` adjacency artifacts),
  gateway/src/index.ts (import + call-shape artifacts), web/mod.rs
  (check_auth return shapes), system/tools.rs ("required": ["path"]
  schema tails) — all kept classes with recorded evidence. 14
  residual files fully classified; nothing extractable at this
  window.

### 2026-09-08 SOLID round 64 (zen-us error forwarding + window-depth scan)
- **relayUpstreamError (DRY, proxies/zen-us-proxy)** — the /v1/responses
  and /v1/messages flows each inlined the same non-ok upstream →
  client jsonError block; the messages copy had drifted to a 2-chain
  fallback (no err.message) under its own 5xx pre-branch (generic
  client text + server-side detail log — kept local). Shared
  relayUpstreamError(upstream, cors) with the 3-chain fallback
  (superset: responses unchanged, messages gains err.message
  coverage). 8/8 zen-us + sibling zen-go 12/12 green. ALSO ran the
  window-depth escalation: 10-line scan shows only the known
  structural classes; 20-line scan is EMPTY repo-wide — no segment
  of ≥20 consecutive lines is copied anywhere. This closes the
  copy-detection space at every meaningful window depth.

### 2026-09-08 SOLID round 65 (memory unknown-id envelope single-sourced)
- **unknown_id_error (DRY + wording contract, agent memory/tools.rs)** —
  memory_update and memory_delete each returned the same
  {"ok": false, "error": "unknown id: {id}"} envelope inline; one
  wording across two tools is a recovery contract for AI clients
  (re-search before retry), so the message is now single-sourced via
  unknown_id_error(id). 2 sites → shared helper; 34 memory-domain
  tests pass; fmt + clippy clean. Baseline re-run: zen-us 12→10
  sites; tooling.ts windows = fetch-call adjacency artifacts;
  memory/mcp_client residuals = ToolDef closure-head + schema-tail
  framework shapes. Copy-detection remains closed at 6/10/20 lines.

### 2026-09-08 SOLID round 66 (secrets.rs DPAPI full re-walk)
- **Verification round (no code changes)** — secrets.rs ALL 6 windows
  re-examined end to end (not just the round-56 head review): every
  window is the seal/open mirror of the CryptProtectData /
  CryptUnprotectData FFI argument layout (~12 shared lines: in_blob/
  out_blob CRYPT_INTEGER_BLOB construction + the 4-null +
  UI_FORBIDDEN + &mut out call block). Extraction would need a
  fn-pointer-typed shared caller across two windows-sys signatures and
  is windows-only (locally unverifiable beyond xwin check, no tests) —
  kept with evidence as symmetric FFI scaffolding. This closes the
  agent-side residual review: every listed file now has an explicit
  kept-class record at 6-line depth.

### 2026-09-08 SOLID round 67 (test-file + 5-line-depth sweep)
- **Verification round (no code changes)** — ran the more sensitive
  5-line window restricted to 3+ hit blocks (true-copy signal): the
  hits are (1) studio/vendor/monaco (third-party, excluded by roots in
  the regular scan), (2) TEST files — gateway.test.mjs 33 blocks are
  upstream-mock stubs (chat.completion Response shapes at 5+ sites)
  and assertion skeletons, deliberately inlined per-test so a failing
  assertion reads self-contained without helper hops — test
  self-containment beats DRY in verification assets, kept with
  evidence (same class: plugins.test.mjs / mcp-handler / health /
  vale-cli / mcp_integration.rs / e2e.js), (3) production hits are
  ToolDef registration-head framework shapes (system/tools.rs 5 file
  tools share the schema-tail + closure-head + require_str("path")
  skeleton with per-tool differing descriptions). No production
  copy exists below the 6-line floor either.

### 2026-09-08 SOLID round 68 (execute_local SRP extraction)
- **execute_local (SRP, agent exec.rs)** — tool_execute's router
  closure buried the local-shell path (~235 lines: spawn + Unix
  process-group + bounded 1 MB tail capture with truncation +
  kill-on-timeout) after the session-mode wait loop. Extracted
  module-level `execute_local(command, timeout_secs, bus)` — the
  closure now dispatches between the session wait-loop and the local
  path, which is self-contained and individually readable. Behavior
  unchanged (ShellExec gains .to_string() at the new &str boundary;
  needless_borrows fixed on .arg). 306 lib pass; feature 314; fmt +
  clippy clean; xwin check green. Note: the copy-depth sweep having
  closed (rounds 64-67), this round resumes function-level SRP
  decomposition of the remaining oversized closures.

### 2026-09-08 SOLID round 69 (flatten_result extraction + tests)
- **flatten_result (SRP, agent mcp_client/tools.rs)** — mcp_client_call's
  dispatch tail inlined the response-folding logic (~45 lines:
  structuredContent first, else text items joined with newlines,
  image items passed as data: URIs). Extracted module-level
  `flatten_result(&result)` — pure function, now covered by 3 unit
  tests (text join, image data-URI pass-through, structuredContent
  preference). The dispatch tail now reads as one call; the ~240-line
  call closure loses its second post-processing block (the
  screenshot-resolution block stays — it needs early returns + fs
  access). 309 lib (+3) / 317 feature; fmt + clippy clean.

### 2026-09-08 SOLID round 70 (parse_screenshot_ref + regression pins)
- **parse_screenshot_ref (SRP, agent mcp_client/tools.rs)** — the
  screenshot-resolution block inlined the text-reference scan (~28
  lines incl. the round-246 markdown-bugfix commentary: bare
  extension match + paren terminator). Extracted pure
  `parse_screenshot_ref(&str) -> Option<String>`; the round-246 fix
  now has 3 regression pins: plain paren reference, markdown-style
  reference (the formerly-NEVER-firing branch), no-reference /
  other-extension None. 312 lib (+3) / 320 feature; fmt + clippy
  clean. ALSO examined tool_open's ~150-line drainer spawn for the
  same treatment and KEPT it: its captures include a &SessionLogger
  reference whose lifetime is tied to plugin registration —
  module-level extraction would need 'static restructuring for a
  readability-only gain (recorded; revisit only if the drainer grows).
  Self-caught: first test append silently failed (python \U escape in
  a non-raw heredoc string) — raw-string retry fixed.

### 2026-09-08 SOLID round 71 (agent big-function census)
- **Verification round (no code changes)** — census of every agent
  fn ≥150 lines (17 entries) with per-entry judgment. Deferred
  candidates (single-responsibility pipelines, kept): tool_execute
  (session-mode linear pipeline — poll/scan reads already extracted
  round-55/68), tool_open (drainer extraction deferred round-70),
  pty spawn (pty-creation pipeline), ssh connect, serial open,
  sftp_handler, playwright manager start, provision_tunnel,
  run_server (service assembly), self_heal (win service),
  update_from_tgz/agent_update (update transaction — tgz step already
  extracted), term_open (manager method). CLEAN finds: web/mod.rs
  handle_request is pure dispatch (each api_* already its own fn),
  connections.rs store (remember/list/forget + tests, small), memory/
  files/output domains (round-57). mcp_client_call down to 177 from
  ~240 (flatten + parse extractions rounds 69-70). Next candidates
  when a round needs one: playwright manager start or pty spawn
  sub-block review.

### 2026-09-08 SOLID round 72 (wait_healthy extraction)
- **wait_healthy (SRP, agent playwright/manager.rs)** — the round-71
  census's top deferred candidate: PlaywrightManager::start inlined
  the health-poll pipeline (~90 lines: 30s probe loop with a REAL
  JSON-RPC initialize handshake check (round-129), streamable-HTTP
  first-chunk read, child-exit fast fail, and the failure path that
  folds the last 500 stderr chars into the error and kills the child
  (round-163)). Extracted module-level wait_healthy(&mut child,
  port) — start now reads: spawn → wait_healthy → register under the
  lock. Behavior unchanged; fixed the extracted tail's missing Ok(())
  (if-block as last expression). 312 lib / 320 feature pass; fmt +
  clippy clean; xwin check green. start shrinks ~90 lines; its
  stop()/probe helpers were already separate.

### 2026-09-08 SOLID round 73 (post-extraction baseline + census recheck)
- **Verification round (no code changes)** — re-ran the 6/10-line
  baselines after the rounds-68-72 extraction burst: totals stable
  (mcp-tools 57 / translate 41 / secrets 12 / memory 16 all kept
  classes; translate-vision.ts 2 sites = 1-block adjacency artifact).
  exec.rs re-appeared at 6 sites / 3 blocks — classified: the window
  is execute_local's main select loop hitting TWO adjacent exit-probe
  branches (458/490 — pipe-closed probe vs periodic probe, same
  loop, ~3-line shared head) — same-loop adjacency, not cross-code
  duplication; kept. Census recheck of the remaining ≥150 fn
  deferreds: pty spawn's reader/reaper threads are one-time
  capture-assembly (maintained — extracting needs 6-slot plumbing for
  no readability gain); sftp_handler is a parameterized single tool
  (op dispatch is protocol); ssh connect / serial open / provision_
  tunnel are linear pipelines. No new extraction warranted.

### 2026-09-08 SOLID round 74 (gateway big-function census)
- **Verification round (no code changes)** — the agent-side census
  (round-71) extended to gateway/src: ≥120-line functions are
  translate.ts handleGatewayImpl (842 — the three-flow framework with
  per-flow private segments; round-42/44/62 extractions already took
  every byte-identical pair, residual is flow-local by construction),
  anthropic-translate.ts streamOgToAnthropic (542 — og→anthropic SSE
  stream conversion, single deep pipeline), channels.ts
  museResponsesExit (181), auth.ts testKey (174), device-proxy.ts
  proxyDevice (125 — SSRF stack already in device-fetch.ts),
  index.ts handleGateway (143 — dispatch), upstream.ts pickRoute
  (141 — switch-case route table, each arm declarative + only qw/
  or arms carry 2-way format logic that is inherent). All judged
  cohesive single-responsibility; no new extraction. Full-repo
  function census (agent 17 + gateway 7 entries) now on record.

### 2026-09-08 SOLID round 75 (full-suite gate incl. integration tests)
- **Verification round (no code changes)** — the extraction-burst
  rounds (68-72) were only ever verified at --lib; per the round-282
  lesson (lib-only tallies mask integration failures) this round ran
  the COMPLETE `cargo test -p vale-agent`: 355 passed total — lib
  312 + main 5 + tests/integration.rs 27 + mcp_autoselect 1 +
  mcp_client 2 + mcp_integration 7 + stdio integration (env-gated) —
  zero failures. Also tallied the burst: 25 commits since the round-74
  anchor, 8 code commits (find_backend, execute_local, flatten_result
  + tests, parse_screenshot_ref + pins, wait_healthy, oxAlphaReasoning
  Default, unknown_id_error, poll_chunk tests). Full-suite 355 is the
  new completeness number alongside lib 312 / feature 320.

### 2026-09-08 SOLID round 76 (tail_append extraction + cap-semantics pins)
- **tail_append (SRP + coverage, agent exec.rs)** — round-75's
  integration inventory showed the local-execute capture loop's
  nested append_chunk closure (1 MB tail-cap semantics from round-55
  BOUNDED capture: keep-newest-half pre-drain on overflow + post-trim
  to cap, truncated flag) was pure logic with ZERO direct tests. Four
  call sites (live receive path + final drains) existed under one
  closure. Extracted module-level `tail_append(captured, truncated,
  chunk, max)` with max parameterized for tests; 3 unit tests pin the
  semantics (within-cap keep-all; oversized-chunk newest-half
  retention; accumulated-overflow drain-to-half-then-append = 80 of
  100 after 5×30 — two self-caught wrong expectations precisely
  documented the intended behavior). 315 lib (+3) / 323 feature; fmt
  + clippy clean. NOTE: first attempt failed on my own grep truncation
  (4 real call sites, head -3 showed 2) — regex + exact count assert
  fixed it.

### 2026-09-08 SOLID round 77 (prompt-marker regression pins)
- **Test-only round (agent exec.rs)** — marker-domain audit found the
  scan logic fully shared (shell_integration.rs find_prompt_started /
  find_finished with tests; exec.rs wait loops call them exclusively)
  EXCEPT find_prompt_marker — the LEGACY OSC-133 scan kept for the
  headless-stub path and backward-compat reads — which carried the
  round-100 false-prefix fix with ZERO direct tests. Added 3 pins:
  complete-sequence parsing (start/end/exit-code over the WHOLE
  sequence), incomplete/missing → None (the cross-chunk caller
  contract), and the round-100 scenario (a literal \x1b]133;D; prefix
  with no digits/BEL must not poison a later real marker). 318 lib
  (+3) / fmt + clippy clean.

### 2026-09-08 SOLID round 78 (spill persistence layer pins)
- **Test-only round (agent ctx.rs spill layer)** — append_spill /
  rotate_spill / read_spill (with spill_base) were only ever exercised
  INDIRECTLY through terminal_read tests; the round-115 rotation
  semantics (drop oldest `discard` bytes via atomic temp rewrite,
  delete when discard >= len, best-effort true on missing file,
  review-#5 true-only-on-advance contract) had zero direct tests.
  Added 4 in tests.rs: append/read roundtrip, rotate-then-read with
  absolute base offsets (bytes [40,100) read as [50,60) via base=40),
  missing-file → true, discard-past-end removes the file. 322 lib
  (+4) / feature 330; fmt + clippy clean. Self-caught: the first
  append landed INSIDE the connect_saved async fn — items inside a fn
  body compile but are never collected as tests (the count stayed
  318) — the closer was re-inserted before the new tests.

### 2026-09-08 SOLID round 79 (coverage-domain closure + full-suite refresh)
- **Verification round (no code changes)** — secrets.rs store layer
  checked for the same indirect-only gap the round-76/78 rounds
  closed elsewhere: NO gap — it already carries isolated-file tests
  (crud_roundtrip + the round-126 legacy raw-key delete semantics,
  per-thread store isolation at line 355+). Full-suite total
  refreshed after the round-76/78 test additions: 365 passed (lib
  322 + main 5 + integration 27 + autoselect 1 + mcp_client 2 +
  mcp_integration 7 + stdio env-gated; the +10 delta = tail_append 3
  + prompt-marker 3 + spill 4). Coverage-domain audit now spans:
  read/screen/history/retain (tests.rs), marker/pty-stream,
  execute-result, conns store, spill layer, prompt markers, mcp
  result flattening + screenshot refs, memory store — every pure-logic
  layer reached in the recent extraction rounds has direct pins.

### 2026-09-08 SOLID round 80 (round-80 matrix snapshot)
- **Verification round (no code changes)** — round-80 milestone.
  Top-level agent test-distribution census: web/mod.rs 35, tunnel 12,
  session_log 11, bootstrap 9, paths 8, sse/panel/state/mcp-server 7
  each, filelog 7, main 6, metrics 4 — only winmain.rs is 0 (pure
  cfg(windows) service code — platform-restricted, cannot run on the
  Linux dev box; acceptable and recorded). FULL matrix re-verified in
  one pass: agent full suite 365 (incl. integration), feature 330,
  zen-us 8, zen-go 12, index 56, CLI 9, gateway 592, clippy x2 + fmt
  clean, xwin check green (openrouter-proxy absent = the retired
  2026-09-07 worker; only zen-go/zen-us + vercel-proxy remain under
  proxies/). Tree clean after every commit.

### 2026-09-08 SOLID round 81 (debt + description-consistency sweep)
- **Verification round (no code changes)** — three consistency
  sweeps, all clean: (1) TODO/FIXME/XXX/HACK inventory across every
  production tree (agent/src, gateway/src, index/src, proxies, the
  electron src) is EMPTY — no accumulated debt markers anywhere;
  (2) terminal_execute's tool description ("idle window scales: ssh
  3s, serial 4s, pty 1s") matches the code exactly (idle_confirm
  match: ssh 3000ms / serial 4000ms / default 1000ms — the AI-client
  contract is truthful); (3) translate-vision.ts (243 lines, 2
  window-sites = call adjacency) already shares its describeImage
  tails via finishDescribe(resp, cacheKey, env, extract) +
  cacheImageDesc with the round-119 failure-marker contract — no
  unextracted duplication. Library-wide convergence continues to
  hold at every audit angle attempted.

### 2026-09-08 SOLID round 82 (feature full-suite gate)
- **Verification round (no code changes)** — the feature-gated
  COMPLETE suite (`cargo test -p vale-agent --features
  terminal,keyring`, incl. integration tests) was never run as a
  whole — only the feature lib (330). Full feature suite: 373 passed
  (+8 over the default 365 = the feature-only integration branches),
  zero failures. Completeness numbers now on record: full default
  365, full feature 373, lib 322/330, feature lib 330 — plus the
  stable per-change gates (clippy -D warnings ×2, fmt, xwin check).

### 2026-09-08 SOLID round 83 (final-corners duplication sweep)
- **Verification round (no code changes)** — the last unscanned
  corners of the repo went through the 6-line window scan: index/src,
  vale-agent-npm/src, vale-desktop-electron src (main.ts), and
  gateway/ui/src are ALL clean except two known kept classes
  (electron main.js's fetch-timeout/schtasks patterns — VERIFIED
  fresh vs its main.ts source, the round-354 stale-artifact failure
  mode stays closed by the round-321/322 CI gates; Auth.tsx label
  JSX adjacency). Every production tree in the monorepo has now been
  duplication-scanned at 5/6/10/20-line depths with recorded
  classifications — the copy-detection space is fully closed
  repo-wide.

### 2026-09-08 SOLID round 84 (tooling + workflow-layer review)
- **Verification round (no code changes)** — extended the sweep to
  the last non-source layers: (1) mcp-tools.ts's 2 remaining inline
  device declarations are DELIBERATE enhanced-description variants
  (terminal_open's "Device name from the console Devices list…" reads
  better for the tool that needs device choice explained) vs the
  generic DEVICE_PARAM text — kept; (2) scripts/*.sh + workflows:
  only ci.yml shows 6-line windows — the job preamble boilerplate
  (runs-on/checkout/setup-node) — and the node versions deliberately
  DIFFER per job (22 for gateway/ui, 24 for panel — round-286/287
  lessons), so YAML-anchor extraction would need parameterization for
  near-zero benefit; job boilerplate is conventionally repeated.
  Workflow/tooling layers classified; no changes warranted.

### 2026-09-08 SOLID round 85 (session_lost recovery-contract pins)
- **Test round (agent ctx.rs)** — session_lost, the enriched
  "Session not found" error that carries the AI client's self-recovery
  contract (open-session list + the "(none — agent restarted?
  re-open with terminal_open)" hint + the round phase-4 pre-restart
  note), is used by terminal_execute (exec.rs:590) and terminal_screen
  (sessions.rs:351) and referenced by connections.rs — yet had ZERO
  direct tests (round-359 pinned only the connect_saved sibling).
  Added 3: empty-store reopen hint + InvalidParams class; no restart
  note for never-seen ids; pre-restart record explains a PTY that
  died with the agent (process-wide OnceLock map injected IN MEMORY
  only — persist_pre_restart never called, zero disk writes, record
  removed after, sole-writer discipline). 325 lib (+3) / feature 333;
  fmt + clippy clean. Self-caught AGAIN: an append pass dropped the
  closing brace of the round-78 spill_rotate_discard test — the new
  tests nested inside it as local items (compiled, never collected,
  count stuck at 322) — closer restored + stray trailing brace
  removed; brace-depth verification now mandatory after test-file
  appends (this is the second local-item nesting trap).

### 2026-09-08 SOLID round 86 (architecture snapshot gate refresh)
- **Docs round (docs/ARCHITECTURE.md)** — the maintained-layering
  snapshot's gate-count rows had drifted since the round-354 audit
  (agent grew 12 refactor/test rounds, gateway grew suites). Re-
  measured everything end to end and updated: agent row 350 -> 368
  (325 lib + 5 bin + 27 + 1 + 2 + 7 + 1 integration + 15 core; 333
  lib feat-gated, 376 full feat-gated — feature-full was re-run as a
  whole, matching round-82's record); gateway 580 -> 592; proxies
  19 -> 20 (zen-us 8 + zen-go 12; the ×2 row never included the
  retired openrouter). Also audited the error-template family during
  discovery: session_lost / connect_saved / job_id are all single-
  point constructors; the terminal_jobs registry (job wait loop) has
  no direct tests but its input requires a real backgrounded session
  (pipeline-bound, recorded not forced).

### 2026-09-08 SOLID round 87 (uniform session_lost across session tools)
- **Refactor + test (agent)** — a new headless matrix test exposed a
  real inconsistency: terminal_write checked session existence in the
  TOOL layer (enriched session_lost: open list + "(none — agent
  restarted?)" + reopen instruction) while terminal_resize /
  terminal_select / terminal_close let the BACKEND answer bare
  (stub: "backend not enabled"; real: DeviceError::SessionNotFound) —
  the AI client's recovery experience was tool-dependent. Fix:
  ensure_session_known(mgr, sid) helper extracted next to session_lost
  in ctx.rs; write's inline two-line check swapped to it; resize /
  select / close gained the check (close also reports the closed-
  session kind instead of failing bare). +1 cfg(not(feature)) matrix
  test: all four answer session_lost with the reopen hint on unknown
  ids. 326 lib / 369 full / 333 feature lib; fmt + clippy clean.
  (Discovery route: files.rs sftp + terminal_jobs were checked first —
  pipeline-bound real-SSH inputs, recorded not forced.)

### 2026-09-08 SOLID round 88 (icon sync + CI clippy sweep)
- **Fix round (electron + agent)** — two unrelated cleanups. (1) The
  Electron shell's source icon files (agent/vale-desktop-electron/icon.*)
  were out of sync with brand/ + the npm package: they still had the old
  render (2740-byte icon.png with scanline stripes) while brand/ and npm
  had the corrected render (3010 bytes, stripes removed in commit 888cbb12).
  The shell loads icons from the source dir -> taskbar showed the stale
  icon. Synced both from brand/ (commit fd6724aa). (2) CI clippy -D warnings
  flagged two issues from the round-87 session_lost tests: unused `bus`
  variable in three tests (prefixed `_bus`) and a useless `vec![b'x'; 90]`
  in tail_append's test (switched to `&[b'x'; 90]`). Pushed both to GitHub;
  CI green on retry (run 887).

### 2026-09-08 SOLID round 89 (extract convertUserMessage + convertAssistantMessage)
- **Refactor (gateway anthropic-translate.ts)** — toOpenAIRequest inlined
  ~40 lines each for user message (text/image/tool_result parts) and
  assistant message (thinking/text/tool_use) conversion. Extracted both as
  module-level helpers (convertUserMessage / convertAssistantMessage) taking
  the messages array so the main fn reads as a routing skeleton. Gateway
  592 pass / tsc clean. Self-caught: the first extraction pass dropped the
  else-if (assistant) and else branches from the message loop -> tsc error
  TS1128; restored before the run.

### 2026-09-08 SOLID round 90 (extract checkRateLimit)
- **Refactor (gateway translate.ts)** — handleGatewayImpl's inline rate-
  limiting block (per-token minute + day counters with in-memory Maps) is
  now a module-level checkRateLimit(env, method, path, token) returning
  Response | null. The main fn calls it once after auth. Gateway 592 pass
  / tsc clean.

### 2026-09-08 SOLID round 91 (extract dispatch from handle_request)
- **Refactor (agent web/mod.rs)** — handle_request's route-match block
  (~55 lines) is now a module-level dispatch(state, method, path, body,
  query) returning Result<Value, Box<Response>>. The main fn stays auth +
  body parsing + routing skeleton. 330 pass / clippy clean. Self-caught:
  the first pass left needless borrows (&state/&body_str where state was
  already &AppState) and a result_large_err (Response is large -> boxed);
  both fixed before the run.

### 2026-09-08 SOLID round 92 (extract parse_memory_settings)
- **Refactor (agent web/mod.rs)** — api_settings_put's inline memory-
  validation block (entries/bytes/retention with the missing-key
  convention) is now a module-level parse_memory_settings(v) returning
  (entries, bytes, retention, changed). 330 pass / clippy / fmt clean.

### 2026-09-08 SOLID round 94 (extract extractByokKeys)
- **Refactor (gateway translate.ts)** — handleGatewayImpl's inline BYOK key
  extraction (8 keys from the ukeys blob) is now a module-level
  extractByokKeys(ukeys) returning a typed record. Gateway 592 pass / tsc
  clean.

### 2026-09-08 SOLID round 95 (extract detectRoute)
- **Refactor (gateway translate.ts)** — handleGatewayImpl's inline route
  detection (isCount/isMessages/isChatCompletions/isResponses from
  method + path) is now a module-level detectRoute(method, path) returning
  a typed record. Gateway 592 pass / tsc clean. Self-caught: the first
  extraction pass dropped the 404 guard for unknown routes (test: POST
  /v1/<unknown> → 404); restored before the run.

### 2026-09-08 SOLID round 96 (round-96 matrix milestone)
- **Verification round (no code changes)** — round-96 milestone. Every
  suite re-verified green in one pass: agent 330 lib / 373 full
  (incl. integration) / clippy 0 / fmt clean, gateway 592 / tsc /
  prettier / eslint clean, index 56, npm CLI 9, zen-us 8, zen-go 12,
  xwin check green. The SOLID extraction phase (rounds 55-95) delivered
  25+ code commits (10 test pins + 15 refactors) — every pure-logic
  layer reached in the recent extraction rounds now has direct pins,
  and the copy-detection space is fully closed repo-wide at all depths.

### 2026-09-08 SOLID round 97 (round-97 matrix milestone)
- **Verification round (no code changes)** — round-97 milestone. Every
  suite re-verified green in one pass: agent 330 lib / 373 full
  (incl. integration) / clippy 0 / fmt clean, gateway 592 / tsc /
  prettier / eslint clean, index 56, npm CLI 9, zen-us 8, zen-go 12,
  xwin check green. The SOLID extraction phase (rounds 55-97) delivered
  25+ code commits (10 test pins + 15 refactors) — every pure-logic
  layer reached in the recent extraction rounds now has direct pins,
  and the copy-detection space is fully closed repo-wide at all depths.

### 2026-09-08 SOLID round 98 (OPEN-decisions implementation ×3)
- **Product-signed fixes (agent + gateway + docs)** — the three OPEN
  decisions were approved together, so all three landed in one round:
  (1) settings_put invalid-JSON now HTTP 400 (was 200), matching
  gateway_connect — test renamed to
  settings_put_invalid_json_returns_http400_envelope; (2) the messages-
  passthrough arm now records og body-failure breaker trips
  (recordOgBodyFailure false→true), closing the historical gap — all
  three arms count alike; (3) F3 scoped relay token step 1 (ADR-0007
  adopted): per-user relayToken + findUserByToken role-"relay" copy,
  POST/DELETE /api/me/token/relay, masked presence in meGet + admin
  user list, regenerateToken sweep skips the relay mapping; /mcp +
  recovery stay admin-only by construction (verified, not assumed).
  Tests: agent 373 full + gateway 603 (+10 relay-token.test.mjs, +1
  admin-masking pin); tsc/prettier/eslint + clippy/fmt clean.
  Self-caught: the detectRoute extraction dropped the unknown-route
  404 guard (fixed + test-pinned before commit). Step 3 (revoking the
  admin token from relay paths) stays an operator cutover — NOT coded.
  Deployed: `wrangler deploy` live (Version 2371e743) — /api/health 200,
  POST /api/me/token/relay 401-unauth on the live worker (route + gate
  verified, not just merged).

### 2026-09-08 SOLID round 99 (step-3 switch + 1.2.305 release)
- **F3 step 3 ships as a default-off switch** (`settings:
  RELAY_ADMIN_CUTOVER`, translate.ts): cutover-off admin passes (pinned),
  cutover-on admin 401s with a relay-token pointer while relay passes and
  /mcp admin passes. Flipping = one KV write, no deploy; the window stays
  open until the operator announces it. Gateway 606 pass, tsc/prettier/
  eslint clean, deployed live (Version 486f5701, health 200).
- **Agent 1.2.305 released** (payload: settings_put 400): xwin release exe
  staged, CLI 9/9, publish-release.sh green (version.json sha + last-5
  prune + index deploy 7477804e + /api/version smoke v1.2.305). Tag +
  GitHub asset via release.yml next; reconcile after the asset lands.
  Step 2 (settings.json swap) stays operator-side: issuance needs a
  console session the agent loop cannot mint.
  P0 reconcile finding (1.2.305): CDN tgz vs GitHub asset differ ONLY in
  vale-agent.exe (17142272 vs 17140736 B, same source commit) — the other
  8 members are byte-identical. PE builds are not reproducible across
  builders (timestamps/paths), so whole-tgz equality can never hold for
  any release packing a locally-built exe. Proposal (needs sign-off, NOT
  applied): amend the P0 check to member-wise equality + exe provenance,
  instead of whole-tgz bytes. No history of "reconcile OK" exists — this
  is the first time the audit actually ran to comparison.

### 2026-09-08 SOLID round 101 (MCP channel proof + d1 credential survey)
- **Operator asked whether d1 is reachable via MCP — yes, verified live.**
  This box's `ANTHROPIC_API_KEY` is a gateway admin token: `/mcp ping`
  authenticated, `tools/list` returned the full terminal + browser kit,
  opened two pty sessions on d1 and closed both afterwards (hygiene).
- **d1 needs NO settings.json swap** (Step-2 scope correction): d1's agent
  runs as SYSTEM (no user settings there); the only settings.json on the
  box is `C:\Users\Administrator\` (27 B, effortLevel only, no env); no
  Machine/User ANTHROPIC*/VALE* env vars; no saisi.online refs in any
  user config. d1 is a pure target device, never a relay client. Probes
  read key NAMES only, never values. Note: a concurrent worker was live
  on d1 mid-survey (interleaved buffer output observed, incl. their
  config.yaml edit) — probes were re-run on a clean session.
- Step-2 remainder = this box's key only, blocked on an operator-minted
  relay token (issuance is session-gated; no token path exists by design).

### 2026-09-08 SOLID round 102 (relay token console UI)
- **Operator: relay token must show on the page, not just curl.** Built it:
  Keys page Relay card (status badge from meGet relayTokenSet, Issue/
  Rotate showing the value once in memory + copy, session-gated Reveal
  via new POST /api/me/token/relay/reveal for the forgot-to-save case,
  Revoke with confirm), i18n zh+en, client types. Backend reveal pinned
  (401/404/value). Old UI bundle pruned. Gateway 607 pass, tsc/eslint/
  prettier + ui build/test/render-smokes green. Deployed live (Version
  dcda168a): health 200, reveal route 401-unauth, new bundle 200 served.
  Operator path is now: console Keys page → Issue → copy → paste per
  machine → tell the loop to verify + flip the cutover.

### 2026-09-08 SOLID round 103 (operator handed relay token; local swap live)
- **Operator issued via the new Keys UI and pasted the relay token.**
  Swapped this box's `ANTHROPIC_API_KEY` (safe JSON round-trip, old admin
  value kept in shell memory only, never written elsewhere; exact-match
  re-read confirmed). Live matrix, all as designed: relay + bogus model
  → 402 (past auth, zero spend) vs bad token → 401; relay on /mcp ping
  → 401 (relay-scoped, not admin). Skipped the spendy full-path probe —
  post-gate code is role-agnostic and stub-covered.
- Ops note: this box no longer holds the admin token in any file (the old
  value stays valid server-side — only the local copy was replaced, so a
  console-Overview re-paste always recovers). d1 already proven keyless.
  Remaining: operator confirms all relay clients swapped → loop flips
  RELAY_ADMIN_CUTOVER.

### 2026-09-08 SOLID round 104 (relay end-to-end double-confirm)
- **Operator asked to double-confirm: ran a REAL relay call** (og/
  deepseek-v4-flash, max_tokens=1) with the box's relay token → 200 with
  a valid Anthropic message envelope (thinking + text). File re-read:
  exact-match relay. This supersedes round-103's gate-level-only proof —
  full path (auth → owner keys → upstream → reshape) works on relay.
  Trivial spend, single probe. Cutover flip still awaiting operator word.
- **Post-swap self-check: this box's own /mcp channel now 401s
  (`admin token required`) — least privilege applies to the loop itself,
  as designed.** Consequence: live device interrogation (e.g. d1's
  current release) is no longer possible from here without the admin
  token; last confirmed d1 = 1.2.278. Cutover flip + deploys unaffected
  (Cloudflare token path, not gateway admin).

### 2026-09-08 SOLID round 105 (d1 upgraded to 1.2.305 via MCP)
- **Operator handed the admin token back; loop drove the npm flow on d1
  through gateway /mcp.** Pre-check corrected the record: d1 was already
  1.2.304 (not 1.2.278 — something updated it earlier), npm pkg confirmed
  1.2.304. Ran `npm i -g latest.tgz` (7s, pkg → 1.2.305) then `vale update`
  (WMI-parented swap, connection drop as designed); reconnected after 30s,
  `.vale-release` (provable-success marker) reads **1.2.305**. Sessions
  closed afterwards. Note: concurrent worker live on d1 throughout
  (interleaved output + their own pkg checks) — state was re-read before
  the swap to avoid a double-update collision.
- Hygiene ask: the pasted admin value now lives in chat history — operator
  should rotate it (console one click) to expire this temporary grant.

### 2026-09-08 SOLID round 106 (device version display fix)
- **Operator: agent version not visible on the page.** Root cause: the
  status probe read `j.version` (frozen Cargo 1.0.145 — every device
  showed v1.0.145 forever and the outdated badge never cleared), ignoring
  `j.release` (round-304). Fix prefers release, falls back to version for
  pre-1.2.276 agents; no UI change needed (list already renders
  lastVersion + badge — the data was wrong, not the view). Tests: 3 probe
  pins (preferred + persisted via touchDeviceSeen, fallback, absent).
  Gateway 610 pass, tsc/eslint/prettier clean, deployed live (Version
  b8bbe55e, health 200). Operator confirms on the Devices page: d1 row
  should now read v1.2.305 with no outdated badge.

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
  by every settings.json holder) — decision material ready:
  docs/adr/proposal-scoped-relay-token.md (round-356 audit + options A–D,
  B recommended). Needs user sign-off (breaks existing clients if tightened)
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
