#!/usr/bin/env node
// Vale Agent E2E suite (runs on the DEVICE, e.g. d1).
//
// Purpose: repeatable, device-side verification that the AI-facing surface
// works end-to-end. Exercises the same paths a real AI client uses:
//   POST /api/tools/{name} with body = the args object (no {tool,args}
//   wrapper); terminal_open returns the sid as a string; terminal_read
//   wraps under .result.
//
// Sections (each exits PASS/FAIL independently):
//   1. terminal  — open session, execute in session mode, run_in_background
//                  + collect via read (round-268 contract)
//   2. file      — stat -> append pages up -> paged raw read down
//                  (round-266 bidirectional transfer)
//   3. workflow  — cross-plugin chain: process_list -> execute -> file_write
//                  -> stat -> memory_save -> memory_search (round-267)
//   4. browser   — browser_run_script drives the embedded view via CDP 9333
//                  and the SPA address bar follows (round-268)
//   5. panel     — AI writes a unique marker into a terminal session; the
//                  SPA's VISIBLE xterm must show it (round-264 display
//                  verification, now repeatable)
//   6. evidence  — an AI screenshot lands in pwout and /api/browser/pwshots
//                  (the Evidence drawer data source) lists it
//   7. mcp       — stdio connect auto-selects the embedded view; the first
//                  browser_navigate drives it (round-281 regression)
//
// Usage:
//   node e2e.js --token <agent-token> [--base http://127.0.0.1:18080]
//                [--only terminal,file,panel] [--no-browser]
//
// Requires: agent running on the device; for section 4 also the Electron
// desktop (CDP 9333) + a playwright install at D:\Vale\playwright.
//
// Exit code: 0 = all selected sections passed; 1 = any failure.

const TOKEN = process.argv.includes('--token')
  ? process.argv[process.argv.indexOf('--token') + 1]
  : process.env.VALE_AGENT_TOKEN;
const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i >= 0 ? process.argv[i + 1] : 'http://127.0.0.1:18080';
})();
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1].split(',').map((s) => s.trim()) : null;
})();
const NO_BROWSER = process.argv.includes('--no-browser');
const PW_DIR = process.env.VALE_PW_DIR || 'D:\\Vale\\playwright';

const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shotsJsonParse(resp) { try { return await resp.json(); } catch (e) { return null; } }

async function tool(name, body) {
  const r = await fetch(BASE + '/api/tools/' + name, {
    method: 'POST', headers: H, body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error('tool ' + name + ' HTTP ' + r.status);
  const j = await r.json();
  if (j && j.ok === false) throw new Error('tool ' + name + ' failed: ' + JSON.stringify(j).slice(0, 200));
  return j && j.result !== undefined ? j.result : j;
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

// ── 1. terminal: session execute + background collect ──────────────────────
async function sectionTerminal() {
  const sid = await tool('terminal_open', { kind: 'pty' });
  if (typeof sid !== 'string' && !(sid && sid.sid)) throw new Error('terminal_open bad result');
  const sessionId = typeof sid === 'string' ? sid : sid.sid;
  await sleep(2500); // let the shell boot (first-prompt gate)
  const ex = await tool('terminal_execute', {
    command: 'Write-Output E2E-SESSION-OK',
    session_id: sessionId, timeout_secs: 20,
  });
  check('terminal session execute', ex && ex.state === 'done' && (ex.text || '').includes('E2E-SESSION-OK'),
    'state=' + (ex && ex.state) + ' exit=' + (ex && ex.exit_code));
  const bg = await tool('terminal_execute', {
    command: 'Start-Sleep -Seconds 2; Write-Output E2E-BG-DONE',
    session_id: sessionId, run_in_background: true,
  });
  check('terminal run_in_background', !!bg && (bg.status === 'running' || bg.job_id),
    'job=' + (bg && bg.job_id));
  await sleep(4000);
  const rd = await tool('terminal_read', { session_id: sessionId });
  const txt = typeof rd === 'string' ? rd : (rd.text || '');
  check('terminal background collect', txt.includes('E2E-BG-DONE'), 'len=' + txt.length);
  await tool('terminal_close', { session_id: sessionId }).catch(() => {});
}

// ── 2. file: stat + append-up + paged raw read down ────────────────────────
async function sectionFile() {
  const path = 'D:\\Vale\\pwout\\e2e_suite_transfer.bin';
  const chunk = Buffer.alloc(150 * 1024, 'B').toString('base64');
  const w1 = await tool('system_file_write', { path, data: chunk });
  const w2 = await tool('system_file_write', { path, data: chunk, append: true });
  check('file upload 2 pages', w1 && w1.ok !== false && w2 && w2.ok !== false,
    JSON.stringify([w1 && w1.bytes, w2 && w2.bytes]).slice(0, 60));
  const st = await tool('system_file_stat', { path });
  check('file stat', st && st.size === 300 * 1024, 'size=' + (st && st.size));
  const r1 = await tool('system_file_read', { path, offset: 0, limit: 1048576, raw: true });
  const bytes = Buffer.from(r1.data || '', 'base64');
  check('file single-read download', bytes.length === 300 * 1024 && bytes.every((b) => b === 66),
    'bytes=' + bytes.length);
  require('fs').unlinkSync(path);
}

// ── 3. workflow: cross-plugin chain ─────────────────────────────────────────
async function sectionWorkflow() {
  const pl = await tool('system_process_list', { name: 'electron' });
  const n = pl && pl.processes ? pl.processes.length : (Array.isArray(pl) ? pl.length : -1);
  check('workflow process_list', n >= 0, 'electron procs=' + n);
  const ex = await tool('terminal_execute', { command: 'echo E2E-WF-1', timeout_secs: 15 });
  check('workflow local execute', !!(ex && (ex.text || '').includes('E2E-WF-1')), '');
  const cfg = JSON.stringify({ e2e: true, ts: Date.now() });
  const fw = await tool('system_file_write', { path: 'D:\\Vale\\pwout\\e2e_wf.json', text: cfg });
  check('workflow file_write', !!(fw && fw.ok !== false), '');
  const st = await tool('system_file_stat', { path: 'D:\\Vale\\pwout\\e2e_wf.json' });
  check('workflow file_stat', st && st.size === Buffer.byteLength(cfg), 'size=' + (st && st.size));
  const ms = await tool('memory_save', {
    title: 'E2E suite marker', content: 'tool-chain ' + Date.now(), tags: ['e2e', 'suite'],
  });
  check('workflow memory_save', !!(ms && ms.ok !== false && ms.id), 'id=' + (ms && ms.id));
  const mq = await tool('memory_search', { query: 'E2E suite marker' });
  check('workflow memory_search', !!(mq && mq.results && mq.results.length > 0), 'hits=' + (mq && mq.results && mq.results.length));
  // self-clean: delete the marker so repeated runs don't accumulate entries
  // (device-caught round-294: memory_search hits grew across runs)
  if (ms && ms.id) await tool('memory_delete', { id: ms.id }).catch(() => {});
  require('fs').unlinkSync('D:\\Vale\\pwout\\e2e_wf.json');
}

// ── 4. browser: browser_run_script drives the view; SPA bar follows ────────
// ── 4b. panel: does the desktop SPA actually SHOW what the AI wrote? ──────
async function sectionPanel() {
  // 1. AI opens a session and writes a unique marker into it
  const marker = 'PANEL-VIS-' + Date.now();
  const sid = await tool('terminal_open', { kind: 'pty' });
  const sessionId = typeof sid === 'string' ? sid : sid.sid;
  await sleep(2500);
  const ex = await tool('terminal_execute', {
    command: 'Write-Output "' + marker + '"',
    session_id: sessionId, timeout_secs: 20,
  });
  check('panel ai write', !!(ex && (ex.text || '').includes(marker)), 'state=' + (ex && ex.state));

  // 2. read the SPA's xterm DOM: the marker must be visible in the panel
  await sleep(3000);
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const spa = list.find((t) => t.url.includes('/desktop/'));
  if (!spa) { check('panel xterm shows ai output', false, 'no desktop SPA target'); return; }
  const ws = new WebSocket(spa.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const evalInSpa = async (id, expression) => {
    const r = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 15000);
      const onMsg = (m) => {
        const o = JSON.parse(m.data);
        if (o.id === id) { clearTimeout(t); ws.removeEventListener('message', onMsg); resolve(o); }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    try {
      const raw = r && r.result && r.result.result && r.result.result.value;
      return raw !== undefined && raw !== null ? raw : null;
    } catch (e) { return null; }
  };
  // 3. make sure the SPA is on the Terminal page (rail button), then click
  //    the LAST session tab — the session we just opened is the newest, and
  //    the visible xterm follows the ACTIVE tab
  const railClick = await evalInSpa(200, "(function(){ var bs = document.querySelectorAll('button, [role=button], [class*=rail] > *'); for (var i=0;i<bs.length;i++){ var el = bs[i]; var t = (el.getAttribute('aria-label')||el.title||el.textContent||'').trim(); if (t === 'Terminal' || t.indexOf('Terminal') === 0 && t.length < 12) { el.click(); return 'clicked'; } } return 'no-rail'; })()");
  await sleep(1500);
  const tabClick = await evalInSpa(205, "(function(){ var ts = document.querySelectorAll('[role=tab]'); if (!ts.length) return 'no-tabs'; ts[ts.length - 1].click(); return 'clicked-last'; })()");
  await sleep(2500);
  // 4. read the visible xterm's text (round-264 method: visible .term-host
  //    .xterm-rows spans — hidden hosts exist per session)
  let found = false;
  for (let attempt = 0; attempt < 6 && !found; attempt++) {
    const raw = await evalInSpa(201 + attempt, "(function(){ var hosts = document.querySelectorAll('.term-host'); var vis = null; for (var i=0;i<hosts.length;i++){ var r = hosts[i].getBoundingClientRect(); if (r.width > 50 && r.height > 50) { vis = hosts[i]; break; } } if (!vis) return 'NO_VISIBLE'; var rows = vis.querySelectorAll('.xterm-rows > div'); var all = ''; for (var j=0;j<rows.length;j++){ all += rows[j].textContent + String.fromCharCode(10); } return all; })()");
    if (raw && raw !== 'NO_VISIBLE' && raw.indexOf('PANEL-VIS-') >= 0) { found = raw.indexOf(marker) >= 0; break; }
    if (raw && raw !== 'NO_VISIBLE') { found = raw.indexOf(marker) >= 0; }
    await sleep(2000);
  }
  check('panel xterm shows ai output', found, 'marker=' + marker.slice(0, 22));
  // cleanup: close the session + the WS
  await tool('terminal_close', { session_id: sessionId }).catch(() => {});
  await new Promise((resolve) => {
    ws.onclose = resolve;
    setTimeout(() => { try { ws.close(); } catch (e) {} }, 100);
    setTimeout(resolve, 3000);
  });
}

// ── 4c2. mcp: stdio connect auto-selects the embedded view (round-281) ──
// Shared: connect (given transport/url) -> immediate navigate -> the
// embedded view must reach the marker URL with NO manual tab select, and
// the SPA must stay intact. Returns the transport tag for check names.
async function mcpAutoselectProbe(tag, connArgs) {
  // round-306: start CLEAN — a leftover connection from a previous run
  // makes connect return already_connected and the check fails spuriously
  // (observed repeatedly on long-running devices).
  await tool('mcp_client_disconnect', {}).catch(() => {});
  await sleep(1500);
  const marker = 'mcp-autoselect-' + Date.now();
  const c = await tool('mcp_client_connect', connArgs);
  check('mcp ' + tag + ' connect', c && c.status === 'connected', (c && c.status) || JSON.stringify(c).slice(0, 60));
  if (!c || c.status !== 'connected') { return; }
  const nav = await tool('mcp_client_call', { tool: 'browser_navigate', arguments: { url: 'https://example.com/' + marker } });
  check('mcp ' + tag + ' navigate ok', nav && nav.ok, (nav && JSON.stringify(nav).slice(0, 60)) || 'no result');
  await sleep(6000);
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const embedded = list.find((t) => !t.url.includes('/desktop/'));
  const spaOk = list.some((t) => t.url.includes('/desktop/'));
  check('mcp ' + tag + ' drives embedded view', embedded && embedded.url.includes(marker), (embedded && embedded.url.slice(0, 60)) || 'NO VIEW');
  check('mcp ' + tag + ' SPA intact', spaOk, 'targets=' + list.length);
  // round-313: AI INTERACTION (not just navigation) must drive the view:
  // snapshot example.com, click "Learn more", the embedded view follows to
  // iana.org (playwright-mcp browser_click takes {target} = the snapshot ref).
  const snap = await tool('mcp_client_call', { tool: 'browser_snapshot', arguments: {} });
  const snapTxt = JSON.stringify(snap);
  // Snapshot line: `- link "Learn more" [ref=f1e6] [cursor=pointer]:`
  const refMatch = /link "Learn more" \[ref=(\w+)\]/.exec(snapTxt);
  const clickRef = refMatch && refMatch[1];
  let clickOk = false;
  if (clickRef) {
    const cl = await tool('mcp_client_call', { tool: 'browser_click', arguments: { target: clickRef } });
    clickOk = !!(cl && cl.ok);
  }
  check('mcp ' + tag + ' click learn-more', clickOk, 'ref=' + clickRef);
  await sleep(5000);
  const list2 = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const emb2 = list2.find((t) => !t.url.includes('/desktop/'));
  check('mcp ' + tag + ' click drives embedded view', emb2 && emb2.url.includes('iana.org'), (emb2 && emb2.url.slice(0, 60)) || 'NO VIEW');
  await tool('mcp_client_disconnect', {}).catch(() => {});
}

async function sectionMcp() {
  // round-281 regression (stdio) + round-285 regression (http/9229):
  // mcp_client_connect must auto-select the EMBEDDED-VIEW tab so the first
  // browser_navigate drives the page the user watches (not the desktop SPA).
  await mcpAutoselectProbe('stdio', { name: 'pw', transport: 'stdio' });
  await mcpAutoselectProbe('http', { name: 'pw-http', transport: 'http', url: 'http://127.0.0.1:9229/mcp' });
}

// ── 4c. evidence: an AI screenshot lands in pwout and shows in pwshots ────
// Shared: switch the desktop SPA to the given rail page so the embedded
// view has non-zero bounds (the WebContentsView is placed only while the
// Browser page is active — device-caught round-291: screenshot of a
// hidden view fails with "Cannot take screenshot with 0 width").
async function spaRailClick(label) {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const spa = list.find((t) => t.url.includes('/desktop/'));
  if (!spa) return false;
  const ws = new WebSocket(spa.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const raw = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 15000);
    const onMsg = (m) => {
      const o = JSON.parse(m.data);
      if (o.id === 1) { clearTimeout(t); ws.removeEventListener('message', onMsg); resolve(o); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: "(function(){ var bs = document.querySelectorAll('button, [role=button]'); for (var i=0;i<bs.length;i++){ var el = bs[i]; var t = (el.getAttribute('aria-label')||el.title||el.textContent||'').trim(); if (t === '" + label + "' || (t.indexOf('" + label + "') === 0 && t.length < 15)) { el.click(); return 'clicked'; } } return 'no-rail'; })()",
      returnByValue: true } }));
  });
  await new Promise((r) => setTimeout(r, 500));
  try { ws.close(); } catch (e) {}
  const v = raw && raw.result && raw.result.result && raw.result.result.value;
  return v === 'clicked';
}

async function sectionEvidence() {
  // 0. the embedded view only has non-zero bounds while the SPA shows the
  //    Browser page — switch there first so the screenshot can succeed
  await spaRailClick('Browser');
  await sleep(2000);
  // 1. AI takes a screenshot of the embedded view (browser_run_script,
  //    screenshot saved into the pwout dir — the round-252 evidence path)
  const name = 'e2e_evidence_' + Date.now() + '.png';
  const script = [
    "const { chromium } = require('" + PW_DIR.replace(/\\/g, '/') + "/node_modules/playwright');",
    "(async () => {",
    "  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 10000 });",
    "  const pages = browser.contexts().flatMap(c => c.pages());",
    "  const view = pages.find(p => !p.url().includes('/desktop/'));",
    "  if (!view) { console.log('NO_VIEW'); await browser.close(); return; }",
    "  await view.screenshot({ path: 'D:\\\\Vale\\\\pwout\\\\" + name + "' });",
    "  console.log('SHOT_SAVED');",
    "  await browser.close();",
    "})().catch(e => { console.log('FAIL:' + String(e).slice(0, 200)); process.exit(1); });",
  ].join('\n');
  const br = await tool('browser_run_script', { script });
  const out = (br && br.stdout) || '';
  check('evidence screenshot saved', br && br.exit_code === 0 && out.includes('SHOT_SAVED'),
    out.trim().slice(0, 60));
  // 2. the pwshots API (Evidence drawer data source) must list it
  await sleep(2000);
  const pwH = { Authorization: 'Bearer ' + TOKEN };
  const shotsResp = await fetch(BASE + '/api/browser/pwshots', { headers: pwH });
  const shotsJson = shotsResp.ok ? await shotsJsonParse(shotsResp) : null;
  const list = (shotsJson && shotsJson.shots) || [];
  check('evidence pwshots lists it', list.some((f) => (f.name || '').includes(name)),
    'shots=' + list.length + ' looking=' + name.slice(0, 30));
  // 3. self-clean the test screenshot (same policy as the file/terminal
  //    sections — the suite must not litter pwout)
  try { require('fs').unlinkSync('D:\\Vale\\pwout\\' + name); } catch (e) { /* best-effort */ }
}

async function sectionBrowser() {
  const script = [
    "const { chromium } = require('" + PW_DIR.replace(/\\/g, '/') + "/node_modules/playwright');",
    "(async () => {",
    "  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 10000 });",
    "  const pages = browser.contexts().flatMap(c => c.pages());",
    "  const view = pages.find(p => !p.url().includes('/desktop/'));",
    "  if (!view) { console.log('NO_VIEW'); await browser.close(); return; }",
    "  await view.goto('https://www.example.com');",
    "  console.log('TITLE=' + await view.title());",
    "  await browser.close();",
    "})().catch(e => { console.log('FAIL:' + String(e).slice(0, 200)); process.exit(1); });",
  ].join('\n');
  const br = await tool('browser_run_script', { script });
  const out = (br && br.stdout) || '';
  check('browser_run_script drives view', br && br.exit_code === 0 && out.includes('TITLE=Example Domain'),
    out.trim().slice(0, 80));
  // SPA address bar should now show example.com (did-navigate push).
  // NOTE: right after a playwright-driven navigation the SPA can take
  // several seconds to respond to Runtime.evaluate (observed undefined
  // result.value ~3s after nav, fine at ~8s — Electron CDP quirk), so
  // poll generously and tolerate malformed/empty responses.
  await sleep(4000);
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const spa = list.find((t) => t.url.includes('/desktop/'));
  if (!spa) { check('browser SPA bar sync', false, 'no desktop SPA target'); return; }
  const ws = new WebSocket(spa.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  // read the bar; if the SPA is not on the Browser page, click the rail first
  const evalUrl = async () => {
    const r = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 15000);
      const onMsg = (m) => {
        const o = JSON.parse(m.data);
        if (o.id === 100) { clearTimeout(t); ws.removeEventListener('message', onMsg); resolve(o); }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: 100, method: 'Runtime.evaluate',
        params: { expression: "JSON.stringify({ onBrowser: !!document.querySelector('.browser-url'), url: (document.querySelector('.browser-url')||{}).value || '' })", returnByValue: true } }));
    });
    // tolerate the Electron quirk where result.value is missing on the
    // first evaluates after a nav
    try {
      const raw = r && r.result && r.result.result && r.result.result.value;
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  };
  let state = { onBrowser: false, url: '' };
  for (let attempt = 0; attempt < 8; attempt++) {
    const parsed = await evalUrl();
    if (parsed && parsed.url && parsed.url.includes('example.com')) { state = parsed; break; }
    if (parsed) state = parsed;
    if (parsed && !parsed.onBrowser) { state = parsed; break; } // need rail click below
    await sleep(2000);
  }
  if (!state.onBrowser) {
    await new Promise((resolve) => {
      const t = setTimeout(() => resolve(''), 10000);
      const onMsg = (m) => {
        const o = JSON.parse(m.data);
        if (o.id === 101) { clearTimeout(t); ws.removeEventListener('message', onMsg); resolve(''); }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: 101, method: 'Runtime.evaluate',
        params: { expression: "var bs = document.querySelectorAll('button'); for (var i=0;i<bs.length;i++){ if (bs[i].getAttribute('aria-label')==='Browser' || bs[i].textContent.trim()==='Browser') { bs[i].click(); break; } } 'ok'", returnByValue: true } }));
    });
    await sleep(3000);
    const s2 = await evalUrl();
    state = s2 || state; // evalUrl already returns the parsed object or null
  }
  // wait for the close handshake so Node doesn't hit the UV_HANDLE_CLOSING assert
  await new Promise((resolve) => {
    ws.onclose = resolve;
    setTimeout(() => { try { ws.close(); } catch (e) {} }, 100);
    setTimeout(resolve, 3000);
  });
  check('browser SPA bar sync', (state.url || '').includes('example.com'), 'bar=' + (state.url || '').slice(0, 60));
}

(async () => {
  if (!TOKEN) { console.error('missing token: pass --token or VALE_AGENT_TOKEN'); process.exit(1); }
  const want = (s) => !ONLY || ONLY.includes(s);
  try {
    if (want('terminal')) await sectionTerminal();
    if (want('file')) await sectionFile();
    if (want('workflow')) await sectionWorkflow();
    if (want('panel') && !NO_BROWSER) await sectionPanel();
    if (want('mcp') && !NO_BROWSER) await sectionMcp();
    if (want('evidence') && !NO_BROWSER) await sectionEvidence();
    if (want('browser') && !NO_BROWSER) await sectionBrowser();
  } catch (e) {
    console.error('SECTION ERROR: ' + e.message);
    results.push({ name: 'suite', pass: false, detail: e.message });
  }
  const failed = results.filter((r) => !r.pass);
  console.log('\n== ' + (results.length - failed.length) + '/' + results.length + ' passed ==');
  process.exit(failed.length ? 1 : 0);
})();
