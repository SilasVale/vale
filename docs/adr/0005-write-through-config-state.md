# ADR 0005: Write-through config state — one source of truth inside the agent

Status: Adopted ｜ Date: 2026-09-05 ｜ Scope: `agent/src/state.rs` + `web` + `main.rs`

## Background

`AppState.config` was an immutable snapshot taken at boot, while the mutation endpoints (`PUT
/api/settings`, `POST /api/gateway/connect`) rewrote `config.yaml` **without updating the
snapshot** — two sources of truth with observable failures:

1. `check_auth` read `state.config.server.device_token`: a token rotated on disk (manual edit,
   recovery flow) was invisible until restart; a mid-boot mismatch 401'd every client.
2. `/api/gateway/connect` had to reload from disk and fell back to the STALE snapshot when the load
   failed (the `HIGH(audit)` comment there records that this exact surface already caused a
   token-rotation incident where a settings write dropped `device_token` and every client 401'd).
3. main.rs's self-register loop re-read the file every cycle instead of trusting state.
4. `GET /api/settings` re-read the disk per request (a third read path).

The settings-write surface is incident-famous (the HIGH(audit) note at the gateway-connect handler),
so the fix had to make the correct behavior hold **by construction**, not by convention.

## Options Considered

1. **Keep the snapshot, reload everywhere** — the status quo; every consumer must remember to
   re-read, and the stale-fallback fallback path is how the incident happened. Rejected.
2. **Event/message-based invalidation** (writers notify readers to re-read) — async fan-out for data
   that is a handful of strings; readers still observe a stale window. Rejected as overkill.
3. **`RwLock<Option<Config>>` loaded on demand** — introduces a boot-ordering hazard (an early
   request could observe None mid-boot) exactly where the code must fail closed. Rejected.
4. **Write-through `RwLock<Config>` seeded at boot (adopted)**.

## Decision

1. `AppState.config` becomes a **`std::sync::RwLock<Config>`**, seeded by `AppState::new` from the
   loaded config — the lock is never empty, boot semantics (fail-closed on a missing token) are
   unchanged.
2. **`update_config(cfg, persist)`**: under ONE write guard, when `persist = true` the file is
   serialized and written (bootstrap `atomic_write` at the ACTUALLY-LOADED path) **before** the
   in-memory swap — write-through, never write-behind, so memory and file cannot disagree even
   transiently, and a failed disk write leaves both untouched. `persist = false` exists for
   memory-only mutation (tests, dev invocations without a config path).
3. **`config_snapshot()`** clones behind a poison-recovered read guard (`unwrap_or_else(|p|
   p.into_inner())` — the project's poison-recovery convention); readers take one snapshot and use
   it consistently within the request.
4. All readers converted: `check_auth`, panel injection (one snapshot serves `proxy_secret` +
   `device_token`), settings get/put, gateway-connect (its disk-reload + stale-fallback block is
   deleted — the HIGH(audit) invariant "a settings write must never drop device_token" now holds by
   construction), `/api/status`, the self-register loop, mcp serve.
5. `Config` clone cost is accepted: it is a handful of `Option<String>`s, cloned per request at most.

## Consequences

- Mutations are visible in-process immediately; the next boot converges by reading the same file the
  swap wrote.
- Tests assert BOTH sides (`settings_put_visible_in_memory_and_file`: snapshot reflects the change
  with zero disk involvement AND the file was written), pinning the write-through contract.
- The agent's module map documents the lock posture: inside AppState only `config_path` (small
  `Mutex`) and `config` (this `RwLock`) carry locks — managers keep owning their own.
- `cargo fmt` note: none — this decision changed behavior visibility, and the new test pins it.
