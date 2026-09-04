#!/usr/bin/env bash
# Vale agent release publisher — the ONE command for a CDN release.
#
#   ./scripts/publish-release.sh <1.2.N>
#
# Assumes the exe is already built and staged (cargo xwin build + cp into
# agent/vale-agent-npm/vale-agent.exe) and package.json version == 1.2.N.
#
# Steps:
#   1. npm pack in agent/vale-agent-npm -> vale-agent-1.2.N.tgz
#   2. stage tgz + versionless latest alias into index/public/vale-agent
#   3. write version.json {version, tarball, updated, sha256} (sha256 of the
#      packed tgz — agent_update REQUIRES it, round-119)
#   4. LAST-5-PER-MINOR PRUNE (round-309 lesson): delete every
#      vale-agent-1.*.*.tgz older than the newest 5 OF ITS minor line, so
#      defective releases are not downloadable (this policy was never
#      enforced on manual publishes and 46 old tgz accumulated on the CDN)
#      without evicting the previous minor line (pinned installs keep
#      working while the new line ramps)
#   5. commit the tracked files (package.json bump + version.json)
#   6. wrangler deploy (CDN sync — deletes pruned assets too)
#
# After this: push main, create the GitHub tag v1.2.N via the API, and let
# release.yml build the GitHub release asset (keep-latest manual).

set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:?usage: ./scripts/publish-release.sh <1.2.N>}"
NPM_DIR=agent/vale-agent-npm
ASSET_DIR=index/public/vale-agent
PKG="$NPM_DIR/package.json"

# Guard: package.json version must already be bumped to $VER.
PKG_VER=$(node -p "require('./$PKG').version")
if [ "$PKG_VER" != "$VER" ]; then
  echo "::error::package.json version is $PKG_VER, want $VER — bump it first" >&2
  exit 1
fi

# Guard: the exe must be staged (built from the current source).
if [ ! -f "$NPM_DIR/vale-agent.exe" ]; then
  echo "::error::missing $NPM_DIR/vale-agent.exe — build + stage it first" >&2
  exit 1
fi

# CHEAP artifact gates replicated from release.yml (a bare `npm pack` here
# used to bypass all three CI gates and ship stale files to the CDN).
# No network, no tsc install — pure local checks, fail fast before packing.
# (a) round-298 marker presence in bin/vale.js — the exact grep the CI step
# runs post-compile. A missing marker means src/vale.ts changed without
# recompiling (the 1.2.274 stale-bin lesson).
if ! grep -q "vale-release" "$NPM_DIR/bin/vale.js"; then
  echo "::error::$NPM_DIR/bin/vale.js missing round-298 marker — recompile src/vale.ts first:" >&2
  echo "  (cd $NPM_DIR && npm install --no-save --ignore-scripts --force typescript@5 @types/node@22 && ./node_modules/.bin/tsc -p tsconfig.json && cp dist/vale.js bin/vale.js)" >&2
  exit 1
fi
echo "bin/vale.js marker check OK"
# (c) electron freshness CANNOT be checked here — the tsc emit comparison
# needs typescript + @types/node (a network install CI does in ~15s), and
# an mtime comparison is NOT a substitute (checkout/cp preserve nothing: a
# fresh copy bumps mtime without changing content, while a stale file can
# carry a new mtime). Instead assert the electron src tree is COMMITTED
# clean: CI compiles the committed state, so any local modification (or
# untracked file) means this pack may not match what CI builds.
if [ -n "$(git status --porcelain -- agent/vale-desktop-electron/src/)" ]; then
  echo "::error::agent/vale-desktop-electron/src/ has uncommitted changes — commit (or stash) them first so this pack matches what CI will compile:" >&2
  git status --porcelain -- agent/vale-desktop-electron/src/ >&2
  exit 1
fi
echo "electron src committed-clean OK"
# (d) source-tree copy vs npm-packaged copy: release.yml's freshness gate
# compiles the TS and cmps ONLY the npm copy (vale-agent-npm/.../src/),
# while tsc's input tree (agent/vale-desktop-electron/src/) holds its OWN
# committed main.js that nothing pins — the two drifted silently once
# already (hand-edit reached only the npm copy). cmp all three shipped
# files; pure local, no toolchain needed.
for F in main.js preload.js url-policy.js; do
  if ! cmp -s "agent/vale-desktop-electron/src/${F}" "agent/vale-agent-npm/vale-desktop-electron/src/${F}"; then
    echo "::error::electron src copy drift: agent/vale-desktop-electron/src/${F} != agent/vale-agent-npm/vale-desktop-electron/src/${F} — sync them (tsc emit) and commit both" >&2
    exit 1
  fi
done
echo "electron src copies in sync OK"

echo "== pack =="
(cd "$NPM_DIR" && npm pack >/dev/null)
TGZ="$NPM_DIR/vale-agent-$VER.tgz"
[ -f "$TGZ" ] || { echo "::error::pack did not produce $TGZ" >&2; exit 1; }

# (b) packed-tgz content gate — mirror release.yml's list exactly (a
# missing file silently keeps the stale one on devices, round-278/282
# lesson). Same SIGPIPE-safe pattern as release.yml (round-288 lesson:
# never `tar tzf | grep -q` under pipefail — list to a temp file first,
# then grep with basename-tolerant anchors).
tar tzf "$TGZ" > "/tmp/tgz-list-${VER}.txt"
for F in "vale-agent.exe" \
         "vale-desktop-electron/src/main.js" \
         "vale-desktop-electron/src/preload.js" \
         "vale-desktop-electron/src/url-policy.js" \
         "vale-desktop-electron/icon.png" \
         "vale-desktop-electron/icon.ico" \
         "bin/vale.js"; do
  if ! grep -qE "(^|/)${F}$" "/tmp/tgz-list-${VER}.txt"; then
    echo "::error::tgz missing required file: $F" >&2
    exit 1
  fi
done
echo "tgz content check OK ($TGZ)"

echo "== stage =="
cp "$TGZ" "$ASSET_DIR/"
cp "$TGZ" "$ASSET_DIR/vale-agent-latest.tgz"
SHA=$(sha256sum "$TGZ" | cut -d' ' -f1)
printf '{"version":"%s","tarball":"vale-agent-latest.tgz","updated":"%s","sha256":"%s"}\n' \
  "$VER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SHA" > "$ASSET_DIR/version.json"
echo "sha256: $SHA"

echo "== last-5-per-minor prune (round-309) =="
# Keep the newest 5 of EACH major.minor line + the latest alias. A flat
# last-5 across ALL 1.x evicts the previous minor line the moment the new
# line ships 5 releases (shipping 1.3.0 would drop the 1.2 line and break
# pinned installs). Exact pattern match — dotted versions: 1.2.274 is NOT
# matched by *-274.tgz (dot vs hyphen).
# The 1.*.* glob covers any 1.x minor line; it can never match the latest
# alias (requires a literal "1." after the prefix — "latest" has none), and
# `grep -v latest` stays as belt-and-braces.
# Use a NEWLINE-SPLIT array — a space-padded string match fails on the
# inner items (newline-separated, not space-separated). Input is sort -V
# ascending, so each major.minor group's TAIL is its newest 5 (sort -V
# aware grouping via awk).
mapfile -t KEEP < <(ls "$ASSET_DIR"/vale-agent-1.*.*.tgz 2>/dev/null | grep -v latest | sort -V | awk '
  { ver = $0; sub(/.*vale-agent-/, "", ver); sub(/\.tgz$/, "", ver); n = split(ver, a, "."); key = a[1] "." a[2]; c[key]++; line[key, c[key]] = $0 }
  END { for (k in c) { from = (c[k] > 5 ? c[k] - 4 : 1); for (i = from; i <= c[k]; i++) print line[k, i] } }
')
for f in "$ASSET_DIR"/vale-agent-1.*.*.tgz; do
  keep=0
  for k in "${KEEP[@]}"; do [ "$k" = "$f" ] && keep=1 && break; done
  if [ "$keep" -eq 0 ]; then rm -f "$f"; echo "pruned $(basename "$f")"; fi
done
echo "remaining: $(ls "$ASSET_DIR"/vale-agent-1.*.*.tgz 2>/dev/null | wc -l) versioned + latest"

echo "== commit =="
git add "$PKG" "$ASSET_DIR/version.json"
git commit -q -F - <<EOF
chore(stage-n): release $VER — CDN publish (sha256 + last-5-per-minor prune)
EOF

echo "== deploy =="
(cd index && CLOUDFLARE_API_TOKEN="$(cat ~/.cloudflare-token)" npx wrangler deploy)

echo "== post-publish smoke =="
# Shared with build.sh's index deploy — a bad manifest or mismatched binary
# (versioned OR latest alias) must fail the release, not ship green.
# shellcheck source=smoke-index.sh
source "scripts/smoke-index.sh"
smoke_index_release "$VER" "$SHA" || exit 1

echo "== done. Next: push main, then create the GitHub tag v$VER via the API"
echo "  (release.yml builds the GitHub asset; keep-latest stays manual)."
