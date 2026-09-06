#!/usr/bin/env bash
# release-lib.sh — testable stages of publish-release.sh, extracted verbatim
# (structure refactor: the last-5-per-minor prune and the version.json writer
# are pure file operations; scripts/test/release-lib.bash pins them so the
# round-309 keep-policy can never silently regress).

# Write the CDN manifest the agent_update tool consumes (round-119: sha256
# REQUIRED). $1 = version, $2 = packed tgz path, $3 = output dir.
# Echoes the sha256 so the caller keeps it for the reconcile stages.
write_version_json() {
  local ver="$1" tgz="$2" out="$3"
  local sha
  sha=$(sha256sum "$tgz" | cut -d' ' -f1)
  printf '{"version":"%s","tarball":"vale-agent-latest.tgz","updated":"%s","sha256":"%s"}\n' \
    "$ver" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sha" > "$out/version.json"
  echo "$sha"
}

# Last-5-per-minor prune (round-309): keep the newest 5 of EACH major.minor
# line + the latest alias; delete every other vale-agent-1.*.*.tgz. A flat
# last-5 across all 1.x would evict the previous minor line the moment the
# new line ships 5 releases and break pinned installs. $1 = asset dir.
prune_last5_per_minor() {
  local dir="$1"
  shopt -s nullglob
  mapfile -t KEEP < <(ls "$dir"/vale-agent-1.*.*.tgz 2>/dev/null | grep -v latest | sort -V | awk '
    { ver = $0; sub(/.*vale-agent-/, "", ver); sub(/\.tgz$/, "", ver); n = split(ver, a, "."); key = a[1] "." a[2]; c[key]++; line[key, c[key]] = $0 }
    END { for (k in c) { from = (c[k] > 5 ? c[k] - 4 : 1); for (i = from; i <= c[k]; i++) print line[k, i] } }
  ')
  local f k keep=0
  for f in "$dir"/vale-agent-1.*.*.tgz; do
    keep=0
    for k in "${KEEP[@]}"; do [ "$k" = "$f" ] && keep=1 && break; done
    if [ "$keep" -eq 0 ]; then rm -f "$f"; echo "pruned $(basename "$f")"; fi
  done
}
