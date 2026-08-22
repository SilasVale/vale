#!/usr/bin/env bash
# patch-dsh-trusted-host.sh
#
# DSH (DeepSeek Harness) local patches for serving the web UI via
# https://dsh.saisi.online (reverse-proxied, non-loopback Host).
#
# ── Patch 1 (primary): pin dsh.saisi.online as loopback ──────────────────
#
#   isLoopbackHostname():
#     if (hostname === "localhost" || hostname === "[::1]"
#         || hostname === "dsh.saisi.online") return true;
#
# Every /api request passes isTrustedApiRequest(), which short-circuits on
# isLoopbackHostname(host):
#
#   if (!isLoopbackHostname(hostUrl.hostname)
#       && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
#
# With the domain treated as loopback, ALL trust fences accept it — including
# the privileged-method gates where upstream hardcodes an empty trust list
# ("pins them to loopback"). This single edit therefore fully restores remote
# access regardless of how upstream reshapes the trust lists.
#
# Applied to BOTH copies of the fence:
#   - dsh-client-connection/lib/index.js   (server-side gateway)
#   - dsh-client-connection/lib/client.js  (bundled client copy)
#
# ── Patch 2 (legacy, best-effort): shared-fetch-handler variable fix ─────
#
# Some builds referenced a bare `trustedHosts` inside createSharedFetchHandler()
# where no such lexical binding exists. If that exact buggy pattern is found it
# is rewritten to `this.trustedHosts`. Newer builds ship `[]` there instead;
# Patch 1 already covers those, so a miss here is NOT an error.
#
# Usage:
#   bash patch-dsh-trusted-host.sh [DSH_ROOT]
#   DSH_ROOT defaults to $(npm root -g)/@deepseek-ai/dsh
#
# Re-run after every `npm install -g @deepseek-ai/dsh` (reinstall wipes the
# patches), then restart DSH (pm2 restart dsh).
#
# The script is idempotent; originals are backed up next to each target as
# <file>.bak on first application only.

set -euo pipefail

DOMAIN="dsh.saisi.online"
DSH_ROOT="${1:-$(npm root -g)/@deepseek-ai/dsh}"
LIB="${DSH_ROOT}/node_modules/@deepseek-ai/dsh-client-connection/lib"

ORIG_LINE='if (hostname === "localhost" || hostname === "[::1]") return true;'
PATCHED_LINE="if (hostname === \"localhost\" || hostname === \"[::1]\" || hostname === \"${DOMAIN}\") return true;"

patch_file() {
  local target="$1"
  if [[ ! -f "$target" ]]; then
    echo "SKIP (not found): $target"
    return 0
  fi
  if grep -qF "\"${DOMAIN}\"" "$target"; then
    echo "Already patched: $target"
    return 0
  fi
  if ! grep -qF "$ORIG_LINE" "$target"; then
    echo "WARNING: isLoopbackHostname pattern not found in $target" >&2
    echo "         The DSH version may differ; inspect manually." >&2
    return 0
  fi
  [[ -f "${target}.bak" ]] || cp "$target" "${target}.bak"
  node -e '
    const fs = require("fs");
    const [file, orig, patched] = process.argv.slice(1);
    const src = fs.readFileSync(file, "utf8");
    if (!src.includes(orig)) { console.error("pattern vanished from " + file); process.exit(2); }
    fs.writeFileSync(file, src.split(orig).join(patched));
  ' "$target" "$ORIG_LINE" "$PATCHED_LINE"
  grep -qF "\"${DOMAIN}\"" "$target" \
    && echo "Patched: $target (backup: ${target}.bak)" \
    || { echo "ERROR: patch did not stick in $target" >&2; exit 1; }
}

echo "== Patch 1: loopback pin for ${DOMAIN} =="
patch_file "${LIB}/index.js"
patch_file "${LIB}/client.js"

echo ""
echo "== Patch 2 (legacy): shared-fetch-handler trustedHosts fix =="
TARGET="${LIB}/index.js"
BUGGY_PATTERN='if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, trustedHosts))'
FIXED_PATTERN='if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, this.trustedHosts))'

if [[ ! -f "$TARGET" ]]; then
  echo "SKIP (not found): $TARGET"
elif grep -qF "$FIXED_PATTERN" "$TARGET"; then
  echo "Already patched: $TARGET"
elif grep -qF "$BUGGY_PATTERN" "$TARGET"; then
  [[ -f "${TARGET}.bak" ]] || cp "$TARGET" "${TARGET}.bak"
  sed -i '/authority === "loopback" && !isTrustedApiRequest(request, trustedHosts)/{
    s/isTrustedApiRequest(request, trustedHosts)/isTrustedApiRequest(request, this.trustedHosts)/
  }' "$TARGET"
  echo "Patched: $TARGET"
else
  echo "Not applicable (pattern absent — fine on newer builds; Patch 1 covers us)."
fi

echo ""
echo "Done. Restart DSH to pick up changes: pm2 restart dsh"
