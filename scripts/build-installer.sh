#!/usr/bin/env bash
# Build the ValeAgent-Setup.exe NSIS installer and stage the download files
# for the index worker (index/public/vale-agent/).
#
#   ./scripts/build.sh agent            # first: build the two Windows exes
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

VALEEXE="$ROOT/agent/target/$TARGET/release/vale-agent.exe"
TRAYEXE="$ROOT/agent/vale-tray/target/$TARGET/release/vale-tray.exe"
for f in "$VALEEXE" "$TRAYEXE"; do
  [ -f "$f" ] || { echo "!! missing $f — run ./scripts/build.sh agent first"; exit 1; }
done
# Freshness preflight: a release binary built before the newest source change
# (e.g. after `./scripts/build.sh agent debug`) would silently ship stale
# code. Guard BOTH exes against every input: agent + core + tray sources, the
# workspace version manifest (where the version bump lives), tray build.rs +
# Cargo.toml, deploy/* (ps1/bat/nsi/ico) and the extension zip. A stale tray
# (LOCAL_VERSION drift) caused an hourly reinstall loop; a stale bundled
# fix-tunnel.ps1 caused a tunnel misconfig. Fail loudly instead of packaging.
NEWEST_IN="$(find "$ROOT/agent/src" "$ROOT/agent/vale-command-core" "$ROOT/agent/vale-tray" \
  "$ROOT/agent/deploy" "$ROOT/index/public/vale-agent/vale-browser-control.zip" \
  "$ROOT/agent/Cargo.toml" \
  \( -name '*.rs' -o -name '*.toml' -o -name '*.ps1' -o -name '*.bat' -o -name '*.nsi' -o -name '*.ico' -o -name '*.zip' \) \
  -newer "$VALEEXE" -print | head -1)"
if [ -n "$NEWEST_IN" ]; then
  echo "!! $NEWEST_IN is newer than the release vale-agent.exe — run ./scripts/build.sh agent (release) first"
  exit 1
fi
# Tray guard: the tray has its own build (vale-tray/); check it against the
# same inputs (the tray is NOT rebuilt by ./scripts/build.sh agent's guard).
NEWEST_TRAY="$(find "$ROOT/agent/vale-tray" "$ROOT/agent/Cargo.toml" \
  \( -name '*.rs' -o -name '*.toml' \) -newer "$TRAYEXE" -print | head -1)"
if [ -n "$NEWEST_TRAY" ]; then
  echo "!! $NEWEST_TRAY is newer than the release vale-tray.exe — rebuild the tray (cd agent/vale-tray && cargo xwin build --release)"
  exit 1
fi
[ -x "$MAKENSIS" ] || { echo "!! makensis not found at $MAKENSIS"; exit 1; }

# Version consistency: the index worker's /api/version constant must match
# the workspace manifest, or devices see a stale version and never update
# (or reinstall-loop).
VERSION="$(sed -n '/\[workspace.package\]/,/^\[/p' "$ROOT/agent/Cargo.toml" | grep -m1 '^version = ' | cut -d'"' -f2)"
if ! grep -q "version: \"$VERSION\"" "$ROOT/index/src/index.js"; then
  echo "!! index/src/index.js version constant != agent/Cargo.toml ($VERSION) — bump index first"
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$VALEEXE" "$TRAYEXE" \
   "$ROOT/agent/deploy/vale-agent-setup.ps1" \
   "$ROOT/agent/deploy/run-setup.bat" \
   "$ROOT/agent/deploy/fix-tunnel.ps1" \
   "$ROOT/agent/deploy/vale-agent-install.nsi" \
   "$ROOT/agent/deploy/vale-agent.ico" \
   "$ROOT/index/public/vale-agent/vale-browser-control.zip" "$STAGE/"

echo "=== building ValeAgent-Setup.exe (makensis) ==="
(cd "$STAGE" && NSISDIR="$NSISDIR" "$MAKENSIS" vale-agent-install.nsi >/dev/null 2>&1) \
  || { echo "!! makensis failed"; exit 1; }
echo "  ok: $STAGE/ValeAgent-Setup.exe"

DEST="$ROOT/index/public/vale-agent"
cp "$STAGE/ValeAgent-Setup.exe" "$DEST/ValeAgent-Setup.exe"
cp "$VALEEXE" "$DEST/vale-agent.exe"
cp "$TRAYEXE" "$DEST/vale-tray.exe"
# Keep the whole deploy set in sync — the site serves all of these, not just
# the binaries. (fix-tunnel.ps1 was previously bundled into the installer but
# never refreshed on the site, serving a stale copy to irm users.)
cp "$ROOT/agent/deploy/vale-agent-setup.ps1" "$DEST/vale-agent-setup.ps1"
cp "$ROOT/agent/deploy/fix-tunnel.ps1" "$DEST/fix-tunnel.ps1"
cp "$ROOT/agent/deploy/run-setup.bat" "$DEST/run-setup.bat"
cp "$ROOT/agent/deploy/vale-agent.ico" "$DEST/vale-agent.ico"
echo "  staged to $DEST/"
echo "  next: ./scripts/build.sh index   (deploy the download site)"
