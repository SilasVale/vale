#!/usr/bin/env bash
# smoke-helpers.bash — regression tests for the shared smoke snippet's pure
# guards (scripts/smoke-index.sh, sourced, never executed). Plain bash
# asserts, no framework (same convention as release-lib.bash); exit 0 = all
# green. Run: bash scripts/test/smoke-helpers.bash
#
# SOLID Round-61: assert_want_sha256 is the pre-publish twin of the worker's
# /api/version SHA256_RE gate (index/src/index.js, pinned in
# index/test/upload-units.test.mjs) — a truncated placeholder sha must fail
# HERE with a clear message instead of shipping a manifest devices refuse
# (agent_update rejects unverifiable installs, round-119). The two shapes
# must stay identical; this file pins the shell half.
set -euo pipefail
cd "$(dirname "$0")/../.."
source "scripts/smoke-index.sh"

PASS=0
check() { # check <desc> <actual> <expected>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else
    echo "FAIL: $1"; echo "  actual:   $2"; echo "  expected: $3"; exit 1
  fi
}

# ── assert_want_sha256 ──────────────────────────────────────────────────
GOOD64="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
GOOD64_UPPER="$(printf 'ABCDEF0123456789%.0s' 1 2 3 4)" # 16 × 4 = 64, case-insensitive arm

if assert_want_sha256 "$GOOD64" 2>/dev/null; then PASS=$((PASS+1)); else echo "FAIL: lowercase 64-hex accepted"; exit 1; fi
if assert_want_sha256 "$GOOD64_UPPER" 2>/dev/null; then PASS=$((PASS+1)); else echo "FAIL: uppercase 64-hex accepted (case-insensitive)"; exit 1; fi

# Every malformed shape must fail (exit 1) with the clear message on stderr.
for bad in "" "abc" "${GOOD64:0:63}" "${GOOD64}00" \
  "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" \
  "${GOOD64:0:63}"$'\n' "  $GOOD64"; do
  # (the guard echoes to stdout, not stderr)
  if assert_want_sha256 "$bad" >/tmp/smoke-err.txt 2>&1; then echo "FAIL: rejected shape accepted: $(printf %q "$bad")"; exit 1; fi
  grep -q "64-hex sha256" /tmp/smoke-err.txt || { echo "FAIL: no clear message for $(printf %q "$bad")"; exit 1; }
  PASS=$((PASS+1))
done
rm -f /tmp/smoke-err.txt

echo "ok: smoke-helpers $PASS checks passed"
