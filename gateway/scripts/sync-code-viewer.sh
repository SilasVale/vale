#!/bin/bash
# Sync the vale-gate + openrouter-proxy sources into public/code/files and generate the manifest.
# Usage: run `bash scripts/sync-code-viewer.sh` after editing code, then `wrangler deploy`.
set -e
cd "$(dirname "$0")/.."
DEST=public/code/files

rm -rf "$DEST"
mkdir -p "$DEST/vale-gate/src" "$DEST/vale-gate/public" "$DEST/openrouter-proxy"

# vale-gate sources — the TS migration (round-83) moved the real source to
# .ts files; the .js files are re-export shims. Copy EVERYTHING (incl.
# plugins/) so the published snapshot shows the implementation, not shims.
cp "$PWD"/src/*.ts "$PWD"/src/*.js "$DEST/vale-gate/src/"
mkdir -p "$DEST/vale-gate/src/plugins"
cp "$PWD"/src/plugins/*.ts "$PWD"/src/plugins/*.js "$DEST/vale-gate/src/plugins/" 2>/dev/null || true
cp public/index.html public/app.js public/style.css "$DEST/vale-gate/public/"
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

# Generate the manifest (vercel-proxy is deprecated and contains a hardcoded key — excluded)
PROXY_HAS="$HAS_PROXY" python3 - "$DEST" <<'EOF'
import json, sys, os
dest = sys.argv[1]
specs = [
    ("vale-gate", ["src/index.js", "src/store.js", "src/auth.js",
                    "public/index.html", "public/app.js", "public/style.css", "wrangler.jsonc"]),
]
if os.environ.get("PROXY_HAS") == "1":
    specs.append(("openrouter-proxy", ["src.js", "wrangler.jsonc"]))
files = []
for group, names in specs:
    for n in names:
        files.append({"name": n, "path": f"files/{group}/{n}", "group": group})
with open(f"{dest}/../manifest.json", "w") as f:
    json.dump({"files": files}, f, indent=2, ensure_ascii=False)
print(f"generated manifest: {len(files)} files → public/code/")
EOF
