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
//
// Usage:
//   node e2e.js --token <agent-token> [--base http://127.0.0.1:18080]
//                [--only terminal,file] [--no-browser]
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
  require('fs').unlinkSync('D:\\Vale\\pwout\\e2e_wf.json');
}

// ── 4. browser: browser_run_script drives the view; SPA bar follows ────────
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
  // Give the did-navigate IPC a beat; then poll the bar a few times (the
  // SPA may be mid-render right after the view navigated).
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const spa = list.find((t) => t.url.includes('/desktop/'));
  if (!spa) { check('browser SPA bar sync', false, 'no desktop SPA target'); return; }
  const ws = new WebSocket(spa.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  // read the bar; if the SPA is not on the Browser page, click the rail first
  const evalUrl = async () => {
    const r = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(''), 15000);
      const onMsg = (m) => {
        const o = JSON.parse(m.data);
        if (o.id === 100) { clearTimeout(t); ws.removeEventListener('message', onMsg); resolve((o.result && o.result.value) || ''); }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: 100, method: 'Runtime.evaluate',
        params: { expression: "JSON.stringify({ onBrowser: !!document.querySelector('.browser-url'), url: (document.querySelector('.browser-url')||{}).value || '' })", returnByValue: true } }));
    });
    return r;
  };
  let state = { onBrowser: false, url: '' };
  for (let attempt = 0; attempt < 5; attempt++) {
    const s1 = await evalUrl();
    const parsed = s1 ? JSON.parse(s1) : null;
    if (parsed && parsed.url && parsed.url.includes('example.com')) { state = parsed; break; }
    if (parsed) state = parsed;
    if (parsed && !parsed.onBrowser) { state = parsed; break; } // need rail click below
    await sleep(1500);
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
    state = s2 ? JSON.parse(s2) : state;
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
    if (want('browser') && !NO_BROWSER) await sectionBrowser();
  } catch (e) {
    console.error('SECTION ERROR: ' + e.message);
    results.push({ name: 'suite', pass: false, detail: e.message });
  }
  const failed = results.filter((r) => !r.pass);
  console.log('\n== ' + (results.length - failed.length) + '/' + results.length + ' passed ==');
  process.exit(failed.length ? 1 : 0);
})();
