// A KEY ADDED TO ONE LANGUAGE IS A KEY MISSING FROM THE OTHER.
//
// The Models page shipped with `nav.models` and all ten `models.*` keys in zh and
// NONE of them in en. `t()` falls back to the Chinese dictionary on a miss, so the
// English console rendered the page ENTIRELY IN CHINESE — measured: lang=en gave
// "模型目录", "个模型", "渠道可用", "未探测" inside an otherwise English UI.
//
// Nothing caught it: the keys existed (in zh), the type-check was happy because the
// key union is built from either dictionary, and no test compared the two.
//
// This is the cheapest possible guard for that class and needs no DOM. It parses the
// dictionary blocks rather than importing them, and asserts it found a realistic
// number of keys on BOTH sides — a parse that reads nothing must not report parity
// (round 54's lesson).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(path.join(ROOT, "src", "i18n.ts"), "utf8");

function keysOf(block) {
  return new Set([...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
}

const zhStart = SRC.indexOf("  zh: {");
const enStart = SRC.indexOf("  en: {");
assert.ok(zhStart >= 0 && enStart > zhStart, "could not locate the zh/en dictionary blocks");
const zh = keysOf(SRC.slice(zhStart, enStart));
const en = keysOf(SRC.slice(enStart));

test("the dictionary parser actually read both languages", () => {
  // A comparison over two empty sets passes for ever.
  assert.ok(zh.size >= 200, `only ${zh.size} zh keys parsed — the parser read the wrong thing`);
  assert.ok(en.size >= 200, `only ${en.size} en keys parsed — the parser read the wrong thing`);
});

test("zh and en declare the SAME keys — no gaps, no strays", () => {
  const missing = [...zh].filter((k) => !en.has(k)).sort();
  const extra = [...en].filter((k) => !zh.has(k)).sort();
  assert.deepEqual(
    missing,
    [],
    `${missing.length} key(s) exist in zh and NOT in en. t() falls back to the Chinese ` +
      `dictionary, so an English user sees Chinese here: ${missing.slice(0, 10).join(", ")}`,
  );
  assert.deepEqual(
    extra,
    [],
    `${extra.length} key(s) exist in en and NOT in zh: ${extra.slice(0, 10).join(", ")}`,
  );
});

test("the Models surface specifically is covered in both languages", () => {
  // Pinned by name because it is the surface that shipped broken, so a future
  // refactor that drops these keys fails here with the page named.
  for (const k of [
    "nav.models",
    "models.lede",
    "models.count",
    "models.unavailable",
    "models.notChecked",
    "models.noPrefix",
  ]) {
    assert.ok(zh.has(k), `${k} missing from zh`);
    assert.ok(en.has(k), `${k} missing from en — the English Models page would render Chinese`);
  }
});

// ── A LITERAL IN A COMPONENT IS A TRANSLATION NOBODY CAN REACH ───────────────
//
// The parity check above compares the two DICTIONARIES, so a string written
// directly into JSX is invisible to it — and that is exactly how the console ended
// up showing Chinese in its English locale and English in its Chinese one:
//
//   Keys.tsx    { weekly: "周", monthly: "月" }   and   `余额: ${money(...)}`
//   Users.tsx   "•••••• (set)" / "— (not set)"
//   Auth.tsx    placeholder="admin key" / "New password (≥8 chars)"
//
// CJK is the half that can be detected mechanically, and it is the half that is
// unambiguous: the console's source language is English, so Chinese in a component
// is always a leak. `i18n.ts` is the one file allowed to contain it.
//
// The English-in-the-Chinese-console direction cannot be found this way (English IS
// the source language); this check closes the direction that can be closed.
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uff00-\uffef]/;

test("no CJK literals in console source outside the dictionary", () => {
  const root = path.join(ROOT, "src");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && entry.name !== "i18n.ts") {
        const src = readFileSync(full, "utf8");
        const lines = src.split("\n");
        lines.forEach((line, i) => {
          // An EXPLICIT, auditable opt-out. The language toggle legitimately renders
          // the OTHER language's name in its own script ("中文" while in English),
          // which is correct practice and not a leak — but rather than pattern-match
          // an exception, the line must SAY why it is allowed.
          //
          // THE MARKER IS MATCHED OVER A WINDOW, NOT THE EXACT LINE. It was
          // line-exact first, and prettier immediately moved the trailing
          // `{/* i18n-allow-cjk: … */}` onto its own line — the marker was still in
          // the file and no longer beside the literal, so the check reported the two
          // LEGITIMATE toggles as leaks. An opt-out whose meaning depends on a line
          // boundary is an opt-out a formatter can revoke.
          const near = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
          if (near.includes("i18n-allow-cjk")) return;
          // Comments may quote the Chinese they are explaining.
          const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
          if (CJK.test(code))
            offenders.push(`${path.relative(ROOT, full)}:${i + 1}  ${line.trim().slice(0, 70)}`);
        });
      }
    }
  };
  walk(root);
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} line(s) put CJK directly in console source. Each one renders in the ` +
      `WRONG locale — the English console shows Chinese — because it never passes through t():\n  ` +
      offenders.join("\n  "),
  );
  // Guard against a walk that read nothing.
  assert.ok(readdirSync(path.join(ROOT, "src")).length > 0, "the source walk found nothing");
});
