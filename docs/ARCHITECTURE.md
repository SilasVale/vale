# Vale Architecture — layering snapshot

> Status: maintained ｜ Last full review: 2026-09-06 (fsapi coverage refresh) ｜ Scope: the whole repo
>
> Single-page map of every module's boundary verdict. Each entry carries the
> evidence (file-header note, ADR, or audit round). When a boundary verdict
> CHANGES, update this file in the same commit. Detailed history lives in the
> ADRs (`docs/adr/`) and the agent iteration log (`agent/AGENTS.md`).

## System overview

```
AI clients ──► vale-gate (CF Worker) ──► upstream channels (og/ds/qw/or/nv/gmi/cm/amd)
console SPA ──►   │  plugins + tooling            │ og via zen, muse via Vercel/zen-us exit
extension ────►   │                               └─ proxies: zen-go/zen-us/openrouter (BYOK pipes)
vale CLI ─────►   │
                  ▼
devices (Windows) ◄── cloudflared tunnel (agent-supervised, free path)
  ├─ vale-agent (Rust): web/ + mcp + plugins (terminal/playwright/memory/update)
  └─ vale-desktop-electron: CDP 9333 + control 9444 + tray/watchdog

install/update: npm tgz ONLY (vale-dist worker; one-time file drop = R2 + TempClaimDO)
studio (pm2, code.saisi.online): code/term/git workspace for the human + extension deep links
```

## Directory contracts (the placement rules)

| Directory | Contract | Evidence |
|---|---|---|
| `gateway/src/` | front door (`index.ts` — hosts/HTTPS/CSRF/dispatch) + cross-cutting FOUNDATION modules | AGENTS.md "Foundation modules" |
| `gateway/src/plugins/` | route plugins + the registry framework + each plugin's EXCLUSIVE collaborators (device-proxy→devices; translate-vision/model-route→translate). Two live consumers ⇒ move to src/ | registry.ts header (d9b4a0ba) |
| `gateway/src/store/` | KV domains behind a re-export shim; `cache.ts` is the SINGLE process-global cache; no inter-domain cycles | bc64b8fb |
| `gateway/src/lib/` | cross-plugin policy factories (ratelimit) | 931f42d6 |
| `agent/src/web/` | mod.rs auth+dispatch+handlers; panel.rs (static+grant redemption); sse.rs (streams) | 02193d37 |
| `agent/src/plugins/terminal/tools/` | ctx.rs (shared state) ← per-domain builders (exec/sessions/files/output/secrets/connections); mod.rs owns registration order | f869d432 |
| `agent/src/tools/` | TRANSPORTS (ssh=russh, serial=SerialPool) UNDER the terminal backends; the two ssh.rs are layers, not duplicates | da6a6137 |
| `index/src/` | single-file router + extracted pure modules (claim.js, page.js) | 81b1c40f |
| `proxies/*` | one-file workers, DELIBERATELY autonomous (ADR 0003) — ~90 lines of CORS/safeEq duplication is the accepted cost of independent secrets/deploys | 5e1f410e review |

## Module boundary verdicts (all reviewed 2026-08/09)

| Module | Verdict | Where |
|---|---|---|
| gateway channels.ts | DATA registry (endpoints/whitelists/health cards + exit helpers); "adding a channel touches only this file" holds | header note (a2501e92) |
| gateway upstream.ts | routing DECISIONS (pickRoute/passthroughHeaders); one-way upstream→channels | header note (a2501e92) |
| gateway reliability.ts | cohesive cluster: bounded fetch → retry ladder → timeout policy → BreakerDO + channel health; every upstream call goes through it | header note (da6a6137) |
| gateway access.ts | Cloudflare Access IDENTITY layer beside session.ts; self-contained JWT verify (L5) | header note (da6a6137) |
| gateway auth trio | auth.ts = primitives leaf (imports NOTHING) ← session.ts = resolution ← plugins/auth.ts = routes. Physical merge REJECTED (access↔auth cycle) | headers (c81fe8bf) |
| agent vale-command-core | the contract crate (Plugin/ToolDef/Config/EventBus); canonical import `vale_agent_core::`; tokio-util CancellationToken is the MCP layer's vocabulary (kept, documented) | lib.rs (29c2a575, a64c32d2) |
| agent paths.rs | single path-resolution truth, OnceLock-cached (boot-invariant) | 584c7669 |
| agent register.rs / mcp/server.rs | register.rs is a pure-planning seam (network lives in main.rs); mcp/server.rs is a thin rmcp↔registry adapter with the full hardening set (round-118/123/124, panic isolation) — correctly layered | fd7d5c19 review |
| agent TerminalManager | 1071-line session orchestration over 3 backends — size inherent to owning PTY/SSH/serial lifecycles with the documented lock discipline (round-92/94/55); a split would scatter the lock policy | fd7d5c19 review |
| agent state.rs | write-through ConfigHandle: file before swap under one guard (ADR 0005) | c579b311 |
| index single file | appropriate at current size; page template + claim logic extracted | 81b1c40f |
| extension | clean: no stale endpoints, least-privilege manifest, shared.js for constants | abb541ce review |
| ~~studio~~ | RETIRED 2026-09-06 (ADR 0006): replaced by code-server behind Access (vscode.saisi.online → 127.0.0.1:7739, password + Access double gate); the extension deep-link target switched to code-server folder-open. Its 41-test suite and lib/ modules are preserved in git history. Post-retirement sweep: code.saisi.online still resolves but is Access-gated with its own app (no unauthenticated exposure) | ADR 0006 |

## Foundation layers (features build on these; changes run every downstream gate)

- **gateway**: http.ts, auth.ts (safeEq/randomHex/HMAC/CSRF), session.ts, reliability.ts, upstream.ts, channels.ts, body-scan.ts, store/cache.ts, lib/ratelimit.ts, mcp-errors.ts
- **agent**: vale-command-core, paths.rs, state.rs ConfigHandle, web/ helpers, session_log.rs (audit trail), bounded subprocess runners
- **studio**: lib/fsapi.mjs (path safety/atomic writes/git), lib/auth.mjs, lib/pty.mjs, lib/watch.mjs, lib/terminals.mjs
- **vale CLI**: boundedFetch — every network call goes through it (6cd81347)
- **test harnesses**: gateway test/helpers.mjs, studio test/helpers.mjs, proxies per-file stubs

## Documented trade-offs (deliberate, not defects)

| Trade-off | Rationale |
|---|---|
| Public-endpoint rate limits are per-isolate memory | KV per-request writes reopen the Free-plan quota-exhaustion vector (round-104); probe only KV-seeds its bucket (lib/ratelimit.ts `kvSeed`) |
| Panel-grant single-use is best-effort | KV eventual consistency; ms window, device-Bearer gated, blast radius documented (ADR 0004) |
| keys/reveal returns the full key to a session | session holders can already rotate/clear; explicit-intent counterpart to the masked list (6c034e44) |
| Device-proxy console-origin HTML can read console APIs | round-133/134 accepted limitation — the sandbox alternative breaks the panel |
| Muse defaults to the Vercel exit | CF egress fails zen's Meta RegionError; only Vercel's ORD edge verified (proxies/README.md) |
| Studio WS/e2e tests are live-only | real PTY + browser deps; CI runs the HTTP contract tier (README tiering) |
| Electron main.ts not split further | no testability gain — electron is unimportable under plain node |
| code-server replaces studio (2026-09-06, ADR 0006) | Monaco ceiling + whole-home workspace need; live on vscode.saisi.online → 127.0.0.1:7739 with password + Access double gate (the tunnel is DASHBOARD-managed; its remote config evolved: socket → 7739 HTTP by the operator) |

## Test gates (per subproject)

| Subproject | Gate | Count (2026-09-06) |
|---|---|---|
| gateway | tsc + eslint(src+ui) + prettier + node --test | 295 |
| agent | cargo test + clippy -D warnings + fmt --check + xwin check | 221 |
| proxies (×3) | node --test behavior suites + wrangler dry-run | 26 |
| studio | node --test (api/terms/terms-readonly/fsapi/hub; e2e live-only) | 44 |
| electron | node --test (url-policy) + tsc build | 4 |
| extension | node --check all JS | — |
| release chain | release-lib regression + bin/electron freshness + tgz content gate + fail-closed smoke/reconcile | 11 checks |
