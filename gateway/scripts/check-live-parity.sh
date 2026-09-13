#!/bin/bash
# Live-vs-repo parity probe (round-541): the round-537 stale deploy proved
# test-only rounds never trigger deploys — 19 src commits sat undeployed
# while every local gate stayed green. Run this after ANY gateway/src
# change (or on a schedule) to catch drift between the LIVE worker's
# /code/ viewer and the repo mirror (public/code/files/vale-gate/).
#
# Usage: bash scripts/check-live-parity.sh [base-url]
#   base-url defaults to https://api.saisi.online
#
# PROPAGATION RETRY (round-546): a deploy's new assets are not visible at every
# POP the instant `wrangler deploy` returns. The probe used to make ONE pass,
# which build.sh fed 8 s after the deploy — so on 2026-09-13 it compared against
# the PREVIOUS assets, printed 9 "DRIFT" lines, and reported a deploy that had
# SUCCEEDED as a failure. "Drift" is only a verdict once it PERSISTS, so the
# pass is retried (the shape smoke-index.sh has had since round-59) and the
# per-file list is printed only after the LAST attempt. A genuinely stale worker
# still fails — just ~2 min later, not 8 s later.
#   PARITY_ATTEMPTS     default 8   (set 1 for a single fast pass)
#   PARITY_RETRY_SLEEP  default 20  (seconds between passes)
#
# Exit 0 = every mirrored file byte-identical; exit 1 = drift persisted across
# every attempt, with the per-file list below.
set -e
cd "$(dirname "$0")/.."
BASE="${1:-https://api.saisi.online}"
MANIFEST=public/code/manifest.json
MIRROR=public/code/files/vale-gate
ATTEMPTS="${PARITY_ATTEMPTS:-8}"
RETRY_SLEEP="${PARITY_RETRY_SLEEP:-20}"

paths=$(python3 -c "
import json
d = json.load(open('$MANIFEST'))
for f in d['files']:
    if f.get('group') == 'vale-gate':
        print(f['path'].replace('files/vale-gate/', ''))
")
count=$(printf '%s\n' $paths | wc -l)

# ONE pass over the manifest. Fills PASS_DRIFT (count) and PASS_DETAIL (the
# per-file lines) rather than printing them, so a retry does not spam the list.
check_pass() {
  local drift=0 p
  PASS_DETAIL=""
  for p in $paths; do
    # -L: the viewer 307-redirects bare files to their directory form
    # (public/index.html → public/); the target body is the comparable one.
    if ! curl -sL --max-time 20 "$BASE/code/files/vale-gate/$p" -o /tmp/parity-live.ts; then
      PASS_DETAIL+="FETCH-FAIL $p"$'\n'
      drift=$((drift + 1))
      continue
    fi
    if ! diff -q /tmp/parity-live.ts "$MIRROR/$p" >/dev/null 2>&1; then
      PASS_DETAIL+="DRIFT $p"$'\n'
      drift=$((drift + 1))
    fi
  done
  PASS_DRIFT="$drift"
}

PASS_DRIFT=0
PASS_DETAIL=""
for attempt in $(seq 1 "$ATTEMPTS"); do
  check_pass
  if [ "$PASS_DRIFT" = 0 ]; then
    echo "checked $count files, 0 drifted"
    exit 0
  fi
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    echo "  .. attempt $attempt/$ATTEMPTS: $PASS_DRIFT of $count files differ — retrying in ${RETRY_SLEEP}s" >&2
    sleep "$RETRY_SLEEP"
  fi
done
printf '%s' "$PASS_DETAIL"
echo "checked $count files, $PASS_DRIFT drifted — PERSISTED across $ATTEMPTS attempts"
exit 1
