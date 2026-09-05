# Vale Index post-publish smoke — SHARED snippet (sourced, never executed).
#
#   source "scripts/smoke-index.sh"   # (repo root; or "$ROOT/scripts/...")
#   smoke_index_release "$want_version" "$want_sha" || exit 1
#
# Shared by scripts/build.sh (index deploy) and scripts/publish-release.sh
# so the two publish paths cannot drift apart again (round-324 lesson: the
# build.sh smoke rotted when index.js stopped carrying static constants).
#
# Checks, mirroring the build.sh round-132/133 style:
#   1. live /api/version reports want_version + want_sha
#   2. the manifest's download URL serves a binary whose sha256 == want_sha
#   3. the versionless latest alias (the landing page's install command)
#      serves a binary whose sha256 == want_sha
#
# Env overrides (local verification only):
#   SMOKE_BASE_URL    base URL under test (default https://agent.saisi.online)
#   SMOKE_RETRY_SLEEP seconds between retries (default 3)
#
# Returns 0 on success, 1 on failure — never exits, so it is safe under
# `set -e` in the caller (the caller decides the exit policy).
#
# Shared sha256-format guard (P2-5/P2-6): the worker's /api/version asserts
# /^[0-9a-f]{64}$/i on the manifest sha (index/src/index.js SHA256_RE) and
# 503s otherwise. Both publish paths (build.sh index deploy,
# publish-release.sh) must call this FIRST on their expected sha, so a
# truncated/all-zero/placeholder digest fails here with a clear message
# instead of mid-smoke — or worse, shipping a manifest devices refuse
# (agent_update rejects unverifiable installs, round-119). Returns 0/1,
# never exits (same `set -e` contract as smoke_index_release).
assert_want_sha256() {
  local sha="$1"
  if [[ "${sha:-}" =~ ^[0-9a-fA-F]{64}$ ]]; then return 0; fi
  echo "  !! want_sha is not a 64-hex sha256: '${sha:-<empty>}'"
  return 1
}

smoke_index_release() {
  local want_version="$1" want_sha="$2"
  assert_want_sha256 "$want_sha" || return 1
  local base="${SMOKE_BASE_URL:-https://agent.saisi.online}"
  local retry_sleep="${SMOKE_RETRY_SLEEP:-3}"
  local live=""
  # Edge propagation lags a few seconds after wrangler returns — a single
  # curl could hit a stale POP and false-fail. Retry briefly (round-59).
  for _ in 1 2 3 4 5; do
    live="$(curl -s -m 30 "$base/api/version")"
    echo "$live" | grep -q "\"version\":\"$want_version\"" && break
    sleep "$retry_sleep"
  done
  if ! echo "$live" | grep -q "\"version\":\"$want_version\""; then
    echo "  !! live version mismatch: want $want_version, got: $live"
    return 1
  fi
  if ! echo "$live" | grep -q "\"sha256\":\"$want_sha\""; then
    echo "  !! live sha256 mismatch: want $want_sha, got: $live"
    return 1
  fi
  # round-132/133: the manifest check alone never touches the served BINARY —
  # hash the live download against the manifest. The download URL comes from
  # the manifest itself.
  local dl_url live_sha
  dl_url="$(echo "$live" | grep -oP '"download":"\K[^"]+' | head -1)"
  [ -n "$dl_url" ] || { echo "  !! manifest has no download URL"; return 1; }
  live_sha=""
  for _ in 1 2 3 4 5; do
    # round-134: curl -f fails fast on 4xx/5xx (a 404 body would otherwise
    # be hashed and burn all retries); `|| live_sha=""` keeps a TRANSPORT
    # failure inside the retry loop instead of aborting under set -e. -L
    # follows redirects (mirrors may redirect); without it the hash could
    # come out as the empty string's.
    live_sha="$(curl -fsSL -m 120 "$dl_url" 2>/dev/null | sha256sum | cut -d' ' -f1)" || live_sha=""
    [ "$live_sha" = "$want_sha" ] && break
    sleep "$retry_sleep"
  done
  if [ "$live_sha" != "$want_sha" ]; then
    echo "  !! live binary sha256 mismatch: manifest $want_sha, downloaded $live_sha ($dl_url)"
    return 1
  fi
  # The landing page installs the versionless latest alias — it must hash
  # to the same manifest sha, else every copy-paste install breaks while
  # the versioned check above stays green.
  local latest_sha=""
  for _ in 1 2 3 4 5; do
    latest_sha="$(curl -fsSL -m 120 "$base/vale-agent/vale-agent-latest.tgz" 2>/dev/null | sha256sum | cut -d' ' -f1)" || latest_sha=""
    [ "$latest_sha" = "$want_sha" ] && break
    sleep "$retry_sleep"
  done
  if [ "$latest_sha" != "$want_sha" ]; then
    echo "  !! latest-alias sha256 mismatch: manifest $want_sha, downloaded $latest_sha ($base/vale-agent/vale-agent-latest.tgz)"
    return 1
  fi
  echo "  ok: /api/version smoke passed (v$want_version, versioned + latest binary sha verified)"
  return 0
}
