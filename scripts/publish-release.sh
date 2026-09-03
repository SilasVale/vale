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
#   4. LAST-5 PRUNE (round-309 lesson): delete every vale-agent-1.2.*.tgz
#      older than the newest 5, so defective releases are not downloadable
#      (this policy was never enforced on manual publishes and 46 old tgz
#      accumulated on the CDN)
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

echo "== pack =="
(cd "$NPM_DIR" && npm pack >/dev/null)
TGZ="$NPM_DIR/vale-agent-$VER.tgz"
[ -f "$TGZ" ] || { echo "::error::pack did not produce $TGZ" >&2; exit 1; }

echo "== stage =="
cp "$TGZ" "$ASSET_DIR/"
cp "$TGZ" "$ASSET_DIR/vale-agent-latest.tgz"
SHA=$(sha256sum "$TGZ" | cut -d' ' -f1)
printf '{"version":"%s","tarball":"vale-agent-latest.tgz","updated":"%s","sha256":"%s"}\n' \
  "$VER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SHA" > "$ASSET_DIR/version.json"
echo "sha256: $SHA"

echo "== last-5 prune (round-309) =="
# Keep the newest 5 versioned tgz + the latest alias. Exact pattern match —
# dotted versions: 1.2.274 is NOT matched by *-274.tgz (dot vs hyphen).
# Use a NEWLINE-SPLIT array — a space-padded string match fails on the
# inner items (newline-separated, not space-separated).
mapfile -t KEEP < <(ls "$ASSET_DIR"/vale-agent-1.2.*.tgz 2>/dev/null | grep -v latest | sort -V | tail -5)
for f in "$ASSET_DIR"/vale-agent-1.2.*.tgz; do
  keep=0
  for k in "${KEEP[@]}"; do [ "$k" = "$f" ] && keep=1 && break; done
  if [ "$keep" -eq 0 ]; then rm -f "$f"; echo "pruned $(basename "$f")"; fi
done
echo "remaining: $(ls "$ASSET_DIR"/vale-agent-1.2.*.tgz 2>/dev/null | wc -l) versioned + latest"

echo "== commit =="
git add "$PKG" "$ASSET_DIR/version.json"
git commit -q -F - <<EOF
chore(stage-n): release $VER — CDN publish (sha256 + last-5 prune)
EOF

echo "== deploy =="
(cd index && CLOUDFLARE_API_TOKEN="$(cat ~/.cloudflare-token)" npx wrangler deploy)

echo "== done. Next: push main, then create the GitHub tag v$VER via the API"
echo "  (release.yml builds the GitHub asset; keep-latest stays manual)."
