#!/usr/bin/env bash
# release-audit.bash — regression tests for the P0 dual-builder verdict.
#
# WHY THIS FILE EXISTS. `release-audit.sh` decides whether the CDN and the GitHub
# release are the same artifact. It was the only lib in this toolbox with NO TEST,
# and two defects lived in it through TWENTY consecutive releases:
#   * it compared file CONTENT only, so a one-file MODE difference was reported
#     as "packaging metadata" and PASSED (WARN, exit 0);
#   * its two `cd`s were unchecked command substitutions, so a tarball whose top
#     directory is not `package` made BOTH listings empty, compared nothing, and
#     returned 0 — an audit that passes while comparing ZERO files.
#
# These tests drive the REAL `audit_release_asset` end to end: `curl` is stubbed
# as a shell function (functions beat PATH), so the function's own download and
# API steps run against fixtures. Nothing about the comparison is re-implemented
# here, which is the only way a test of it can be trusted.
set -euo pipefail
cd "$(dirname "$0")/../.."
source "scripts/lib/release-audit.sh"

PASS=0
check() { # check <desc> <actual> <expected>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else
    echo "FAIL: $1"; echo "  actual:   $2"; echo "  expected: $3"; exit 1
  fi
}
has() { # has <desc> <haystack> <needle>
  case "$2" in *"$3"*) PASS=$((PASS+1));; *) echo "FAIL: $1"; echo "  looked for: $3"; echo "  in: $2"; exit 1;; esac
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export GITHUB_TOKEN=test-token-not-used   # the token CHECK runs; the calls are stubbed

# --- fixtures ---------------------------------------------------------------
# Build a tgz whose single file carries a chosen MODE, paired against a 644 twin.
mk_tgz() { # mk_tgz <out.tgz> <top> <mode> [content]
  local out="$1" top="$2" mode="$3" content="${4:-hello}"
  local d; d="$(mktemp -d)"
  mkdir -p "$d/$top"
  printf '%s\n' "$content" > "$d/$top/a.txt"
  chmod "$mode" "$d/$top/a.txt"
  printf 'exe\n' > "$d/$top/vale-agent.exe"; chmod 644 "$d/$top/vale-agent.exe"
  tar czf "$out" -C "$d" "$top"
  rm -rf "$d"
}

# --- the harness: drive the REAL function with `curl` stubbed ----------------
# `curl` is a shell FUNCTION here, and functions beat PATH. So the function's own
# API check, its two downloads, its extraction and its comparison all run — only
# the network is replaced. Nothing about the comparison is re-implemented.
run_audit() { # run_audit <gh.tgz> <cdn.tgz> -> rc, prints the audit's output
  # NAMES MUST NOT COLLIDE WITH THE FUNCTION UNDER TEST. Bash locals are
  # DYNAMICALLY scoped, so a local named `cdn` here is shadowed by
  # `audit_release_asset`'s own `local cdn="$2"` — and my first version of this
  # harness copied the literal URL "https://cdn.example" as its fixture.
  local fix_gh="$1" fix_cdn="$2"
  curl() {
    local url="" out=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -o) out="$2"; shift 2;;
        -m|--retry|--retry-delay) shift 2;;
        -*) shift;;
        *) url="$1"; shift;;
      esac
    done
    case "$url" in
      *api.github.com*) printf '{"assets":[{"name":"vale-agent-9.9.9.tgz"}]}\n'; return 0;;
      *releases/download*) cp "$fix_gh" "$out"; return 0;;
      *vale-agent/vale-agent-*) cp "$fix_cdn" "$out"; return 0;;
      *) return 22;;
    esac
  }
  audit_release_asset 9.9.9 "https://cdn.example"
}

# --- 1. a FILE MODE difference must FAIL, not warn --------------------------
# The live defect: identical bytes, one file 600 vs 644 — called "packaging
# metadata" and returned 0 for twenty consecutive releases.
mk_tgz "$WORK/gh.tgz"   package 644
mk_tgz "$WORK/cdn.tgz"  package 600
out="$(run_audit "$WORK/gh.tgz" "$WORK/cdn.tgz" 2>&1)" && rc=0 || rc=$?
if [ "$rc" != 1 ]; then echo "--- audit output ---"; echo "$out"; fi
check "a FILE MODE difference must FAIL" "$rc" "1"
has "the message must name modes" "$out" "FILE MODES"
has "and name the file" "$out" "./a.txt"

# --- 2. matching modes and content pass ------------------------------------
mk_tgz "$WORK/gh.tgz"   package 644
mk_tgz "$WORK/cdn.tgz"  package 644
out="$(run_audit "$WORK/gh.tgz" "$WORK/cdn.tgz" 2>&1)" && rc=0 || rc=$?
check "identical trees (modes included) must PASS" "$rc" "0"

# --- 3. a listing that cannot be taken must NOT compare equal ---------------
# Both `cd`s failed, both listings were empty, they compared equal, ZERO files
# were compared, and the function returned 0.
# The two tarballs must DIFFER, or the function's own sha shortcut returns 0
# before extracting anything — my first version of this test used identical
# fixtures and "proved" the guard was missing when it had simply never been
# reached. (A test whose premise skips the code under test.)
mk_tgz "$WORK/gh.tgz"   notpackaged 644 "one"
mk_tgz "$WORK/cdn.tgz"  notpackaged 644 "two"
out="$(run_audit "$WORK/gh.tgz" "$WORK/cdn.tgz" 2>&1)" && rc=0 || rc=$?
check "a tarball without a top-level package/ must FAIL" "$rc" "1"
has "and say nothing could be compared" "$out" "nothing could be compared"

# The SECOND guard, which that fixture does not reach: a `package/` that exists
# and holds NO REGULAR FILES. Both listings are still empty, so without the guard
# they compare equal and zero files are compared — the same silent pass, one
# directory deeper. (I found this by mutating the guard away and watching this
# file stay green: a test that passes for a reason unrelated to its claim.)
mk_empty_tgz() { # mk_empty_tgz <out.tgz> <top> [content]
  local out="$1" top="$2" content="${3:-}"
  local d; d="$(mktemp -d)"
  mkdir -p "$d/$top"
  # A directory entry, never a file; the content argument only varies the bytes
  # so the two tarballs' shas differ and the comparison is actually reached.
  mkdir -p "$d/$top/sub-$content"
  tar czf "$out" -C "$d" "$top"
  rm -rf "$d"
}
mk_empty_tgz "$WORK/gh.tgz"  package one
mk_empty_tgz "$WORK/cdn.tgz" package two
out="$(run_audit "$WORK/gh.tgz" "$WORK/cdn.tgz" 2>&1)" && rc=0 || rc=$?
check "a package/ with no regular files must FAIL" "$rc" "1"
has "and say the audit compared nothing" "$out" "compared nothing"

# --- 4. content drift still fails ------------------------------------------
mk_tgz "$WORK/gh.tgz"   package 644 "different"
mk_tgz "$WORK/cdn.tgz"  package 644 "hello"
out="$(run_audit "$WORK/gh.tgz" "$WORK/cdn.tgz" 2>&1)" && rc=0 || rc=$?
check "content drift must FAIL" "$rc" "1"

echo "release-audit: all $PASS checks passed"
