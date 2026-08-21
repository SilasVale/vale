#!/usr/bin/env bash
# patch-dsh-trusted-host.sh
#
# Fixes a bug in DSH (DeepSeek Harness) where --trusted-host is parsed from
# the CLI and flows through the config chain (web-startup → web-runtime →
# client-connection), but the value is never actually used in the
# privileged-method gate inside createSharedFetchHandler.
#
# Bug location: dsh-client-connection/lib/index.js, line 237
#   createSharedFetchHandler() creates a closure that references the bare
#   variable `trustedHosts` — which doesn't exist in its lexical scope.
#   The `register()` method (line 243) correctly uses `this.trustedHosts`,
#   but `createSharedFetchHandler()` does not.
#
# Fix: replace the bare `trustedHosts` reference with `this.trustedHosts`
# so the trusted-host fence actually receives the CLI-provided authorities.
#
# Usage:
#   bash patch-dsh-trusted-host.sh [DSH_ROOT]
#
#   DSH_ROOT defaults to the global npm install location:
#     $(npm root -g)/@deepseek-ai/dsh
#
# The script is idempotent — it applies the patch only once and backs up
# the original file.

set -euo pipefail

DSH_ROOT="${1:-$(npm root -g)/@deepseek-ai/dsh}"
TARGET="${DSH_ROOT}/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js"

if [[ ! -f "$TARGET" ]]; then
  echo "ERROR: target file not found: $TARGET" >&2
  echo "       Pass the DSH root as the first argument." >&2
  exit 1
fi

# Check whether the bug is present: the bare `trustedHosts` reference inside
# createSharedFetchHandler (line ~237). We look for the exact buggy pattern.
BUGGY_PATTERN='if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, trustedHosts))'
FIXED_PATTERN='if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, this.trustedHosts))'

if grep -qF "$FIXED_PATTERN" "$TARGET"; then
  echo "Already patched: $TARGET"
  exit 0
fi

if ! grep -qF "$BUGGY_PATTERN" "$TARGET"; then
  echo "WARNING: expected buggy pattern not found in $TARGET" >&2
  echo "         The file may have been modified or the DSH version may differ." >&2
  exit 1
fi

# Backup
cp "$TARGET" "$TARGET.bak"
echo "Backup created: $TARGET.bak"

# Apply the fix using sed (in-place).
# We must ONLY patch the occurrence inside createSharedFetchHandler (line ~237),
# NOT the two correct occurrences in apply() (lines ~538, ~554) where the
# closure variable `trustedHosts` is properly captured. The distinguishing
# context is the `authority === "loopback"` check that wraps the buggy line.
sed -i '/authority === "loopback" && !isTrustedApiRequest(request, trustedHosts)/{
  s/isTrustedApiRequest(request, trustedHosts)/isTrustedApiRequest(request, this.trustedHosts)/
}' "$TARGET"

echo "Patched: $TARGET"
echo ""
echo "Summary of the fix:"
echo "  createSharedFetchHandler() referenced a bare variable \`trustedHosts\`"
echo "  that does not exist in its lexical scope (it's an instance property)."
echo "  Changed to \`this.trustedHosts\` so the --trusted-host CLI values"
echo "  actually reach the browser-trust fence."
