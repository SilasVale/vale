#!/usr/bin/env bash
# Bundle the api/ edge handlers + server/entry.mjs into relay-bundle.tar.gz
# for the VPS (see proxies/README.md "vrelay"). The former Vercel deploy target
# is gone WITH the deleted project (2026-09-08): shipping there again would
# mean recreating the project by hand.
#
# Transpile: the repo's existing tsc (gateway devDep) — same API surface the
# Vercel build uses; no extra toolchain download on CN-restricted boxes.
set -euo pipefail
cd "$(dirname "$0")"
TSC="${TSC:-../../gateway/node_modules/.bin/tsc}"
[ -x "$TSC" ] || { echo "tsc not found at $TSC (run npm ci in gateway/)"; exit 1; }
rm -rf dist && mkdir -p dist
"$TSC" --target es2022 --module esnext --moduleResolution bundler --skipLibCheck \
  --lib es2022,dom --outDir dist --rootDir api api/git.ts api/github.ts api/gform.ts
mv dist/git.js dist/git.mjs && mv dist/github.js dist/github.mjs && mv dist/gform.js dist/gform.mjs
cp api/zen.js dist/zen.mjs
cp api/proxy.js dist/proxy.mjs
cp server/entry.mjs dist/entry.mjs
tar -czf relay-bundle.tar.gz -C dist .
echo "built $(pwd)/relay-bundle.tar.gz ($(wc -c < relay-bundle.tar.gz) bytes)"
