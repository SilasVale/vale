#!/usr/bin/env bash
# Vale 平台统一构建脚本（从 monorepo 顶层跑通 command / gateway / index）
#
#   ./scripts/build.sh                 # 构建 command（Windows 交叉编译，release）
#   ./scripts/build.sh command [debug] # 构建 vale-command + vale-tray
#   ./scripts/build.sh gateway         # 部署 Vale Gate worker（ai.saisi.online）
#   ./scripts/build.sh index           # 部署 Vale Index worker（command.saisi.online）
#   ./scripts/build.sh deploy          # command 构建 + gateway/index 部署
#
# 依赖：cargo-xwin、wrangler（全局 v4）、CLOUDFLARE_API_TOKEN（仅部署，
#       或 ~/.cloudflare-token 文件）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="x86_64-pc-windows-msvc"
FEATURES="terminal,browser"   # serial/SSH/PTY + headless Edge/Chrome

# --- token: $CLOUDFLARE_API_TOKEN 优先，否则 ~/.cloudflare-token ---
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
    echo "  !! 缺 CLOUDFLARE_API_TOKEN（或 ~/.cloudflare-token），跳过部署 $name"
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
