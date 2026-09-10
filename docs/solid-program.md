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
   **Ledger-row insertion has its own recurring trap** (hit at R108, R119 and
   R121 — three fix-up commits for one mechanical mistake). The append pattern
   is `j = s.index("\n", s.index("<last row>"))`, then
   `s[:j+1] + row.lstrip("\n") + s[j+1:]`. Stripping the LEADING newline
   without adding a TRAILING one jams the new row against whatever follows —
   which is the cumulative-totals line, so the totals silently become part of
   the row and stop being greppable (`grep '^Gateway +'` returns nothing).
   Either keep `row` as `"\n| … |"` and drop the `lstrip`, or append `"\n"`.
   After any row insertion, verify with `grep -c '|Gateway +'` — it must be 0.

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
| 103 | agent router auth | tests | the axum layer that R102 explicitly left unpinned: `mcp::bind`'s `nest_service("/mcp", TokenGate) + fallback_service(WebPanel)` composition had NO router-level test (R102's pins call `handle_request` directly, so a routing edit stays green). New `tests/router_auth_integration.rs` drives a REAL server over real HTTP: `/mcp` gated by the Tower layer (missing + wrong token), the fallback branch reaching the web gate (GET and POST), and the public surfaces serving. Mutation-proven: dropping TokenGate from the nest fails the `/mcp` case; re-applying R102's broken `needs_auth` classification fails the fallback case | +3 | `b642790d` |> line 92) is removed. Also, the R97-recounted agent gate total (409) was
| 104 | agent settings parse | DRY/SRP/tests | the two settings bodies (`PUT /api/settings`, `POST /api/gateway/connect`) had grown their own copies of two concerns, both owned by nothing: the 8-line 400 `invalid_params` envelope (built inline twice) and "an optional string field, trimmed; blank ⇒ unset" (written out 5×, carrying the two documented incidents — a console-only save clobbering `buffer_mb`, and a reg-key-only request UNBINDING the gateway). Promoted to `web/parse.rs` (`json_body`, `optional_trimmed_string`, `invalid_params_response`); error WORDING stays a caller argument because the two endpoints' texts differ deliberately. Real fix on the way: `api_gateway_connect` evaluated the console_url rule TWICE — the value it reported and the value it persisted were independent copies that agreed only by luck; now one evaluation feeds both. Response-echo-vs-read-back semantics pinned (reg-key-only answers `console_url:null` while KEEPING the stored binding) | +7 | `f575f8ee` |> ALREADY stale when written: the suites measured 412 before R98's changes
| 105 | agent text clipping | DRY/tests | "clip to ≤N bytes on a char boundary" was written out at EIGHT sites across SIX files (mcp_client ×3, session_log ×2, output, playwright, design + memory's private helper) in two styles (`floor_char_boundary` vs hand-rolled `while !is_char_boundary`). The crate has paid for the naive version at least three times — round-68 `&text[..4096]` panicked the drainer and WEDGED THE SESSION, rounds 110/111 the same in the diag writer, and an audit-HIGH slice of a remote-controlled body at byte 80 panicked mid-call. Promoted to `src/text.rs` (`boundary_at_or_below`, `clip`); truncation SUFFIX wording deliberately stays with each caller (model-facing vs audit-facing) | +5 | `094bf128` |> (364 lib → 366; the extra 2 are post-recount tree drift, not program work).
| 106 | agent kill-tree | SRP/tests | the timed-out-command KILL POLICY was inline in `execute_local`: FOUR `#[cfg]`-gated signal blocks (SIGTERM/SIGKILL × same code) + TWO hand-written copies of the identical 50 ms exit-poll loop. Promoted to `signal_tree(pid, force)` + `wait_for_exit(child, patience)` with named `KILL_GRACE`/`KILL_REAP`. Notable because the arms are NEVER compiled together (Linux tests see the Unix one, xwin the Windows one), so an inline typo is invisible to every other platform's gate. First-ever test coverage of the round-55 contract "a timeout kills the TREE, not just the shell" — real processes, asserting the SIGKILL reaches a BACKGROUNDED GRANDCHILD via `kill -0 -PGID`. Mutation-proven both directions: group-kill → single-process kill fails "group N still has live members"; SIGTERM → no-op fails "SIGTERM must terminate the group" | +5 | `1f9a0783` |> R98's rows use measured values only.
| 107 | core error codes | tests/contract | the AGENT→GATEWAY failure-class contract had NO pin guarding renames. `gateway/src/mcp.ts` dispatches on three literal codes (`session_not_found`/`session_busy`/`ssh_timeout`) onto its own classes and falls everything else through to `TOOL_ERROR` (the deliberate round-64 widening), but the boundary is not compiled together and the gateway's tests never run here — so renaming a code, and "fixing" the enum's own table test to match, would silently degrade that class with every gate green. `GATEWAY_DISPATCHED_CODES` now carries the gateway's expectation in the CORE, plus 3 pins: every listed code is reachable from a variant, the set is exactly the gateway's three, and the rest fall through. PROVEN: with the rename applied to BOTH the enum and the old table test, `every_variant_has_its_stable_code` still passed — only the new pin caught it | +3 (core) | `3cce1774` |
| 108 | agent web routing | SRP/structural | `handle_request` was a 230-line function mixing THREE concerns: pre-dispatch routing (public SPA/assets, status page, the 3 self-authenticating streaming routes), the auth gate, and the body/dispatch pipeline. Steps 1–6 extracted to `route_pre_dispatch(...) -> Option<Response>`, so the dispatcher is reached only by requests that are not public — R102's "anything reaching the dispatcher is authenticated" becomes a property of WHICH FUNCTION a request lands in, not of statement order. `handle_request` 230 → 158 lines; the public surface is now one readable list. Required narrowing `check_auth(&Request)` → `check_auth(&HeaderMap)`: `&Request<Body>` is neither Send nor Sync, so holding one across an await made the whole future non-Send (caught by the compiler — the honest fix, not an allow). New structural pin asserts the SEAM (dispatcher routes fall through, public ones do not, evidence routes self-authenticate) rather than only its consequence | +1 | `a4d47bf6` |

> **Counting correction (Round-55 audit):** prior cumulative claims
| 109 | agent memory identity | dead-code/claims | the memory plugin's CLIENT-IDENTITY CAPTURE is a documented feature that does not exist. `tools::set_source` is declared `pub`, documented as "called by the MCP layer on handshake", and has ZERO callers repo-wide — so `SOURCE` keeps its `"unknown"` initializer and every `memory_save` record is stamped `unknown`. Three doc comments asserted the capture works (module header, the static, the fn) and `MemoryRecord.source`'s field doc listed the intended values; none of it was contradicted by anything, which is why it survived. Also removed `MemoryRecord::is_deleted` — zero callers plus a doc comment describing an unrelated concern ("the effective id used for ordering"). Claims corrected in all four places, and the gap is PINNED (not silently repaired: wiring it is a behaviour change needing a product decision about WHAT identity to record) | +2 | `3cd83ad7` |> overstated gateway pins (+85/+89/+90 across R50/R53/R54 reports) by
| 110 | agent boot path | tests/contract | the BOOT PATH's "never fatal" promise was prose, and prose does not fail a build. `migrate_layout_v2()` runs FIRST in `main()`, BEFORE tracing init — a panic there is a device that never starts and leaves NO log (the 1.2.223 dark-device class) — and it held the boot path's only panic surface (`marker.parent().unwrap()`, whose own doc says "Never fails the boot"). Fixed structurally, then pinned: new `tests/boot_surface.rs` scans the six boot modules for the panic family. The scanner is brace- AND string-literal-aware (the test modules it must skip contain `format!("{{{{{{")`), and it is itself pinned by planted-panic + after-a-test-module + line-number tests — a gate that cannot fail is not a gate. Limits documented in the header rather than implied | +5 | `e5d769b9` |> conflating suite-delta with program-attributable tests — the 610
| 111 | agent JSONL hygiene | DRY/tests | found with a normalized 5-line cross-file clone detector: the append-only JSONL crash-safety rules were duplicated in `session_log.rs` and `memory/store.rs`, with the SAME incident documented in prose at both sites — an empty file needs a version header, and a crash mid-`writeln` leaves a fragment without its newline that the next append FUSES onto (in the audit trail the fused pair once swallowed the "interrupted" recovery marker, so a crashed command read back as FINISHED). Promoted to `src/jsonl.rs` (`prepare_append`, `has_torn_tail`); the header plumbing differs (uuid+createdAt vs type+version) and stays caller data, and the caller's open handle is passed in because an append-mode handle cannot be read back | +6 | `10d1e0be` |> baseline predates 8 stage-n tests, and the R1/+1–R2-3/+1 split has been
| 112 | agent terminal tools | ISP/DRY | the terminal tool builders each listed the subset of shared runtime state they needed, and `build()` threaded SEVEN parameters by hand; three builders took five params each. The cost was never the typing — the terminal tools keep gaining shared state (`buffer_limit` round-68, `jobs`, `diag`), and each addition re-churned every signature and call site. Introduced `ToolCtx` (ctx.rs) as a PARAMETER OBJECT with the seven deps plus `jobs`, which moves from `build()`'s local into the context (its two consumers, the executor and `terminal_jobs`, are the exact pair review #2 required to share ONE map). Deliberately NOT imposed on single-dep builders — `tool_read(&ctx.output_buf)`, `tool_diag_read(&ctx.diag)` keep focused signatures (the ISP half). Bonus: `connections::tool_connect_saved`'s reuse of `tool_open` no longer unpacks five locals back into five arguments | ±0 | `5021a49d` |> corrected to R1 ±0 / R2–3 +2 above. Rebuilt from history: per-commit
| 113 | docs/audit | verify | CUMULATIVE-ACCOUNTING AUDIT (R98–R112). Ran the deliberate-verification round: every per-round pin count re-measured from git (`#[test]`/`#[tokio::test]` attr deltas per commit) instead of trusted. Result: the agent rows were ACCURATE — they sum to the measured total, and the per-commit sum running total (415→475, i.e. +60 over R98–R112 on a 415 baseline) matches, which independently confirms the R97-era "409/412" recount. One ±1 drift found (R108 wrote +1, attrs show the initial authoring added +1 then +1 more: 461→463 across two commits) and corrected here. TWO METHOD HAZARDS recorded so future audits do not repeat them: (a) grep-counting `#[test]` OVER-COUNTS when a test's own fixture contains the string (boot_surface.rs counts 6, really 5) — the authoritative count is `cargo test -- --list`; (b) `git grep -c ... | awk '{s+=$NF}'` silently produced 0 on the baseline path (empty result) — a zero baseline is a BUG SIGNAL, not a fact. Measured authoritative counts now: agent 471 total feat-gated (417 lib + 54 integration/bin), 464 default, core 25 | ±0 | `9bfb4039` |> added-`test(` lines sum to the base→HEAD `git grep` delta exactly
| 114 | agent module map | docs-gate | the two guide files' MODULE MAP had rotted silently, and the rot was worse than a missing line: FIVE real `src/` modules were absent (`text.rs`/`jsonl.rs` added by THIS program in R105/R111, plus `register.rs`, `tunnel.rs`, `winmain.rs`), `paths.rs` — the single most-referenced module in the guide — was only ever mentioned in PROSE and never as an entry, and the map's code fence was NEVER CLOSED in either file, so every heading after it rendered as monospace code. Both files had drifted IDENTICALLY, so manually diffing them would not have caught it either. Fixed, then gated by `tests/module_map.rs`: (1) every `src/` module is an entry in BOTH maps, (2) no entry names a module that no longer exists (single explicit allowlist for the sibling crate `vale-command-core`), (3) the two guides document the same set. The parser distinguishes entries from wrapped prose by TOKEN SHAPE (`text.rs`/`plugins/`/`mcp/server.rs`) plus the description gap, not indentation — a column rule reported every real entry as missing, which is recorded in the test. Limits stated in its header: names are checked, ACCURACY is not. 4 pins, mutation-shaped self-checks included | +4 | `7cfca6e6` |> (gateway +82; agent lib +12 incl. `#[tokio::test]`; core +7). Trust the
| 115 | agent epoch helpers | DRY/unify/pin | `crate::now_millis`'s own doc claimed it was added to kill a duplicated 3-liner — but the playwright plugin still carried its OWN copy (`manager::now_ms`, byte-identical) plus TWO inline copies in `playwright/tools.rs`. A doc that claims a consolidation which did not happen is worse than no doc. All three now use the shared helper, whose return type drops `i64` for `u64` (matching its sibling `unix_now`; a timestamp is never negative, so the signed form bought nothing and cost a cast at every `u64` consumer — same number for every reachable input, so the JSON is byte-identical). `next_run_stem` narrowed `u128`→`u64` to match. NEW PIN makes the UNIT CONTRACT machine-checked: `unix_now()`/`now_millis()` are one word apart at a call site and 1000× apart in value. The audit that motivated it: `started_unix` is produced as seconds and echoed to the model with NO comparison anywhere — harmless TODAY, one line from being wrong by 1000×. The pin bounds each helper's MAGNITUDE (1.7e12 millis vs 1.7e9 secs; a century of drift stays inside) rather than comparing a clock reading, and is mutation-proven: making `now_millis` return `as_secs()` fails with "outside a millis range — a seconds value here means the two helpers were swapped". Also verified EMPIRICALLY (a probe crate) that the inline `u128` millis really does serialize through `serde_json::json!` — it does, so that was NOT a bug | +3 | `ab91706d` |> table above, not the older reports.
| 116 | agent download gate | tests/security | `check_download_url` is the LAST gate before a REMOTE manifest field (`version.json`'s `download`) has its bytes spawned at SYSTEM. It was unit-pinned, but only for the shapes the author thought of. Added an ADVERSARIAL pin and, critically, MUTATION-TESTED it — which immediately proved the first version was worthless: swapping the exact host compare for `ends_with` left the test GREEN. The missed shape was the suffix trap (`notagent.saisi.online` for site `agent.saisi.online` — a DIFFERENT host a naive check accepts); added, plus a bare-domain spelling where the attacker host is unmistakable; the mutant now fails. Also recorded, from an OBSERVED probe rather than inspection: the scheme match is case-SENSITIVE so `HTTPS://` is refused (fails CLOSED — safe, pinned so changing it is deliberate), a different PORT on the authenticated host is accepted (sound: the cert still has to be valid for the site), the `userinfo@` spellings resolve the way real URL parsers do (`https://evil@site/` connects to the SITE and is correctly accepted), and the empty-`site` branch is DEFENSIVE-ONLY because `agent_update` returns early when `platform.download_url` is unset. No production bug found — the gate is sound; what changed is that its soundness is now evidence instead of inspection | +1 | `d581891f` |
| 117 | **gateway** request shaping | extract + FIX + pins | FIRST gateway round (the architecture audit put `handleGatewayImpl` at **798 lines / 57 branches / 38 returns** — the repo's worst monolith, and gateway had never had a SOLID round). Extracted the five PURE decision cores the block inlined (tools-region scan, parse trigger, search-only guard, forced-search detection, search-model choice), which between them carried FOUR recorded incidents (round-41's 1102 regression, round-42 + round-43 Medium, round-46 **High**) and had ZERO direct coverage. **FOUND AND FIXED A REAL BUG on the way:** the tools-region scan used `depth < 0` where the loop starts ON the array's own `[` — so it ran one level OUT and the region swallowed `messages`. A conversation whose history carries a previous search (`{"name":"web_search"}` — Claude Code keeps those blocks) therefore matched the parse trigger and the WHOLE body was re-parsed every later turn, though the current request declared no web_search: ~2.4 ms per turn, ~a quarter of the 10 ms Free-plan budget (Error 1102) the guard exists to protect. Code now matches its own documented intent (`<= 0`); verified against all 720 pre-existing tests. Two claims MEASURED and one WITHDRAWN: `lastIndexOf` over a 6 MB body is 0.005 ms (so the redundant clause I found is a CLARITY issue, NOT a perf one — my first hypothesis was wrong and was dropped), and JSON.parse of ~2 MB is 2.38 ms (which is what makes the fix worth having). `handleGatewayImpl` 798 → 762 lines | +9 | `ed4bd682` |## Cumulative pins (program-attributable)
| 118 | **gateway** BYOK key contract | unify + pins | The "which BYOK key does this route need" mapping was written out **FIVE times**: three ad-hoc `[kind, key][]` tables (chat/completions + its post-probe half + count_tokens) and **eleven** hand-written `route.kind === "X" && !byok.Y` checks across five flows. The irregular fields are the tell — `nvidia→nv`, `opencode→opencodeGo`, `commandgoat→cmd` — and that irregularity is exactly where the recorded incidents live: the amd/ and og-native guard comments each describe a flow that FORGOT its check, so the request went out headerless and the user got a bare "Upstream 401" instead of a config error. Now ONE canonical `REQUIRED_KEY_BY_KIND` + pure `isKeyMissing(kind, byok)`. Every call site keeps its exact ORDER and kind-SET (the chat/completions flow deliberately splits its checks around the degraded-channel probe, so the split is preserved); only the mechanism changed. The highest-value pin is the TYPO guard: `isKeyMissing` reports an unknown field as present, so `opencodeGo→opencodeG` would silently make a required key look set — now impossible, because every table value must be a REAL `extractByokKeys` field AND every byok field must be reachable from some kind (both directions). Also pinned: the three irregular spellings by name (a symmetry "tidy-up" breaks the lookup), the `""`/null-are-the-same-absent contract, unknown-kind→false, and the round-trip through `extractByokKeys` (mapping to the env-var spelling would typecheck and pass every unit pin). `handleGatewayImpl` 762 → 746 lines; 11 bare checks + 3 tables → 0 | +6 | `8d1a5656` |
| 119 | **gateway** upstream error envelope | audit + pin | Continuing the P0 monolith work. Added `errorTypeForStatus` (http.ts) for the HTTP-status→Anthropic-error-`type` decision that was written out **four** times — it is load-bearing, not cosmetic: a 429 answered as a bare `api_error` tells Claude Code to GIVE UP instead of backing off (the incident the OpenRouter comment records). Then audited `upstreamBodyErrorResponse`, whose comment claimed to be "shared by the three /v1 arms' !upstream.ok handlers" — it has **ONE** caller, and the two arms that bypass it are measurably WORSE. Found a **credential-echo hole** and, per rule 1, PINNED rather than silently fixed: the nv/gmi arm copies the upstream's error message into the client-visible response with NO `scrubKeys`, so a provider echoing the submitted key in a 401 body (`Invalid API key provided: sk-live-…`) sends it back to the caller — demonstrated, not asserted. The same pin covers the og/cm arm dropping the upstream message AND Retry-After (so a 429 there cannot be paced), which its own round-116 comment half-fixed. Both need sign-off; recorded in Open threads with the fix recipe | +2 | `12115ffb` |
| 120 | **gateway** model registry | unify + gate | ANSWERED "every new model needs code edits — is there a better way?" with evidence: ONE model (`og/muse-spark-1.3-contributor`) lived in **SIX** places (MODELS, OG_WIRE_REMAP, OG_FORCE_US_PROXY, SEARCH_CAPABLE_WIRE_MODELS, HEALTH_CHANNELS + the VISION_CAPABLE_MODELS env var) plus **3 hardcoded conditions** in translate.ts. Measured the gap: adding an id to MODELS alone left all **737** tests GREEN while the model was half-wired, and **5 of 22** advertised models had already silently gone unprobed. Now `MODEL_REGISTRY`: one record per model, and MODELS / OG_WIRE_REMAP / OG_FORCE_US_PROXY / SEARCH_CAPABLE_WIRE_MODELS all DERIVE from it — proven **byte-identical** against a pre-refactor snapshot of every derived table AND the /v1/models order (which caught a real regression: redistributing `or/stealth/ox-alpha` into the or/ group reordered the client-visible catalogue). The 3 hardcoded translate.ts conditions became facets (`responsesOnly`, `reasoningMax`), with the reasoning facet SPLIT BY MECHANISM (`raw` for passthrough text injection vs `parsed` for the translate path) because collapsing them would have silently applied one path's default on the other. New `model-registry.test.mjs` (9 pins) makes coverage BIDIRECTIONAL and **5/5 mutation-proof**: a new model without a `probe` facet, `probe:false` without a reason, a reordered catalogue, a `wire` on a non-og record, and a hardcoded special case returning to translate.ts all fail. Found and fixed a latent trap on the way: stripping the channel makes `og/` and `or/` spellings of the same slug collide on one wire name, so `wireSpec` now REFUSES ambiguity instead of returning the first match (which would have let one channel inherit the other's facet). VISION stays an ENV var deliberately — operators must fix it without a redeploy | +9 | `8aa80da0` |
| 121 | **gateway** route list + ladder | derive + gate | Found the FIFTH and SIXTH copies of the model catalogue that R120 left behind, by checking the tables R120 did NOT derive. `ROUTE_INFO[].models` (served by `/api/admin/public` beside `models: MODELS`) was hand-maintained and had **already drifted**: the `og/` list OMITTED `openai/gpt-5.6-luna:floor[1m]` (advertised by /v1/models, absent from the console's route breakdown) and `og/`+`cm/` listed theirs in a different order — invisible because the only ROUTE_INFO test checked PREFIX coverage, never the lists. Now derived via `routeModelsFor(prefix)`, so the console cannot disagree with the catalogue. **This changes console output** (23 entries, two prefixes reordered) and is recorded as a deliberate correction: the old list was wrong, not curated. The `none` entry stays an EXPLICIT argument (its ids carry no prefix, so it is not a filtered view). Also found the SIXTH copy — `resolveAutoModel`'s fallback ladder in model-route.ts — and deliberately did NOT derive it, because its ORDER is the meaning (default channel first). Extracted it as `AUTO_FALLBACK_LADDER` and gated it as a SUBSET of the catalogue + default-first + no duplicates: an entry that is not advertised is a rung `isModelUsable` can never accept, skipped in silence while `auto` picks something else | +2 | `6449df59` |
| 122 | docs cadence (rule 5) | verify | R25 is a docs-cadence round, and re-measuring from the RUNNERS (not trusting the prose) caught **five** stale or wrong claims: (1) the gateway gate row read **712** since R81 while the suite is at **748** — the 36-test gap was split and both halves verified (R117–R121 added 28, measured per-round; 720−712=8 landed between R81 and R117 with the row never refreshed); (2) the agent row read 478 → **479**; (3) the header's Rust total was **arithmetically wrong** in the line I had just written (72+12+10 = **94**, not 96 — caught by cross-checking the header against the ledger's cumulative line rather than by reading it); (4) the `handleGatewayImpl` line count was stale (**746 → 741**: R119's error-type extraction removed 5 more); (5) `agent/AGENTS.md` had **missed R116 entirely** (an agent round) and carried no pointer for the five gateway rounds. Also fixed **two jammed ledger rows** (R108 and R121 had the cumulative-totals line glued to their tail, so `grep '^Gateway +'` returned nothing) and recorded the cause as a RULE: the row-insertion pattern strips the leading newline without adding a trailing one, which has now cost three fix-up commits (R108/R119/R121). Added the measured `node --test <dir>` trap to the gates section: from the right directory bare `node --test` is correct, but `node --test test/` makes Node resolve the directory as a MODULE and report "1 test, 1 fail" for a green suite. Docs-only round; no production code touched | ±0 | `d288fbab` |
| 123 | **gateway** security params | audit + pin | Audited the gateway's 258 top-level exports for RULE 4 ("no speculative generality") and found **16 with no consumer outside their own file** — but every one is a TYPE, and every self-declared OCP extension point (`registerRoute`, `registerChannelKey`, `provideApi`/`requireApi`/`optionalApi`) DOES have one (production call site, or a test that would otherwise be impossible — rule 4's explicit allowance). So the seams are justified; stripping `export` off 14 erased type aliases would be churn. **The audit was still worth it: it surfaced two RUNTIME constants that no other file reads**, and one of them is a security parameter. `PASSWORD_ITERATIONS` is read at VERIFY time while user records store only `{salt, passwordHash}` — so RAISING it (the normal PBKDF2 hardening direction) locks out every existing user, and `verifyPassword` cannot distinguish that from a wrong password. Measured: same password+salt at 100000 vs 600000 gives different digests; no test pinned the value. **The finding is an INCONSISTENCY, not a mistake:** `SESSION_TTL_MS` sits in the same file and IS safely changeable, because the token carries its own `exp` inside the signed payload. Both behaviours now documented in `auth.ts` and pinned — the iteration pin fails with the migration recipe, and the session pin PROVES the asymmetry by verifying a token minted under a different TTL | +2 | `efed1821` |
| 124 | **agent** SSE viewer cap | audit + pin | Widened the audit beyond gateway: measured the largest agent production functions and found `route_pre_dispatch` (259 lines) in `web/mod.rs`, whose first two branches were byte-identical except for the stream function they return. Following that duplication found a **REAL DEFECT**: the cap those branches install does not work. `let _guard = acquire_sse_guard()` binds a local, and the `return Some(sse_stream(…).await)` on the next line drops every local in scope — so the slot is released when the response is CONSTRUCTED, not when the connection ends. The documented bound ("a flood of viewers can't exhaust tasks/memory") therefore limits microseconds of setup, not concurrent streams. **MEASURED:** 70 responses opened and all held → **ZERO** 503s; should be 6 (70 − 64). The mutation that genuinely holds the guard produces **exactly 6**, confirming both the diagnosis and the expected post-fix behaviour. Pinned rather than fixed, because a working cap is client-visible (rule 1 needs sign-off). Corrected the comments in BOTH files: `mod.rs` no longer claims the bound works, and `sse.rs` warns that its returned guard must outlive the response. The pin's message carries the fix AND the trap inside it (a guard moved into the body can LEAK slots if the body is never polled to completion) | +1 | `503b2d7a` |
| 125 | **agent** SSE route seam | extract + pin | Consolidated the two streaming routes' shared path. `route_pre_dispatch`'s `/api/events` and `/api/events/term` branches were byte-identical apart from which stream function they returned (auth → acquire → return), so every future change had to be made TWICE and could be made once — including the R124 fix, which was pending sign-off in two places. Now `sse_route_response(headers, state, stream)` owns the sequence and each branch is one line; the function is **259 → 79 lines** (the earlier 259 figure counted past the closing brace; this is brace-matched). The guard is still dropped at the same point in the request's life — R124's cap pin still passes UNCHANGED, which is the behaviour-preservation evidence, and the comment says so rather than implying the extraction fixed anything. New source-scan pin keeps the seam: exactly ONE `acquire_sse_guard()` CALL in production code, inside the helper, and both routes routed through it. Writing that pin hit the recurring false-positive trap twice (doc comments MENTION the helper; my own string literals contain the call), so it strips the test module then line comments — the same technique as the boot-surface and module-map gates. Its first version also carried an auth assertion that a `let _ = check_auth(…)` mutant PASSED (verified) — a check that cannot fail is worse than none, so it was removed in favour of pointing at `term_sse_requires_auth`, which does fail under that mutant | +1 | `760dd806` |
| 126 | **agent** terminal marker gate | doc fix + pin | Audited `mcp_client/tools.rs` (1510 lines, the biggest agent file) and found it already well factored — ~40 named functions, all pure helpers extracted, and `truncate` correctly delegating to R105's `crate::text`. So the audit moved to the terminal backend's marker handling and found **two FALSE comments** plus a pin-design lesson. (1) `Session.inject_marker` claimed it "is no longer consulted by execute" — a stage-l note about the OSC-injection MECHANISM being replaced by the command wrapper. The mechanism changed; the CONSULTATION did not: exec.rs still reads it via `term_marker_injected` for the pwsh 633 wait path. A comment that retires a live flag is how someone deletes it later. (2) `term_set_marker_injected` claimed "Called by the open handler with the real injectable result" — it has **ZERO callers** repo-wide, real and stub alike; the open handler sets the value at CONSTRUCTION from `backend.marker_injected()`, which is what round-109 actually needed, so the corrector is redundant rather than pending. Kept (not deleted) because `TerminalManager` is PUBLIC API and both configs must expose the same path — recorded in Open threads. (3) THE PIN LESSON, which is the transferable part: my first pin ran UNGATED and passed even when I inverted the real implementation's `unwrap_or(false)` to `true` — because the headless `stub.rs` twin returns a hardcoded `false`, so the test never touched the production lookup. I caught it only because the mutation failed to fail. Now `#[cfg(feature = "terminal")]`, where it exercises the real code and the same mutation DOES fail. Also audited the other 9 tests touching `TerminalManager` for the same flaw — all false positives (my scan window spilled into the next function); no real stub-only tests exist | +1 | `a5eb47d1` |
| 127 | **agent** default-config divergence | doc fix + pin | Tested a drift class the program had not checked: the EMBEDDED default config versus `Config::default()`. Measured through the real production path (`load_or_create`, i.e. what a fresh install runs): the embedded `config.yaml` yields `console_url = Some("https://api.saisi.online")` and `download_url = Some("https://agent.saisi.online")`, while `Config::default()` yields `None` for both. Two "defaults" for one concept, and the docs described only the second — `config.yaml`'s own header said "BOTH ARE OPTIONAL. A purely local install … can leave them unset" directly ABOVE the two keys it had just set, so a reader would conclude a fresh install is local-only when it is in fact cloud-configured. **Why it matters:** the whole test suite builds on `Config::default()`, so it exercises the LOCAL-only configuration while production STARTS cloud-configured (agent_update enabled, page_view remote enabled, device self-registration running every cycle). Every test of the "no console configured → explicit error" degradation path tests a state production reaches only after someone deletes those keys — true, and previously unstated. Corrected the comment in `config.yaml` and added the reciprocal warning on `PlatformConfig`, then pinned the divergence: if the embedded file stops setting them, or `Config::default()` starts, the difference in what the suite covers becomes a decision instead of an accident. Both mutation directions verified (embedded → unset fails; an explicit `Default` setting console_url fails) | +1 | `afc9b7aa` |
| 128 | **agent** SSE cap FIXED | fix (was deferred) | **FIX #1 of the signed-off "大胆修" batch.** The R124 finding is now repaired rather than pinned: the viewer slot MOVES into the streaming task, so the 64-viewer cap is real. Client-visible by design — the 65th concurrent viewer now receives 503 instead of a stream, which is what the cap always claimed to do. **Two mutations, and the SECOND one caught a flaw in my own test.** (a) Dropping the guard at task start (the R124 behaviour) fails the HOLD assertion. (b) Removing `tx.closed()` fails the RELEASE assertion. Getting (a) to fail took TWO attempts, and the first attempt is the lesson: counting refusals DURING the opens proves nothing, because the acquires are synchronous — 70 opens against a 64-slot pool refuse 6 of them whether or not the slot survives, so the original assertion PASSED against the mutant. The discriminating question is asked AFTER the pump tasks have run: with 64 streams still held, ONE MORE request must be refused. **The pin also caught a half-fix I had just written:** moving the guard into the task released it only when the pump noticed the closed channel, which it could not while parked on the BROADCAST receiver — so release lagged up to the heartbeat tick (30s events, 60s term) and the pool stayed exhausted seconds after every response was dropped. Both pumps now `select!` on `tx.closed()`, releasing the moment the body drops. The guard lives in the TASK rather than a Body wrapper deliberately: an unpolled dropped body still closes the mpsc, which the pump must detect anyway, so release holds on every path. R125's one-place seam is what made this a single edit plus two signatures | +0 | `8b634272` |

Gateway +124 · agent lib +76 · agent integration +12 · core +10 · CLI +4 · relay +54 · extension +9 · index +7 · scripts +19 · deps +2.

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
- ~~**THE SSE VIEWER CAP WAS ACQUIRED BUT NOT HELD**~~ — **FIXED in R128.**
  R124 found that `acquire_sse_guard()`'s value was bound to a LOCAL of
  `route_pre_dispatch`, so `return Some(sse_stream(…))` dropped it when the
  response was CONSTRUCTED: the documented 64-viewer bound limited microseconds
  of setup, not concurrent streams (measured — 70 held streams, zero 503s).
  R128 moved the guard into the streaming task and made both pumps release on
  `tx.closed()`, so the cap is real and the release is prompt. The pin was
  INVERTED rather than deleted (`sse_viewer_cap_holds_and_releases_per_connection`,
  checking HOLD and RELEASE separately). Kept as a retraction, like the
  round-90 gmi entry, because two things are worth remembering: how a
  lifetime bug survives a documented bound, and the fix's own trap — a release
  that waits for the next heartbeat (30s / 60s) starves the pool under a burst
  of short-lived viewers. NOTE: R124's Open-thread entry for this never made it
  into the file (the insert failed silently that round); this retraction is
  written now, after the fix, so the record is complete either way.
- **SUGGESTION for the human (R98 finding, NOT acted on):**
  `update::tools::host_of()` strips a bare IPv6 loopback URL
  (`http://[::1]:8080/x` → host `[`) so such a URL can never pass
  `check_download_url`'s loopback exemption — the existing `"::1"` match arm
  is dead. The code documents this deliberately ("widening a SYSTEM-execution
  gate is a product decision"), so R98 left it alone. One-line fix if wanted:
  use `reqwest::Url` for host parsing (already a dependency) — testable
  without widening the gate, since the verdicts are pure.
- **⛔ SECURITY — upstream error body echoes a credential (R119, needs
  sign-off):** the `/v1/messages` **nv/gmi** arm copies
  `err.error?.message || err.message` from the upstream's non-OK body straight
  into the CLIENT-VISIBLE error message and never calls `scrubKeys`. A
  provider that echoes the submitted credential in a 401 body (the common
  `Invalid API key provided: sk-live-…` shape) therefore sends that credential
  back to the caller. Demonstrated on this branch: `scrubKeys` turns
  `sk-live-ABCDEF1234567890` into `***`, and the arm does not call it.
  `upstreamBodyErrorResponse` — the helper that DOES scrub, and whose comment
  claimed to be "shared by the three /v1 arms" while having ONE caller — is
  the ready-made fix. Rule 1 forbids fixing it silently (the message text is
  client-visible), so it is PINNED by
  `upstream_error_envelope_gaps_are_pinned`, which fails the moment the arm is
  fixed and points back here. **Same pin covers a second, non-security gap:**
  the **og/cm** arm answers `${label}: ${detail || upstream N}`, dropping both
  the upstream's own message and the Retry-After header, so a 429 there cannot
  be paced by the client even though its sibling branches carry it (that arm's
  own round-116 comment records fixing the status/type half of exactly this).
  Fixing both = adopt `upstreamBodyErrorResponse` in the two arms, delete the
  pin, update this entry.
- **⚠️ `PASSWORD_ITERATIONS` is an UNVERSIONED security parameter (R123, needs
  sign-off):** the constant (`gateway/src/auth.ts`) is read at VERIFY time,
  while a user record stores only `{ salt, passwordHash }` — no iteration
  count, no algorithm marker. **Raising it — the normal PBKDF2 hardening
  direction — therefore locks out every existing user**, and `verifyPassword`
  cannot tell "wrong password" from "the constants moved" because it compares
  derived bits. Measured, not argued: the same password+salt at 100000 and
  600000 yields different digests, and no test pinned the value until R123
  (`PASSWORD_ITERATIONS is pinned: raising it locks out every existing user`).
  **Contrast, and the reason this is an inconsistency rather than a mistake:**
  `SESSION_TTL_MS` lives in the same file and IS safely changeable, because the
  session token carries its own `exp` inside the signed payload — a changed
  TTL affects only newly issued tokens. Both behaviours are pinned so the
  asymmetry is machine-visible. **Migration recipe (NOT implemented):** persist
  the iteration count beside the hash, verify against the STORED value, then
  re-hash on the next successful login to upgrade in place. Changing the
  constant without that is a deliberate, user-visible break.
- **`term_set_marker_injected` is dead public API (R126, needs sign-off to
  remove):** zero callers repo-wide, in the real implementation AND the
  headless stub twin, and its doc comment claimed the open handler called it
  (false — corrected). The behaviour it was written for is delivered at
  CONSTRUCTION instead, from `backend.marker_injected()`. It is kept because
  `TerminalManager` is `pub` through `pub mod tools` → `pub mod terminal` →
  `pub use …TerminalManager`, and the feature-gating rule requires both
  configs to expose the same paths — so deleting a public method is a breaking
  change. Removing it (plus the identical stub arm) needs sign-off.
- **SFTP timeout CODE divergence (R113, deferred for a human decision):** an
  SFTP connect timeout is `internal`; the SSH terminal path reports the SAME
  condition as `ssh_timeout`. Via `gateway/src/mcp.ts` those become different
  client-visible classes (`TIMEOUT` vs `TOOL_ERROR`). Arguably wrong, but
  changing it is a BEHAVIOUR change, so R113 pinned the current choice instead
  (`sftp_timeout_code_is_pinned_below_its_ledger_entry`, which fails with an
  instruction pointing here) rather than unifying it silently.
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
