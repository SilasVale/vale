#!/usr/bin/env bash
# publish-cdn-from-ci.sh <ver> — make the CDN serve the CI-BUILT artifact.
#
# Why this exists. Today two builders produce the release artifact: this box
# packs it onto the CDN, release.yml packs it onto the GitHub release. Their
# SOURCE-derived files are identical (release-audit.sh enforces that), but the
# exe is not byte-identical and cannot easily be made so — every toolchain
# input is already pinned and verified identical (rustc/clang/lld/llvm-ar/
# cargo-xwin by hash), the embedded panel.js matches, yet ~800 bytes of .data
# layout still differ, which puts the cause in the compile ENVIRONMENT (the
# classic unreproducible-build long tail).
#
# Rather than chase that tail, run this to collapse the two builders into one:
# the CDN stops serving the locally packed tgz and starts serving the artifact
# CI built, so "CDN == GitHub release" holds by construction and the audit has
# nothing left to compare but itself.
#
# Opt-in per release, deliberately. Making the DEFAULT publish flow depend on
# CI would block the delivery channel on a pipeline that still fails on
# environment issues — this keeps the fast local path intact and converges
# afterwards, on demand.
#
# Guards (fail closed):
#   * the GitHub release must exist and carry vale-agent-<ver>.tgz
#   * release-audit.sh must first prove the CI artifact packages the same
#     SOURCE as the CDN's current (locally built) tgz — if any source-derived
#     file drifted, this refuses to touch the CDN
#
# usage: ./scripts/publish-cdn-from-ci.sh <1.2.N> [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."
source "scripts/lib/release-lib.sh"

VER="${1:?usage: ./scripts/publish-cdn-from-ci.sh <1.2.N> [--dry-run]}"
case "$VER" in -*) echo "::error::usage: ./scripts/publish-cdn-from-ci.sh <1.2.N> [--dry-run]" >&2; exit 1;; esac
shift || true
DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    *) echo "::error::unknown flag: $a" >&2; exit 1 ;;
  esac
done

ASSET_DIR=index/public/vale-agent
TGZ_NAME="vale-agent-${VER}.tgz"
CDN_BASE="${SMOKE_BASE_URL:-https://agent.saisi.online}"

cf_token() {
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then echo "$CLOUDFLARE_API_TOKEN";
  elif [[ -f "$HOME/.cloudflare-token" ]]; then cat "$HOME/.cloudflare-token";
  else echo ""; fi
}

echo "== 1. audit: does the CI artifact package the same SOURCE? =="
# shellcheck source=lib/release-audit.sh
source "scripts/lib/release-audit.sh"
audit_release_asset "$VER" "$CDN_BASE" || {
  echo "::error::refusing to converge: the audit did not pass (see above)" >&2
  exit 1
}

echo "== 2. fetch the CI artifact =="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL -m 300 --retry 5 --retry-delay 3 --retry-connrefused \
  "https://github.com/${REPO:-SilasVale/vale}/releases/download/v${VER}/${TGZ_NAME}" \
  -o "$WORK/$TGZ_NAME" || { echo "::error::cannot download the GitHub asset" >&2; exit 1; }
CI_SHA=$(sha256sum "$WORK/$TGZ_NAME" | cut -d' ' -f1)
echo "  CI artifact sha256: $CI_SHA"

CUR_SHA=""
if [ -f "$ASSET_DIR/$TGZ_NAME" ]; then
  CUR_SHA=$(sha256sum "$ASSET_DIR/$TGZ_NAME" | cut -d' ' -f1)
fi
if [ "$CUR_SHA" = "$CI_SHA" ]; then
  echo "-- CDN already serves the CI artifact — nothing to do."
  exit 0
fi

if [ "$DRY" -eq 1 ]; then
  echo "-- dry-run: would replace the CDN tgz with the CI artifact, rebuild the"
  echo "   installer from it, rewrite version.json and redeploy the index worker."
  exit 0
fi

echo "== 3. stage the CI artifact =="
cp "$WORK/$TGZ_NAME" "$ASSET_DIR/$TGZ_NAME"
cp "$WORK/$TGZ_NAME" "$ASSET_DIR/vale-agent-latest.tgz"
echo "  staged $TGZ_NAME + latest alias"

echo "== 4. rebuild the self-contained installer FROM the CI tgz =="
./scripts/build-installer.sh "$VER" --no-deploy

echo "== 5. rewrite the manifest =="
INST_EXE="$ASSET_DIR/ValeAgent-Setup-${VER}.exe"
SHA=$(write_version_json "$VER" "$ASSET_DIR/$TGZ_NAME" "$ASSET_DIR" "$INST_EXE")
[ "$SHA" = "$CI_SHA" ] || { echo "::error::manifest sha $SHA != CI sha $CI_SHA" >&2; exit 1; }
echo "  version.json -> $SHA"

echo "== 6. deploy the index worker =="
TOKEN="$(cf_token)"
[ -n "$TOKEN" ] || { echo "::error::no Cloudflare token (CLOUDFLARE_API_TOKEN or ~/.cloudflare-token)" >&2; exit 1; }
(cd index && CLOUDFLARE_API_TOKEN="$TOKEN" npx wrangler deploy)

echo "== 7. smoke =="
# shellcheck source=smoke-index.sh
source "scripts/smoke-index.sh"
smoke_index_release "$VER" "$SHA" || exit 1

echo "== done: the CDN now serves the CI-built artifact =="
echo "  $CDN_BASE/vale-agent/$TGZ_NAME  ($SHA)"
echo "  next: commit the staged tgz/installer/version.json (git add $ASSET_DIR)"
