#!/usr/bin/env bash
# Vale agent release publisher — the ONE command for a CDN release.
#
#   ./scripts/publish-release.sh <1.2.N> [--skip-reconcile]
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
#   7. P0 RECONCILE: CDN versioned tgz sha256 == GitHub release asset
#      sha256 (fail-closed; --skip-reconcile only for first publishes
#      whose asset release.yml has not built yet)
#
# After this: push main, create the GitHub tag v1.2.N via the API, and let
# release.yml build the GitHub release asset (keep-latest manual).

set -euo pipefail
# P2-4: nullglob so the prune globs below iterate zero times on an empty
# asset dir instead of rm-ing the literal pattern. The 1.*.* pattern only
# needs revisiting at 2.x (major bump = revisit the keep policy anyway).
shopt -s nullglob
cd "$(dirname "$0")/.."

VER="${1:?usage: ./scripts/publish-release.sh <1.2.N> [--skip-reconcile]}"
case "$VER" in -*) echo "::error::usage: ./scripts/publish-release.sh <1.2.N> [--skip-reconcile]" >&2; exit 1;; esac
shift
SKIP_RECONCILE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-reconcile) SKIP_RECONCILE=1 ;;
    *) echo "::error::unknown flag: $1 (usage: ./scripts/publish-release.sh <1.2.N> [--skip-reconcile])" >&2; exit 1 ;;
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

echo "== reconcile CDN vs GitHub release asset (P0 dual-build audit) =="
# Fail-CLOSED: two builders (this script's npm pack onto the CDN,
# release.yml's xwin build onto the release) must ship byte-identical
# bytes — same sha256, or abort. A missing asset ABORTS (never a WARN:
# a skipped audit that stays skipped is how drift ships). Legitimate
# skip case: a FIRST publish has no asset yet — release.yml builds it
# only after the tag push below — so rerun with --skip-reconcile now and
# verify post-tag via the checklist. No network / no gh → same abort.
CDN_BASE="${SMOKE_BASE_URL:-https://agent.saisi.online}"
if [ "$SKIP_RECONCILE" -eq 1 ]; then
  echo "-- WARN: --skip-reconcile given, CDN/asset audit SKIPPED — verify post-tag via the checklist below"
else
  command -v gh >/dev/null 2>&1 || { echo "::error::gh CLI not found — install it (gh auth login), or --skip-reconcile for a first publish (then verify post-tag)" >&2; exit 1; }
  ASSET_LIST="/tmp/reconcile-assets-${VER}.txt"
  if ! gh release view "v$VER" --json assets --jq '.assets[].name' >"$ASSET_LIST" 2>/dev/null; then
    echo "::error::no GitHub release v$VER (or no access) — the asset is built by release.yml AFTER the tag push below" >&2
    echo "  first publish? rerun with --skip-reconcile now, verify post-tag via the checklist." >&2
    exit 1
  fi
  # (list-to-file first, then grep — never `gh ... | grep -q` under
  # pipefail: SIGPIPE false-fails even on a match, round-288 lesson.)
  if ! grep -qx "vale-agent-${VER}.tgz" "$ASSET_LIST"; then
    echo "::error::GitHub release v$VER has no vale-agent-$VER.tgz asset yet — release.yml may still be building" >&2
    echo "  wait for it green, then rerun this script's audit (or verify via the checklist)." >&2
    exit 1
  fi
  rm -rf "/tmp/reconcile-$VER" && mkdir -p "/tmp/reconcile-$VER"
  gh release download "v$VER" --pattern "vale-agent-$VER.tgz" --dir "/tmp/reconcile-$VER" --clobber \
    || { echo "::error::gh release download v$VER failed (network/auth) — aborting, never green by default" >&2; exit 1; }
  CDN_SHA=$(curl -fsSL -m 120 "$CDN_BASE/vale-agent/vale-agent-$VER.tgz" | sha256sum | cut -d' ' -f1)
  GH_SHA=$(sha256sum "/tmp/reconcile-$VER/vale-agent-$VER.tgz" | cut -d' ' -f1)
  if [ "$CDN_SHA" != "$GH_SHA" ]; then
    echo "::error::reconcile FAILED: CDN sha $CDN_SHA != GitHub asset sha $GH_SHA — two builders disagree, do NOT tag" >&2
    exit 1
  fi
  if [ "$CDN_SHA" != "$SHA" ]; then
    echo "::error::reconcile FAILED: CDN sha $CDN_SHA != just-packed local sha $SHA — the CDN drifted mid-publish" >&2
    exit 1
  fi
  echo "reconcile OK (CDN == GitHub asset == local pack: $SHA)"
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
