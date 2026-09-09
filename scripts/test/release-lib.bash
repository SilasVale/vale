#!/usr/bin/env bash
# release-lib.bash — regression tests for the extracted publish-release
# stages (last-5-per-minor prune + version.json writer). Plain bash asserts,
# no framework; exit 0 = all green. Run: bash scripts/test/release-lib.bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source "scripts/lib/release-lib.sh"

PASS=0
check() { # check <desc> <actual> <expected>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else
    echo "FAIL: $1"; echo "  actual:   $2"; echo "  expected: $3"; exit 1
  fi
}
check_match() { # check_match <desc> <string> <regex>
  if [[ "$2" =~ $3 ]]; then PASS=$((PASS+1)); else
    echo "FAIL: $1"; echo "  string: $2"; echo "  wanted to match: $3"; exit 1
  fi
}

# ── last-5-per-minor prune ────────────────────────────────────────────────
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

mk() { for v in "$@"; do echo "payload-$v" > "$T/vale-agent-$v.tgz"; done; }
remaining() { ls "$T"/vale-agent-1.*.*.tgz 2>/dev/null | xargs -r -n1 basename | sort -V | tr '\n' ' '; }

# 1. Seven 1.2.x files + three 1.3.x: keep newest 5 of 1.2 and ALL of 1.3 —
#    the new line must never evict the pinned old line.
mk 1.2.270 1.2.271 1.2.272 1.2.273 1.2.274 1.2.275 1.2.276 1.3.0 1.3.1 1.3.2
echo x > "$T/vale-agent-latest.tgz"
echo keepme > "$T/unrelated.txt"
prune_last5_per_minor "$T" >/dev/null
check "1.2 keeps newest 5, 1.3 keeps all" "$(remaining)" "vale-agent-1.2.272.tgz vale-agent-1.2.273.tgz vale-agent-1.2.274.tgz vale-agent-1.2.275.tgz vale-agent-1.2.276.tgz vale-agent-1.3.0.tgz vale-agent-1.3.1.tgz vale-agent-1.3.2.tgz "
check "1.3 keeps all 3 (under the cap)" \
  "$(ls "$T"/vale-agent-1.3.*.tgz | xargs -r -n1 basename | sort -V | tr '\n' ' ')" \
  "vale-agent-1.3.0.tgz vale-agent-1.3.1.tgz vale-agent-1.3.2.tgz "
check "latest alias untouched" "$(cat "$T/vale-agent-latest.tgz")" "x"
check "unrelated files untouched" "$(cat "$T/unrelated.txt")" "keepme"

# 2. Exact-pattern discipline: dot-versions are NOT matched by the hyphen
#    glob analogue, and non-tgz versioned names stay put. 1.2.9 < 1.2.10
#    must sort by VERSION (sort -V), not lexicographically.
rm -rf "$T" && mkdir -p "$T"
mk 1.2.9 1.2.10 1.2.2
echo keep > "$T/vale-agent-latest.tgz"
echo other > "$T/vale-agent-2.0.0.tgz"
prune_last5_per_minor "$T" >/dev/null
check "sort -V ordering (9 < 10)" "$(remaining)" "vale-agent-1.2.2.tgz vale-agent-1.2.9.tgz vale-agent-1.2.10.tgz "
check "major 2.x outside the 1.*.* policy" "$(cat "$T/vale-agent-2.0.0.tgz")" "other"

# 3. Empty dir: nullglob semantics — no literal-pattern rm, no error.
rm -rf "$T" && mkdir -p "$T"
out=$(prune_last5_per_minor "$T")
check "empty asset dir prunes nothing and stays silent" "$out" ""

# 4. Exactly five in one line: nothing pruned (boundary of the -4 arithmetic).
rm -rf "$T" && mkdir -p "$T"
mk 1.2.1 1.2.2 1.2.3 1.2.4 1.2.5
prune_last5_per_minor "$T" >/dev/null
check "exactly 5 keeps all 5" "$(remaining)" "vale-agent-1.2.1.tgz vale-agent-1.2.2.tgz vale-agent-1.2.3.tgz vale-agent-1.2.4.tgz vale-agent-1.2.5.tgz "

# ── version.json writer ──────────────────────────────────────────────────
echo "payload for sha" > "$T/payload.tgz"
WANT_SHA=$(sha256sum "$T/payload.tgz" | cut -d' ' -f1)
GOT_SHA=$(write_version_json "1.2.297" "$T/payload.tgz" "$T")
check "writer echoes the sha" "$GOT_SHA" "$WANT_SHA"
check_match "manifest is valid JSON with version+tarball" \
  "$(cat "$T/version.json")" \
  '^\{"version":"1\.2\.297","tarball":"vale-agent-latest\.tgz","updated":"[0-9TZ:+-]+","sha256":"[0-9a-f]{64}"\}$'
# The written sha must equal an independent hash of the tgz (agent_update
# REFUSES installs without a correct sha — round-119).
WRITTEN_SHA=$(node -p "JSON.parse(require('fs').readFileSync('$T/version.json','utf8')).sha256")
check "manifest sha256 matches the packed tgz" "$WRITTEN_SHA" "$WANT_SHA"
# No installer staged: the manifest keeps the tgz-only shape (old consumers
# ignore nothing, new consumers treat missing installer fields as absent).
check "tgz-only manifest has no installer fields" \
  "$(node -p "JSON.stringify(Object.keys(JSON.parse(require('fs').readFileSync('$T/version.json','utf8'))).sort())")" \
  '["sha256","tarball","updated","version"]'

# With a staged installer: additive installer + installer_sha256 fields.
echo "fake-exe-payload" > "$T/ValeAgent-Setup-1.2.297.exe"
WANT_ISH=$(sha256sum "$T/ValeAgent-Setup-1.2.297.exe" | cut -d' ' -f1)
GOT_SHA2=$(write_version_json "1.2.297" "$T/payload.tgz" "$T" "$T/ValeAgent-Setup-1.2.297.exe")
check "writer with installer still echoes the tgz sha" "$GOT_SHA2" "$WANT_SHA"
check "manifest installer basename" \
  "$(node -p "JSON.parse(require('fs').readFileSync('$T/version.json','utf8')).installer")" \
  "ValeAgent-Setup-1.2.297.exe"
check "manifest installer_sha256 matches the staged exe" \
  "$(node -p "JSON.parse(require('fs').readFileSync('$T/version.json','utf8')).installer_sha256")" \
  "$WANT_ISH"
# Missing installer path: falls back to the tgz-only shape (never writes a
# dangling installer name).
write_version_json "1.2.297" "$T/payload.tgz" "$T" "$T/ValeAgent-Setup-9.9.9.exe" >/dev/null
check "dangling installer path keeps tgz-only shape" \
  "$(node -p "JSON.stringify(Object.keys(JSON.parse(require('fs').readFileSync('$T/version.json','utf8'))).sort())")" \
  '["sha256","tarball","updated","version"]'

# ── installer prune ────────────────────────────────────────────────────
rm -rf "$T" && mkdir -p "$T"
for v in 1.2.300 1.2.301 1.2.302 1.2.303 1.2.304 1.2.305 1.2.306; do echo "exe-$v" > "$T/ValeAgent-Setup-$v.exe"; done
echo "alias" > "$T/ValeAgent-Setup.exe"
echo keep > "$T/unrelated.txt"
prune_installers "$T" >/dev/null
check "installer prune keeps newest 5 versioned" \
  "$(ls "$T"/ValeAgent-Setup-1.*.*.exe 2>/dev/null | xargs -r -n1 basename | sort -V | tr '\n' ' ')" \
  "ValeAgent-Setup-1.2.302.exe ValeAgent-Setup-1.2.303.exe ValeAgent-Setup-1.2.304.exe ValeAgent-Setup-1.2.305.exe ValeAgent-Setup-1.2.306.exe "
check "installer alias untouched" "$(cat "$T/ValeAgent-Setup.exe")" "alias"
check "installer prune leaves unrelated files" "$(cat "$T/unrelated.txt")" "keep"
rm -rf "$T" && mkdir -p "$T"
out=$(prune_installers "$T")
check "empty asset dir installer-prunes nothing and stays silent" "$out" ""

echo "release-lib: $PASS checks passed"
