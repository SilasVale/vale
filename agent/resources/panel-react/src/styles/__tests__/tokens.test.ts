// tokens.test.ts — static check of the BUILT panel.css: every var() reference
// must be defined in the single :root block (same check as build-css.mjs, run
// against the shipped artifact so a hand-edit of panel.css can't sneak in
// undefined variables either).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  // __tests__/ → styles/ → src/ → panel-react/ → .. (agent/resources/) → panel/panel.css
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "panel", "panel.css"),
  "utf8",
);

describe("panel.css token consistency", () => {
  it("has exactly one :root block", () => {
    const roots = css.match(/:root\s*\{/g) || [];
    expect(roots.length).toBe(1);
  });

  it("every var() reference resolves to a defined token", () => {
    const defined = new Set<string>();
    const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/);
    expect(rootBlock).not.toBeNull();
    for (const m of (rootBlock![1].matchAll(/--[a-z0-9-]+/g))) defined.add(m[0]);
    const missing = new Set<string>();
    for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      if (!defined.has(m[1])) missing.add(m[1]);
    }
    expect([...missing]).toEqual([]);
  });
});
