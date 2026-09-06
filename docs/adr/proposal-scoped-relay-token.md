# Proposal: scoped relay token — split daily relay use from the admin token (F3)

Status: Proposal (round-356) ｜ Scope: `gateway/` auth model ｜ Needs: **human sign-off** (any option except A breaks existing `settings.json` clients)

## Problem (verified in tree 2026-09-06, not hypothetical)

The admin gateway token is THREE credentials in one string:

| Use | Where | Evidence |
|---|---|---|
| Daily relay (`x-api-key` in every Claude Code `settings.json`) | `translate.ts:183-195` resolves any valid token to its user; spend bills that user's `ukeys` | `gateway/src/plugins/translate.ts:183` |
| Full device control over `/mcp` (Bearer admin) | `handleMcp` rejects everything except `role === "admin"` — then exposes `terminal_execute`/`terminal_write` (arbitrary Windows commands), `secret_*` (device keychain), browser tools on ANY registered device | `gateway/src/mcp.ts:32-45`, `gateway/src/mcp-tools.ts:27-` |
| Console takeover without a session | initial-password bootstrap + password reset are gated by possession of the admin token alone (`adminKey`) | `gateway/src/plugins/admin.ts` (bootstrap gate), `gateway/src/plugins/auth.ts:192-214` |

The same string is shown in the console Overview, lives in `~/.claude/settings.json`
on every AI-driven machine, and seeds from the legacy `CLIENT_KEY` (`store/admin.ts:57,95`
— compat, not a second factor). Rotation exists (`POST /api/me/token/regenerate`,
`auth.ts:711`) but rotates ALL THREE uses at once: rotating after a settings.json
leak also breaks relay until every client reconfigures — so in practice it is
rotated rarely, and the highest-exposure copy (dozens of client configs, shell
histories, backups) carries the highest privilege.

What is already correctly scoped (NOT part of this problem): per-user BYOK keys —
`/api/me/*` returns only the caller's OWN keys (`auth.ts:359-373`), `adminListUsers`
masks every token and shows key status only (`admin.ts:84-112`). The issue is the
admin token's own triple use, not cross-user leakage.

## Options

**A. Status quo, documented.** Accept the triple use for a single-operator
deployment; rely on rotation + the existing masking/rate-limit/safeEq hardening.
Cost of a leak: relay abuse (spend) + device RCE + console takeover. Zero breakage.

**B. Scoped relay token (RECOMMENDED).** New `role: "relay"`: may call
translate/models (spend own ukeys) and nothing else — not `/mcp`, not
`adminKey` recovery, not admin console routes. `settings.json` carries the relay
token; the admin token leaves client configs entirely. Staged so nothing breaks
mid-migration: (1) add role + issuance (`/api/me/token/relay`), dual-accept both
tokens on relay paths; (2) operator swaps `settings.json` to the relay token;
(3) admin token revoked from relay paths (translate/models require non-admin OR
explicit allow), `/mcp` + recovery stay admin-only. Breakage on step 3 for any
client still on the admin token (401 until reconfigured) — hence sign-off.

**C. Per-tool MCP gate.** Keep one token; require a second secret/session for
`terminal_execute`/`secret_*` over `/mcp`. Smaller settings.json churn, but leaves
password-reset equivalence intact and complicates the MCP contract every client
implements. Half a fix.

**D. Session-only /mcp.** Drop Bearer auth on `/mcp`, require the console session
cookie. Kills headless Claude Code MCP use (the round-280/281/285 auto-select path
assumes a static key). Rejected unless MCP clients move to sessions first.

## Decision needed from the human

1. A or B? (C/D documented only as considered-and-rejected unless argued otherwise.)
2. If B: acceptable window for step 3 (admin token stops working on relay paths)?
   Default proposal: 7 days dual-accept after the relay token ships.
3. Should existing `token:*→admin` mappings keep working on relay paths during the
   window (yes = zero-downtime, no = flag-day)?

## On approval

Implement B as ADR 0007 (adopted): role + issuance endpoint + gate changes in
`mcp.ts`/`translate.ts`/`models` + reset/bootstrap exclusion + tests
(relay-allowed/denied matrix, dual-accept window, revocation) + settings.json
swap runbook. Estimated: 1 focused round + CI green before the window starts.
