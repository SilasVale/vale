# Architecture Decision Records

Index for `docs/adr/`. Numbered files are adopted decisions; the unnumbered
`proposal-*` file is an unaccepted design draft kept for history. Per
`docs/agents/domain.md`, new records are created lazily (by the
domain-modeling skill) when decisions actually get resolved — absence of a
file here is not an error.

| Record | Status | Summary |
|---|---|---|
| [0001](0001-plugin-core-single-dispatch.md) | Adopted 2026-08-21 | `vale-gate` uses a single plugin core; `index.ts` is only a front door |
| [0003](0003-repo-topology-and-brand.md) | Adopted (re-reviewed 2026-08-22) | three-repo topology (`vale` / `vale-forge` / `vale-deploy`) split by audience, soft integration |
| [proposal-interactive-browser](proposal-interactive-browser.md) | Proposal (unnumbered, round-134) | draft for an interactive remote browser embedded in the panel (CDP screencast + WS input) |

Note: the number **0002 is intentionally unused** — no record was ever made
under it. Do not renumber existing records to close the gap.

Note: a missing root `CONTEXT.md` is expected (lazy — see `docs/agents/domain.md`).
