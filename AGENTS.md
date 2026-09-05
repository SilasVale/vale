# Vale — monorepo guide (AGENTS.md)

This file is the agent-facing guide for the Vale monorepo. It mirrors
`CLAUDE.md` (kept for Claude Code) and adds the post-2026-08-28 architecture
facts: single npm install channel, registry-based layout, gateway-as-optional
card. DSH (DeepSeek Harness) reads this file; Claude Code reads CLAUDE.md;
keep both in sync. (Header difference vs CLAUDE.md is by design: this file
carries the DSH paragraph + extra architecture facts; CLAUDE.md stays shorter.)

Vale = one repo + one front door — core: `gateway/` (Vale Gate worker), `agent/` (Vale Agent, Windows), `index/` (Vale Index worker), `docs/`; satellites: `proxies/`, `studio/`, `extension/`, `brand/` (see README layout table).

## Build

Unified entry `scripts/build.sh`:

```bash
./scripts/build.sh agent             # Windows cross-compile vale-agent (tray/Tauri retired; needs cargo-xwin)
./scripts/build.sh gateway|index     # wrangler deploy the worker (needs CLOUDFLARE_API_TOKEN)
./scripts/build.sh proxies           # deploy satellite proxy workers (zen-go / zen-us / openrouter; needs CLOUDFLARE_API_TOKEN)
./scripts/build.sh vercel-proxy      # deploy the Vercel exit proxy (v.saisi.online; needs vercel CLI)
./scripts/build.sh studio            # build + test + restart vale-studio (code.saisi.online; see studio/README.md)
./scripts/build.sh deploy            # build agent + deploy gateway/index + 3 CF proxies (not studio/vercel-proxy)
```

Subprojects have their own build docs:
- **agent**: `agent/AGENTS.md` (cargo-xwin cross-compile, feature gating, MCP tool additions, Windows smoke checklist; mirrored by `agent/CLAUDE.md` — keep both in sync)
- **gateway / index**: wrangler deploy per their `wrangler.jsonc`

Panel-first: `./scripts/build.sh agent` rebuilds the panel SPA before the exe (panel.js is embedded at compile time) — never ship a raw `cargo xwin build` after touching `agent/resources/panel-react/`.

## Conventions

- **Commits**: conventional commits with stage tags (`fix(stage-x)`, `feat(stage-x)`, …); each commit leaves the tree green. Before committing, run the subproject's `format:check` (e.g. gateway: `npm run format:check`) — no husky hooks (deliberately heavy; manual until a later round).
- **Subproject changes**: verify inside that subdir (agent: cargo test/clippy/xwin check; gateway/index: wrangler deploy).
- **Worker name**: the gateway worker is `vale-gate`. If the Cloudflare dashboard still binds the console domain to an old-named worker, rebind it to `vale-gate`.
- **Design docs**: `docs/superpowers/specs/2026-08-28-vale-desktop-core-design.md` (desktop/core); `gateway/DEVICE-INTEGRATION.md` is SUPERSEDED (2026-08 extension era, history only).

## Install / update channel (2026-08-28: npm is THE single channel)

The NSIS installer, `setup.ps1` and `run-setup.bat` are RETIRED
(`agent/deploy/retired/`). Install and update are npm only:

```bash
npm i -g https://agent.saisi.online/vale-agent/vale-agent-<ver>.tgz   # install the CLI
vale setup                        # PURE LOCAL install — no key, no tunnel, no cloud
vale setup --reg-key <key>        # optional: also register the device with the gateway
vale setup --tunnel d1            # optional: also provision the free cloudflared tunnel
vale update                       # update (same channel)
vale uninstall [--purge-data]     # remove (data kept unless --purge-data)
vale tunnel status|install|start|stop|update   # tunnel management (boxed component)
```

- Install layout is registry-first: `HKLM\SOFTWARE\Vale\Agent\{InstallDir,DataDir}`
  is the single source of truth; all path resolution goes through
  `agent/src/paths.rs` (`install_dir()` / `data_dir()`). No legacy-directory
  probing anywhere.
- Boxed components: playwright bundle (`vale-playwright.zip` →
  `InstallDir\playwright\`) and cloudflared (`InstallDir\tools\`) are
  version-locked by the release flow and agent-supervised (no Windows service).
- The Gateway is an OPTIONAL card in the device Settings page
  (`POST /api/gateway/connect`): fill gateway URL + registration key, toggle
  the free tunnel, one click. Pure local mode needs none of it.
- Cost rule: keep the free path (cloudflared tunnel is free). The reverse
  channel (device → gateway persistent WS / DeviceLinkDO) was evaluated and
  REJECTED — Cloudflare DO duration billing makes it ~$36/device/month.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `SilasVale/vale` using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain layout expecting a root `CONTEXT.md` and `docs/adr/`; the root `CONTEXT.md` is created lazily per `docs/agents/domain.md`.

## dsh (DeepSeek Harness) upgrades

> `.mcp.json` holds live tokens (mode 600) — never cat/paste its contents into chat, never commit it.

Upgrading the locally running dsh must go through `/home/zhengsaisi/dsh-upgrade/upgrade-dsh.sh` — it applies the local `enableBrowserAuth` patch (this deployment authenticates via Cloudflare Access, so the built-in token/cookie auth stays off), then builds, deploys, and restarts. Any other upgrade path silently drops that patch. The patch itself lives at `/home/zhengsaisi/dsh-upgrade/0001-enable-browser-auth-toggle.patch`; if it no longer applies to a new upstream version, stop and hand the conflict back to the human instead of working around it.

Notes from the 2026-08-31 upgrade (0.1.2-alpha.2 → 0.1.2-alpha.3):

- `upgrade-dsh.sh` first runs `git apply --check` on the patch; if that fails it falls back to `git apply --reverse --check` and **skips applying when the patch is already in the worktree** (checkout to a new tag preserves previously-applied local changes when upstream didn't touch those files). Only when both checks fail does it abort and hand the conflict to a human. This is the expected flow, not an error.
- `--check` compares the deployed version against the remote's newest `dsh-v*` tag and prints the upgrade command; it no longer misreads `--check` as a tag name.
- Backups of each deployed version live at `~/dsh-backup-<version>` (e.g. `~/dsh-backup-0.1.2-alpha.2`); rollback = copy back to the global pkg dir and `pm2 restart dsh`.
- Deployment layout: dsh source at `~/dsh-src`, mirror at `https://v.saisi.online/api/git/deepseek-ai/deepseek-harness.git`, pm2 app name `dsh`, web port 7738, profile patch at `~/.dsh/profiles/web/cordis.patch.yml` (holds `enableBrowserAuth: false`).

Notes from the 2026-09-05 upgrade (0.1.2-alpha.5 → 0.1.3-alpha.1):

- The script does NOT tolerate a dirty worktree: when upstream touched the same files as the local patch, `git checkout --detach <tag>` aborts (`local changes would be overwritten`). Recovery is `git stash push` in `~/dsh-src`, then re-run the script (it re-applies the patch itself). First verify the patch still applies on the clean new tag with `git apply --check`; if it doesn't, stop and hand the conflict to a human.
- The box's system g++ is 9.4 (Ubuntu 20.04, no sudo), but the new `fs-ext` dependency (session write-lease `flock`, Node 24 node-gyp) requires C++20. A userspace g++-10 lives at `~/gcc10-root` (extracted from apt `.deb`s via `apt-get download` + `dpkg-deb -x`, no sudo needed). Every upgrade that compiles native modules must run with `CXX=$HOME/gcc10-root/usr/bin/g++-10 CC=$HOME/gcc10-root/usr/bin/gcc-10` exported, otherwise `pnpm install` fails on `fs-ext`.
- Upstream sometimes deletes packages (this time `session-persistence-sqlite`, plus older leftovers `tool-subagent-report`, `code-runtime-python`, `agent-spine-demo`). Their `lib/` + `node_modules/` are git-ignored, so neither `git checkout` nor the script's `git clean -fdq` removes them, and the stale `lib/` can break the next build (here: removed `PersistenceCoordinator` exports). Before building a new tag, delete any `packages/*/*/ ` dir that has `lib/` but no `package.json` and is absent from the new tag (`git ls-tree --name-only <tag> <dir>` empty).
