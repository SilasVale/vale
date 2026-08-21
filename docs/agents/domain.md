# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check context-specific `docs/adr/` directories.

If any of these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## File structure

This repository uses a single-context layout by default:

```text
/
├── CONTEXT.md
├── docs/adr/
└── ...
```

If a root `CONTEXT-MAP.md` is introduced later, it becomes the index for multiple context-specific `CONTEXT.md` and `docs/adr/` directories.

## Use the glossary vocabulary

When output names a domain concept—for example, in an issue title, a refactor proposal, a hypothesis, or a test name—use the term as defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the required concept is not in the glossary, treat that as a signal to reconsider invented language or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding it:

> _Contradicts ADR-0007 — but worth reopening because…_
