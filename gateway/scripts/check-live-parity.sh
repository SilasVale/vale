#!/bin/bash
# Live-vs-repo parity probe (round-541): the round-537 stale deploy proved
# test-only rounds never trigger deploys — 19 src commits sat undeployed
# while every local gate stayed green. Run this after ANY gateway/src
# change (or on a schedule) to catch drift between the LIVE worker's
# /code/ viewer and the repo mirror (public/code/files/vale-gate/).
#
# Usage: bash scripts/check-live-parity.sh [base-url]
#   base-url defaults to https://api.saisi.online
# Exit 0 = all 39 files byte-identical; exit 1 = drift listed below.
set -e
cd "$(dirname "$0")/.."
BASE="${1:-https://api.saisi.online}"
MANIFEST=public/code/manifest.json
MIRROR=public/code/files/vale-gate

paths=$(python3 -c "
import json
d = json.load(open('$MANIFEST'))
for f in d['files']:
    if f.get('group') == 'vale-gate':
        print(f['path'].replace('files/vale-gate/', ''))
")
drift=0
count=0
for p in $paths; do
  count=$((count + 1))
  # -L: the viewer 307-redirects bare files to their directory form
  # (public/index.html → public/); the target body is the comparable one.
  if ! curl -sL --max-time 20 "$BASE/code/files/vale-gate/$p" -o /tmp/parity-live.ts; then
    echo "FETCH-FAIL $p"
    drift=$((drift + 1))
    continue
  fi
  if ! diff -q /tmp/parity-live.ts "$MIRROR/$p" >/dev/null 2>&1; then
    echo "DRIFT $p"
    drift=$((drift + 1))
  fi
done
echo "checked $count files, $drift drifted"
[ "$drift" = 0 ]
