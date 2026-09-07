#!/bin/bash
# Sync the vale-gate sources into public/code/files and generate the manifest.
# Usage: run `bash scripts/sync-code-viewer.sh` after editing code, then `wrangler deploy`.
#
# MIRROR DISCIPLINE: scripts/build.sh deploy_worker (gateway) calls THIS script
# as its single sync path — there is no second implementation to keep in
# step. Both use rm -rf + re-copy: plain cp never deletes, so files removed
# from gateway/src (e.g. plugin-hub.ts, round-341) kept being served by the
# Source Viewer until the rm -rf discipline landed.
set -e
cd "$(dirname "$0")/.."
DEST=public/code/files

rm -rf "$DEST"
mkdir -p "$DEST/vale-gate/src" "$DEST/vale-gate/public"

# vale-gate sources: the TS migration (round-83) moved the real source to
# .ts files (the .js re-export shims are long gone). Copy the live tree
# wholesale (incl. plugins/) so the published snapshot shows the
# implementation. rm -rf above guarantees deleted sources vanish here too.
cp "$PWD"/src/*.ts "$DEST/vale-gate/src/"
# The TS migration removed the re-export .js shims; tolerate their absence.
cp "$PWD"/src/*.js "$DEST/vale-gate/src/" 2>/dev/null || true
mkdir -p "$DEST/vale-gate/src/plugins"
cp "$PWD"/src/plugins/*.ts "$DEST/vale-gate/src/plugins/"
cp "$PWD"/src/plugins/*.js "$DEST/vale-gate/src/plugins/" 2>/dev/null || true
# Subdirectory domains (structure refactors): src/store/ (split from store.ts)
# and src/lib/ (ratelimit factory). The old top-level-only copy silently
# dropped them from the published snapshot — copy each live subdir so the
# mirror stays a byte-identical tree (redactions below still apply per file).
mkdir -p "$DEST/vale-gate/src/store" "$DEST/vale-gate/src/lib"
cp "$PWD"/src/store/*.ts "$DEST/vale-gate/src/store/"
cp "$PWD"/src/lib/*.ts "$DEST/vale-gate/src/lib/"
# Live public/ is a Vite build shell (index.html + hashed assets/ + static
# files). The dead single-file public/app.js was removed round-341 — do NOT
# re-add it here; sync only what live serves.
cp public/index.html public/style.css "$DEST/vale-gate/public/"
cp wrangler.jsonc "$DEST/vale-gate/"

# (openrouter-proxy mirror removed with the worker's 2026-09-07 retirement —
# the sibling-path block never fired inside the monorepo anyway.)

# Generate the manifest from WHAT WAS ACTUALLY COPIED (no hardcoded file
# list — the old static src/*.js spec rotted when the tree moved to .ts and
# the viewer 404d on every entry). vercel-proxy is deprecated and contains
# a hardcoded key — excluded.
python3 - "$DEST" <<'EOF'
import json, os, sys
dest = sys.argv[1]
files = []
vg = os.path.join(dest, "vale-gate")
for root, _dirs, names in os.walk(vg):
    for n in sorted(names):
        full = os.path.join(root, n)
        rel = os.path.relpath(full, vg).replace(os.sep, "/")
        files.append({"name": rel, "path": f"files/vale-gate/{rel}", "group": "vale-gate"})
with open(os.path.join(dest, "..", "manifest.json"), "w") as f:
    json.dump({"files": files}, f, indent=2, ensure_ascii=False)
print(f"generated manifest: {len(files)} files → public/code/")
EOF

# Redact the production download host in the PUBLISHED snapshot (comments
# only — code strings, error copy and defaults keep the real host). The
# mirror is otherwise byte-identical to live; without this step every
# re-sync wipes the redaction. Fail LOUD if a pattern stops matching
# (source line moved) instead of silently publishing the raw host.
redact() { # $1=file $2=live-text ERE $3=sed-expr $4=expected-count
  local n m
  n="$(grep -c -E -e "$2" "$DEST/vale-gate/$1" || true)"
  [ "$n" = "$4" ] || { echo "  !! redaction pattern gone in $1 (want $4, got $n) — update sync-code-viewer.sh" >&2; exit 1; }
  sed -i -e "$3" "$DEST/vale-gate/$1"
  m="$(grep -c -F '<dist-host>' "$DEST/vale-gate/$1" || true)"
  [ "$m" = "$4" ] || { echo "  !! redaction did not apply in $1 (want $4, got $m)" >&2; exit 1; }
}
redact "src/auth.ts" '\*\.agent\.saisi\.online' 's/\*\.agent\.saisi\.online/*.<dist-host>/g' 1
redact "src/store/devices.ts" 'd1\.agent\.saisi\.online' 's/d1\.agent\.saisi\.online/d1.<dist-host>/g' 1
redact "src/plugins/devices.ts" '/api/version on agent\.saisi\.online' 's|/api/version on agent\.saisi\.online|/api/version on https://<dist-host>|g' 1
echo "redacted production host in 3 mirror comments"
