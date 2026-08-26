# ADR 0003: Three-repo topology — platform / toolchain / ops credentials separation

Status: Adopted (re-reviewed late on 2026-08-22) ｜ Scope: Organization level

## Background

The Vale ecosystem currently has three repositories; the user asked "should they be merged into one":

| Repo | Contents | Audience | Change cadence |
|---|---|---|---|
| `vale` | Platform runtime: gateway (CF Worker) / agent (Windows Rust) / index (distribution) / extension / proxies | Users and devices | Deploy anytime |
| `vale-forge` | Developer toolchain MCP: OpenWrt builds (build) / board SSH (board) / TAPD (tapd), ~3k lines of Rust | Firmware developers' local machines | Local cargo build |
| `vale-deploy` | Ops credentials + rebuild manual: CF/GitHub/Vercel tokens, worker manifest, bootstrap.sh | Disaster-recovery restoration | Very infrequent changes |

## Options Considered

### Option 1: Merge the three repos into one (rejected)
- Merging deploy into the public vale = credential isolation breaks, a security red line
- Merging forge into vale burdens the main repo with the OpenWrt build context; release cadences are completely different
  (Worker second-level deploys vs local cargo)

### Option 2: Rename forge → vale-tools (rejected)
- "forge" is accurate and recognizable for build semantics; renaming requires a full migration across GitHub/directories/binaries/MCP registration names/
  documentation, and the only payoff is literal clarity

### Option 3 (adopted): Keep three repos + soft integration
Divide by audience — user-facing (vale), developer-facing (forge), ops-facing (deploy). The client layer is already
naturally integrated: Claude Code registers both `vale-gate` (devices) and `forge` (toolchain) as MCP
routes, no gateway proxying needed.

Landing items:
1. vale README gains an ecosystem description and cross-links between the brand/installation docs
2. vale-dist gains a one-command npm distribution artifact (`vale-agent-npm.tgz`)
3. vale-deploy bootstrap.sh gains an optional step that installs forge (later)
4. Known naming drift recorded: `index/` directory ↔ Worker name `vale-dist` (keep as-is,
   because renaming the worker would require rebinding the domain)

## Consequences

- Positive: clear responsibility boundaries, credential isolation maintained, each repo evolves independently
- Cost: cross-repo changes require multiple commits and pushes (low frequency, acceptable)
- Security note: vale-forge `.mcp.json` (contains a gateway token) is no longer tracked and has been added to
  gitignore; consider rotating the old token in history at some point
