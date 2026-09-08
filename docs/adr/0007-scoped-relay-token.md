# 0007 — Scoped relay token (F3, step 1 shipped)

Status: **Adopted 2026-09-08** (human sign-off on Option B) ｜ Scope: `gateway/` auth model ｜ Supersedes the decision question in [proposal-scoped-relay-token](proposal-scoped-relay-token.md) (kept as history)

## Decision

Split daily relay use from the admin gateway token via a per-user scoped
relay credential (`role: "relay"`), staged so nothing breaks mid-migration:

- **Step 1 (shipped, this ADR):** role + issuance + dual-accept. Relay
  tokens work on relay paths (translate/models); everything privileged
  stays admin-only. Admin tokens keep working everywhere (no breakage).
- **Step 2 (operator action):** swap `settings.json` clients to the relay
  token (`POST /api/me/token/relay` while logged into the console).
- **Step 3 (later cutover, NOT in code):** revoke the admin token from
  relay paths. Proposed default: 7 days dual-accept after the relay token
  ships. Until then the window stays open by design.

## What shipped (step 1)

- `User.relayToken` (`store/users.ts`) + `token:<relay>` → owner mapping;
  `findUserByToken` resolves it as a **copy** with `role: "relay"`.
- `POST /api/me/token/relay` (issue/rotate) + `DELETE /api/me/token/relay`
  (revoke), both session-gated (`plugins/auth.ts`); presence-only
  `relayTokenSet` on `GET /api/me`; masked `relayToken` on
  `GET /api/admin/users` (no reveal endpoint, same rule as admin tokens).
- `regenerateToken`'s survivor-sweep skips the relay mapping (admin
  rotation must not kill the relay credential).
- Gates, verified by the matrix in `gateway/test/relay-token.test.mjs`
  (10 tests): translate/models dual-accept relay; `/mcp` 401s it
  (admin-only, unchanged code); adminKey bootstrap/reset compare against
  `u.token`, so relay can never satisfy them; revocation/rotation behave
  independently of the admin token.

## What is explicitly NOT done

- Admin tokens still work on relay paths (dual-accept window open).
- No per-tool MCP gating (rejected option C) and no session-only /mcp
  (rejected option D) — see the proposal for rationale.

## Consequences

- A leaked `settings.json` now costs relay abuse (spend) only — no device
  RCE, no console takeover — once the operator completes step 2.
- Until step 3, a leaked admin token still carries all three uses; rotation
  (`POST /api/me/token/regenerate`) still rotates all uses at once.
- Step 3 is a flag-day for clients still on the admin token (401 until
  reconfigured); announce the window before flipping it.
