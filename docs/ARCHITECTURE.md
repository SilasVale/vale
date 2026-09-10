# Vale Architecture — layering snapshot

> Status: maintained ｜ Last full review: 2026-09-08 (09-07/09-08 sweep: Vercel retirement, vrelay, relay token, extension→code-server) ｜ Scope: the whole repo
>
> SOLID program 2026-09-09 (rounds 1–97, `refactor(solid)` commits): OCP/ISP/DIP/SRP refinements banked per-module below + 94 gateway / 24 Rust / 4 CLI / 54 relay / 9 extension / 7 index / 19 scripts / 2 deps pins. NOT a boundary re-review — every verdict below stands unless the row says otherwise; counts refreshed in Test gates.
>
> Single-page map of every module's boundary verdict. Each entry carries the
> evidence (file-header note, ADR, or audit round). When a boundary verdict
> CHANGES, update this file in the same commit. Detailed history lives in the
> ADRs (`docs/adr/`) and the agent iteration log (`agent/AGENTS.md`).

## System overview

```
AI clients ──► vale-gate (CF Worker) ──► upstream channels (og/ds/qw/or/nv/gmi/cm/amd)
console SPA ──►   │  plugins + tooling            │ og via zen, muse via Oracle vrelay US exit
code-links ext ─► │                               └─ proxies: zen-go/zen-us (BYOK pipes; openrouter retired 2026-09-07) + vrelay (Oracle VPS: full api-relay handler set since 2026-09-08, Vercel retired)
vale CLI ─────►   │
                  ▼
devices (Windows) ◄── cloudflared tunnel (agent-supervised, free path)
  ├─ vale-agent (Rust): web/ + mcp + plugins (terminal 26 / memory 6 / system 9 / mcp-client 4 / playwright 2 / update 1 / design 1 = 49 tools)
  └─ vale-desktop-electron: CDP 9333 + control 9444 + tray/watchdog

install/update: npm tgz ONLY (vale-dist worker; one-time file drop = R2 + TempClaimDO)
auth: admin token + scoped relay credential (role "relay", ADR 0007) — relay paths dual-accept during migration, cutover via RELAY_ADMIN_CUTOVER flag (default off)
~~studio~~ RETIRED 2026-09-06 (ADR 0006) — code-server behind Access (vscode.saisi.online) is the code-viewing surface; the extension is now a code-server folder-link rewriter ("Vale Code Links"); zero tracked files remain under studio/ (untracked node_modules/test/vendor leftovers only)
```

## Directory contracts (the placement rules)

| Directory | Contract | Evidence |
|---|---|---|
| `gateway/src/` | front door (`index.ts` — hosts/HTTPS/CSRF/dispatch) + cross-cutting FOUNDATION modules | AGENTS.md "Foundation modules" |
| `gateway/src/plugins/` | 9 route plugins (admin/auth/device-proxy/devices/mcp/model-route/registry/translate/translate-vision) + the registry framework + each plugin's EXCLUSIVE collaborators (device-proxy→devices; translate-vision/model-route→translate). Two live consumers ⇒ move to src/ | registry.ts header (d9b4a0ba) |
| `gateway/src/store.ts` | pure re-export shim over `store/` — every existing `from "../store.ts"` import keeps working; implementation lives in the domain modules | store.ts header |
| `gateway/src/store/` | KV domains (users/admin/settings/devices/regkeys/plugins/grants) behind the shim; `cache.ts` is the SINGLE process-global cache; no inter-domain cycles | bc64b8fb |
| `gateway/src/lib/` | cross-plugin policy factories (ratelimit) | 931f42d6 |
| `agent/src/web/` | mod.rs auth+dispatch+handlers; panel.rs (static+grant redemption); sse.rs (streams) | 02193d37 |
| `agent/src/evidence.rs` | the pwout AI-evidence feed contract (actions.jsonl append/newest-first read, shot listing, basename guard, `browser-actions-changed` push) — ONE owner for both producers + the web reader (SOLID R98) | evidence.rs header |
| `agent/src/plugins/terminal/tools/` | ctx.rs (shared state) ← per-domain builders (exec/sessions/files/output/secrets/connections); mod.rs owns registration order | f869d432 |
| `agent/src/tools/` | TRANSPORTS (ssh=russh, serial=SerialPool) UNDER the terminal backends; the two ssh.rs are layers, not duplicates | da6a6137 |
| `index/src/` | single-file router + extracted pure modules (claim.js, page.js) | 81b1c40f |
| `proxies/*` | one-file workers, DELIBERATELY autonomous (ADR 0003) — ~90 lines of CORS/safeEq duplication is the accepted cost of independent secrets/deploys | 5e1f410e review |
| `proxies/api-relay` | VPS relay: entry.mjs (socket plumbing ONLY since R68–R69: host/header/response-header helpers moved verbatim to routing.mjs) + routing.mjs (pure table+matchers+plumbing, table-param seam) + api/ edge handlers with exported pure guards (SOLID R18–R23: first tests this tree ever had) | server/routing.mjs header |

## Module boundary verdicts (all reviewed 2026-08/09)

| Module | Verdict | Where |
|---|---|---|
| gateway channels.ts | DATA registry (endpoints/whitelists/health cards + exit helpers); "adding a channel touches only this file" holds | header note (a2501e92) |
| gateway upstream.ts | routing DECISIONS (pickRoute/passthroughHeaders); one-way upstream→channels. SOLID R1: switch → ROUTE_TABLE + registerRoute (OCP, closed for modification); R4: session-id extraction (clientSessionId) vs synthesis (syntheticSessionId) split (SRP) | header note (a2501e92) |
| gateway reliability.ts | cohesive cluster: bounded fetch → retry ladder → timeout policy → BreakerDO + channel health; every upstream call goes through it | header note (da6a6137) |
| gateway access.ts | Cloudflare Access IDENTITY layer beside session.ts; self-contained JWT verify (L5) | header note (da6a6137) |
| gateway auth trio | auth.ts = primitives leaf (imports NOTHING) ← session.ts = resolution ← plugins/auth.ts = routes. Physical merge REJECTED (access↔auth cycle). SOLID R5: resolution depends on the SessionUserStore seam (liveSessionStore default; ~25 call sites untouched). SOLID R8: route-do.ts authorizeDoRequest reuses auth.ts safeEq behind its fail-closed guard (second loop deleted) | headers (c81fe8bf) |
| gateway store.ts shim | PURE re-export (zero logic) over `store/` domains; keeps every `from "../store.ts"` import working after the domain split | store.ts header |
| gateway plugins/registry.ts | route-plugin framework (topo-order deps, fail-loud cycles) + typed capability seam provideApi/requireApi/optionalApi (SOLID R2/3: replaces raw ctx.api reads; translate/auth migrated) | registry.ts header |
| gateway mcp trio | mcp.ts = hand-rolled stateless JSON-RPC server (zero-dep, Workers has no runtime deps) ← mcp-tools.ts = DATA registry (mirrors agent /api/spec; round-54 lesson: both lists + spec snapshot update together) + mcp-browser.ts = browser bridge (per-call total budget + per-device semaphore; extension/PluginHubDO path deleted round-341) | headers (round-341) |
| gateway tooling.ts | public UNAUTHENTICATED CLI surface (health/probe/installers) extracted verbatim from index.ts — front door owns nothing but the front door (ADR 0001 completion) | header note |
| gateway route-do.ts | RouteDO per-user routes (KV→DO fix for cross-isolate staleness) + the SHARED DO external-address guard (BreakerDO/RouteDO dedup). SOLID R8: gate truth table pinned; comparison unified onto auth.ts safeEq | header note |
| gateway body-scan.ts | O(n) raw-string scans (10ms CPU budget). SOLID R7: estimateTokens = countBase64Payloads + estimateTextTokens composer (verbatim moves); raw-* rewriters directly pinned | body-scan.ts header |
| gateway device-proxy.ts | device reverse-proxy (session/plugin-token/per-device-cookie auth) + rewriteDeviceBody as an exported pure unit (SOLID R14: mount rewriting + token-strip pins; R54: table pruned to the live /api/ + /mcp paths) | device-proxy.ts header |
| gateway anthropic-translate.ts | PURE data transforms (Anthropic↔OpenAI), zero env dependency | header note |
| gateway relay token | `store/users.ts` User.relayToken + role "relay" (ADR 0007): relay paths dual-accept during migration, `/mcp` stays admin-only, cutover is the default-off RELAY_ADMIN_CUTOVER flag — one KV write, no deploy | ADR 0007 |
| agent vale-command-core | the contract crate (Plugin/ToolDef/Config/EventBus); canonical import `vale_agent_core::`; tokio-util CancellationToken is the MCP layer's vocabulary (kept, documented). SOLID R11/12: ensure_token table, ToolHandler blanket-impl + cancellable-default pins | lib.rs (29c2a575, a64c32d2) |
| agent paths.rs | single path-resolution truth, OnceLock-cached (boot-invariant) | 584c7669 |
| agent register.rs / mcp/server.rs | register.rs is a pure-planning seam (network lives in main.rs); mcp/server.rs is a thin rmcp↔registry adapter with the full hardening set (round-118/123/124, panic isolation) — correctly layered | ece266d4 review |
| agent winmain.rs | Windows-only boot plumbing (self-heal, child-reaper job, SCM service, tunnel supervisor) behind `#![cfg(windows)]`; main.rs keeps only `winmain::…` call sites. SCM dispatch wrapped as `started_by_scm()` (the macro-generated fn can't carry visibility); Linux test/clippy never compile this file — xwin check is its gate | header note (d35873b0, round-351) |
| agent TerminalManager | 1071-line session orchestration over 3 backends — size inherent to owning PTY/SSH/serial lifecycles with the documented lock discipline (round-92/94/55); a split would scatter the lock policy | ece266d4 review |
| agent terminal spill helpers | spill_path is the single Option choke point for spill-file access; writers fail closed (SOLID R6, review-#8 completion: validation lived only on the read path) | tools/ctx.rs header |
| agent state.rs | write-through ConfigHandle: file before swap under one guard (ADR 0005) | c579b311 |
| agent update busy marker | the exclusive cross-process update lock. Path + decision were BOTH duplicated: the acquirer built the path from PathBuf joins while the generated PowerShell swap script carried two hand-written literals of the same file (drift ⇒ the swap releases a marker the agent never made ⇒ updates refused for up to an hour), and the acquire/reclaim logic sat inline in the 300-line `agent_update` closure with no coverage despite three recorded incidents (round-54 check-then-act, round-54 stuck-marker, round-115 premature release). R99: `BUSY_MARKER_REL` is the single definition behind `busy_marker_path()`/`busy_marker_ps()`, and `acquire_busy_marker(path, stale_after)` owns the decision. Deliberately STAYS in `plugins/update/` (one consumer) — NOT promoted to the foundation layer | update/tools.rs header (R99) |
| agent evidence.rs | the pwout AI-evidence feed. Before R98 the JSONL open/append pair lived in TWO producers (playwright `browser_run_script` inline, mcp-client private helper), the refresh push was a mcp-client-private OnceLock (a second producer could not signal), and the reader in web/mod.rs re-implemented the shape by hand — a shape change had three places to land. Now: dir is a PARAMETER (contract unit-testable against a temp dir; paths.rs keeps the resolution), producers only supply payloads. Promotion held all three conditions (2 real producers + the round-245/252 evidence-feed incident lessons + zero env coupling) | evidence.rs header (R98) |
| index single file | appropriate at current size; page template + claim logic extracted | 81b1c40f |
| extension | code-server folder-link rewriter ("Vale Code Links"): no tokens, no network probes since ADR 0006 (pure-local resolution); manifest + README + default origin (`vscode.saisi.online`) re-synced 2026-09-08 | ADR 0006, 2026-09-08 sweep |
| ~~studio~~ | RETIRED 2026-09-06 (ADR 0006): replaced by code-server behind Access (vscode.saisi.online → 127.0.0.1:7739, password + Access double gate); the extension deep-link target switched to code-server folder-open. Its 41-test suite and lib/ modules are preserved in git history. Post-retirement sweep: code.saisi.online still resolves but is Access-gated with its own app (no unauthenticated exposure) | ADR 0006 |

## Foundation layers (features build on these; changes run every downstream gate)

- **gateway**: http.ts, auth.ts (safeEq/randomHex/HMAC/CSRF), session.ts, reliability.ts, upstream.ts, channels.ts, body-scan.ts, device-fetch.ts (device dialing + SSRF guard stack), store/cache.ts, lib/ratelimit.ts, mcp-errors.ts
- **agent**: vale-command-core, paths.rs, state.rs ConfigHandle, evidence.rs (pwout AI-evidence feed: append/newest-first read/basename guard/push), web/ helpers, session_log.rs (audit trail), bounded subprocess runners
- ~~studio~~: RETIRED with the code (ADR 0006) — lib/fsapi.mjs, lib/auth.mjs, lib/pty.mjs, lib/watch.mjs, lib/terminals.mjs live in git history only
- **vale CLI**: boundedFetch — every network call goes through it (6cd81347)
- **test harnesses**: gateway test/helpers.mjs, proxies per-file stubs (studio test/helpers.mjs retired with the code)

## Documented trade-offs (deliberate, not defects)

| Trade-off | Rationale |
|---|---|
| Public-endpoint rate limits are per-isolate memory | KV per-request writes reopen the Free-plan quota-exhaustion vector (round-104); probe only KV-seeds its bucket (lib/ratelimit.ts `kvSeed`) |
| Panel-grant single-use is best-effort | KV eventual consistency; ms window, device-Bearer gated, blast radius documented (ADR 0004) |
| keys/reveal returns the full key to a session | session holders can already rotate/clear; explicit-intent counterpart to the masked list (6c034e44) |
| Device-proxy console-origin HTML can read console APIs | round-133/134 accepted limitation — the sandbox alternative breaks the panel |
| Muse US exit = self-hosted Oracle VPS relay (2026-09-08; replaced the Vercel one) | zen geo-locates the EGRESS IP: CF egress 403 (re-verified after placement fixes), Vercel free team paused at 304% of its 10 GB transfer cap (402, project since DELETED); the Always-Free ARM box carries only the ~40 ms intra-US hop (muse E2E ≡ non-relayed baseline), grey-cloud + LE TLS, body-streaming nginx, 5-min watchdog; since 2026-09-08 the box ALSO serves the FULL api-relay handler set (zen/proxy/github/git/gform) as `vrelay` under Node, completing the Vercel retirement — VPS as USER-side front measured strictly worse (tails to 7.9 s); runbook proxies/README.md |
| Relay dual-accept window is open by design (ADR 0007) | admin tokens still pass relay paths until step 2 (clients on relay token) + step 3 (flip RELAY_ADMIN_CUTOVER); announce the window before flipping — it is a flag-day 401 for stragglers |
| ~~Studio WS/e2e tests are live-only~~ | retired with the code (ADR 0006) — was: real PTY + browser deps; CI ran the HTTP contract tier |
| Electron main.ts not split further | no testability gain — electron is unimportable under plain node |
| code-server replaces studio (2026-09-06, ADR 0006) | Monaco ceiling + whole-home workspace need; live on vscode.saisi.online → 127.0.0.1:7739 with password + Access double gate (the tunnel is DASHBOARD-managed; its remote config evolved: socket → 7739 HTTP by the operator) |

## Test gates (per subproject)

Run each gate from its own directory — never bare `node --test` from the
repo root: root discovery sweeps panel-react's vitest `.ts` files into
node's runner (extensionless imports unresolvable there), producing ~14
false failures. Suites are green only under their own runners.

| Subproject | Gate | Count |
|---|---|---|
| gateway | tsc + eslint(src+ui) + prettier + node --test | 712 (709 → 712, relay-matrix R81; suite green) |
| agent | cargo test + clippy -D warnings + fmt --check + xwin check | 425 feat-gated terminal,keyring (recounted R99: 379 lib — +9 evidence-feed pins R98, +4 busy-marker pins R99 — + 6 bin + 2 dep-surface + 27 + 1 + 2 + 7 + 1 integration; default-config lib 372; xwin gate re-verified R98 AND R99 (R99 touched `#[cfg(windows)]` code, so the cross-check is the only local gate that compiles it); suite green) |
| vale-agent-core | cargo test + clippy -D warnings + fmt --check | 22 (15 + 7 SOLID-program pins R11–R12; suite green) |
| vale CLI (npm) | node --test | 20 (16 + 4 SOLID-program pins R17: boxed-manifest contract; suite green) |
| api-relay (vrelay) | node --test + build-relay.sh bundle build | 54 (0 → 49 across SOLID R18–R23; 49 → 54 across R67–R69 no-body/plumbing/header-merge; suite green) |
| index (vale-dist) | node --test | 73 (66 + 5 R30 disposition/token/sha + 2 R74 electron-proxy; suite green) |
| extension | node --check all JS + node --test pure guards | 9 (4 R24 httpsOrigin MITM table + 5 R96 studio-links path core; CI extension job runs them) |
| proxies (×2) | node --test behavior suites + wrangler dry-run | 20 |
| ~~studio~~ | retired (ADR 0006); CI studio job dropped, suite lives in git history | — |
| electron | node --test (url-policy) + tsc build | 8 (recounted 2026-09-09, R44 audit; suite green) |
| scripts | plain asserts, no framework (bash + stdlib python) + CI pack-chain steps | 19 new (smoke sha-guard 9 R61, dup normalizer 10 R62; release-lib 20 pre-existing) |
| release chain | release-lib regression + bin/electron freshness + tgz content gate + fail-closed smoke/reconcile | 11 checks |
