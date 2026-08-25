#!/usr/bin/env node
// e2e.mjs — deterministic end-to-end verification of Vale Studio against the
// local server (http://127.0.0.1:PORT) using Playwright Chromium.
//
//   LD_LIBRARY_PATH=~/chromium-libs/root/usr/lib/x86_64-linux-gnu \
//     node test/e2e.mjs [--port 7780] [--token XXX]
//
// Covers: token gate, file tree, Monaco open/edit/save-to-disk, external-change
// conflict banner, deep-link line jump, search UI, quick open, integrated
// terminal I/O. Screenshots land in test/artifacts/.

import { chromium } from "playwright";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const PORT = Number(arg("--port", 7780));
const TOKEN = arg("--token", "dev-studio-token-2026-08-25-local");
const BASE = `http://127.0.0.1:${PORT}`;
const ART = path.join(import.meta.dirname, "artifacts");
fs.mkdirSync(ART, { recursive: true });

const probeFile = path.join(arg("--root", "/home/zhengsaisi/vale"), "studio-e2e-probe.txt");
await fsp.writeFile(probeFile, "e2e line one\ne2e line two\n");

let passed = 0;
let failed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${String(e.message).split("\n")[0].slice(0, 180)}`);
  }
};

const browser = await chromium.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors = [];
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 160));
});

const editorText = () =>
  page.evaluate(() => {
    const ed = window.monaco;
    if (!ed) return "";
    const model = ed.editor.getModels().find((m) => m.uri.path.endsWith("studio-e2e-probe.txt"));
    return model ? model.getValue() : "";
  });

try {
  // ── 1. token gate ──────────────────────────────────────────────────────────
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await step("token gate appears when unauthenticated", async () => {
    await page.waitForSelector("#token-gate:not([hidden])", { timeout: 8000 });
  });

  await step("wrong token is rejected with message", async () => {
    await page.fill("#gate-token", "wrong-token");
    await page.click("#gate-go");
    await page.waitForFunction(
      () => document.getElementById("gate-err").textContent.includes("令牌无效"),
      null,
      { timeout: 6000 },
    );
  });

  await step("valid token logs in and hides gate", async () => {
    await page.fill("#gate-token", TOKEN);
    await page.click("#gate-go");
    await page.waitForSelector("#token-gate[hidden]", { state: "attached", timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll("#tree .tree-item").length > 0, null, { timeout: 10000 });
  });
  await page.screenshot({ path: path.join(ART, "01-logged-in.png") });

  // ── 2. file tree ───────────────────────────────────────────────────────────
  let rootName = "";
  await step("file tree lists workspace root entries", async () => {
    const names = await page.$$eval("#tree .tree-item .name", (els) => els.map((e) => e.textContent));
    if (!names.includes("agent") || !names.includes("gateway")) throw new Error("expected repo dirs, got: " + names.slice(0, 8).join(","));
    rootName = await page.$eval("#root-select", (s) => s.value);
  });

  await step("expand directory lazily loads children", async () => {
    await page.locator("#tree .tree-item .name", { hasText: /^studio$/ }).first().click();
    await page.locator('#tree .tree-item .name', { hasText: /^server\.mjs$/ }).first().waitFor({ timeout: 6000 });
  });

  // ── 3. open + edit + save round-trip ───────────────────────────────────────
  await step("open probe file via deep link renders Monaco", async () => {
    await page.evaluate((p) => {
      location.hash = `/open?p=${encodeURIComponent(p)}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }, probeFile);
    await page.waitForSelector(".monaco-editor", { timeout: 10000 });
    await page.waitForFunction(
      (p) => [...document.querySelectorAll(".tab .name")].some((n) => n.title === p),
      probeFile,
      { timeout: 6000 },
    );
  });

  await step("editing marks tab dirty", async () => {
    await page.click(".monaco-editor .view-lines", { position: { x: 80, y: 30 } });
    await page.keyboard.press("Control+a");
    await page.keyboard.type("e2e edited content v1");
    await page.waitForSelector(".tab.dirty", { timeout: 5000 });
  });

  await step("save writes to real disk (Ctrl+S)", async () => {
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !document.querySelector(".tab.dirty"), null, { timeout: 8000 });
    const disk = await fsp.readFile(probeFile, "utf8");
    if (disk !== "e2e edited content v1") throw new Error(`disk mismatch: ${JSON.stringify(disk)}`);
  });

  await step("external disk change + dirty buffer → conflict banner → reload wins", async () => {
    await page.keyboard.press("End");
    await page.keyboard.type(" plus unsaved tail"); // buffer dirty again
    await fsp.writeFile(probeFile, "disk wins after conflict\n");
    await page.waitForSelector("#conflict-banner:not([hidden])", { timeout: 20000 }); // watch WS push
    await page.click("#conflict-reload");
    await page.waitForFunction(
      (want) => {
        const banner = document.getElementById("conflict-banner");
        return banner.hidden === true && window.monaco &&
          monaco.editor.getModels().some((m) => m.getValue() === want);
      },
      "disk wins after conflict\n",
      { timeout: 8000 },
    );
  });
  await page.screenshot({ path: path.join(ART, "02-editor-flow.png") });

  // ── 4. deep link with line jump ───────────────────────────────────────────
  await step("deep link opens file at requested line", async () => {
    const target = path.join(rootName, "studio", "public", "index.html");
    await page.goto(`${BASE}/#/open?p=${encodeURIComponent(target)}&l=12`, { waitUntil: "load" });
    await page.waitForSelector(".monaco-editor", { timeout: 10000 });
    await page.waitForFunction(
      () => document.getElementById("sb-pos").textContent.startsWith("Ln 12"),
      null,
      { timeout: 9000 },
    );
  });
  await page.screenshot({ path: path.join(ART, "03-deeplink-line12.png") });

  // ── 5. search UI ───────────────────────────────────────────────────────────
  await step("global search finds ripgrep hits and opens them", async () => {
    await page.click('.act-btn[data-view="search"]');
    await page.fill("#search-input", "VSTUDIO_ROOT");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".sr-file", { timeout: 10000 });
    await page.locator(".sr-hit").first().click();
    await page.waitForFunction(
      () => [...document.querySelectorAll(".tab .name")].some((n) => n.textContent === "pty.mjs" || n.textContent === "server.mjs"),
      null,
      { timeout: 6000 },
    );
  });

  // ── 6. quick open ──────────────────────────────────────────────────────────
  await step("quick open (Ctrl+P) filters and opens file", async () => {
    await page.keyboard.press("Control+p");
    await page.waitForSelector("#quickopen:not([hidden])", { timeout: 5000 });
    await page.fill("#quickopen-input", "wrangler.jsonc");
    await page.locator(".qo-item").first().waitFor({ timeout: 15000 });
    await page.locator(".qo-item").first().click();
    await page.waitForFunction(
      () => [...document.querySelectorAll(".tab .name")].some((n) => n.textContent === "wrangler.jsonc"),
      null,
      { timeout: 8000 },
    );
  });

  // ── 7. integrated terminal ────────────────────────────────────────────────
  await step("terminal panel opens and PTY echoes commands", async () => {
    await page.keyboard.press("Control+`");
    await page.waitForSelector("#terminal-panel:not([hidden])", { timeout: 5000 });
    await page.waitForSelector(".term-host.active .xterm", { timeout: 12000 });
    await page.locator(".term-host.active .xterm").click({ position: { x: 300, y: 60 } });
    await page.waitForTimeout(600);
    await page.keyboard.type('echo STUDIO_E2E_$((41+1))\r');
    await page.waitForFunction(
      () => document.querySelector(".term-host.active .xterm-screen")?.textContent.includes("STUDIO_E2E_42")
         || document.querySelector(".term-host.active .xterm")?.textContent.includes("STUDIO_E2E_42"),
      null,
      { timeout: 12000 },
    );
  });
  await page.screenshot({ path: path.join(ART, "04-terminal.png") });

  await step("second terminal tab creates independent session", async () => {
    await page.click("#btn-term-new");
    await page.waitForFunction(() => document.querySelectorAll(".term-tab").length >= 2, null, { timeout: 12000 });
  });

  // ── 8. hygiene ────────────────────────────────────────────────────────────
  await step("no unexpected console/page errors during session", async () => {
    const real = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !/Failed to load resource.*404/.test(e) &&
        !e.includes("WebSocket"),
    );
    if (real.length) throw new Error(real.slice(0, 4).join(" | "));
  });
} finally {
  await fsp.unlink(probeFile).catch(() => {});
  await browser.close();
}

console.log(`\ne2e: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
