# SOLID Iteration Program — ledger

Long-running, same-session program: bring the Vale tree toward SOLID
shaping **without changing behavior**, and pin every contract that matters
with tests + docs. English throughout; token cost is not a constraint,
correctness is.

## Rules of engagement (binding on every round)

1. **Behavior-preserving.** Refactors move code verbatim; only additive
   surface (new exports, new params with defaults, new table entries).
   Any semantic difference found mid-round is reverted, not "fixed",
   unless it is a documented security hole with sign-off.
2. **Respected no-split verdicts.** `docs/ARCHITECTURE.md` records
   deliberate monoliths (`reliability.ts` cluster, `TerminalManager`,
   Electron `main.ts`, hardware-gated backends). They are audited, never
   split.
3. **Evidence per round.** tsc / prettier / eslint (gateway), fmt / test /
   clippy `-D warnings` both configs (agent), `node --test` per-directory
   suites. A round is done only when its gates are green and the tree is
   clean (committed).
4. **No speculative generality.** New seams need a consumer (production
   call site or a test that would otherwise be impossible). Documented
   near-misses stay out (e.g. splitting `testKey`'s provider chain —
   arms differ too much; removing the `api` bag — churn without gain).
5. **Docs cadence.** `docs/ARCHITECTURE.md` gate counts + verdict notes
   refreshed every 10 rounds (R15, R25, R33…); this ledger updated with
   every banked round batch.
6. **Edit discipline.** Anchors end only on owned boundaries; `git diff`
   reviewed after every edit (rounds 4/11/14/21/22 caught and reverted
   mis-anchored edits this way).

## Round journal

| Round | Area | SOLID | Change | Tests | Commit |
|---|---|---|---|---|---|
| 1 | gateway upstream | OCP | `pickRoute` switch → `ROUTE_TABLE` + `registerRoute` (no new tests; refactor only) | ±0 | `375645ae` |
| 2–3 | gateway registry | ISP/DIP | typed capability seam (`provideApi`/`requireApi`/`optionalApi`); translate/auth migrated | +2 | `375645ae` |
| 4 | gateway upstream | SRP | session-id extract (`clientSessionId`) vs synthesize (`syntheticSessionId`) | +3 | `375645ae` |
| 5 | gateway session | DIP | `SessionUserStore` seam + `liveSessionStore` default | +4 | `375645ae` |
| 6 | agent terminal spill | SRP | `spill_path` → `Option` choke point; writers fail closed (review-#8 completion) | +2 | `917e3054` |
| 7 | gateway body-scan | SRP | `estimateTokens` → `countBase64Payloads` + `estimateTextTokens` | +7 | `375645ae` |
| 8 | gateway route-do | DRY/DIP | gate unified onto `auth.ts` `safeEq` (fail-closed guard kept) | +3 | `375645ae` |
| 9 | gateway vision | tests | vision-gate no-touch contract (`isVisionCapable` + early returns) | +5 | `375645ae` |
| 10 | — | — | commit point (R1–9 banked in two splits) | — | `917e3054` `375645ae` |
| 11 | agent-core config | tests | `ensure_token` truth table + alias/decouple/defaults | +5 | `0d0a4c60` |
| 12 | agent-core lib | tests | blanket-impl dispatch + cancellable default (std-only `block_on`) | +2 | `db99850c` |
| 13 | gateway ratelimit | tests | limiter factory contract (first direct suite) | +7 | `2230d8b2` |
| 14 | gateway device-proxy | SRP/tests | `rewriteDeviceBody` export + table/token/decode pins | +6 | `17b5e892` |
| 15 | docs | docs | ARCHITECTURE refresh (gates + verdict notes) | — | `570ce1f9` |
| 16 | agent sse | tests | `send_bounded` arms + guard Ok path | +3 | `751f79a8` |
| 17 | vale CLI | tests | boxed-manifest contract | +4 | `ed609fb4` |
| 18 | relay routing | SRP/DIP | `routing.mjs` table-param seam; first relay tests | +6 | `6e3fb015` |
| 19 | relay zen | tests | BYOK/target/path/auth-split gates | +10 | `64625cb9` |
| 20 | relay proxy | tests | BYOK/CORS/hygiene gates | +6 | `0ad7fdec` |
| 21 | relay github | tests | route/redirect/credential gates | +8 | `3ad55544` |
| 22 | relay git | tests | stricter allowlist/cap/auth-forwarding gates | +7 | `10f286af` |
| 23 | relay gform | tests | rewrite/redirect/reCAPTCHA/storm gates | +12 | `290ee1d1` |
| 24 | extension | tests | `httpsOrigin` MITM table + CI test step (first ext tests) | +4 | `8ece627a` |
| 25 | docs | docs | gates refresh (relay/CLI/ext rows added) | — | `51601f62` |
| 26 | gateway model-route | OCP | per-prefix key table + `registerChannelKey` | +5 | `8bf4ed0a` |
| 27 | gateway translate | SRP/tests | 4 pure units exported + route/key/reasoning/rate pins | +6 | `db0c2ab1` |
| 28 | gateway devices | SRP/tests | 4 validation units + boundary table | +6 | `45e0da8e` |
| 29 | agent mcp | tests | schema-fallback pin + full-matrix sweep | +1 | `f2607be0` |
| 30 | index | SRP/tests | disposition/token/sha exports + pins | +5 | `cb0ef0c1` |
| 31 | gateway mcp plugin | SRP/tests | probe classifier export + verdict pins | +4 | `8f6f3f77` |
| 32 | gateway auth | SRP/tests | probe units + allowlist COMPLETENESS pin | +7 | `f6ef6f64` |
| 33 | docs/gates | docs | xwin gap closed; gates refresh + index row | — | `a19b0d39` |
| 34 | matrix/docs | verify | full-matrix sweep; root-runner trap documented | — | `71a52c73` |
| 35 | matrix | verify | saturation audits; full matrix green, zero churn | — | — |
| 36 | docs | docs | AGENTS↔CLAUDE sync: stale `web.rs` paths fixed | — | `567c086e` |
| 37 | docs | docs | this ledger created | — | `8db494d8` |
| 38 | gateway vision | SRP/tests | `describeImage` export + fault→marker taxonomy + throw-gate consistency | +3 | `13730daa` |
| 39 | gateway auth | SRP | usage mappers extracted (`mapOpenRouter/Amd/OgUsage`); mapping tables | +4 | `6213de52` |
| 40 | gateway channels | tests | `usProxyBase`/`museResponsesExit` direct branch pins | +2 | `906ae87e` |
| 41 | audits | verify | TODO mine (1 human-only SSH item surfaced), unwrap audit, SFTP correctly untestable; zero churn | — | — |
| 42 | audits | verify | full-file reads: mcp.ts dispatch, cache.ts coherence, files.rs; all clean | — | — |
| 43 | agent web | tests | `timing_safe_eq` truth table (sole gate compare, was unpinned) | +1 | `abc297f2` |
| 44 | verify | verify | electron 8/8 (doc said 4); saturation re-confirmed; no commit | — | — |
| 45 | docs | docs | gates refresh (electron row, gateway/agent recounts); ledger R41–45 | — | `4f205e5d` |
| 46 | audits | verify | dependency audit (`cargo tree` dupes; reqwest dual-stack flagged for sign-off) | — | — |
| 47 | audits | verify | comment-claim integrity (all resolve; one correct Not-pinned) | — | — |
| 48 | gateway mcp | tests | typed-code isolation pins (guess-proof texts + backstop table) | +2 | `90d7ad31` |
| 49 | gateway translate | tests | rate-cap pin hardened to both sides, mutation-proven | ±0 | `b1a9b2b6` |
| 50 | audits | verify | mutation audit: DO/spill/BYOK mutants each killed precisely; ledger+counts | — | `6be0a5cb` |
| 51 | agent terminal | tests | diag ring bound + char-safe write cap | +5 | `7e2b412c` |
| 52 | gateway tooling | OCP | probe key table + `probeEnvKeyName`; cm channel pin | +2 | `63cabb39` |
| 53 | gateway consistency | tests | OCP tables × registries cross-checks (route/key/probe) | +3 | `626654bc` |
| 54 | gateway proxy | dead-code | prune 14 dead rewrite-table entries to live paths | +1 net | `96f12de7` |
| 55 | docs | docs | count reconciliation (see note) + ledger R51–55 | — | `60d2a25b` |
| 56 | docs | docs | open-threads: reqwest dual-stack decision recorded (R46 finding) | — | `33cca369` |
| 57 | gateway translate | SRP/tests | response decision tree export + stream/oneshot/envelope pins | +3 | `310b72ed` |
| 58 | gateway translate | tests | kind↔message cross-check + SSE envelope pin | +2 | `9be0f40e` |
| 59 | gateway consistency | tests | managed keys routable + probeable cross-checks | +2 | `32c182ab` |
| 60 | gateway auth | verify+fix | mutation proof → self-diagnosing probe fallback + comment correction | ±0 | `708d6d39` |
| 61 | scripts | tests | smoke sha-guard pins + CI step (new shell front) | +9 | `4736ecf3` |
| 62 | scripts | SRP/tests | dup-scanner seam + normalizer pins + CI step | +10 | `f1e238fb` |
| 63 | docs | docs | ledger R56–63 catch-up | — | `416a24d4` |
| 64 | agent memory | tests | dispatch roundtrip + validation/sanitize/envelope pins | +4 | `6d342093` |
| 65 | audits | verify | mutation wave 2 (name-regex, char-boundary, vision marker kills) | — | — |
| 66 | agent deps | tests | Cargo.lock surface pins (reqwest dual-stack, rmcp major) | +2 | `0b1f670e` |
| 67 | relay handlers | tests | GET-no-body upstream contract (zen/proxy; rest structural) | +2 | `5519f12f` |
| 68 | relay entry | SRP | host/header extraction + pins; bundle rebuilt | +2 | `d69166b1` |
| 69 | relay entry | SRP | response-header merge extraction; entry left with sockets | +1 | `d55e0a32` |
| 70 | docs | docs | stale wrapper-subsystem reference fixed + tree sweep | — | `2a05938a` |
| 71 | docs | docs | stale extraction provenance fixed + file-mention sweep | — | `066a9d66` |
| 72 | audits | verify | shared-tree coexistence check (stage-n work untouched, suites green) | — | — |
| 73 | docs | docs | ledger R64–73 catch-up | — | `1e237e6a` |
| 74 | index | tests | electron-proxy route pins (happy + !ok; throw path flagged) | +2 | `93b78216` |
| 75 | docs | docs | ledger R74–75 + index recount | — | `e6f7fcab` |
| 76 | audits | verify | README/spec-snapshot/touchSeen/bootstrap re-verification | — | — |
| 77 | gateway reliability | OCP | retryPolicyFor table + pins; count-arm revert (review catch) | +2 | `cd496595` |
| 78 | docs | docs | gmi retry question recorded as open thread; 1.2.309 coexistence | — | `218f94c3` |
| 79 | audits | verify | full fast-matrix sweep, all green (9 suites) | — | — |
| 80 | docs | docs | ledger R76–80 + gateway recount | — | `8391bd0d` |
| 81 | gateway translate | SRP/tests | result-relay export + breaker recording matrix pins | +3 | `cf91d2a9` |
| 82 | audits | verify | behavior-preservation audit: all program commits classified, zero drift | — | — |
| 83 | audits | verify | mutation proof: recordOgBodyFailure flag matters (precise kill) | — | — |
| 84 | docs | docs | ledger R81–84 + gateway recount | — | `ad429f92` |
| 85 | docs | docs | ledger R84–85 (record exactness) | — | `01fb4e53` |
| 86 | audits | verify | export-surface audit: all program exports test-imported | — | — |
| 87 | audits | verify | cross-layer 100MB limit audit (agent cap deliberately untested) | — | — |
| 88 | audits | verify | panel-react 183/183 fresh; adopt/api helpers pinned | — | — |
| 89 | docs | docs | two verdict rows refreshed to R54/R68–69 end-states | — | `c1962d7f` |
| 90 | gateway reliability | fix | gmi asymmetry retracted (misread); flag dropped; thread corrected | −1 net | `cc5847ac` |
| 91 | gateway auth | SRP | mePutKeys onto the shared key prologue (body rides along) | ±0 | `7db1e1b0` |
| 92 | audits | verify | access-handler review; double-check duplication judged structural | — | — |
| 93 | gateway auth | OCP | usage-query endpoint table + pins | +1 | `fa02e5cc` |
| 94 | agent terminal | tests | secret-tool validation without a keychain | +1 | `3e2a03cb` |
| 95 | audits | verify | dep drift check + build.sh/CI wiring verification | — | — |
| 96 | extension | SRP/tests | studio-links pure core to shared + path pins | +5 | `3a1346dc` |
| 97 | docs | docs | ledger R86–97 + recounts (agent 407, extension 9) | — | `4648be01` |
| 98 | agent evidence | SRP/OCP/tests | pwout AI-evidence feed promoted to `evidence.rs`: one owner for actions.jsonl append + newest-first read, shot listing, basename guard, `browser-actions-changed` push (was 2 inline producers + a mcp-client-private OnceLock + a hand-mirrored reader); dir now a PARAMETER so the contract is unit-testable; recount found the R97 "409" already stale (real pre-round 412) | +9 | `28c7c71f` |
| 99 | agent update | DRY/SRP/tests | update BUSY MARKER owned: the path was spelled out twice (a Rust PathBuf join in `agent_update` + two hand-written literals in the generated PowerShell swap script) and the acquire/reclaim decision sat inline in the 300-line handler closure with ZERO coverage despite three recorded incidents. Now `BUSY_MARKER_REL` → `busy_marker_path()` (acquirer) + `busy_marker_ps()` (swap script) from ONE definition, and the decision is `acquire_busy_marker(path, stale_after)` (atomic `create_new`; reclaim the stale marker at most once so a locked marker cannot spin). Mutation-proven: dropping the reclaim-once flag HANGS the suite (timeout exit 124), and changing either the relpath or the join shape fails the drift contract | +4 | `24341e1b` |
| 100 | agent terminal exec | SRP/tests | session-mode result cap extracted from the `tool_execute` wait loop into pure `bounded_append(result, truncated, s, max)`: the closure carried THREE panic/wedge incidents (round-105 OOM, round-113 oversized-chunk bypass, round-106 + review-#1 char-boundary panics that abort the loop PAST `term_release_execute` and wedge the session busy flag forever) with ZERO coverage. Both walks mutation-proven: removing the chunk-trim walk-forward panics with `start byte index 7 is not a char boundary; it is inside '汉'`, removing the drain walk-back panics in `String::drain` | +7 | `f44130df` |
| 101 | agent tool errors | DRY/tests | the device-tool FAILURE envelope `{"ok": false, "error": msg}` had NO owner — hand-written at 46 sites across 4 plugins (system 36, memory 7, connections 2, update 1). Promoted to `plugins::tool_error`; migration proven byte-identical mechanically (a string-aware extractor compared all 46 message expressions before/after: identical). While pinning it, the cross-layer contract was found UNDOCUMENTED and is now on record + tested: in-band `Ok({"ok":false})` renders as `{"ok":true,"result":{"ok":false}}` (outer ok TRUE, no top-level code) while typed `Err(DeviceError)` renders `{"ok":false,"error","code"}` — so the gateway's round-58 check classifies only the typed family as a failure | +3 | `7f74aec1` |> **Ledger repair (Round-98):** the stray duplicate `| 56 | …` row that sat
| 102 | agent web auth | SRP/security | `handle_request`'s auth gate was wrapped in a `needs_auth` flag that re-classified routes (`method != GET \|\| path.starts_with("/api") \|\| path == "/mcp"`) although the early returns above already decide exactly which requests are public — i.e. the flag was provably always true at that point. Duplicated classification is a security hazard with an ASYMMETRIC failure mode (disagreement ⇒ the gate is skipped ⇒ unauthenticated tool dispatch ⇒ SYSTEM-level device control), so the gate is now UNCONDITIONAL: anything reaching the dispatcher is authenticated by construction. Also: `auth_401_without_token` never sent a non-Bearer request (it used `req()`, which carries a WRONG token), so the genuinely-missing-header path had no coverage — now pinned, together with a 20-route auth-coverage matrix (both failure modes) and a public-surface pin so a tightening cannot silently lock out `/` + the panel SPA. Both halves mutation-proven. PIN-COUNT CORRECTION (R103 audit): this round ADDED 2 test functions (`every_dispatch_route_is_auth_gated`, `deliberately_public_routes_stay_public`) and MODIFIED `auth_401_without_token` — the earlier "+3" counted the modified test as new | +2 | `aeb5fcd0` |> after R97 (an R97 editing accident — R56 already has its row in sequence at
| 103 | agent router auth | tests | the axum layer that R102 explicitly left unpinned: `mcp::bind`'s `nest_service("/mcp", TokenGate) + fallback_service(WebPanel)` composition had NO router-level test (R102's pins call `handle_request` directly, so a routing edit stays green). New `tests/router_auth_integration.rs` drives a REAL server over real HTTP: `/mcp` gated by the Tower layer (missing + wrong token), the fallback branch reaching the web gate (GET and POST), and the public surfaces serving. Mutation-proven: dropping TokenGate from the nest fails the `/mcp` case; re-applying R102's broken `needs_auth` classification fails the fallback case | +3 | (this commit: the ledger row cannot name its own final hash) |> line 92) is removed. Also, the R97-recounted agent gate total (409) was
> ALREADY stale when written: the suites measured 412 before R98's changes
> (364 lib → 366; the extra 2 are post-recount tree drift, not program work).
> R98's rows use measured values only.

> **Counting correction (Round-55 audit):** prior cumulative claims
> overstated gateway pins (+85/+89/+90 across R50/R53/R54 reports) by
> conflating suite-delta with program-attributable tests — the 610
> baseline predates 8 stage-n tests, and the R1/+1–R2-3/+1 split has been
> corrected to R1 ±0 / R2–3 +2 above. Rebuilt from history: per-commit
> added-`test(` lines sum to the base→HEAD `git grep` delta exactly
> (gateway +82; agent lib +12 incl. `#[tokio::test]`; core +7). Trust the
> table above, not the older reports.

## Cumulative pins (program-attributable)

Gateway +94 · agent lib +42 · agent integration +3 · core +7 · CLI +4 · relay +54 · extension +9 · index +7 · scripts +19 · deps +2.

## Open threads (explicitly NOT started)

- `requireApi` has no production consumer yet (reserved for hard deps).
- `SessionUserStore` is default-only (minimal test seam, correct as-is).
- `testKey` provider chain stays an if-chain (arms differ too much to table).
- `api` capability bag stays (removal = churn without gain).
- reqwest 0.12 (direct) + 0.13 (via rmcp) dual HTTP stacks stay (R46 audit):
  unifying means migrating all agent call sites with device verification —
  needs product sign-off, never a silent program edit. Bitflags/cpufeatures
  transitive dupes likewise untouched (upstream-owned).
- ~~gmi retry asymmetry~~ WITHDRAWN Round-90: the "asymmetry" was a misread —
  nv/gmi /v1/messages never reach the native site (the arm's nv/gmi branch
  catches them first for the translate path, which retries). No asymmetry
  exists; the `gmiBursty` flag is removed and the routing fact is pinned by
  the gmi/nv messages-translate flow tests. Kept here so the retraction is
  on record.
- Panel-react, hardware-gated backends, Electron main: covered or
  deliberately untestable — see round notes, not revisit-worthy.
- **SUGGESTION for the human (R98 finding, NOT acted on):**
  `update::tools::host_of()` strips a bare IPv6 loopback URL
  (`http://[::1]:8080/x` → host `[`) so such a URL can never pass
  `check_download_url`'s loopback exemption — the existing `"::1"` match arm
  is dead. The code documents this deliberately ("widening a SYSTEM-execution
  gate is a product decision"), so R98 left it alone. One-line fix if wanted:
  use `reqwest::Url` for host parsing (already a dependency) — testable
  without widening the gate, since the verdicts are pure.
- `agent_update` (`update/tools.rs`) and `tool_execute`
  (`terminal/tools/exec.rs`, 622 lines) are the two remaining agent
  monoliths. Both are ~entirely `#[cfg(windows)]` or process-plumbing
  bodies where extraction would scatter the documented sequencing
  (stage → swap-script → WMI hand-off; spawn → bounded capture → kill-tree).
  Next rounds audit them for a PURE decision core (like R98's
  `host_of`/`check_download_url`/`pin_blocks`, and R99's
  `acquire_busy_marker`/`busy_marker_path`) rather than split the I/O.
  R99 harvested the update side's decision core; what remains there is the
  staging + swap-script body, which is Windows-only by construction.
  R100 harvested `tool_execute`'s result-cap decision core (`bounded_append`);
  what remains in that closure is the wait-loop state machine itself, whose
  rules (eviction jump, idle-confirm scaling, settle-drain, marker scan) are
  entangled with live session state and the 50 ms poll cadence — auditing
  those needs a fake-clock harness, not more extraction.
