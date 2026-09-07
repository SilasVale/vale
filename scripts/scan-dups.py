#!/usr/bin/env python3
"""Duplicate-block scanner for the Vale monorepo.

Methodology hardened across the 2026-09-08 SOLID refactor rounds (see
agent/AGENTS.md round log): hash fixed-width line windows per file
(and optionally across files), strip comment/blank lines first so doc
comments do not mask real duplication, and rank files by dup-site
count. Intended as the periodic convergence check — TRUE duplication
is exhausted as of round 36; rerun after feature work to catch new
copy-paste early.

Usage:
  python3 scripts/scan-dups.py [--window 6] [--cross] [--min-sites 2]
                               [--root agent/src gateway/src index/src ...]
Default roots: agent/src, agent/vale-command-core/src, gateway/src,
index/src, gateway/ui/src, proxies, extension, agent/vale-agent-npm/src,
agent/vale-desktop-electron/src.

Rust files: #[cfg(test)] blocks are skipped (test scaffolding is
deliberately excluded from the production-duplication signal — see
round-23 log). Comment-only and blank lines are dropped for all
languages. Results are reported per file, biggest first.
"""
import argparse
import os
import sys
from collections import defaultdict

COMMENT_PREFIXES = ("//", "*", "#", "/*")

def code_lines(path: str):
    """Yield source lines with comments/blanks dropped; Rust test blocks skipped."""
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except (OSError, UnicodeDecodeError):
        return []
    out = []
    in_test, depth = False, 0
    for l in lines:
        s = l.strip()
        if path.endswith(".rs"):
            if not in_test and s.startswith("#[cfg(test)]"):
                in_test = True
                continue
            if in_test:
                depth += l.count("{") - l.count("}")
                if depth <= 0:
                    in_test = False
                    depth = 0
                continue
        if not s or s.startswith(COMMENT_PREFIXES):
            continue
        out.append(l)
    return out

def collect_files(roots, exts):
    files = []
    for root in roots:
        for dirpath, _, names in os.walk(root):
            for f in names:
                if not f.endswith(exts):
                    continue
                p = os.path.join(dirpath, f)
                if any(seg in p for seg in ("node_modules", "/dist/", "public/code")):
                    continue
                files.append(p)
    return files

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--window", type=int, default=6)
    ap.add_argument("--min-sites", type=int, default=2)
    ap.add_argument("--cross", action="store_true",
                    help="also report blocks shared across files")
    ap.add_argument("--roots", nargs="*", default=[
        "agent/src", "agent/vale-command-core/src", "gateway/src",
        "index/src", "gateway/ui/src", "proxies", "extension",
        "agent/vale-agent-npm/src", "agent/vale-desktop-electron/src",
    ])
    args = ap.parse_args()
    missing = [r for r in args.roots if not os.path.isdir(r)]
    if missing:
        print("missing roots:", ", ".join(missing))
        sys.exit(1)

    files = collect_files(args.roots, (".rs", ".ts", ".tsx", ".js", ".mjs"))
    per_file = []
    cross = defaultdict(list)
    for p in files:
        lines = code_lines(p)
        n = len(lines)
        if n < args.window + 1:
            continue
        seen = defaultdict(list)
        for i in range(n - args.window + 1):
            block = tuple(x.strip() for x in lines[i:i + args.window])
            seen[block].append(i)
            cross[block].append((p, i))
        d = [(pos, b) for b, pos in seen.items() if len(pos) >= args.min_sites]
        if d:
            per_file.append((sum(len(x[0]) for x in d), len(d), p, d))
    per_file.sort(reverse=True)
    print(f"=== intra-file ({args.window}-line windows) ===")
    for sites, blocks, p, d in per_file:
        print(f"{sites:4d} sites / {blocks:3d} blocks  {p}")
        for pos, b in d[:3]:
            print("    sites=" + str(pos) + ": " + " | ".join(x[:45] for x in b[:3]))
    if args.cross:
        xf = [(len(v), b, v) for b, v in cross.items()
              if len({p for p, _ in v}) > 1 and len(v) >= args.min_sites]
        xf.sort(reverse=True)
        print(f"\n=== cross-file ({args.window}-line windows) ===")
        for n, b, v in xf[:20]:
            files = sorted({p for p, _ in v})
            print(f"{n:3d} sites across {files}: " + " | ".join(x[:45] for x in b[:3]))

if __name__ == "__main__":
    main()
