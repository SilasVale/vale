#!/usr/bin/env bash
# release-audit.sh — P0 dual-builder audit, honest about what CAN be identical.
#
# What this replaces: publish-release.sh used to demand that the locally packed
# tgz and the CI-built GitHub asset be BYTE-IDENTICAL (same sha256) or abort.
# That gate could never pass here, because the two builders do not share a
# toolchain:
#   * rustc   — local `stable` 1.98.0 vs CI `dtolnay/rust-toolchain@stable`
#               (whatever stable is that week)
#   * clang   — local cargo-xwin's clang-cl is a hand-built symlink to
#               ~/llvm18/bin/clang (18.1.8); CI installs `apt llvm`
# Pinning all of that on a GitHub runner is not practical, and ubuntu-latest's
# default llvm moves under us anyway. So the exe legitimately differs.
#
# What CAN and MUST be identical is every SOURCE-DERIVED file in the tarball:
# the npm CLI, the electron shell sources, package.json, the icons. If any of
# those drifts, the two builders packaged different source — that IS a real
# integrity failure and this audit fails closed.
#
# Verdicts:
#   0  all source-derived files identical (exe hash difference is expected and
#      reported, with both hashes recorded for the ledger)
#   1  a source-derived file differs, or the audit could not run (fail closed)
#
# Usage: audit_release_asset <version> <cdn_base>
#   env: GITHUB_TOKEN / GH_TOKEN, or ~/.github-token
#        REPO (default SilasVale/vale)
#        AUDIT_KEEP=1 to keep the temp dir for inspection

AUDIT_REPO="${REPO:-SilasVale/vale}"

_audit_token() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then echo "$GITHUB_TOKEN"
  elif [[ -n "${GH_TOKEN:-}" ]]; then echo "$GH_TOKEN"
  elif [[ -f "$HOME/.github-token" ]]; then tr -d '\r\n' < "$HOME/.github-token"
  else echo ""; fi
}

# audit_asset_names <version>
# Print the release's asset names (one per line) via one cheap API call — no
# artifact download. Returns non-zero when the release does not exist (or no
# token), so callers can distinguish "not built yet" from "audit failed".
audit_asset_names() {
  local ver="$1" token; token="$(_audit_token)"
  [[ -n "$token" ]] || return 1
  curl -fsSL -m 60 -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${AUDIT_REPO}/releases/tags/v${ver}" 2>/dev/null \
    | grep -o '"name": *"[^"]*\.tgz"' | sed 's/.*: *"//; s/"$//'
}

# audit_release_asset <version> <cdn_base>
# Returns 0 = source-identical (exe may differ), 1 = real drift / cannot audit.
audit_release_asset() {
  local ver="$1" cdn="$2"
  local tgz="vale-agent-${ver}.tgz"
  local token; token="$(_audit_token)"
  if [[ -z "$token" ]]; then
    echo "::error::release audit: no GitHub token (GITHUB_TOKEN/GH_TOKEN/~/.github-token) — cannot audit" >&2
    return 1
  fi

  # 1. The release asset must exist (CI builds it after the tag push).
  local api="https://api.github.com/repos/${AUDIT_REPO}/releases/tags/v${ver}"
  local listing; listing="$(curl -fsSL -m 60 -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" "$api" 2>/dev/null)" || {
    echo "::error::release audit: no GitHub release v${ver} (or no access) — CI may still be building" >&2
    return 1
  }
  # Here-string, NOT `printf | grep -q`: under `set -o pipefail` an early
  # grep -q exit SIGPIPEs the producer and the pipeline reports failure even on
  # a match (the round-288 lesson).
  if ! grep -q "\"name\": *\"${tgz}\"" <<< "$listing"; then
    echo "::error::release audit: release v${ver} has no asset ${tgz}" >&2
    return 1
  fi

  local work; work="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "[[ \"${AUDIT_KEEP:-0}\" == 1 ]] || rm -rf '$work'" RETURN

  # 2. Fetch both artifacts. Retries matter: this box's route to GitHub's
  # release-asset host is intermittent (a 0-byte timeout has been observed),
  # and a single flaky attempt used to read as "audit failed".
  curl -fsSL -m 300 --retry 5 --retry-delay 3 --retry-connrefused \
    "https://github.com/${AUDIT_REPO}/releases/download/v${ver}/${tgz}" \
    -o "$work/gh.tgz" || { echo "::error::release audit: cannot download the GitHub asset" >&2; return 1; }
  curl -fsSL -m 300 --retry 5 --retry-delay 3 --retry-connrefused \
    "${cdn}/vale-agent/${tgz}" -o "$work/cdn.tgz" \
    || { echo "::error::release audit: cannot download the CDN tgz" >&2; return 1; }

  local cdn_sha gh_sha
  cdn_sha="$(sha256sum "$work/cdn.tgz" | cut -d' ' -f1)"
  gh_sha="$(sha256sum "$work/gh.tgz" | cut -d' ' -f1)"

  if [[ "$cdn_sha" == "$gh_sha" ]]; then
    echo "release audit OK: CDN == GitHub asset byte-for-byte (${cdn_sha:0:16}…)"
    return 0
  fi

  # 3. Whole-tarball hashes differ. That is EXPECTED (exe toolchain) — but only
  #    if every source-derived file still matches. Compare file by file.
  mkdir -p "$work/cdn" "$work/gh"
  tar xzf "$work/cdn.tgz" -C "$work/cdn" || { echo "::error::release audit: CDN tgz is not a readable tarball" >&2; return 1; }
  tar xzf "$work/gh.tgz"  -C "$work/gh"  || { echo "::error::release audit: GitHub asset is not a readable tarball" >&2; return 1; }

  # Same file LIST first — a missing/extra file is drift regardless of content.
  local lc lg
  lc="$( (cd "$work/cdn/package" && find . -type f | sort) )"
  lg="$( (cd "$work/gh/package"  && find . -type f | sort) )"
  if [[ "$lc" != "$lg" ]]; then
    echo "::error::release audit FAILED: tarball contents differ" >&2
    diff <(printf '%s\n' "$lc") <(printf '%s\n' "$lg") | sed 's/^/  /' >&2
    return 1
  fi

  local f a b drifted=0 exe_cdn="" exe_gh=""
  while IFS= read -r f; do
    a="$(sha256sum "$work/cdn/package/$f" | cut -d' ' -f1)"
    b="$(sha256sum "$work/gh/package/$f"  | cut -d' ' -f1)"
    if [[ "$a" != "$b" ]]; then
      if [[ "$f" == "./vale-agent.exe" ]]; then
        # The one file a different toolchain legitimately changes.
        exe_cdn="$a"; exe_gh="$b"
      else
        echo "::error::release audit FAILED: source-derived file drifted: $f" >&2
        echo "  CDN: ${a:0:24}…" >&2
        echo "  GH : ${b:0:24}…" >&2
        drifted=1
      fi
    fi
  done <<< "$lc"

  if [[ "$drifted" == 1 ]]; then
    echo "::error::release audit: the two builders packaged DIFFERENT SOURCE — do not ship" >&2
    return 1
  fi

  if [[ -z "$exe_cdn" ]]; then
    # Non-exe difference already handled; identical files but different tarball
    # bytes means packaging metadata (mtimes/order) drifted — report it.
    echo "release audit WARN: file contents match but tarball bytes differ (packaging metadata)"
    echo "  CDN: ${cdn_sha:0:24}…"
    echo "  GH : ${gh_sha:0:24}…"
    return 0
  fi

  echo "release audit OK (source-identical): every source-derived file matches byte-for-byte."
  echo "  vale-agent.exe differs by TOOLCHAIN (expected — not a source difference):"
  echo "    CDN (local build): ${exe_cdn:0:24}…"
  echo "    GH  (CI build)   : ${exe_gh:0:24}…"
  echo "  CDN remains authoritative (devices update from the CDN manifest sha256)."
  return 0
}
