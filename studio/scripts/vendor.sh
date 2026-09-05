#!/usr/bin/env bash
# Vendor the studio browser assets out of node_modules into the gitignored
# vendor/ dir (monaco AMD loader + xterm UMD builds).
#
# Single source for the copy sequence — called by:
#   - scripts/build.sh (studio target, after `npm install --include=dev`)
#   - .github/workflows/ci.yml (studio job, after `npm ci --ignore-scripts`)
#
# Usage: vendor.sh [STUDIO_DIR]   # defaults to the dir above this script
#
# NOTE: this script deliberately does NOT install dependencies — the two
# callers' install flags intentionally differ (see above) and stay local
# to each caller.
set -euo pipefail

STUDIO_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$STUDIO_DIR"

mkdir -p vendor/xterm
rm -rf vendor/monaco
mkdir -p vendor/monaco
cp -r node_modules/monaco-editor/min/vs/. vendor/monaco/vs/
cp node_modules/@xterm/xterm/lib/xterm.js node_modules/@xterm/xterm/css/xterm.css vendor/xterm/
cp node_modules/@xterm/addon-fit/lib/addon-fit.js node_modules/@xterm/addon-web-links/lib/addon-web-links.js vendor/xterm/
