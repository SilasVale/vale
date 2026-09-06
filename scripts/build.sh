#!/usr/bin/env bash
# Vale unified build script (agent / gateway / index from the monorepo root)
#
#   ./scripts/build.sh                 # build agent (Windows cross-compile, release)
#   ./scripts/build.sh agent [debug]   # build vale-agent (tray/Tauri desktop retired)
#   ./scripts/build.sh command [debug] # legacy alias for `agent`
#   ./scripts/build.sh gateway         # deploy the Vale Gate worker
#   ./scripts/build.sh index           # deploy the Vale Index worker
#   ./scripts/build.sh proxies         # deploy the satellite proxy workers (zen-go / zen-us / openrouter)
#   ./scripts/build.sh vercel-proxy    # deploy the Vercel exit proxy (v.saisi.online, needs vercel CLI)
#   ./scripts/build.sh deploy          # build agent + deploy gateway/index
#
# Dependencies: cargo-xwin, wrangler (global v4), CLOUDFLARE_API_TOKEN (deploy
# only, or a ~/.cloudflare-token file).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="x86_64-pc-windows-msvc"
FEATURES="terminal,keyring"   # terminal backends + OS keychain (file fallback for the service context)

# --- token: prefer $CLOUDFLARE_API_TOKEN, else ~/.cloudflare-token ---
cf_token() {
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then echo "$CLOUDFLARE_API_TOKEN";
  elif [[ -f "$HOME/.cloudflare-token" ]]; then cat "$HOME/.cloudflare-token";
  else echo ""; fi
}

# --- P0-2 deploy/agent preflights (fail-closed, fail EARLY) ---
# `deploy` chains five steps with && — a missing toolchain piece used to
# abort MID-CHAIN, leaving a half-deployed stack with no manifest. Check
# everything up front instead. Each check is local (no network) and prints
# the fix, so a healthy env passes through with zero behavior change.
preflight_agent_toolchain() {
  # cargo-xwin present AND runnable (a broken install fails here, not mid-build)
  command -v cargo-xwin >/dev/null 2>&1 \
    || { echo "  !! cargo-xwin not found — install: cargo install cargo-xwin" >&2; return 1; }
  cargo xwin --version >/dev/null 2>&1 \
    || { echo "  !! cargo-xwin not runnable — reinstall: cargo install cargo-xwin" >&2; return 1; }
  # Windows MSVC target installed (build_agent cross-compiles to it)
  if command -v rustup >/dev/null 2>&1; then
    rustup target list --installed 2>/dev/null | grep -q "^x86_64-pc-windows-msvc" \
      || { echo "  !! rust target x86_64-pc-windows-msvc not installed — run: rustup target add x86_64-pc-windows-msvc" >&2; return 1; }
  else
    echo "  !! rustup not found — cannot verify the x86_64-pc-windows-msvc target" >&2
    return 1
  fi
}

preflight_deploy() {
  # Full-stack gate for the `deploy` chain: agent toolchain + wrangler +
  # Cloudflare token. Individual targets keep their own token checks (a direct
  # `./scripts/build.sh gateway` must fail closed too); this one fails the
  # whole chain BEFORE the first step runs.
  preflight_agent_toolchain || return 1
  command -v wrangler >/dev/null 2>&1 \
    || { echo "  !! wrangler not found — install: npm i -g wrangler@4" >&2; return 1; }
  wrangler --version >/dev/null 2>&1 \
    || { echo "  !! wrangler not runnable — reinstall: npm i -g wrangler@4" >&2; return 1; }
  [[ -n "$(cf_token)" ]] \
    || { echo "  !! CLOUDFLARE_API_TOKEN (or ~/.cloudflare-token) missing — deploy would fail at every worker" >&2; return 1; }
}

# Run `npm run format:check` only when the subproject DEFINES it. gateway has
# it (prettier); index / panel-react do not, and their package.jsons are out
# of scope for this script — invoking a missing script under `set -e` would
# fail every build. Missing = skip with a note, never a silent pass.
maybe_format_check() {
  # $1 = repo-relative dir, $2 = display label
  if [[ ! -f "$ROOT/$1/package.json" ]]; then
    echo "  -- $2: no package.json, skipping format:check"
    return 0
  fi
  if grep -q '"format:check"' "$ROOT/$1/package.json"; then
    echo "=== [format:check] $2 ==="
    ( cd "$ROOT/$1" && npm run format:check )
  else
    echo "  -- $2: no format:check script, skipping (add one to enable the gate)"
  fi
}

build_agent() {
  local profile="${1:-release}"
  local flags=""
  case "$profile" in
    release) flags="--release" ;;
    debug)   flags="" ;;
    *) echo "usage: $0 agent [release|debug]"; exit 1 ;;
  esac
  echo "=== [agent] vale-agent (${profile}) ==="
  # P0-2: toolchain + format gates BEFORE the expensive panel/exe builds.
  # (clippy -D warnings stays in CI — minutes per local build; fmt is local
  # and fast, and AGENTS.md names cargo fmt as the agent-side format gate.)
  preflight_agent_toolchain || exit 1
  ( cd "$ROOT/agent" && cargo fmt --all -- --check )
  maybe_format_check "agent/resources/panel-react" "panel-react"
  # panel.js is include_str!-embedded at compile time (agent/src/web.rs
  # reads ../resources/panel/panel.js; panel-react vite outDir is ../panel)
  # — building the exe without rebuilding the SPA bakes a STALE UI into the
  # binary. Build + test the panel FIRST (mirror release.yml's Build/Test
  # panel SPA steps). A missing node_modules fails LOUDLY with the install
  # command — silently skipping would recreate the stale-UI bug.
  if [ ! -d "$ROOT/agent/resources/panel-react/node_modules" ]; then
    echo "  !! agent/resources/panel-react/node_modules missing — install first:" >&2
    echo "     (cd agent/resources/panel-react && npm ci --include=optional)" >&2
    exit 1
  fi
  ( cd "$ROOT/agent/resources/panel-react" && npm run build )
  ( cd "$ROOT/agent/resources/panel-react" && npm test )
  ( cd "$ROOT/agent" \
      && cargo xwin build --target "$TARGET" $flags --features "$FEATURES" --bin vale-agent )
  echo "    ok: agent/target/$TARGET/${profile}/vale-agent.exe"

  # round-330: vale-tray + vale-desktop (Tauri) builds removed — both are
  # RETIRED (npm CLI replaced the tray; the Electron shell replaced the
  # Tauri desktop). They cost minutes per build_agent run and never enter
  # the npm tgz (CI builds vale-agent only).
  # npm-only packaging (2026-08-28): the NSIS installer is retired — the
  # npm tgz (vale-agent-npm/) is the single install/update channel, packed
  # by scripts/publish-release.sh (round-320).
}

deploy_worker() {
  local dir="$1" name="$2"
  local token; token="$(cf_token)"
  if [[ -z "$token" ]]; then
    echo "  !! CLOUDFLARE_API_TOKEN (or ~/.cloudflare-token) missing — skipping $name deploy"
    return 1
  fi
  echo "=== [deploy] ${name} (${dir}/) ==="
  # P0-2: format gate before the deploy (runs only where the script exists —
  # gateway/prettier runs, index skips with a note).
  maybe_format_check "$dir" "$name"
  # round-324: the gateway's public /code/ viewer mirrors gateway/src —
  # build-installer.sh used to sync it (round-320 deleted that script).
  # Sync before deploy so the served sources never drift from live.
  if [[ "$dir" == "gateway" ]]; then
    # Gateway deploy preflight (fail-closed): DO_AUTH / SESSION_SECRET /
    # ADMIN_PASSWORD 任一缺失即 abort，不带病上线 (secrets live in the
    # worker, never in wrangler.jsonc — see its Secrets comment).
    # DO_AUTH is required because RouteDO denies every caller when it is
    # unset (fail-closed) while the store path still forwards — deploying
    # without it turns route calls into 401s surfacing as store-side 500s.
    # NOTE: wrangler resolves the worker from the cwd's wrangler.jsonc —
    # this MUST run inside $ROOT/$dir (repo root has no config and the
    # command fails silently into 2>/dev/null, aborting every deploy).
    for s in DO_AUTH SESSION_SECRET ADMIN_PASSWORD; do
      if ! ( cd "$ROOT/$dir" \
        && CLOUDFLARE_API_TOKEN="$token" wrangler secret list 2>/dev/null \
        | grep -qE "(^|[\"' ])${s}([\"' ]|$)" ); then
        echo "  !! abort: worker secret $s 未配置 — 先执行 wrangler secret put $s (gateway fail-closed)" >&2
        return 1
      fi
    done
    # Single sync path: delegate to gateway/scripts/sync-code-viewer.sh
    # (rm -rf + re-copy + dynamic manifest + <dist-host> redaction). The old
    # inline cp block lived here and drifted from that script (public/ +
    # manifest were never synced) — one caller, no dual-script skew.
    if [ ! -d "$ROOT/gateway/src" ]; then
      echo "  !! gateway/src missing — skipping code viewer mirror sync" >&2
    else
      bash "$ROOT/gateway/scripts/sync-code-viewer.sh" \
        || { echo "  !! code viewer mirror sync failed — aborting deploy" >&2; return 1; }
      echo "  synced code viewer mirror ($ROOT/gateway/public/code/files/vale-gate)"
    fi
  fi
  ( cd "$ROOT/$dir" \
      && CLOUDFLARE_API_TOKEN="$token" wrangler deploy )
  # Post-publish smoke (round-58, reworked round-324): /api/version derives
  # from the version.json asset (round-297) — the OLD smoke grepped static
  # version/sha256 constants out of index.js that no longer exist, so every
  # index deploy failed at this step. Expectation now comes from
  # index/public/vale-agent/version.json (the file the worker serves); the
  # checks themselves live in scripts/smoke-index.sh, shared with
  # publish-release.sh so the two publish paths cannot drift apart again.
  if [[ "$dir" == "index" ]]; then
    local want_version want_sha
    want_version="$(python3 -c "import json;print(json.load(open('$ROOT/index/public/vale-agent/version.json'))['version'])")"
    want_sha="$(python3 -c "import json;print(json.load(open('$ROOT/index/public/vale-agent/version.json'))['sha256'])")"
    if [[ -z "$want_sha" || "$want_sha" == *placeholder* || "$want_sha" =~ ^0+$ ]]; then
      echo "  !! version.json sha256 is missing/all-zero/placeholder — devices would be locked out of updates"
      exit 1
    fi
    # shellcheck source=smoke-index.sh
    source "$ROOT/scripts/smoke-index.sh"
    # Shared sha guard (fail-fast here too; smoke_index_release re-asserts
    # internally — both publish paths call the same function, P2-6).
    assert_want_sha256 "$want_sha" || exit 1
    smoke_index_release "$want_version" "$want_sha" || exit 1
  fi
}

deploy_proxy() {
  # Satellite proxy workers (proxies/<name>/): same deploy + smoke pattern as
  # deploy_worker, but these are one-file workers without the post-publish
  # version assertion (no /api/version endpoint).
  local dir="$1" name="$2"
  local token; token="$(cf_token)"
  if [[ -z "$token" ]]; then
    echo "  !! CLOUDFLARE_API_TOKEN (or ~/.cloudflare-token) missing — skipping $name deploy"
    return 1
  fi
  echo "=== [deploy] proxy ${name} (proxies/${dir}/) ==="
  ( cd "$ROOT/proxies/$dir" \
      && CLOUDFLARE_API_TOKEN="$token" wrangler deploy )
  # Secrets are set once via `wrangler secret put` (or the dashboard) and
  # survive re-deploys; if a proxy needs env it reads from Worker env.
  echo "  ok: $name deployed"
}

deploy_vercel_proxy() {
  # Vercel exit proxy (v.saisi.online/api/zen + /api/proxy). Needs the Vercel
  # CLI + token; skips with a clear message when unavailable (CI-friendly).
  if ! command -v vercel >/dev/null 2>&1; then
    echo "  !! vercel CLI not found — skipping vercel-proxy deploy"
    echo "     install: npm i -g vercel  &&  vercel login  (or set VERCEL_TOKEN)"
    return 1
  fi
  # P2-5b preflight: `vercel --prod` without auth fails mid-deploy (and
  # --yes suppresses the login prompt, so it just dies). Require an explicit
  # token OR a linked project (proxies/vercel-proxy/.vercel/project.json).
  if [[ -z "${VERCEL_TOKEN:-}" && ! -f "$ROOT/proxies/vercel-proxy/.vercel/project.json" ]]; then
    echo "  !! neither VERCEL_TOKEN nor a linked .vercel/project.json — set VERCEL_TOKEN or run: (cd proxies/vercel-proxy && vercel link)" >&2
    return 1
  fi
  echo "=== [deploy] vercel-proxy (proxies/vercel-proxy/) ==="
  ( cd "$ROOT/proxies/vercel-proxy" \
      && vercel --prod --yes )
  echo "  ok: vercel-proxy deployed"
  # P2-5b smoke (keyless, mirrors the index-smoke pattern): /api/zen is
  # BYOK-gated, so a keyless GET must answer 401 — that proves the deployment
  # serves AND the auth gate is intact, without spending an upstream call.
  # Any other status (404/500/...) fails the deploy, not the next caller.
  echo "=== [smoke] vercel-proxy ==="
  local smoke_base="${VERCEL_SMOKE_URL:-https://v.saisi.online}"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 30 "${smoke_base}/api/zen?target=og&path=/v1/models" || true)"
  if [[ "$code" != "401" ]]; then
    echo "  !! vercel-proxy smoke FAILED: keyless /api/zen want 401, got ${code:-<curl error>} (${smoke_base})" >&2
    return 1
  fi
  echo "  ok: vercel-proxy smoke 401-gate intact (${smoke_base}/api/zen)"
}

cmd="${1:-agent}"
case "$cmd" in
  agent|command)  build_agent "${2:-release}" ;;
  gateway)  deploy_worker gateway "Vale Gate" ;;
  index)    deploy_worker index "Vale Index" ;;
  proxies)  deploy_proxy zen-go-proxy "zen-go" && deploy_proxy zen-us-proxy "zen-us" && deploy_proxy my-openrouter-proxy "openrouter" ;;
  vercel-proxy) deploy_vercel_proxy ;;
  # round-320: build-installer.sh retired (it staged the dead Vercel mirror
  # + rewrote index.js + required retired Tauri exes — it always failed).
  # Releases use scripts/publish-release.sh (CDN publish + last-5 prune);
  # `deploy` builds agent + deploys gateway/index + the three Cloudflare
  # proxies and vercel-proxy are NOT deployed by `deploy` (deploy manually).
  # P0-2: full-stack preflight FIRST — a missing toolchain piece or token
  # aborts here, never mid-chain as a half-deployed stack (&& serial).
  deploy)   preflight_deploy && build_agent "${2:-release}" && deploy_worker gateway "Vale Gate" && deploy_worker index "Vale Index" && deploy_proxy zen-go-proxy "zen-go" && deploy_proxy zen-us-proxy "zen-us" && deploy_proxy my-openrouter-proxy "openrouter" ;;
  *) echo "usage: $0 [agent|gateway|index|proxies|vercel-proxy|deploy]"; exit 1 ;;
esac
