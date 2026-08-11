# Vale — monorepo guide

Vale = one repo + one front door: `gateway/` (Vale Gate worker), `agent/` (Vale Agent, Windows), `index/` (Vale Index worker), `docs/`.

## Build

Unified entry `scripts/build.sh`:

```bash
./scripts/build.sh agent             # Windows cross-compile vale-agent + vale-tray (needs cargo-xwin)
./scripts/build.sh gateway|index     # wrangler deploy the worker (needs CLOUDFLARE_API_TOKEN)
./scripts/build.sh deploy            # build + deploy everything
```

Subprojects have their own build docs:
- **agent**: `agent/CLAUDE.md` (cargo-xwin cross-compile, feature gating, MCP tool additions, Windows smoke checklist)
- **gateway / index**: wrangler deploy per their `wrangler.jsonc`

## Conventions

- **Commits**: conventional commits with stage tags (`fix(stage-x)`, `feat(stage-x)`, …); each commit leaves the tree green.
- **Subproject changes**: verify inside that subdir (agent: cargo test/clippy/xwin check; gateway/index: wrangler deploy).
- **Worker name**: the gateway worker is `vale-gate`. If the Cloudflare dashboard still binds the console domain to an old-named worker, rebind it to `vale-gate`.
- **Design docs**: `gateway/DEVICE-INTEGRATION.md` (device module).
