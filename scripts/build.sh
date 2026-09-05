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
#   ./scripts/build.sh studio          # build + test + restart vale-studio (code.saisi.online)
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

build_agent() {
  local profile="${1:-release}"
  local flags=""
  case "$profile" in
    release) flags="--release" ;;
    debug)   flags="" ;;
    *) echo "usage: $0 agent [release|debug]"; exit 1 ;;
  esac
  echo "=== [agent] vale-agent (${profile}) ==="
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
  # round-324: the gateway's public /code/ viewer mirrors gateway/src —
  # build-installer.sh used to sync it (round-320 deleted that script).
  # Sync before deploy so the served sources never drift from live.
  if [[ "$dir" == "gateway" ]]; then
    # Gateway deploy preflight (fail-closed): DO_AUTH / SESSION_SECRET /
    # ADMIN_PASSWORD 任一缺失即 abort，不带病上线 (secrets live in the
    # worker, never in wrangler.jsonc — see its Secrets comment).
    for s in DO_AUTH SESSION_SECRET ADMIN_PASSWORD; do
      if ! CLOUDFLARE_API_TOKEN="$token" wrangler secret list 2>/dev/null | grep -qE "(^|[\"' ])${s}([\"' ]|$)"; then
        echo "  !! abort: worker secret $s 未配置 — 先执行 wrangler secret put $s (gateway fail-closed)" >&2
        return 1
      fi
    done
    local mirror_root="$ROOT/gateway/public/code/files/vale-gate"
    local code_dir="$mirror_root/src"
    if [ ! -d "$ROOT/gateway/src" ]; then
      echo "  !! gateway/src missing — skipping code viewer mirror sync" >&2
    elif [ ! -d "$mirror_root" ]; then
      echo "  !! code viewer mirror root missing: $mirror_root" >&2
    else
      # rm -rf + re-copy: plain cp never deletes, so files removed from
      # gateway/src (e.g. plugin-hub.ts) kept being served by the Source
      # Viewer. wrangler.jsonc is refreshed too — the mirror copy drifts.
      rm -rf "$code_dir"
      mkdir -p "$code_dir"
      cp "$ROOT"/gateway/src/*.ts "$code_dir/"
      cp -r "$ROOT"/gateway/src/plugins/. "$code_dir/plugins/" 2>/dev/null || true
      cp "$ROOT/gateway/wrangler.jsonc" "$mirror_root/wrangler.jsonc"
      echo "  synced code viewer mirror ($mirror_root)"
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
  echo "=== [deploy] vercel-proxy (proxies/vercel-proxy/) ==="
  ( cd "$ROOT/proxies/vercel-proxy" \
      && vercel --prod --yes )
  echo "  ok: vercel-proxy deployed"
}

build_studio() {
  # Vale Studio (studio/): install deps, vendor the browser assets out of
  # node_modules (monaco AMD loader + xterm UMD — gitignored, generated here),
  # run the API contract tests, then restart the pm2 app.
  echo "=== [studio] npm install ==="
  ( cd "$ROOT/studio" \
      && npm install --include=dev --no-audit --no-fund )
  echo "=== [studio] vendor browser assets ==="
  ( cd "$ROOT/studio" \
      && mkdir -p vendor/xterm \
      && rm -rf vendor/monaco \
      && mkdir -p vendor/monaco \
      && cp -r node_modules/monaco-editor/min/vs/. vendor/monaco/vs/ \
      && cp node_modules/@xterm/xterm/lib/xterm.js node_modules/@xterm/xterm/css/xterm.css vendor/xterm/ \
      && cp node_modules/@xterm/addon-fit/lib/addon-fit.js node_modules/@xterm/addon-web-links/lib/addon-web-links.js vendor/xterm/ )
  echo "=== [studio] API contract tests ==="
  ( cd "$ROOT/studio" && npm test )
  echo "=== [studio] pm2 restart ==="
  pm2 start "$ROOT/studio/ecosystem.config.js" --only vale-studio >/dev/null 2>&1 || true
  pm2 restart vale-studio >/dev/null
  sleep 1
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7780/api/boot || true)"
  [ "$code" = "404" ] || [ "$code" = "200" ] \
    || { echo "  !! studio not answering on :7780 (got $code)"; exit 1; }
  echo "  ok: vale-studio serving on 127.0.0.1:7780 (public: code.saisi.online)"
}

cmd="${1:-agent}"
case "$cmd" in
  agent|command)  build_agent "${2:-release}" ;;
  gateway)  deploy_worker gateway "Vale Gate" ;;
  index)    deploy_worker index "Vale Index" ;;
  proxies)  deploy_proxy zen-go-proxy "zen-go" && deploy_proxy zen-us-proxy "zen-us" && deploy_proxy my-openrouter-proxy "openrouter" ;;
  vercel-proxy) deploy_vercel_proxy ;;
  studio)   build_studio ;;
  # round-320: build-installer.sh retired (it staged the dead Vercel mirror
  # + rewrote index.js + required retired Tauri exes — it always failed).
  # Releases use scripts/publish-release.sh (CDN publish + last-5 prune);
  # `deploy` builds agent + deploys gateway/index + the three Cloudflare
  # proxies (not studio/vercel-proxy).
  deploy)   build_agent "${2:-release}" && deploy_worker gateway "Vale Gate" && deploy_worker index "Vale Index" && deploy_proxy zen-go-proxy "zen-go" && deploy_proxy zen-us-proxy "zen-us" && deploy_proxy my-openrouter-proxy "openrouter" ;;
  *) echo "usage: $0 [agent|gateway|index|proxies|vercel-proxy|studio|deploy]"; exit 1 ;;
esac
