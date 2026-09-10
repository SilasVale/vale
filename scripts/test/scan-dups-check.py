#!/usr/bin/env python3
"""Regression tests for scripts/scan-dups.py pure units (code_lines,
collect_files, is_test_file). Plain asserts, no framework (same convention
as the .bash suites); exit 0 = all green. Run: python3
scripts/test/scan-dups-check.py

SOLID Round-62: the normalizer (comment/test stripping, brace-tracked Rust
test skip) decides what counts as duplication — an untested normalizer
silently skews every convergence report it produces.
"""
import importlib.util
import os
import sys
import tempfile

# No __pycache__ litter next to the tool (repo .gitignore does not cover it).
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "scan_dups", os.path.join(HERE, "..", "scan-dups.py")
)
scan_dups = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan_dups)

PASS = 0


def check(desc, actual, expected):
    global PASS
    if actual == expected:
        PASS += 1
    else:
        print(f"FAIL: {desc}\n  actual:   {actual!r}\n  expected: {expected!r}")
        sys.exit(1)


def write_tmp(suffix, content, binary=False):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "case" + suffix)
    with open(p, "wb" if binary else "w", encoding=None if binary else "utf-8") as f:
        f.write(content)
    return p


# ── code_lines: comments + blanks dropped ────────────────────────────
p = write_tmp(".ts", "// lead\n\nconst a = 1;\n  # hash\n  /* block */\n  * star\nlet b = 2;\n")
check("comment/blank stripping", scan_dups.code_lines(p), ["const a = 1;", "let b = 2;"])

# ── code_lines: Rust test blocks skipped with brace tracking ─────────
rs = write_tmp(".rs", """use x;
#[cfg(test)]
mod tests {
    #[test]
    fn a() {
        if x {
            foo();
        }
    }
}
pub fn live() {}
""")
check(
    "rust test module skipped, production kept",
    scan_dups.code_lines(rs),
    ["use x;", "pub fn live() {}"],
)

# ── code_lines: the cfg marker is inert outside .rs ──────────────────
# ("#[cfg(test)]" itself drops as a #-comment everywhere; the point is no
# test-SKIPPING engages: following lines are kept.)
ts = write_tmp(".ts", "#[cfg(test)]\nconst a = 1;\nconst b = 2;\n")
check("non-Rust keeps lines after the marker", scan_dups.code_lines(ts), ["const a = 1;", "const b = 2;"])

# ── code_lines: unreadable / binary → [] ────────────────────────────
check("missing file → []", scan_dups.code_lines("/nonexistent-xyz/case.rs"), [])
check("binary file → []", scan_dups.code_lines(write_tmp(".rs", b"\xff\xfe\x00a", binary=True)), [])

# ── is_test_file predicate ──────────────────────────────────────────
check("tests.rs excluded", scan_dups.is_test_file("agent/src/plugins/terminal/tools/tests.rs"), True)
check("foo_test.rs excluded", scan_dups.is_test_file("agent/tests/mcp_test.rs"), True)
check("mod.rs kept", scan_dups.is_test_file("agent/src/plugins/terminal/tools/mod.rs"), False)
check("contest.rs kept (suffix, not match)", scan_dups.is_test_file("x/contest.rs"), False)

# ── collect_files: extensions + exclusion segments ──────────────────
root = tempfile.mkdtemp()
os.makedirs(os.path.join(root, "node_modules", "pkg"))
os.makedirs(os.path.join(root, "dist"))
open(os.path.join(root, "a.ts"), "w").write("x")
open(os.path.join(root, "b.md"), "w").write("x")
open(os.path.join(root, "node_modules", "pkg", "c.ts"), "w").write("x")
open(os.path.join(root, "dist", "d.js"), "w").write("x")
got = sorted(scan_dups.collect_files([root], (".ts", ".js")))
check("collects sources, skips vendored/built dirs and md", got, [os.path.join(root, "a.ts")])

print(f"ok: scan-dups-check {PASS} checks passed")
