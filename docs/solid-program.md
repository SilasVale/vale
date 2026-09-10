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
| 75 | docs | docs | ledger R74–75 + index recount | — | (this commit: the ledger row cannot name its own final hash) |
| 56 | docs | docs | open-threads: reqwest dual-stack decision recorded (R46 finding) | — | (this commit: the ledger row cannot name its own final hash) |

> **Counting correction (Round-55 audit):** prior cumulative claims
> overstated gateway pins (+85/+89/+90 across R50/R53/R54 reports) by
> conflating suite-delta with program-attributable tests — the 610
> baseline predates 8 stage-n tests, and the R1/+1–R2-3/+1 split has been
> corrected to R1 ±0 / R2–3 +2 above. Rebuilt from history: per-commit
> added-`test(` lines sum to the base→HEAD `git grep` delta exactly
> (gateway +82; agent lib +12 incl. `#[tokio::test]`; core +7). Trust the
> table above, not the older reports.

## Cumulative pins (program-attributable)

Gateway +89 · agent lib +16 · core +7 · CLI +4 · relay +54 · extension +4 · index +7 · scripts +19 · deps +2.

## Open threads (explicitly NOT started)

- `requireApi` has no production consumer yet (reserved for hard deps).
- `SessionUserStore` is default-only (minimal test seam, correct as-is).
- `testKey` provider chain stays an if-chain (arms differ too much to table).
- `api` capability bag stays (removal = churn without gain).
- reqwest 0.12 (direct) + 0.13 (via rmcp) dual HTTP stacks stay (R46 audit):
  unifying means migrating all agent call sites with device verification —
  needs product sign-off, never a silent program edit. Bitflags/cpufeatures
  transitive dupes likewise untouched (upstream-owned).
- gmi retry asymmetry (R77 consolidation finding): chat/count arms retry gmi
  bursts, messages-native does not (`gmiBursty: false` locks the current
  table exactly). Burst-shedding is server behavior, not pricing — but
  changing retries affects cost/latency, so the question stays OPEN for the
  owner rather than being "fixed" by the program. See retryPolicyFor.
- Panel-react, hardware-gated backends, Electron main: covered or
  deliberately untestable — see round notes, not revisit-worthy.
