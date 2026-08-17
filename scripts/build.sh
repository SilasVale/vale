#!/usr/bin/env bash
# Vale unified build script (agent / gateway / index from the monorepo root)
#
#   ./scripts/build.sh                 # build agent (Windows cross-compile, release)
#   ./scripts/build.sh agent [debug]   # build vale-agent + vale-tray
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

build_agent() {
  local profile="${1:-release}"
  local flags=""
  case "$profile" in
    release) flags="--release" ;;
    debug)   flags="" ;;
    *) echo "usage: $0 agent [release|debug]"; exit 1 ;;
  esac
  echo "=== [agent] vale-agent (${profile}) ==="
  ( cd "$ROOT/agent" \
      && cargo xwin build --target "$TARGET" $flags --features "$FEATURES" --bin vale-agent )
  echo "    ok: agent/target/$TARGET/${profile}/vale-agent.exe"

  echo "=== [agent] vale-tray (release) ==="
  ( cd "$ROOT/agent/vale-tray" \
      && cargo xwin build --target "$TARGET" --release )
  echo "    ok: agent/vale-tray/target/$TARGET/release/vale-tray.exe"

  # round-140/142: compile the NSIS script at build time — string errors
  # (e.g. the R139 quote-splitting bug) previously shipped to devices
  # silently. The stage needs ALL the File-directive inputs (the R140
  # version omitted 5 and every `build.sh agent` failed); the path defaults
  # match build-installer.sh's actual NSIS install. Release-only (the
  # documented fast debug iteration path must not require NSIS tooling).
  if [[ "$profile" == "release" ]]; then
    echo "=== [agent] NSIS script compile check ==="
    local stage; stage="$(mktemp -d)"
    cp "$ROOT/agent/deploy/vale-agent-install.nsi" "$stage/"
    cp "$ROOT/agent/deploy/vale-agent.ico" "$stage/"
    cp "$ROOT/agent/deploy/vale-agent-setup.ps1" "$stage/"
    cp "$ROOT/agent/deploy/run-setup.bat" "$stage/"
    cp "$ROOT/agent/deploy/fix-tunnel.ps1" "$stage/"
    cp "$ROOT/index/public/vale-agent/vale-browser-control.zip" "$stage/" 2>/dev/null || true
    # The playwright bundle may not exist yet (prepare_playwright builds it
    # in build-installer.sh) — a placeholder lets the File directive resolve.
    [ -f "$ROOT/agent/deploy/vale-playwright.zip" ] \
      && cp "$ROOT/agent/deploy/vale-playwright.zip" "$stage/" \
      || touch "$stage/vale-playwright.zip"
    cp "$ROOT/agent/target/$TARGET/${profile}/vale-agent.exe" "$stage/vale-agent.exe"
    cp "$ROOT/agent/vale-tray/target/$TARGET/release/vale-tray.exe" "$stage/vale-tray.exe"
    local nsis_out
    nsis_out="$(cd "$stage" \
      && NSISDIR="${NSISDIR:-$HOME/tools/nsis/extracted/usr/share/nsis}" \
         "${MAKENSIS:-$HOME/tools/nsis/extracted/usr/bin/makensis}" vale-agent-install.nsi 2>&1)"
    local rc=$?
    if [[ $rc -ne 0 ]]; then
      echo "!! NSIS compile failed — check vale-agent-install.nsi:"
      echo "$nsis_out" | tail -8
      rm -rf "$stage"
      exit 1
    fi
    rm -rf "$stage"
    echo "  ok: NSIS script compiles"
  fi
}

deploy_worker() {
  local dir="$1" name="$2"
  local token; token="$(cf_token)"
  if [[ -z "$token" ]]; then
    echo "  !! CLOUDFLARE_API_TOKEN (or ~/.cloudflare-token) missing — skipping $name deploy"
    return 1
  fi
  echo "=== [deploy] ${name} (${dir}/) ==="
  ( cd "$ROOT/$dir" \
      && CLOUDFLARE_API_TOKEN="$token" wrangler deploy )
  # Post-publish smoke (round-58): a stale/placeholder sha256 in index.js
  # ships silently and locks EVERY device's agent_update (integrity check
  # fails) until someone notices. Assert the live /api/version matches the
  # source constants right after deploy — fail loudly at publish time.
  if [[ "$dir" == "index" ]]; then
    local want_version want_sha
    want_version="$(grep -oP 'version: "\K[0-9.]+' "$ROOT/index/src/index.js" | head -1)"
    want_sha="$(grep -oP 'sha256: "\K[0-9a-f]{64}' "$ROOT/index/src/index.js" | head -1)"
    if [[ -z "$want_sha" || "$want_sha" == *placeholder* || "$want_sha" =~ ^0+$ ]]; then
      echo "  !! index/src/index.js sha256 is missing/all-zero/placeholder — devices would be locked out of updates"
      exit 1
    fi
    local live
    # Edge propagation has a few seconds' delay after wrangler returns — a
    # single curl could hit a stale POP and false-fail the deploy. Retry
    # briefly before giving up (round-59).
    live=""
    for _ in 1 2 3 4 5; do
      live="$(curl -s -m 30 https://agent.saisi.online/api/version)"
      echo "$live" | grep -q "\"version\":\"$want_version\"" && break
      sleep 3
    done
    if ! echo "$live" | grep -q "\"version\":\"$want_version\""; then
      echo "  !! live version mismatch: want $want_version, got: $live"
      exit 1
    fi
    if ! echo "$live" | grep -q "\"sha256\":\"$want_sha\""; then
      echo "  !! live sha256 mismatch: want $want_sha, got: $live"
      exit 1
    fi
    # round-132/133: the manifest check alone never touched the served BINARY —
    # a missing (fresh-clone deploy without the exe in git) or mismatched
    # (interrupt between the index.js sha write and the exe copy) installer
    # shipped with a green smoke, and round-119 made every device refuse the
    # install permanently. Hash the live download against the manifest. The
    # download URL comes from the manifest (retry like the version check —
    # asset propagation lags a few seconds after wrangler returns).
    local dl_url live_sha
    dl_url="$(echo "$live" | grep -oP '"download":"\K[^"]+' | head -1)"
    [ -n "$dl_url" ] || { echo "  !! manifest has no download URL"; exit 1; }
    live_sha=""
    for _ in 1 2 3 4 5; do
      # round-134: curl -f fails fast on 4xx/5xx (a 404 error body would
      # otherwise be hashed and burn all retries); `|| live_sha=""` keeps a
      # TRANSPORT failure (timeout/reset during the post-deploy propagation
      # window) inside the retry loop instead of aborting the whole deploy
      # under set -e.
      live_sha="$(curl -fsS -m 120 "$dl_url" 2>/dev/null | sha256sum | cut -d' ' -f1)" || live_sha=""
      [ "$live_sha" = "$want_sha" ] && break
      sleep 3
    done
    if [ "$live_sha" != "$want_sha" ]; then
      echo "  !! live binary sha256 mismatch: manifest $want_sha, downloaded $live_sha ($dl_url)"
      exit 1
    fi
    echo "  ok: /api/version smoke passed (v$want_version, binary sha verified)"
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

cmd="${1:-agent}"
case "$cmd" in
  agent|command)  build_agent "${2:-release}" ;;
  gateway)  deploy_worker gateway "Vale Gate" ;;
  index)    deploy_worker index "Vale Index" ;;
  proxies)  deploy_proxy zen-go-proxy "zen-go" && deploy_proxy zen-us-proxy "zen-us" && deploy_proxy my-openrouter-proxy "openrouter" ;;
  vercel-proxy) deploy_vercel_proxy ;;
  deploy)   build_agent "${2:-release}" && ./scripts/build-installer.sh && deploy_worker gateway "Vale Gate" && deploy_worker index "Vale Index" && deploy_proxy zen-go-proxy "zen-go" && deploy_proxy zen-us-proxy "zen-us" && deploy_proxy my-openrouter-proxy "openrouter" ;;
  *) echo "usage: $0 [agent|gateway|index|proxies|vercel-proxy|deploy]"; exit 1 ;;
esac
