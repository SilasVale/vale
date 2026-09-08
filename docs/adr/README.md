# Architecture Decision Records

Index for `docs/adr/`. Numbered files are adopted decisions; unnumbered
`proposal-*` files are unaccepted design drafts kept for history. Per
`docs/agents/domain.md`, new records are created lazily (by the
domain-modeling skill) when decisions actually get resolved — absence of a
file here is not an error.

| Record | Status | Summary |
|---|---|---|
| [0001](0001-plugin-core-single-dispatch.md) | Adopted 2026-08-21 | `vale-gate` uses a single plugin core; `index.ts` is only a front door |
| [0003](0003-repo-topology-and-brand.md) | Adopted (re-reviewed 2026-08-22) | three-repo topology (`vale` / `vale-forge` / `vale-deploy`) split by audience, soft integration |
| [0004](0004-one-time-panel-grants.md) | Adopted 2026-09-05 | the device panel is bootstrapped by a gateway-minted one-time 120s grant — the permanent device token never rides in a URL |
| [0005](0005-write-through-config-state.md) | Adopted 2026-09-05 | agent config is a write-through RwLock (file before swap under one guard) — settings/gateway-connect mutations are visible in-process |
| [0006](0006-retire-studio-adopt-code-server.md) | Adopted 2026-09-06 | Vale Studio retired; code-server behind Access is the code-viewing surface |
| [0007](0007-scoped-relay-token.md) | Adopted 2026-09-08 | F3 scoped relay token, step 1: per-user relay credential (`role: "relay"`) for settings.json; dual-accept on relay paths, /mcp + recovery stay admin-only; step-3 cutover pending |
| [proposal-interactive-browser](proposal-interactive-browser.md) | Proposal (unnumbered, round-134) | draft for an interactive remote browser embedded in the panel (CDP screencast + WS input) |
| [proposal-scoped-relay-token](proposal-scoped-relay-token.md) | Superseded by 0007 (Option B approved 2026-09-08) | F3 decision material, kept as history |

Note: the number **0002 is intentionally unused** — no record was ever made
under it. Do not renumber existing records to close the gap.

Note: a missing root `CONTEXT.md` is expected (lazy — see `docs/agents/domain.md`).
