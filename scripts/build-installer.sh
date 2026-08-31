#!/usr/bin/env bash
# Stage the npm distribution package (vale-agent-npm/) — the SINGLE install
# and update channel (NSIS installer retired 2026-08-28). Builds the boxed
# artifacts (playwright bundle + cloudflared), packs the npm tgz, and stages
# the download files for the index worker (index/public/vale-agent/).
#
#   ./scripts/build.sh agent            # first: build the Windows exes
#   ./scripts/build-installer.sh          # then: pack + stage the npm tgz
#   ./scripts/build.sh index              # then: deploy the download site
#
# No makensis/NSIS required anymore.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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

# Bundle cloudflared (Windows amd64) INTO the installer — one package contains
# every piece. C2: the binary is BOXED under $INSTDIR\tools\ (the NSIS
# script stages it there) and supervised by the agent; the setup script no
# longer needs winget/external downloads (the "分散" fix).
CLOUDFLARED="$ROOT/agent/deploy/cloudflared.exe"
fetch_cloudflared() {
  if [ -f "$CLOUDFLARED" ] && [ "$(stat -c%s "$CLOUDFLARED" 2>/dev/null || echo 0)" -gt 1000000 ]; then
    echo "  cloudflared already staged ($(du -h "$CLOUDFLARED" | cut -f1))"
    return 0
  fi
  echo "  downloading cloudflared (Windows amd64)..."
  curl -fsSL --retry 3 -o "$CLOUDFLARED" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" \
    || { echo "!! cloudflared download failed"; exit 1; }
  echo "  staged cloudflared ($(du -h "$CLOUDFLARED" | cut -f1))"
}
fetch_cloudflared

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
  # Reuse an already-staged bundle (like cloudflared): the zip holds node.exe
  # + @playwright/mcp, neither of which changes with an agent release. A
  # rebuild needs a bump of PW_BUNDLE_VER below (or deleting the file).
  if [ -f "$out" ] && [ "$(stat -c%s "$out" 2>/dev/null || echo 0)" -gt 1000000 ]; then
    echo "  playwright bundle already staged ($(du -h "$out" | cut -f1))"
    return 0
  fi
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
      && npm init -y >/dev/null 2>&1 \
      && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund --no-package-lock @playwright/mcp@0.0.79 >/dev/null 2>&1 )
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
DESKTOPEXE="$ROOT/agent/vale-desktop/src-tauri/target/$TARGET/release/vale-desktop.exe"
for f in "$VALEEXE" "$TRAYEXE" "$DESKTOPEXE"; do
  [ -f "$f" ] || { echo "!! missing $f — run ./scripts/build.sh agent first"; exit 1; }
done
# Freshness preflight: a release binary built before the newest source change
# (e.g. after `./scripts/build.sh agent debug`) would silently ship stale
# code. Guard ALL exes against every input: agent + core + tray + desktop
# sources, the workspace version manifest (where the version bump lives),
# tray build.rs + Cargo.toml, deploy/* (ps1/bat/nsi/ico) and the extension
# zip. A stale tray (LOCAL_VERSION drift) caused an hourly reinstall loop; a
# stale bundled fix-tunnel.ps1 caused a tunnel misconfig. Fail loudly instead
# of packaging.
# NOTE: the extension zip is intentionally EXCLUDED from the agent freshness
# guard — it is repacked independently (no dependency on the exes) and would
# otherwise always be newer than a freshly-built exe, blocking every build.
# round-131: deploy/*.ps1|*.bat are no longer staged (npm-only packaging);
# only rs/toml sources that actually feed the exe are gated.
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
  -path '*/target' -prune -o \
  \( -name '*.rs' -o -name '*.toml' \) -newer "$TRAYEXE" -print | head -1)"
if [ -n "$NEWEST_TRAY" ]; then
  echo "!! $NEWEST_TRAY is newer than the release vale-tray.exe — rebuild the tray (cd agent/vale-tray && cargo xwin build --release)"
  exit 1
fi
# Desktop guard: vale-desktop has its own workspace target dir.
NEWEST_DESKTOP="$(find "$ROOT/agent/vale-desktop" "$ROOT/agent/Cargo.toml" \
  -path '*/target' -prune -o \
  \( -name '*.rs' -o -name '*.toml' -o -name '*.json' \) \
  -newer "$DESKTOPEXE" -print | head -1)"
if [ -n "$NEWEST_DESKTOP" ]; then
  echo "!! $NEWEST_DESKTOP is newer than the release vale-desktop.exe — rebuild (cd agent/vale-desktop/src-tauri && cargo xwin build --release)"
  exit 1
fi
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

NPM_DIR="$ROOT/agent/vale-agent-npm"
# Stage the boxed artifacts into the npm package (files: list in package.json).
cp "$VALEEXE" "$NPM_DIR/vale-agent.exe"
cp "$DESKTOPEXE" "$NPM_DIR/vale-desktop.exe"
cp "$ROOT/agent/deploy/cloudflared.exe" "$NPM_DIR/cloudflared.exe"
cp "$ROOT/agent/deploy/vale-playwright.zip" "$NPM_DIR/vale-playwright.zip"
echo "=== packing npm tgz (single install/update channel) ==="
TGZ="$(cd "$NPM_DIR" && npm pack --silent)"
TGZ_PATH="$NPM_DIR/$TGZ"
echo "  ok: $TGZ_PATH"

# Publish the package's SHA-256 into the index worker's /api/version — the
# agent's agent_update verifies the download against it before spawning.
# (Deploy order in build.sh deploy: npm tgz → index, so the hash is in the
# worker before it ships.)
SHA256="$(sha256sum "$TGZ_PATH" | cut -d' ' -f1)"
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

# Keep the manifest's download URL in sync with the packed artifact: a tgz
# over the Workers Assets 25MiB per-file cap must live on the Vercel mirror
# (v.saisi.online/dl/); a smaller one is staged into the worker assets and
# served from agent.saisi.online directly. Both /api/version and the
# download page must point at wherever the file actually is — a stale URL
# 404s every device's vale update (surfacing as a failed download, not a
# corruption, in the post-deploy sha smoke).
TGZ_NAME="$(basename "$TGZ_PATH")"
TGZ_MB=$(( $(stat -c%s "$TGZ_PATH") / 1024 / 1024 ))
if [ "$TGZ_MB" -ge 25 ]; then
  DL_HOST="https://v.saisi.online/dl"
else
  DL_HOST="https://agent.saisi.online/vale-agent"
  cp "$TGZ_PATH" "$DEST/$TGZ_NAME"
fi
sed -i "s|https://[^\"\\\`]*/${TGZ_NAME}|${DL_HOST}/${TGZ_NAME}|g" "$ROOT/index/src/index.js"
if ! grep -q "${DL_HOST}/${TGZ_NAME}" "$ROOT/index/src/index.js"; then
  echo "!! download URL sync failed in index/src/index.js — expected ${DL_HOST}/${TGZ_NAME}"
  exit 1
fi
echo "  ok: download URLs → ${DL_HOST}/${TGZ_NAME} (${TGZ_MB} MiB)"

# The npm tgz (~40MB, embeds the playwright bundle) is over the Workers
# Assets 25MiB per-file cap — stage it to the Vercel static mirror below
# (v.saisi.online/dl/*), and the download page + /api/version manifest point
# there. Only the small files stay Workers Assets.
rm -f "$DEST/ValeAgent-Setup.exe"
# Primary download path: Vercel static hosting (v.saisi.online/dl/*). The
# Vercel CDN serves the files from US edge nodes — devices on slow/blocked
# GitHub paths still get full speed, and the URL stays on our own domain.
# Static files (100MB cap) instead of a proxy FUNCTION: Hobby-plan functions
# cap at 4.5MB responses / 10s, which a 40MB tgz can't pass through.
# Staged here; `build.sh deploy` pushes them with the vercel-proxy deploy.
VERCEL_DL="$ROOT/proxies/vercel-proxy/dl"
mkdir -p "$VERCEL_DL"
cp "$TGZ_PATH" "$VERCEL_DL/$TGZ"
echo "  staged $(du -sh "$VERCEL_DL" | cut -f1) for v.saisi.online/dl/"
cp "$VALEEXE" "$DEST/vale-agent.exe"
cp "$TRAYEXE" "$DEST/vale-tray.exe"
cp "$DESKTOPEXE" "$DEST/vale-desktop.exe"
# Refresh the gateway's code-viewer mirror of the worker source — the public
# /code/ viewer was drifting 1000+ lines behind live src with no pipeline step.
# Sync ALL viewer files (round-63): the original list missed
# anthropic-translate/mcp/mcp-tools/device-fetch/http, which then showed
# versions that never existed in production.
CODE_DIR="$ROOT/gateway/public/code/files/vale-gate"
if [ -d "$CODE_DIR" ]; then
  # 2026-08: gateway src migrated to TypeScript (shims deleted) — mirror .ts
  mkdir -p "$CODE_DIR/src"
  cp "$ROOT"/gateway/src/*.ts "$CODE_DIR/src/"
  cp -r "$ROOT"/gateway/src/plugins/. "$CODE_DIR/src/plugins/"
  cp "$ROOT/gateway/public/index.html" "$CODE_DIR/public/index.html"
  cp "$ROOT/gateway/public/app.js" "$CODE_DIR/public/app.js"
  cp "$ROOT/gateway/public/style.css" "$CODE_DIR/public/style.css"
  echo "  synced code viewer mirror ($CODE_DIR)"
fi
# The npm tgz is the single distribution artifact — nothing else is staged
# to the download site (NSIS/setup.ps1 retired).
cp "$ROOT/agent/deploy/vale-agent.ico" "$DEST/vale-agent.ico"
echo "  staged to $DEST/"
echo "  next: ./scripts/build.sh index   (deploy the download site)"
