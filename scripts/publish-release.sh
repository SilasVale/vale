#!/usr/bin/env bash
# Vale agent release publisher — the ONE command for a CDN release.
#
#   ./scripts/publish-release.sh <1.2.N> [--skip-reconcile] [--with-installer]
#
# Assumes the exe is already built and staged (cargo xwin build + cp into
# agent/vale-agent-npm/vale-agent.exe) and package.json version == 1.2.N.
#
# Steps:
#   1. npm pack in agent/vale-agent-npm -> vale-agent-1.2.N.tgz
#   2. stage tgz + versionless latest alias into index/public/vale-agent
#   2b. [--with-installer] build the SELF-CONTAINED installer (NSIS bundles
#      the staged tgz; --no-deploy here — the single deploy in step 6 covers
#      everything, so the manifest and the installer never disagree)
#   3. write version.json {version, tarball, updated, sha256} (sha256 of the
#      packed tgz — agent_update REQUIRES it, round-119) + installer fields
#      when the exe is staged
#   4. LAST-5-PER-MINOR PRUNE (round-309 lesson): delete every
#      vale-agent-1.*.*.tgz older than the newest 5 OF ITS minor line, so
#      defective releases are not downloadable (this policy was never
#      enforced on manual publishes and 46 old tgz accumulated on the CDN)
#      without evicting the previous minor line (pinned installs keep
#      working while the new line ramps)
#   5. commit the tracked files (package.json bump + version.json)
#   6. wrangler deploy (CDN sync — deletes pruned assets too)
#   7. P0 AUDIT: CDN tgz vs GitHub release asset (scripts/lib/release-audit.sh).
#      Every SOURCE-DERIVED file must match byte-for-byte; only vale-agent.exe
#      may differ, because the two builders do not share a toolchain (local
#      rustc stable + hand-built llvm18 vs release.yml's floating stable +
#      distro llvm). Whole-tarball equality was the old rule and could never
#      pass here, which is how the gate became a skip. --skip-reconcile covers
#      only a genuine first publish (no asset built yet) and refuses once one
#      exists.
#
# After this: push main, create the GitHub tag v1.2.N via the API, and let
# release.yml build the GitHub release asset (keep-latest manual).

set -euo pipefail
# P2-4: nullglob so the prune globs below iterate zero times on an empty
# asset dir instead of rm-ing the literal pattern. The 1.*.* pattern only
# needs revisiting at 2.x (major bump = revisit the keep policy anyway).
shopt -s nullglob
cd "$(dirname "$0")/.."
# Testable stages (prune + manifest writer) live in the sourced lib —
# scripts/test/release-lib.bash pins them.
source "scripts/lib/release-lib.sh"

VER="${1:?usage: ./scripts/publish-release.sh <1.2.N> [--skip-reconcile] [--with-installer]}"
case "$VER" in -*) echo "::error::usage: ./scripts/publish-release.sh <1.2.N> [--skip-reconcile] [--with-installer]" >&2; exit 1;; esac
shift
SKIP_RECONCILE=0
WITH_INSTALLER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-reconcile) SKIP_RECONCILE=1 ;;
    --with-installer) WITH_INSTALLER=1 ;;
    *) echo "::error::unknown flag: $1 (usage: ./scripts/publish-release.sh <1.2.N> [--skip-reconcile] [--with-installer])" >&2; exit 1 ;;
  esac
  shift
done
NPM_DIR=agent/vale-agent-npm
ASSET_DIR=index/public/vale-agent
PKG="$NPM_DIR/package.json"

# P2-3 token (same logic as scripts/build.sh cf_token): env first,
# ~/.cloudflare-token fallback — never a bare `cat` (missing file used to
# die with an opaque cat error deep in the deploy step).
cf_token() {
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then echo "$CLOUDFLARE_API_TOKEN";
  elif [[ -f "$HOME/.cloudflare-token" ]]; then cat "$HOME/.cloudflare-token";
  else echo ""; fi
}

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

# P1-1 exe provenance (fail-closed): a stale exe used to sail through this
# script straight onto the CDN. The canonical cross-compile output must
# exist, the staged copy must BE that output (byte-identical — a hand
# cp from elsewhere aborts), and the build must postdate the newest commit
# touching any exe input (rust src + embedded panel + cargo manifests).
# Minimum bar on top: older than 30 days always aborts (WARN past 7 days).
EXE_BUILD="agent/target/x86_64-pc-windows-msvc/release/vale-agent.exe"
if [ ! -f "$EXE_BUILD" ]; then
  echo "::error::missing $EXE_BUILD — cross-compile first: ./scripts/build.sh agent" >&2
  exit 1
fi
if ! cmp -s "$EXE_BUILD" "$NPM_DIR/vale-agent.exe"; then
  echo "::error::staged $NPM_DIR/vale-agent.exe != fresh $EXE_BUILD — re-stage and retry:" >&2
  echo "  cp $EXE_BUILD $NPM_DIR/vale-agent.exe" >&2
  exit 1
fi
SRC_TS=$(git log -1 --format=%ct -- agent/src agent/resources/panel-react agent/resources/panel agent/Cargo.toml agent/Cargo.lock)
SRC_TS=${SRC_TS:-0}
# ...and the working tree of those inputs must be clean: build.sh bakes
# the CURRENT panel SPA into the exe (include_str!), so uncommitted panel
# or rust changes mean the exe matches neither HEAD nor CI.
DIRTY_EXE=$(git status --porcelain -- agent/src agent/resources/panel-react agent/resources/panel agent/Cargo.toml agent/Cargo.lock)
if [ -n "$DIRTY_EXE" ]; then
  echo "::error::exe inputs have uncommitted changes (the exe embeds them, CI never sees them) — commit (or stash), rebuild, re-stage:" >&2
  echo "$DIRTY_EXE" >&2
  exit 1
fi
EXE_TS=$(stat -c %Y "$EXE_BUILD")
NOW_TS=$(date +%s)
if [ "$EXE_TS" -lt "$SRC_TS" ]; then
  echo "::error::$EXE_BUILD predates the newest exe-input commit ($(date -u -d "@$SRC_TS" +%Y-%m-%dT%H:%M:%SZ)) — rebuild, re-stage, retry:" >&2
  echo "  ./scripts/build.sh agent && cp $EXE_BUILD $NPM_DIR/vale-agent.exe" >&2
  exit 1
fi
if [ "$EXE_TS" -lt "$((NOW_TS - 30*24*3600))" ]; then
  echo "::error::$EXE_BUILD is older than 30 days — rebuild regardless of source changes" >&2
  exit 1
fi
if [ "$EXE_TS" -lt "$((NOW_TS - 7*24*3600))" ]; then
  echo "-- WARN: $EXE_BUILD is older than 7 days (still newer than every exe-input commit — proceeding)"
fi
echo "exe provenance OK ($EXE_BUILD newer than all exe inputs)"

# CHEAP artifact gates replicated from release.yml (a bare `npm pack` here
# used to bypass all three CI gates and ship stale files to the CDN).
# Fail fast before packing. tsc comes from the repo's own
# vale-agent-npm/node_modules (P1-2 pins typescript@5, same as CI) — no
# network install here; a missing tsc fails with the install command.
# (a) round-298 marker presence in bin/vale.js — the exact grep the CI step
# runs post-compile. A missing marker means src/vale.ts changed without
# recompiling (the 1.2.274 stale-bin lesson).
if ! grep -q "vale-release" "$NPM_DIR/bin/vale.js"; then
  echo "::error::$NPM_DIR/bin/vale.js missing round-298 marker — recompile src/vale.ts first:" >&2
  echo "  (cd $NPM_DIR && npm install --no-save --ignore-scripts --force typescript@5 @types/node@22 && ./node_modules/.bin/tsc -p tsconfig.json && cp dist/vale.js bin/vale.js)" >&2
  exit 1
fi
echo "bin/vale.js marker check OK"
# P1-2 bin/vale.js freshness (same gate as release.yml:140-143 + the CI
# pack-chain step): recompile src/vale.ts with the repo tsconfig into a
# tmp dir and cmp against the committed bin/vale.js. The marker grep above
# only proves SOME build happened — this proves it was built from the
# CURRENT source. No tsc here FAILS with the install command (never skip:
# an uncheckable bin is an unshippable bin).
TSC="$NPM_DIR/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "::error::no tsc in $NPM_DIR (bin/vale.js freshness uncheckable) — install and retry:" >&2
  echo "  (cd $NPM_DIR && npm install --no-save --ignore-scripts --force typescript@5 @types/node@22)" >&2
  exit 1
fi
if ! "$TSC" --version | grep -q "Version 5\."; then
  echo "::error::$TSC is not typescript@5 (CI compiles with v5 — a foreign major emits different bytes and false-fails the cmp) — reinstall:" >&2
  echo "  (cd $NPM_DIR && npm install --no-save --ignore-scripts --force typescript@5 @types/node@22)" >&2
  exit 1
fi
"$TSC" -p "$NPM_DIR/tsconfig.json" --outDir /tmp/vale-fresh-bin
if ! cmp -s /tmp/vale-fresh-bin/vale.js "$NPM_DIR/bin/vale.js"; then
  echo "::error::$NPM_DIR/bin/vale.js is stale (src/vale.ts changed without recompiling) — recompile, commit, retry:" >&2
  echo "  (cd $NPM_DIR && ./node_modules/.bin/tsc -p tsconfig.json && cp dist/vale.js bin/vale.js)" >&2
  rm -rf /tmp/vale-fresh-bin
  exit 1
fi
rm -rf /tmp/vale-fresh-bin
echo "bin/vale.js freshness check OK (tsc recompile + cmp)"
# (c) electron freshness: COMMITTED-clean (as before — CI compiles the
# committed state, so any local modification means this pack may not match
# what CI builds) PLUS the fresh-emit compare, same gate as
# release.yml:155-162. The old comment here claimed the emit comparison
# needed a network install CI does in ~15s — P1-2 above already guarantees
# a pinned tsc, so run the real gate instead of waving through.
if [ -n "$(git status --porcelain -- agent/vale-desktop-electron/src/)" ]; then
  echo "::error::agent/vale-desktop-electron/src/ has uncommitted changes — commit (or stash) them first so this pack matches what CI will compile:" >&2
  git status --porcelain -- agent/vale-desktop-electron/src/ >&2
  exit 1
fi
echo "electron src committed-clean OK"
(cd "$NPM_DIR" && ./node_modules/.bin/tsc -p ../vale-desktop-electron/tsconfig.json \
  --typeRoots ./node_modules/@types --outDir /tmp/electron-fresh-pub --noCheck)
for F in main.js preload.js url-policy.js; do
  if ! cmp -s "/tmp/electron-fresh-pub/${F}" "$NPM_DIR/vale-desktop-electron/src/${F}"; then
    echo "::error::$NPM_DIR/vale-desktop-electron/src/${F} is stale (ts source changed without recompiling) — run tsc and commit the fresh output" >&2
    rm -rf /tmp/electron-fresh-pub
    exit 1
  fi
done
rm -rf /tmp/electron-fresh-pub
echo "electron src freshness check OK (fresh tsc emit + cmp)"
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

# P1-6 pack-input committed-clean: everything npm packs EXCEPT the
# gitignored exe/tgz/dist (invisible to git status) and the in-progress
# package.json bump (committed in step 5 below) must already be committed
# — CI packs the committed tree, so any local delta here means this tgz
# may not match what CI builds.
DIRTY_INPUTS=$(git status --porcelain -- "$NPM_DIR/bin" "$NPM_DIR/src" "$NPM_DIR/test" "$NPM_DIR/README.md" "$NPM_DIR/vale-desktop-electron" "agent/vale-desktop-electron")
if [ -n "$DIRTY_INPUTS" ]; then
  echo "::error::pack inputs have uncommitted changes — commit (or stash) them first so this pack matches CI:" >&2
  echo "$DIRTY_INPUTS" >&2
  exit 1
fi
echo "pack inputs committed-clean OK"

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
# Installer 同版同发：--with-installer 在这里打自包含安装器（--no-deploy，
# 单次 deploy 在下面统一做，manifest 和安装器不可能互相滞后）。tgz 已在
# 上面 stage 好，正好满足 build-installer.sh 的前置。
if [ "$WITH_INSTALLER" -eq 1 ]; then
  echo "== installer (self-contained, staged, no deploy yet) =="
  ./scripts/build-installer.sh "$VER" --no-deploy
fi
# 自包含证明：staged 安装器必须比 tgz 大（内嵌 payload）。更小的只有一种
# 可能——上一个版本的在线包残留（没打进去 tgz）。WARN 不 fail：紧急发布
# 允许先上 tgz-only manifest，补打安装器后重跑 manifest+deploy 即可。
INST_EXE="$ASSET_DIR/ValeAgent-Setup-$VER.exe"
if [ -f "$INST_EXE" ]; then
  echo "installer staged: $(basename "$INST_EXE") ($(stat -c %s "$INST_EXE") bytes)"
  if [ "$(stat -c %s "$INST_EXE")" -le "$(stat -c %s "$TGZ")" ]; then
    echo "-- WARN: $INST_EXE not larger than the tgz — stale online-only build? Rebuild with ./scripts/build-installer.sh $VER (manifest will advertise a non-self-contained exe)"
  fi
else
  echo "-- WARN: no $INST_EXE — run ./scripts/build-installer.sh $VER first so fresh installs track this release (manifest will be tgz-only)"
fi
SHA=$(write_version_json "$VER" "$TGZ" "$ASSET_DIR" "$INST_EXE")
echo "sha256: $SHA"

echo "== last-5-per-minor prune (round-309) =="
# Keep the newest 5 of EACH major.minor line + the latest alias (the policy
# and its awk grouping live in scripts/lib/release-lib.sh, pinned by
# scripts/test/release-lib.bash).
prune_last5_per_minor "$ASSET_DIR"
prune_installers "$ASSET_DIR"
echo "remaining: $(ls "$ASSET_DIR"/vale-agent-1.*.*.tgz 2>/dev/null | wc -l) versioned tgz + latest + $(ls "$ASSET_DIR"/ValeAgent-Setup-1.*.*.exe 2>/dev/null | wc -l) versioned installers + alias"

echo "== commit =="
git add "$PKG" "$ASSET_DIR/version.json"
git commit -q -F - <<EOF
chore(stage-n): release $VER — CDN publish (sha256 + last-5-per-minor prune)
EOF

echo "== deploy =="
CF_TOKEN="$(cf_token)"
if [ -z "$CF_TOKEN" ]; then
  echo "::error::no Cloudflare token — set CLOUDFLARE_API_TOKEN or write ~/.cloudflare-token (same rule as scripts/build.sh)" >&2
  exit 1
fi
(cd index && CLOUDFLARE_API_TOKEN="$CF_TOKEN" npx wrangler deploy)

echo "== post-publish smoke =="
# Shared with build.sh's index deploy — a bad manifest or mismatched binary
# (versioned OR latest alias) must fail the release, not ship green.
# shellcheck source=smoke-index.sh
source "scripts/smoke-index.sh"
assert_want_sha256 "$SHA" || exit 1
smoke_index_release "$VER" "$SHA" || exit 1

echo "== release audit: CDN vs GitHub release asset (P0 dual-builder) =="
# The audit lives in scripts/lib/release-audit.sh. It demands that every
# SOURCE-DERIVED file in the two tarballs be byte-identical and tolerates ONLY
# a differing vale-agent.exe, because the two builders do not share a
# toolchain: this box builds with rustc `stable` (1.98.0 here) + a hand-built
# llvm18 that cargo-xwin is symlinked to, while release.yml uses
# dtolnay/rust-toolchain@stable (floating) + the distro's llvm. Demanding whole
# -tarball equality — what this block used to do — could therefore NEVER pass,
# which silently turned the gate into a skip. Comparing source-derived files is
# what actually catches a builder that packaged different source.
# See the header of release-audit.sh for the full evidence.
#
# The GitHub asset only exists AFTER the tag push below, so a genuine first
# publish has nothing to audit — that is the only case --skip-reconcile covers,
# and it refuses as soon as an asset exists.
CDN_BASE="${SMOKE_BASE_URL:-https://agent.saisi.online}"
# shellcheck source=lib/release-audit.sh
source "scripts/lib/release-audit.sh"
if [ "$SKIP_RECONCILE" -eq 1 ]; then
  # List to a file FIRST, then grep — never `producer | grep -q` under
  # pipefail (round-288: grep -q exits early, SIGPIPEs the producer, and the
  # pipeline reports failure even on a match).
  SKIP_LIST="/tmp/audit-assets-skip-${VER}.txt"
  audit_asset_names "$VER" >"$SKIP_LIST" 2>/dev/null || true
  if grep -qx "vale-agent-${VER}.tgz" "$SKIP_LIST"; then
    echo "::error::--skip-reconcile refused: GitHub release v$VER already ships vale-agent-$VER.tgz — rerun WITHOUT the flag so the audit executes" >&2
    exit 1
  fi
  echo "-- WARN: --skip-reconcile given and no auditable GitHub asset v$VER exists yet (first publish) — audit SKIPPED, verify post-tag via the checklist below"
else
  audit_release_asset "$VER" "$CDN_BASE" || {
    echo "  the asset is built by release.yml AFTER the tag push below." >&2
    echo "  first publish? rerun with --skip-reconcile, then audit post-tag." >&2
    exit 1
  }
  # The CDN must still serve the exact bytes this run packed (catches a
  # mid-publish drift / a stale deploy), independent of the exe question.
  CDN_SHA=$(curl -fsSL -m 120 "$CDN_BASE/vale-agent/vale-agent-$VER.tgz" | sha256sum | cut -d' ' -f1)
  if [ "$CDN_SHA" != "$SHA" ]; then
    echo "::error::audit FAILED: CDN sha $CDN_SHA != just-packed local sha $SHA — the CDN drifted mid-publish" >&2
    exit 1
  fi
  echo "audit OK: CDN serves this run's pack, and its source-derived files match the GitHub asset"
fi

echo "== done. Next: push main, then create the GitHub tag v$VER via the API"
echo "  (release.yml builds the GitHub asset; keep-latest stays manual)."
echo ""
echo "== post-publish checklist (copy-paste) =="
echo "  [1] push the release commit:   git push origin main"
echo "  [2] cut the tag (triggers release.yml):   git tag v$VER && git push origin v$VER"
echo "  [3] watch the asset build:   gh run watch --workflow release.yml"
echo "  [4] reconcile (CDN vs asset):   gh release list --limit 5   # v$VER must be present, then:"
echo "        curl -fsSL $CDN_BASE/vale-agent/vale-agent-$VER.tgz | sha256sum   # want: $SHA"
echo "        gh release download v$VER -p 'vale-agent-$VER.tgz' -D /tmp/reconcile-$VER --clobber && sha256sum /tmp/reconcile-$VER/vale-agent-$VER.tgz   # want: $SHA"
echo "  [5] keep-latest alias:   curl -fsSL $CDN_BASE/vale-agent/vale-agent-latest.tgz | sha256sum   # want: $SHA"
echo "  [6] live manifest:   curl -s $CDN_BASE/api/version   # want version $VER + sha $SHA"
echo "  [7] installer alias:   curl -fsSL $CDN_BASE/vale-agent/ValeAgent-Setup.exe -o /tmp/Setup-check.exe && curl -s $CDN_BASE/api/version | grep -o '\"installer_sha256\":\"[0-9a-f]*\"'   # alias sha must equal the advertised installer_sha256"
