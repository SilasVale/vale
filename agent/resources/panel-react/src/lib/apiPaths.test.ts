/**
 * The panel's URL surface, checked against the routes the agent actually serves.
 *
 * THE SAME BLIND SPOT AS THE CONSOLE, one frontend over. Every panel test stubs
 * `fetch`, so a path the agent does not answer produces a 404 that the tests feed
 * into an empty view: the page renders blank, the suite stays GREEN, and the defect
 * ships INSIDE THE EXE. Round 46 built this contract for `gateway/ui` after two
 * hand-written mocks invented bugs; the panel had none.
 *
 * It matters more here, not less: the panel is compiled into the binary, so a wrong
 * path is not a bad deploy that can be rolled back — it is baked into a release.
 *
 * Both sides are READ, never hardcoded. The panel's paths come from its own source
 * (comments stripped first — a parser that matches inside a comment lies, which is
 * exactly how the token-contract checker failed in round 42); the agent's come from
 * the route literals in `src/web/*.rs`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import ts from "typescript";
import { join, resolve } from "node:path";

const PANEL_SRC = resolve(__dirname, "..");
const AGENT_WEB = resolve(__dirname, "..", "..", "..", "..", "src", "web");

/** Every .ts/.tsx under the panel source tree. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Paths are collected from the TYPESCRIPT AST, not from a regex.
 *
 * My first version stripped `//`-to-end-of-line by hand, and that ate
 * `${proto}//${hostname}/api/events/term` — the `//` after `}` is a
 * protocol-relative separator, not a comment, so the real request path vanished and
 * the check reported a path it could no longer see. A hand-rolled parser for a
 * language that ships its own lexer is a check that can only be wrong (round 48, and
 * round 42's token parser matching inside a comment).
 *
 * Only SAME-ORIGIN literals count. The panel also calls the Electron shell directly
 * at `http://127.0.0.1:9444/api/browser-session/open`, which is a different server
 * with no agent route — an absolute URL naming a host is therefore not an agent call.
 */
function literalsIn(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      // Rebuild with a placeholder for each substitution, so `${x}/api/y` keeps its
      // literal tail instead of losing it to the expression.
      let s = node.head.text;
      for (const span of node.templateSpans) s += "\u0000" + span.literal.text;
      out.push(s);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** `/api/...` paths the panel requests from the AGENT (same origin). */
function panelPaths(): Set<string> {
  const out = new Set<string>();
  for (const file of sourceFiles(PANEL_SRC)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    for (const lit of literalsIn(file)) {
      // An absolute URL names another origin (the Electron shell on :9444) — not the
      // agent, so it is not part of this contract.
      if (/^https?:\/\//i.test(lit)) continue;
      for (const m of lit.matchAll(/\/api\/[a-z0-9/_-]*/g))
        out.add(m[0].replace(/\/+$/, ""));
    }
  }
  return out;
}

/** `/api/...` literals declared by the agent's web layer. */
function agentRoutes(): Set<string> {
  const out = new Set<string>();
  for (const entry of readdirSync(AGENT_WEB)) {
    if (!entry.endsWith(".rs")) continue;
    const src = readFileSync(join(AGENT_WEB, entry), "utf8");
    for (const m of src.matchAll(/"(\/api\/[a-z0-9/_-]*)"/g))
      out.add(m[1].replace(/\/+$/, ""));
  }
  return out;
}

const paths = panelPaths();
const routes = agentRoutes();

describe("panel API surface", () => {
  it("actually read both sides", () => {
    // A comparison over two empty sets passes for ever. Same guard as the console's
    // contract and the token contract, for the same reason.
    expect(paths.size).toBeGreaterThanOrEqual(4);
    expect(routes.size).toBeGreaterThanOrEqual(10);
  });

  it("requests only paths the agent serves", () => {
    const missing: string[] = [];
    for (const p of paths) {
      // A route with a dynamic tail (`/api/tools/{name}`, `/api/sessions/{id}/…`)
      // matches by PREFIX, which is how the agent dispatches them too.
      const hit = [...routes].some(
        (r) => p === r || p.startsWith(r + "/") || r.startsWith(p + "/"),
      );
      if (!hit) missing.push(p);
    }
    expect(
      missing,
      `the panel requests ${missing.length} path(s) no agent route answers. Every panel ` +
        `test stubs fetch, so these would 404 in production with a green suite, and the ` +
        `panel ships inside the exe: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("names the paths it depends on, so a removal is visible", () => {
    // Pinned by name: the browser-evidence paths are the panel's only URL surface
    // beyond tools and SSE, and they are read by EvidenceDrawer rather than by the
    // shared client, which is exactly where a rename would go unnoticed.
    for (const p of [
      "/api/tools",
      "/api/events/term",
      "/api/browser/pwshots",
      "/api/browser/actions",
      "/api/browser/pwshot",
    ]) {
      expect(
        [...paths],
        `${p} is no longer requested by the panel — update this pin if that is intended`,
      ).toContain(p);
    }
  });
});
