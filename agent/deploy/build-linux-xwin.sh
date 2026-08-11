#!/usr/bin/env bash
# build-linux-xwin.sh — cross-compile the headless vale-command binary from
# Linux to Windows via cargo-xwin (needs `cargo install cargo-xwin`).
#
# Output: target/x86_64-pc-windows-msvc/release/vale-command.exe
set -euo pipefail

cd "$(dirname "$0")/.."

RELEASE="${1:-release}"   # pass "debug" for a debug build
TARGET="x86_64-pc-windows-msvc"

features="terminal"   # serial/SSH/PTY backends (keyring optional).

case "$RELEASE" in
  release) profile="--release" ;;
  debug)   profile="" ;;
  *)       echo "usage: $0 [release|debug]"; exit 1 ;;
esac

cargo xwin build --target "$TARGET" $profile --features "$features" --bin vale-command

out="target/$TARGET/${RELEASE}/vale-command.exe"
echo "Built: $out"
