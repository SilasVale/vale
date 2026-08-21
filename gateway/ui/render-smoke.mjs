// Headless render smoke test: execute the built bundle in jsdom and verify
// the app mounts (login page renders when /api/me 401s). Usage:
//   node render-smoke.mjs <path-to-built-js>
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) { console.error("usage: node render-smoke.mjs <built-js>"); process.exit(1); }
const html = readFileSync("../public/index.html", "utf8");
const js = readFileSync(jsPath, "utf8");

const dom = new JSDOM(html, {
  url: "https://ai.saisi.online/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
window.fetch = async () =>
  new Response(JSON.stringify({ type: "error", error: { message: "unauthorized" } }), { status: 401 });

// jsdom eval runs as classic script — shim import.meta (harness-only).
window.__ims = (s) => s;
const shimmed = js
  .replaceAll("import.meta.resolve", "window.__ims")
  .replaceAll("import.meta.url", JSON.stringify("https://ai.saisi.online/"));
try {
  window.eval(shimmed);
} catch (e) {
  console.error("BUNDLE THREW:", e.message);
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 400));
const root = window.document.getElementById("root");
const text = root?.textContent || "";
console.log("root children:", root?.children.length);
console.log("content sample:", JSON.stringify(text.slice(0, 100)));
if (root?.children.length > 0 && text.includes("Vale")) { console.log("RENDER OK"); } else { console.error("RENDER FAILED"); process.exit(1); }
