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
MAKENSIS="${MAKENSIS:-$HOME/tools/nsis/extracted/usr/bin/makensis}"
NSISDIR="${NSISDIR:-$HOME/tools/nsis/extracted/usr/share/nsis}"
TARGET="x86_64-pc-windows-msvc"

# Repack the browser extension into its zip — the extension previously had NO
# automated repack step (a lib/ edit shipped only if someone remembered to zip
# by hand; the freshness guard excluded the zip).
repack_extension() {
  local z="$ROOT/index/public/vale-agent/vale-browser-control.zip"
  rm -f "$z"
  ( cd "$ROOT/extension" \
      && zip -r -q "$z" manifest.json background.js popup/ options/ terminal/ lib/ icons/ README.md )
  echo "  repacked extension zip"
}
repack_extension

# Phase 3: bundle the playwright-mcp runtime (node.exe + the full flat
# node_modules tree) into vale-playwright.zip, staged next to the installer
# for the NSIS script (File "vale-playwright.zip"). The PlaywrightManager
# spawns install_dir/playwright/node.exe + the package's cli.js (at the
# package ROOT — 0.0.79 has no dist/; verified against the npm tarball).
# The device uses its own Edge (--browser msedge), so no Chromium is
# bundled and PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD avoids pulling Linux
# browsers on this build host. Repacked on every run.
prepare_playwright() {
  local out="$ROOT/agent/deploy/vale-playwright.zip"
  local work
  work="$(mktemp -d)"
  echo "  preparing playwright bundle..."
  # 1. node.exe (Windows x64, LTS 20+) — pinned.
  local node_ver="v20.18.0"
  curl -fsS -m 300 -o "$work/node.zip" \
    "https://nodejs.org/dist/$node_ver/node-$node_ver-win-x64.zip"
  ( cd "$work" && unzip -q node.zip && mv "node-$node_ver-win-x64" node )
  # 2. @playwright/mcp@0.0.79 + deps (flat node_modules). The postinstall
  #    would download Linux browsers — skip (the manager runs --browser
  #    msedge, and browsers are never shipped).
  ( cd "$work" \
      && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund @playwright/mcp@0.0.79 >/dev/null 2>&1 )
  # 3. layout: playwright/{node.exe, node_modules/} — the whole flat tree,
  #    including node_modules/@playwright/mcp itself (cli.js + index.js +
  #    package.json live there; cli.js requires './package.json' and
  #    'playwright-core' from the flattened deps).
  mkdir -p "$work/playwright"
  mv "$work/node/node.exe" "$work/playwright/"
  cp -r "$work/node_modules" "$work/playwright/node_modules"
  # 4. sanity: the entry the manager spawns must exist.
  if [ ! -f "$work/playwright/node_modules/@playwright/mcp/cli.js" ]; then
    echo "  !! playwright bundle missing cli.js — npm install failed?"
    rm -rf "$work"
    exit 1
  fi
  # 5. zip it
  ( cd "$work" && zip -r -q "$out" playwright )
  rm -rf "$work"
  echo "  staged vale-playwright.zip ($(du -h "$out" | cut -f1))"
}
prepare_playwright

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
# NOTE: the extension zip is intentionally EXCLUDED from the agent freshness
# guard — it is repacked independently (no dependency on the exes) and would
# otherwise always be newer than a freshly-built exe, blocking every build.
# NOTE: *.nsi is intentionally excluded — the NSIS script is independent of
# the exe build (editing it must not require a rebuild).
# round-131: deploy/*.ps1|*.bat are re-staged fresh into the installer by
# THIS script at makensis time — their mtime vs the exe is meaningless, and
# gating on them wedges the pipeline (editing a ps1 demands an exe rebuild
# that nothing changes). Only rs/toml sources that actually feed the exe.
NEWEST_IN="$(find "$ROOT/agent/src" "$ROOT/agent/vale-command-core" \
  "$ROOT/agent/vale-tray" "$ROOT/agent/Cargo.toml" \
  -path '*/target' -prune -o \
  \( -name '*.rs' -o -name '*.toml' \) \
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
# The sha256 field must exist (agent_update verifies the installer against
# it); its value is regenerated below after makensis produces the exe.
if ! grep -q 'sha256: "' "$ROOT/index/src/index.js"; then
  echo "!! index/src/index.js sha256 field missing — add it (agent verifies installer integrity against it)"
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
   "$ROOT/index/public/vale-agent/vale-browser-control.zip" \
   "$ROOT/agent/deploy/vale-playwright.zip" "$STAGE/"

echo "=== building ValeAgent-Setup.exe (makensis) ==="
(cd "$STAGE" && NSISDIR="$NSISDIR" "$MAKENSIS" vale-agent-install.nsi >/dev/null 2>&1) \
  || { echo "!! makensis failed"; exit 1; }
echo "  ok: $STAGE/ValeAgent-Setup.exe"

# Publish the installer's SHA-256 into the index worker's /api/version — the
# agent's agent_update verifies the download against it before spawning.
# (Deploy order in build.sh deploy: installer → index, so the hash is in the
# worker before it ships.)
SHA256="$(sha256sum "$STAGE/ValeAgent-Setup.exe" | cut -d' ' -f1)"
sed -i "s/sha256: \"[0-9a-f]*\"/sha256: \"$SHA256\"/" "$ROOT/index/src/index.js"
# Fail-loud guard (round-55): the old sed pattern [0-9a-f]* could not match
# the letter-containing placeholder "sha256-placeholder" — sed exited 0, the
# placeholder shipped verbatim, and every agent_update died on the integrity
# check until someone hand-edited index.js. Any leftover placeholder text
# means the replace silently failed; refuse to continue.
if grep -q "placeholder" "$ROOT/index/src/index.js"; then
  echo "!! sha256 placeholder not replaced in index/src/index.js — fix the sed pattern"
  exit 1
fi
echo "  ok: sha256 $SHA256 → index/src/index.js"

DEST="$ROOT/index/public/vale-agent"
# The installer embeds the playwright bundle (~36MB) — over the Workers
# Assets 25MiB per-file cap — so it ships as a GitHub Release asset on the
# public SilasVale/vale repo instead; the download page + /api/version
# manifest point at releases/latest/download/. The standalone bundle is
# published too (the setup.ps1 script-install path downloads it directly).
# Only the small files stay Workers Assets. Clean any stale oversize copies.
rm -f "$DEST/ValeAgent-Setup.exe" "$DEST/vale-playwright.zip"
publish_release() {
  local gh_token
  gh_token="$(sed -n 's|https://[^:]*:\([^@]*\)@github.com.*|\1|p' "$HOME/.git-credentials" 2>/dev/null | head -1)"
  [[ -n "$gh_token" ]] || { echo "!! GitHub release upload needs a PAT in ~/.git-credentials"; exit 1; }
  local api="https://api.github.com/repos/SilasVale/vale" tag="v$VERSION" rel_id
  rel_id="$(curl -s -m 30 -H "Authorization: token $gh_token" "$api/releases/tags/$tag" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))')"
  if [[ -z "$rel_id" ]]; then
    rel_id="$(curl -s -m 30 -X POST -H "Authorization: token $gh_token" -H "Accept: application/vnd.github+json" \
      "$api/releases" -d "{\"tag_name\":\"$tag\",\"name\":\"$tag\"}" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))')"
    [[ -n "$rel_id" ]] || { echo "!! failed to create release $tag"; exit 1; }
    echo "  created release $tag"
  fi
  local asset file
  for asset in "$STAGE/ValeAgent-Setup.exe:ValeAgent-Setup.exe" \
               "$ROOT/agent/deploy/vale-playwright.zip:vale-playwright.zip"; do
    file="${asset%%:*}"; name="${asset##*:}"
    # Replace any same-name asset from an earlier build of this version.
    local aid
    aid="$(curl -s -m 30 -H "Authorization: token $gh_token" "$api/releases/$rel_id/assets" \
      | python3 -c "import sys,json; a=[x for x in json.load(sys.stdin) if x['name']=='$name']; print(a[0]['id'] if a else '')")"
    [[ -n "$aid" ]] && curl -s -m 30 -X DELETE -H "Authorization: token $gh_token" "$api/releases/assets/$aid" >/dev/null
    curl -s -m 600 -X POST -H "Authorization: token $gh_token" -H "Content-Type: application/octet-stream" \
      "https://uploads.github.com/repos/SilasVale/vale/releases/$rel_id/assets?name=$name" \
      --data-binary "@$file" | grep -q 'uploaded' \
      || { echo "!! release asset upload failed: $name"; exit 1; }
    echo "  ok: release $tag asset $name ($(du -h "$file" | cut -f1))"
  done
}
publish_release
# Primary download path: Vercel static hosting (v.saisi.online/dl/*). The
# Vercel CDN serves the files from US edge nodes — devices on slow/blocked
# GitHub paths still get full speed, and the URL stays on our own domain.
# Static files (100MB cap) instead of a proxy FUNCTION: Hobby-plan functions
# cap at 4.5MB responses / 10s, which a 37MB installer can't pass through.
# Staged here; `build.sh deploy` pushes them with the vercel-proxy deploy.
VERCEL_DL="$ROOT/proxies/vercel-proxy/dl"
mkdir -p "$VERCEL_DL"
cp "$STAGE/ValeAgent-Setup.exe" "$VERCEL_DL/ValeAgent-Setup.exe"
cp "$ROOT/agent/deploy/vale-playwright.zip" "$VERCEL_DL/vale-playwright.zip"
echo "  staged $(du -sh "$VERCEL_DL" | cut -f1) for v.saisi.online/dl/"
cp "$VALEEXE" "$DEST/vale-agent.exe"
cp "$TRAYEXE" "$DEST/vale-tray.exe"
# Refresh the gateway's code-viewer mirror of the worker source — the public
# /code/ viewer was drifting 1000+ lines behind live src with no pipeline step.
# Sync ALL viewer files (round-63): the original list missed
# anthropic-translate/mcp/mcp-tools/device-fetch/http, which then showed
# versions that never existed in production.
CODE_DIR="$ROOT/gateway/public/code/files/vale-gate"
if [ -d "$CODE_DIR" ]; then
  cp "$ROOT"/gateway/src/*.js "$CODE_DIR/src/"
  cp "$ROOT/gateway/public/index.html" "$CODE_DIR/public/index.html"
  cp "$ROOT/gateway/public/app.js" "$CODE_DIR/public/app.js"
  cp "$ROOT/gateway/public/style.css" "$CODE_DIR/public/style.css"
  echo "  synced code viewer mirror ($CODE_DIR)"
fi
# Keep the whole deploy set in sync — the site serves all of these, not just
# the binaries. (fix-tunnel.ps1 was previously bundled into the installer but
# never refreshed on the site, serving a stale copy to irm users.)
cp "$ROOT/agent/deploy/vale-agent-setup.ps1" "$DEST/vale-agent-setup.ps1"
cp "$ROOT/agent/deploy/fix-tunnel.ps1" "$DEST/fix-tunnel.ps1"
cp "$ROOT/agent/deploy/run-setup.bat" "$DEST/run-setup.bat"
cp "$ROOT/agent/deploy/vale-agent.ico" "$DEST/vale-agent.ico"
echo "  staged to $DEST/"
echo "  next: ./scripts/build.sh index   (deploy the download site)"
