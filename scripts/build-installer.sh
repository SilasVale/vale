#!/usr/bin/env bash
# Build the ValeAgent-Setup.exe NSIS installer and stage the download files
# for the index worker (index/public/vale-command/).
#
#   ./scripts/build.sh command            # first: build the two Windows exes
#   ./scripts/build-installer.sh          # then: bundle + stage
#   ./scripts/build.sh index              # then: deploy the download site
#
# Requires the extracted makensis + NSIS data (NSISDIR). Override with
# MAKENSIS / NSISDIR env if your install lives elsewhere.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAKENSIS="${MAKENSIS:-/home/zhengsaisi/tools/nsis/extracted/usr/bin/makensis}"
NSISDIR="${NSISDIR:-/home/zhengsaisi/tools/nsis/extracted/usr/share/nsis}"
TARGET="x86_64-pc-windows-msvc"

VALEEXE="$ROOT/command/target/$TARGET/release/vale-agent.exe"
TRAYEXE="$ROOT/command/vale-tray/target/$TARGET/release/vale-tray.exe"
for f in "$VALEEXE" "$TRAYEXE"; do
  [ -f "$f" ] || { echo "!! missing $f — run ./scripts/build.sh command first"; exit 1; }
done
[ -x "$MAKENSIS" ] || { echo "!! makensis not found at $MAKENSIS"; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$VALEEXE" "$TRAYEXE" \
   "$ROOT/command/deploy/vale-agent-setup.ps1" \
   "$ROOT/command/deploy/run-setup.bat" \
   "$ROOT/command/deploy/fix-tunnel.ps1" \
   "$ROOT/command/deploy/vale-agent-install.nsi" \
   "$ROOT/index/public/vale-agent/vale-browser-control.zip" "$STAGE/"

echo "=== building ValeAgent-Setup.exe (makensis) ==="
(cd "$STAGE" && NSISDIR="$NSISDIR" "$MAKENSIS" vale-agent-install.nsi >/dev/null 2>&1) \
  || { echo "!! makensis failed"; exit 1; }
echo "  ok: $STAGE/ValeAgent-Setup.exe"

DEST="$ROOT/index/public/vale-agent"
cp "$STAGE/ValeAgent-Setup.exe" "$DEST/ValeAgent-Setup.exe"
cp "$VALEEXE" "$DEST/vale-agent.exe"
cp "$TRAYEXE" "$DEST/vale-tray.exe"
cp "$ROOT/command/deploy/vale-agent-setup.ps1" "$DEST/vale-agent-setup.ps1"
echo "  staged to $DEST/"
echo "  next: ./scripts/build.sh index   (deploy the download site)"
