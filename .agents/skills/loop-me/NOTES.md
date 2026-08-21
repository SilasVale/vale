# Vale — User World Notes

## The repo

Vale = monorepo with three subprojects:
- **gateway/** — Cloudflare Worker (`vale-gate`), the API gateway. Plugin-based architecture (DSH/Cordis-style). Has auth, HTTP helpers, channels, body-scan modules. One HTML source viewer page.
- **agent/** — Rust, Windows-only, cross-compiled via cargo-xwin. MCP tool integration.
- **index/** — Cloudflare Worker, separate worker.
- **docs/** — Design docs, ADRs, agent instructions.

## Current architecture pain points (inferred)

- Gateway plugin system exists but is thin — no hot reload, no profile/bundle layering, no lifecycle hooks.
- Source viewer is a single inline HTML file — no build pipeline, no component system.
- No web UI beyond the source viewer (no dashboard, no admin panel).
- Auth is basic (PBKDF2 + HMAC session cookies) — no OAuth, no multi-user roles beyond admin/user.
- No goal/workflow/skill system like DSH has.
- No session management, no token metering, no compaction.

## Reference: DeepSeek Harness (DSH)

DSH is a plugin-based AI harness with:
- **Profile system** — layered config (bundles → profile → user overrides → CLI flags)
- **Cordis plugin core** — `@deepseek-ai/cordis` for DI, lifecycle, HMR
- **Web UI** — `dsh-web-app` with client plugins, Vite build, HMR
- **Tool ecosystem** — bash, fs, goal, ralph, subagent, workflow, skill, todo, etc.
- **Session management** — projection, reference, compaction, token metering
- **Goal system** — persisted goals with rounds, blockers, continuation
- **Skill system** — reusable task-specific instruction sets
- **Workflow engine** — multi-agent orchestration via JS scripts

## User's goal

Optimize vale's architecture, code, and page design by referencing DSH patterns. "ultracode" = high-quality, production-grade code.

## Grilling outcomes (2026-08-19)

- **Pain point**: All of the above — plugin system, web UI, tooling. Full rewrite, sequenced.
- **Plugin system**: Full cordis model — lifecycle hooks (setup/ready/dispose), DI container, HMR, profile/bundle layering.
- **Web UI**: Full admin panel — devices, plugins, config, source viewer. React + Vite.
- **Tooling**: TypeScript strict + ESLint + Prettier. Foundation first.
- **Sequence**: Tooling first → Plugin system → Web UI. Cleanest path.

## Terminology

- **Plugin** — a module with `name`, `deps`, `setup(ctx)` that registers routes/api on a shared context.
- **Profile** — a named configuration bundle (DSH concept, not yet in vale).
- **Cordis** — DI container / plugin lifecycle manager (DSH uses `@deepseek-ai/cordis`).
- **Stage tags** — conventional commit prefixes like `fix(stage-x)`, `feat(stage-x)`.
- **Worker** — Cloudflare Worker (the runtime for gateway and index).
