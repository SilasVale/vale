#!/usr/bin/env bash
# Vale unified build script (command / gateway / index from the monorepo root)
#
#   ./scripts/build.sh                 # build command (Windows cross-compile, release)
#   ./scripts/build.sh command [debug] # build vale-command + vale-tray
#   ./scripts/build.sh gateway         # deploy the Vale Gate worker
#   ./scripts/build.sh index           # deploy the Vale Index worker
#   ./scripts/build.sh deploy          # build command + deploy gateway/index
#
# Dependencies: cargo-xwin, wrangler (global v4), CLOUDFLARE_API_TOKEN (deploy
# only, or a ~/.cloudflare-token file).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="x86_64-pc-windows-msvc"
FEATURES="terminal"   # serial/SSH/PTY backends (keyring optional)

# --- token: prefer $CLOUDFLARE_API_TOKEN, else ~/.cloudflare-token ---
cf_token() {
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then echo "$CLOUDFLARE_API_TOKEN";
  elif [[ -f "$HOME/.cloudflare-token" ]]; then cat "$HOME/.cloudflare-token";
  else echo ""; fi
}

build_command() {
  local profile="${1:-release}"
  local flags=""
  case "$profile" in
    release) flags="--release" ;;
    debug)   flags="" ;;
    *) echo "usage: $0 command [release|debug]"; exit 1 ;;
  esac
  echo "=== [command] vale-command (${profile}) ==="
  ( cd "$ROOT/command" \
      && cargo xwin build --target "$TARGET" $flags --features "$FEATURES" --bin vale-command )
  echo "    ok: command/target/$TARGET/${profile}/vale-command.exe"

  echo "=== [command] vale-tray (release) ==="
  ( cd "$ROOT/command/vale-tray" \
      && cargo xwin build --target "$TARGET" --release )
  echo "    ok: command/vale-tray/target/$TARGET/release/vale-tray.exe"
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
}

cmd="${1:-command}"
case "$cmd" in
  command)  build_command "${2:-release}" ;;
  gateway)  deploy_worker gateway "Vale Gate" ;;
  index)    deploy_worker index "Vale Index" ;;
  deploy)   build_command "${2:-release}" && deploy_worker gateway "Vale Gate" && deploy_worker index "Vale Index" ;;
  *) echo "usage: $0 [command|gateway|index|deploy]"; exit 1 ;;
esac
