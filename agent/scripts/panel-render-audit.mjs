#!/usr/bin/env node
// Render the REAL panel bundle with a stubbed device API, and audit it.
//
// WHY THIS EXISTS. Every earlier visual check in this repo was a hand-built HTML
// gallery: I wrote the markup, linked the stylesheet, and measured the elements I
// had just created. That verifies the CSS I was thinking about and nothing else —
// and it is how five chrome contrast defects lived through several rounds of
// "auditing": `#session-count`, `.side-time`, `.side-count`, `.tab.active` and
// `.view-switch-btn.active` were wrong the whole time and no feature-by-feature
// gallery could see them, because I only ever measured what I was working on.
//
// This harness instead loads `resources/panel/panel.js` and `panel.css` — the
// exact bytes the agent embeds via include_str! — into a page that serves at a
// real `/panel/` origin, with `window.fetch` stubbed to return a fixed device
// state. The app boots through its own production path (including computeBoot's
// same-origin branch) and renders its own component tree. Then it:
//
//   1. measures EVERY visible text node, alpha-compositing both background alpha
//      and the ancestor `opacity` chain (element opacity is in NEITHER
//      getComputedStyle(color) NOR backgroundColor — a probe that ignores it
//      reports a dimmed element at its full colour);
//   2. asserts each governance element is PRESENT, so a clean contrast sweep over
//      a page that failed to render cannot pass;
//   3. checks nothing in the top bar overflows.
//
// Pages are addressed over http://vale.test/panel/ and satisfied by Playwright
// route interception, so NO listener is opened anywhere — the run is safe on a box
// where binding a port is not allowed.
//
// Usage (needs the Playwright runtime; see VALE_BROWSER_HELPER):
//   node scripts/panel-render-audit.mjs --out /tmp/panel-audit
//
// Regenerate panel.js/panel.css first: (cd agent/resources/panel-react && npm run build)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PANEL = join(ROOT, "agent", "resources", "panel");
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : "/tmp/panel-render-audit";
})();

const SID = "term-audit-0";

// A device state that exercises every governance surface at once: a stated goal,
// the gate armed, a command waiting for a decision, a grant already in force, and
// a trail carrying intent + the branches not taken.
const EVENTS = [
  { seq: 1, ts: 1789000000, kind: "status", status: "opened" },
  { seq: 2, ts: 1789000001, kind: "goal", text: "provision the ONU at 0/1 on VLAN 100, then save the config" },
  { seq: 3, ts: 1789000002, kind: "approval", status: "armed" },
  {
    seq: 4, ts: 1789000010, kind: "command/start", command: "display ont info 0 1",
    intent: "check whether the ONU is actually online before changing its config",
    considered: ["reset the ONU", "check the OLT uplink first"],
  },
  { seq: 5, ts: 1789000011, kind: "output", text: "ONT 0/1 online, VLAN 1" },
  { seq: 6, ts: 1789000012, kind: "command/end", exit_code: 0, duration_ms: 900 },
  { seq: 7, ts: 1789000020, kind: "approval", status: "approved", text: "vlan 100" },
  { seq: 8, ts: 1789000021, kind: "approval", status: "granted", text: "vlan" },
  { seq: 9, ts: 1789000030, kind: "command/start", command: "vlan 100", intent: "apply the change" },
  { seq: 10, ts: 1789000031, kind: "command/end", exit_code: 1, duration_ms: 200 },
];

const SESSION = {
  id: SID, kind: "pty", label: "d1", status: "live", bytes: 512,
  held_by_human: false, approval_required: true, approval_grants: ["display"],
  goal: "provision the ONU at 0/1 on VLAN 100, then save the config",
  pending_approval: {
    id: "ap-1",
    command: "vlan 100 / port vlan 100 0/1 1",
    expires_in_ms: 47000,
  },
};

/** Elements the governance surface must render. A contrast sweep that measured a
 *  blank page would otherwise be a clean, meaningless PASS. */
const REQUIRED = [
  ["goal bar", "#goal-bar"],
  ["goal text", ".goal-text"],
  ["approval prompt", ".approval-prompt"],
  ["pending command", ".approval-cmd"],
  ["countdown", ".approval-left"],
  ["approve button", ".approval-approve"],
  ["refuse button", ".approval-refuse"],
  ["remember button", ".approval-remember"],
  ["session tab", ".tab-name"],
  ["view switch", ".view-switch-btn.active"],
  ["status session count", "#session-count"],
  ["side time", ".side-time"],
  ["side count", ".side-count"],
];

function buildHarness() {
  const css = readFileSync(join(PANEL, "panel.css"), "utf8");
  const js = readFileSync(join(PANEL, "panel.js"), "utf8");
  // No `</script` may appear in the bundle or the inline tag would terminate early.
  if (/<\/script/i.test(js)) throw new Error("panel.js contains </script — inline embedding is unsafe");

  const stub = `
(function(){
  var P = new URLSearchParams(location.search);
  var THEME = P.get('theme') || 'light', MODE = P.get('mode') || 'pending';
  try { localStorage.setItem('vale-theme', THEME); } catch(e){}
  window.__PANEL_TOKEN__ = 'audit-token';
  var SID = ${JSON.stringify(SID)}, SESSION = ${JSON.stringify(SESSION)}, EVENTS = ${JSON.stringify(EVENTS)};
  if (MODE === 'idle') SESSION = Object.assign({}, SESSION, {pending_approval: null});
  var J = function(o){ return new Response(JSON.stringify(o), {status:200, headers:{'content-type':'application/json'}}); };
  var realFetch = window.fetch.bind(window);
  window.fetch = function(url, init){
    var u = String(url);
    if (u.indexOf('/api/tools/terminal_list') >= 0)    return Promise.resolve(J({ok:true, result:[SESSION]}));
    if (u.indexOf('/api/tools/terminal_history') >= 0) return Promise.resolve(J({ok:true, result:[]}));
    if (u.indexOf('/api/tools/terminal_read') >= 0)    return Promise.resolve(J({ok:true, result:{text:'ONT 0/1 online', start:0, end:14, evicted:false}}));
    if (u.indexOf('/api/tools/') >= 0)                 return Promise.resolve(J({ok:true, result:'OK'}));
    if (/\\/api\\/sessions\\/[^/]+$/.test(u))            return Promise.resolve(J({ok:true, id:SID, events:EVENTS}));
    if (u.indexOf('/api/plugins/status') >= 0)         return Promise.resolve(J({plugins:[{name:'terminal',ok:true}]}));
    if (u.indexOf('/api/spec') >= 0)                   return Promise.resolve(J({plugins:[]}));
    if (u.indexOf('/api/') >= 0)                       return Promise.resolve(J({ok:true}));
    return realFetch(url, init);
  };
  window.EventSource = function(){ this.addEventListener=function(){}; this.removeEventListener=function(){}; this.close=function(){}; };
  window.WebSocket = function(){ this.addEventListener=function(){}; this.send=function(){}; this.close=function(){}; };
})();`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Vale Agent</title>
<style>${css}</style></head><body><div id="root"></div>
<script>${stub}</script><script type="module">${js}</script></body></html>`;
}

// Runs INSIDE the page. Composites background alpha AND the ancestor opacity
// chain, then measures every visible text node.
const PROBE = `(() => {
  const parse = (c) => { const m=(c||'').match(/[\\d.]+/g); if(!m) return null;
    const [r,g,b]=m.map(Number); return {r,g,b,a:m.length>3?Number(m[3]):1}; };
  const effBg = (el) => { const st=[]; let p=el;
    while(p){ const c=parse(getComputedStyle(p).backgroundColor);
      if(c&&c.a>0){st.push(c); if(c.a===1) break;} p=p.parentElement; }
    let o={r:255,g:255,b:255};
    for(let i=st.length-1;i>=0;i--){const c=st[i];
      o={r:c.r*c.a+o.r*(1-c.a),g:c.g*c.a+o.g*(1-c.a),b:c.b*c.a+o.b*(1-c.a)};}
    return o; };
  const chainOpacity = (el) => { let o=1, p=el;
    while(p && p !== document.documentElement){ o *= parseFloat(getComputedStyle(p).opacity||'1'); p=p.parentElement; }
    return o; };
  const effFg = (el) => { const c=parse(getComputedStyle(el).color); const bg=effBg(el);
    const a=(c.a ?? 1) * chainOpacity(el);
    return { r:c.r*a+bg.r*(1-a), g:c.g*a+bg.g*(1-a), b:c.b*a+bg.b*(1-a) }; };
  const lum=(c)=>{const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
    return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b)};
  const ratio=(a,b)=>{const[x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return +((x+0.05)/(y+0.05)).toFixed(2)};
  const out = []; const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    // xterm paints from its own palette (the app's terminal theme), not from the
    // panel tokens; measuring it here mixes two colour systems and produced a
    // phantom reading once already.
    if (el.closest('.xterm')) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) === 0) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    const key = cls + '|' + (el.textContent||'').slice(0,16);
    if (seen.has(key)) continue; seen.add(key);
    out.push({ sel: el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\\s+/).join('.') : ''),
      text: (el.textContent||'').trim().slice(0,24), size: parseFloat(st.fontSize),
      cr: ratio(effFg(el), effBg(el)) });
  }
  return out;
})()`;

const OVERFLOW = `(() => {
  const bad = [];
  for (const el of document.querySelectorAll('#root *')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/)[0] : '';
      bad.push(el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' over=' + (el.scrollWidth - el.clientWidth));
    }
  }
  return [...new Set(bad)].slice(0, 12);
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const html = buildHarness();
  const harnessPath = join(OUT, "panel-harness.html");
  writeFileSync(harnessPath, html);

  // WHERE THIS RUNS. The audit needs a Playwright runtime, and on the Linux dev
  // box there is none that can launch (the system chromium is missing
  // libatk-1.0.so.0 and there is no sudo). The runtime that DOES work is the
  // device's bundled one, reached through the agent's `browser_run_script` tool —
  // which is how every round of this work actually audited the panel. So:
  //
  //   * with VALE_BROWSER_HELPER set (on a device, or any box with the bundle)
  //     this script runs the whole audit itself;
  //   * without it, it still generates the harness and prints the probe, so the
  //     same measurement can be driven from wherever a runtime exists.
  //
  // Emitting rather than failing is the point: a check that can only run in one
  // environment is a check that quietly stops running.
  const helper = process.env.VALE_BROWSER_HELPER;
  if (!helper) {
    console.log("No VALE_BROWSER_HELPER — harness written, running in EMIT mode.");
    console.log("  harness: " + harnessPath);
    console.log("  drive it by loading that file in any Playwright page, routing");
    console.log("  http://vale.test/** to its body, then evaluating the PROBE and");
    console.log("  OVERFLOW snippets in this file.");
    process.exit(0);
  }
  const { acquireBrowser } = await import(helper);
  const { page, close } = await acquireBrowser();

  // Served at a REAL origin and path, satisfied by interception — the panel sees
  // location.pathname === "/panel/" and boots through its own production branch.
  // No listener is opened anywhere.
  await page.route("http://vale.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 200)));

  let failures = 0;
  let measured = 0;
  let low = 0;

  for (const theme of ["light", "dark"]) {
    for (const mode of ["pending", "idle"]) {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(`http://vale.test/panel/?theme=${theme}&mode=${mode}`, { waitUntil: "load" });
      await page.waitForTimeout(1800);

      const rows = await page.evaluate(PROBE);
      const under = rows.filter((r) => r.cr < 4.5);
      measured += rows.length;
      low += under.length;
      console.log(`\n--- ${theme} / ${mode}: ${rows.length} text nodes, ${under.length} under AA ---`);
      for (const r of under) {
        failures++;
        console.log(`  LOW ${String(r.cr).padStart(5)}  ${String(r.size).padStart(4)}px  ${r.sel.slice(0, 46)}  "${r.text}"`);
      }

      // Presence: a clean sweep over a page that did not render proves nothing.
      if (mode === "pending") {
        const found = await page.evaluate(
          (sels) => Object.fromEntries(sels.map(([k, s]) => [k, !!document.querySelector(s)])),
          REQUIRED,
        );
        for (const [k] of REQUIRED) {
          if (!found[k]) {
            failures++;
            console.log(`  MISSING  ${k}`);
          }
        }
        const over = await page.evaluate(OVERFLOW);
        for (const o of over) {
          failures++;
          console.log(`  OVERFLOW ${o}`);
        }
        if (pageErrors.length) {
          failures++;
          console.log(`  PAGE ERRORS ${JSON.stringify(pageErrors.slice(0, 3))}`);
        }
        await page.screenshot({ path: join(OUT, `panel-${theme}.png`), fullPage: false });
      }
    }
  }

  console.log(`\n== ${measured} text nodes measured, ${low} under AA, ${failures} failure(s) ==`);
  console.log(`screenshots: ${OUT}/panel-light.png, ${OUT}/panel-dark.png`);
  await close();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL " + e.message);
  process.exit(1);
});
