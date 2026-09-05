#!/bin/bash
# Sync the vale-gate sources into public/code/files and generate the manifest.
# Usage: run `bash scripts/sync-code-viewer.sh` after editing code, then `wrangler deploy`.
#
# MIRROR DISCIPLINE (round-345): this script and scripts/build.sh deploy_worker
# sync the SAME tree (gateway/public/code/files/vale-gate). Both use rm -rf +
# re-copy: plain cp never deletes, so files removed from gateway/src (e.g.
# plugin-hub.ts, round-341) kept being served by the Source Viewer. If you
# change the file set here, mirror the change in build.sh (which I cannot —
# see its deploy_worker gateway block), and vice versa.
set -e
cd "$(dirname "$0")/.."
DEST=public/code/files

rm -rf "$DEST"
mkdir -p "$DEST/vale-gate/src" "$DEST/vale-gate/public" "$DEST/openrouter-proxy"

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
# Live public/ is a Vite build shell (index.html + hashed assets/ + static
# files). The dead single-file public/app.js was removed round-341 — do NOT
# re-add it here; sync only what live serves.
cp public/index.html public/style.css "$DEST/vale-gate/public/"
cp wrangler.jsonc "$DEST/vale-gate/"

# openrouter-proxy (sibling project, the or/ OpenRouter proxy). Not part of the
# vale monorepo — copy it when the sibling repo is present, else skip.
if [ -f ../my-openrouter-proxy/src/index.js ]; then
  cp ../my-openrouter-proxy/src/index.js "$DEST/openrouter-proxy/src.js"
  cp ../my-openrouter-proxy/wrangler.jsonc "$DEST/openrouter-proxy/"
  HAS_PROXY=1
else
  echo "  (warning: ../my-openrouter-proxy not found — skipping openrouter-proxy in code viewer)"
  HAS_PROXY=0
fi

# Generate the manifest from WHAT WAS ACTUALLY COPIED (no hardcoded file
# list — the old static src/*.js spec rotted when the tree moved to .ts and
# the viewer 404d on every entry). vercel-proxy is deprecated and contains
# a hardcoded key — excluded.
PROXY_HAS="$HAS_PROXY" python3 - "$DEST" <<'EOF'
import json, os, sys
dest = sys.argv[1]
files = []
vg = os.path.join(dest, "vale-gate")
for root, _dirs, names in os.walk(vg):
    for n in sorted(names):
        full = os.path.join(root, n)
        rel = os.path.relpath(full, vg).replace(os.sep, "/")
        files.append({"name": rel, "path": f"files/vale-gate/{rel}", "group": "vale-gate"})
if os.environ.get("PROXY_HAS") == "1":
    for n in sorted(os.listdir(os.path.join(dest, "openrouter-proxy"))):
        files.append({"name": n, "path": f"files/openrouter-proxy/{n}", "group": "openrouter-proxy"})
with open(os.path.join(dest, "..", "manifest.json"), "w") as f:
    json.dump({"files": files}, f, indent=2, ensure_ascii=False)
print(f"generated manifest: {len(files)} files → public/code/")
EOF
