#!/usr/bin/env bash
# Vale unified build script (agent / gateway / index from the monorepo root)
#
#   ./scripts/build.sh                 # build agent (Windows cross-compile, release)
#   ./scripts/build.sh agent [debug]   # build vale-agent + vale-tray
#   ./scripts/build.sh command [debug] # legacy alias for `agent`
#   ./scripts/build.sh gateway         # deploy the Vale Gate worker
#   ./scripts/build.sh index           # deploy the Vale Index worker
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
    echo "  ok: /api/version smoke passed (v$want_version)"
  fi
}

cmd="${1:-agent}"
case "$cmd" in
  agent|command)  build_agent "${2:-release}" ;;
  gateway)  deploy_worker gateway "Vale Gate" ;;
  index)    deploy_worker index "Vale Index" ;;
  deploy)   build_agent "${2:-release}" && ./scripts/build-installer.sh && deploy_worker gateway "Vale Gate" && deploy_worker index "Vale Index" ;;
  *) echo "usage: $0 [agent|gateway|index|deploy]"; exit 1 ;;
esac
