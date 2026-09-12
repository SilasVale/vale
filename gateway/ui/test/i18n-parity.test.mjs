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
import { readFileSync } from "node:fs";
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
  assert.deepEqual(extra, [], `${extra.length} key(s) exist in en and NOT in zh: ${extra.slice(0, 10).join(", ")}`);
});

test("the Models surface specifically is covered in both languages", () => {
  // Pinned by name because it is the surface that shipped broken, so a future
  // refactor that drops these keys fails here with the page named.
  for (const k of ["nav.models", "models.lede", "models.count", "models.unavailable", "models.notChecked", "models.noPrefix"]) {
    assert.ok(zh.has(k), `${k} missing from zh`);
    assert.ok(en.has(k), `${k} missing from en — the English Models page would render Chinese`);
  }
});
