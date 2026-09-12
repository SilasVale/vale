// ── the console's browser_* tools must speak the SHIPPED server's language ───
//
// `browser_*` is the one tool family the gateway TRANSLATES rather than relays to
// the device: `mcp-browser.ts` maps the console's name to playwright-mcp's and
// forwards the arguments VERBATIM (only `element_ref` is rewritten, and `run_id`
// is lifted out). So a parameter name that does not exist in the shipped
// playwright-mcp is not a cosmetic drift — the argument is dropped or rejected,
// and the console is advertising a call it cannot make.
//
// TWO WERE WRONG, verified against the bundle the agent itself installs
// (`agent/deploy/vale-playwright.zip`, `@playwright/mcp` 0.0.79):
//   * `browser_wait` advertised `condition` — REQUIRED — and `timeout_s`. The
//     server's `browser_wait_for` takes `time`, `text`, `textGone`; there is no
//     `condition` at all. A schema-validating client could only issue a call
//     whose only required argument the server does not have.
//   * `browser_screenshot` advertised `full_page`; the server takes `fullPage`.
//     A full-page request was silently dropped.
//
// WHY NOTHING CAUGHT IT: the parameter-name contract tests compare the gateway
// against the DEVICE (`spec-tools.json`) — but these tools are bridge-routed and
// never reach the device's registry. And `mcp-browser.test.mjs` verified only
// `browser_open -> browser_navigate`; the other six mappings were pinned by
// nothing. A test on a copy can only compare copies; this one compares the
// console against the bundle, which is the third party in the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ZIP = new URL("../../agent/deploy/vale-playwright.zip", import.meta.url).pathname;

/** The shipped playwright-mcp bundle, as text. */
function shippedBundle() {
  return execFileSync("unzip", ["-p", ZIP, "playwright/node_modules/playwright-core/lib/coreBundle.js"], {
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
}

/**
 * The shipped server's block of source for each `browser_*` tool.
 *
 * A WINDOW, not a parsed schema. Two earlier attempts here (a lazy regex, then a
 * brace walk) both returned EMPTY key sets for every tool while reporting that
 * they had found the tools — the exact failure mode this repo keeps recording: a
 * checker that reads nothing reports no problems. A window between one tool's
 * `name:` and the next one's cannot silently parse nothing, and `blockOf` asserts
 * the window is substantial, so a change in the bundle's shape fails loudly
 * instead of turning the whole test into a no-op.
 */
function toolBlocks(bundle) {
  const out = new Map();
  const marks = [...bundle.matchAll(/name:\s*"(browser_[a-z_]+)"/g)];
  for (let i = 0; i < marks.length; i++) {
    const name = marks[i][1];
    if (out.has(name)) continue;
    const from = marks[i].index;
    const to = i + 1 < marks.length ? marks[i + 1].index : Math.min(bundle.length, from + 4000);
    const block = bundle.slice(from, to);
    // Every real definition carries its schema; a window without one means the
    // split is wrong and the assertions below would be vacuous.
    if (!block.includes("inputSchema")) continue;
    out.set(name, block);
  }
  return out;
}

/** Whether the shipped block declares `param` as an object key. */
function declares(block, param) {
  return new RegExp("(^|[{,\\s])" + param + "\\s*:").test(block);
}

test("every argument the console sends a browser tool exists in the shipped server", async () => {
  const { allMcpTools } = await import("../src/mcp-tools.ts");
  const toPm = {
    browser_open: "browser_navigate",
    browser_snapshot: "browser_snapshot",
    browser_screenshot: "browser_take_screenshot",
    browser_click: "browser_click",
    browser_type: "browser_type",
    browser_wait: "browser_wait_for",
    browser_close: "browser_close",
  };
  const blocks = toolBlocks(shippedBundle());
  assert.ok(blocks.size >= 5, `the bundle split found too few tools (${blocks.size}) — re-point this test`);
  // A block that is all header and no schema would make the check vacuous.
  for (const [n, b] of blocks) {
    assert.ok(b.length > 200, `the block for ${n} is only ${b.length} chars — the split is wrong`);
  }

  // Arguments the GATEWAY owns and deliberately does not forward.
  const NOT_FORWARDED = new Set(["device", "run_id"]);
  // Arguments the bridge REWRITES into the server's own name before forwarding
  // (`mcp-browser.ts` turns `element_ref` into `target`). Console-only by
  // design, so they are not drift.
  const TRANSLATED = new Set(["element_ref", "text_gone"]);

  const problems = [];
  for (const tool of allMcpTools()) {
    const pm = toPm[tool.name];
    if (!pm) continue;
    const block = blocks.get(pm);
    assert.ok(block, `the shipped bundle has no ${pm} — the mapping table in mcp-browser.ts is stale`);
    for (const p of Object.keys(tool.inputSchema.properties || {})) {
      if (NOT_FORWARDED.has(p) || TRANSLATED.has(p)) continue;
      if (!declares(block, p)) problems.push(`${tool.name}.${p} (server ${pm} does not declare it)`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    "the console advertises browser arguments the SHIPPED playwright-mcp does not " +
      `accept, so they are dropped or rejected: ${problems.join(" | ")}`,
  );
});

test("every mapping in the bridge points at a tool the shipped server defines", () => {
  const src = readFileSync(new URL("../src/mcp-browser.ts", import.meta.url), "utf8");
  const blocks = toolBlocks(shippedBundle());
  const table = /const toolMap[^{]*\{([\s\S]*?)\n  \};/.exec(src);
  assert.ok(table, "the mapping table moved — re-point this test rather than deleting it");
  const mappings = [...table[1].matchAll(/(\w+):\s*"(\w+)"/g)].map((m) => [m[1], m[2]]);
  assert.ok(mappings.length >= 7, `only ${mappings.length} mappings parsed`);
  const ghosts = mappings.filter(([, pm]) => !blocks.has(pm)).map(([g, pm]) => `${g} -> ${pm}`);
  assert.deepEqual(ghosts, [], `the bridge maps to tools the server does not define: ${ghosts.join(", ")}`);
});
