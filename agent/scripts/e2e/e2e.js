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
const PW_DIR = process.env.VALE_PW_DIR || 'D:\\Vale\\components\\playwright';
// Layout v2 (ADR 0008): AI evidence lives under DataDir\pwout (was the
// install-root pwout\). Pre-migration devices: VALE_EVIDENCE_DIR override
// (same pattern as VALE_PW_DIR above).
const EVIDENCE_DIR = process.env.VALE_EVIDENCE_DIR || 'C:\\ProgramData\\Vale\\pwout';

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
  // ASCII-only separator: the device console is GBK (cp936) — a UTF-8
  // em-dash here mojibakes to `鈥?` in PowerShell transcripts. Same for
  // detail: OS error strings arrive in Chinese ("系统找不到指定的文件")
  // and PowerShell's `>` redirect decodes node UTF-8 output as GBK,
  // baking mojibake into the log — sanitize to printable ASCII.
  const safe = String(detail || '').replace(/[^\x20-\x7E]/g, '?');
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  -- ' + safe : ''));
}

// ── 1. terminal: session execute + background collect ──────────────────────
// + interaction checks: list/resize/write+screen/bad-session/history.
async function sectionTerminal() {
  const sid = await tool('terminal_open', { kind: 'pty' });
  if (typeof sid !== 'string' && !(sid && sid.sid)) throw new Error('terminal_open bad result');
  const sessionId = typeof sid === 'string' ? sid : sid.sid;
  await sleep(2500); // let the shell boot (first-prompt gate)
  const ls = await tool('terminal_list', {});
  const lsArr = Array.isArray(ls) ? ls : (ls && ls.sessions) || [];
  check('terminal list contains session', lsArr.some((s) => (s && s.id) === sessionId || s === sessionId),
    'sessions=' + lsArr.length);
  const rs = await tool('terminal_resize', { session_id: sessionId, rows: 30, cols: 120 });
  check('terminal resize ok', rs === 'OK', String(rs).slice(0, 20));
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
  // keystroke path (not execute): write raw text + CRLF, the shell runs it
  // and terminal_screen (tail view) must show the echo.
  const wmarker = 'E2E-WRITE-' + Date.now();
  const wr = await tool('terminal_write', { session_id: sessionId, data: 'Write-Output "' + wmarker + '"\r\n' });
  check('terminal write ok', wr === 'OK', String(wr).slice(0, 20));
  await sleep(3000);
  const sc = await tool('terminal_screen', { session_id: sessionId });
  const screen = typeof sc === 'string' ? sc : (sc.screen || '');
  check('terminal screen shows write', screen.includes(wmarker), 'len=' + screen.length);
  // unknown session must report evicted (not throw, not empty-ok).
  const bad = await tool('terminal_read', { session_id: 'no-such-session-e2e' });
  check('terminal read unknown evicted', !!(bad && bad.evicted === true), JSON.stringify(bad).slice(0, 60));
  await tool('terminal_close', { session_id: sessionId }).catch(() => {});
  // closed sessions stay queryable via history (audit/retain path).
  const hist = await tool('terminal_history', {});
  const histArr = Array.isArray(hist) ? hist : [];
  const hrow = histArr.find((h) => h && h.id === sessionId);
  check('terminal history retains closed', !!(hrow && hrow.status === 'closed'), hrow ? hrow.status : 'missing');
}

// ── 2. file: stat + append-up + paged raw read down ────────────────────────
async function sectionFile() {
  const path = EVIDENCE_DIR + '\\e2e_suite_transfer.bin';
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
  // list must show the uploaded file (same dir the suite writes to).
  const fl = await tool('system_file_list', { path: EVIDENCE_DIR });
  const entries = (fl && fl.entries) || [];
  check('file list contains upload', entries.some((e) => (e.name || '').includes('e2e_suite_transfer.bin')),
    'entries=' + entries.length);
  // missing path is a data-shaped {ok:false}, not a transport error.
  const miss = await tool('system_file_stat', { path: EVIDENCE_DIR + '\\e2e_no_such_file_xyz' });
  check('file stat missing ok:false', !!(miss && miss.ok === false), (miss && miss.error || '').slice(0, 60));
  // text mode (not just base64 pages): write text, read it back as text.
  const tpath = EVIDENCE_DIR + '\\e2e_suite_text.txt';
  const tw = await tool('system_file_write', { path: tpath, text: 'E2E-TEXT-OK' });
  check('file text write', !!(tw && tw.ok !== false), '');
  const tr = await tool('system_file_read', { path: tpath });
  check('file text read', !!(tr && (tr.text || '').includes('E2E-TEXT-OK')), 'bytes=' + (tr && tr.bytes));
  require('fs').unlinkSync(path);
  require('fs').unlinkSync(tpath);
}

// ── 3. workflow: cross-plugin chain ─────────────────────────────────────────
async function sectionWorkflow() {
  const pl = await tool('system_process_list', { name: 'electron' });
  const n = pl && pl.processes ? pl.processes.length : (Array.isArray(pl) ? pl.length : -1);
  check('workflow process_list', n >= 0, 'electron procs=' + n);
  const ex = await tool('terminal_execute', { command: 'echo E2E-WF-1', timeout_secs: 15 });
  check('workflow local execute', !!(ex && (ex.text || '').includes('E2E-WF-1')), '');
  const cfg = JSON.stringify({ e2e: true, ts: Date.now() });
  const fw = await tool('system_file_write', { path: EVIDENCE_DIR + '\\e2e_wf.json', text: cfg });
  check('workflow file_write', !!(fw && fw.ok !== false), '');
  const st = await tool('system_file_stat', { path: EVIDENCE_DIR + '\\e2e_wf.json' });
  check('workflow file_stat', st && st.size === Buffer.byteLength(cfg), 'size=' + (st && st.size));
  const tok = 'toolchain-' + Date.now();
  const ms = await tool('memory_save', {
    title: 'E2E suite marker', content: tok, tags: ['e2e', 'suite'],
  });
  check('workflow memory_save', !!(ms && ms.ok !== false && ms.id), 'id=' + (ms && ms.id));
  const mq = await tool('memory_search', { query: 'E2E suite marker' });
  check('workflow memory_search', !!(mq && mq.results && mq.results.length > 0), 'hits=' + (mq && mq.results && mq.results.length));
  // list must enumerate the saved entry (newest-first, no filter).
  const ml = await tool('memory_list', { limit: 50 });
  check('workflow memory_list', !!(ml && ml.results && ml.results.some((r) => r && r.id === (ms && ms.id))),
    'rows=' + (ml && ml.results && ml.results.length));
  // update the entry, then prove the new token is searchable.
  const tok2 = 'toolchain-upd-' + Date.now();
  const mu = await tool('memory_update', { id: ms && ms.id, content: tok2 });
  check('workflow memory_update', !!(mu && mu.ok !== false), '');
  const mq2 = await tool('memory_search', { query: tok2 });
  check('workflow memory_search updated', !!(mq2 && mq2.results && mq2.results.length > 0), 'hits=' + (mq2 && mq2.results && mq2.results.length));
  // export must include the entry (JSONL backup path).
  const me = await tool('memory_export', {});
  check('workflow memory_export', !!(me && me.lines >= 1 && String(me.export || '').includes(ms && ms.id)),
    'lines=' + (me && me.lines));
  // self-clean: delete the marker so repeated runs don't accumulate entries
  // (device-caught round-294: memory_search hits grew across runs)
  if (ms && ms.id) await tool('memory_delete', { id: ms.id }).catch(() => {});
  // ... and prove the delete took (search the unique token → zero hits).
  const mq3 = await tool('memory_search', { query: tok2 });
  check('workflow memory_delete verified', !!(mq3 && mq3.results && mq3.results.length === 0),
    'hits=' + (mq3 && mq3.results && mq3.results.length));
  require('fs').unlinkSync(EVIDENCE_DIR + '\\e2e_wf.json');
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
  // Poll (not fixed sleep) for the navigate to become visible on CDP: after
  // a transport switch the view can still show the previous probe's page
  // for several seconds (device-caught: http probe kept seeing the stdio
  // probe's iana.org landing past the old fixed 6s sleep). Same predicate,
  // more time — mirrors the click poll below.
  let embedded = null;
  let list = [];
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    try {
      list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
      embedded = list.find((t) => !t.url.includes('/desktop/'));
      if (embedded && embedded.url.includes(marker)) break;
    } catch {}
  }
  const spaOk = list.some((t) => t.url.includes('/desktop/'));
  check('mcp ' + tag + ' drives embedded view', embedded && embedded.url.includes(marker), (embedded && embedded.url.slice(0, 60)) || 'NO VIEW');
  check('mcp ' + tag + ' SPA intact', spaOk, 'targets=' + list.length);
  // round-313: AI INTERACTION (not just navigation) must drive the view:
  // snapshot example.com, click "Learn more", the embedded view follows to
  // iana.org (playwright-mcp browser_click takes {target} = the snapshot ref).
  // The marker URL above is example.com/<marker> (404 page, no links) —
  // navigate to the example.com HOMEPAGE first so the snapshot has links.
  await tool('mcp_client_call', { tool: 'browser_navigate', arguments: { url: 'https://example.com/' } });
  await sleep(3000);
  // Deterministic click target: inject a big same-origin link and click IT
  // (a real snapshot-ref mouse click driving a real navigation — the
  // round-313 proof). The external "Learn more" link's cross-origin
  // redirect chain flakes under load (device-caught: ok clicks with valid
  // geometry that never commit, while same-origin clicks land in seconds).
  // Falls back to Learn more when injection yields no ref.
  await tool('mcp_client_call', { tool: 'browser_evaluate', arguments: { function: "() => { document.body.innerHTML = '<a id=e2e href=/inner-click-test style=display:block;font-size:40px;padding:60px>E2E-INNER-LINK</a>'; return 'INJECTED'; }" } }).catch(() => null);
  await sleep(1000);
  // Snapshot + click + poll, up to 2 attempts with a FRESH snapshot each
  // time: under contention (parallel drivers on one box) a click can land
  // while the view is mid-navigation and silently do nothing (device-caught:
  // back-to-back misses with valid geometry, manual retry navigates fine).
  // The proof stays strict — a real click must still drive the navigation.
  let clickOk = false;
  let clickRef = null;
  let clickWant = 'inner-click-test';
  let emb2 = null;
  for (let attempt = 0; attempt < 2 && !(emb2 && (emb2.url.includes('inner-click-test') || emb2.url.includes('iana.org'))); attempt++) {
    if (attempt > 0) await sleep(3000);
    const snap = await tool('mcp_client_call', { tool: 'browser_snapshot', arguments: {} });
    const snapTxt = JSON.stringify(snap);
    // Prefer the injected link; fall back to "Learn more". NOTE: snapTxt is
    // JSON.stringify'd, so inner quotes are escaped \" and the text is
    // double-escaped (\\") — match the ref after the label without
    // depending on the exact quote escaping.
    let lmIdx = snapTxt.indexOf('E2E-INNER-LINK');
    let refMatch = lmIdx >= 0 ? /\[ref=(\w+)\]/.exec(snapTxt.slice(lmIdx, lmIdx + 200)) : null;
    if (!refMatch) {
      lmIdx = snapTxt.indexOf('Learn more');
      refMatch = lmIdx >= 0 ? /\[ref=(\w+)\]/.exec(snapTxt.slice(lmIdx, lmIdx + 200)) : null;
      if (refMatch) clickWant = 'iana.org';
    }
    clickRef = refMatch && refMatch[1];
    if (clickRef) {
      const cl = await tool('mcp_client_call', { tool: 'browser_click', arguments: { target: clickRef } });
      clickOk = clickOk || !!(cl && cl.ok);
    }
    // Poll for the navigation (slow loads committed after the old fixed 5s
    // sleep flaked 16/18 on 1.2.297 — same predicate, more time).
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      try {
        const list2 = await (await fetch('http://127.0.0.1:9333/json/list')).json();
        emb2 = list2.find((t) => !t.url.includes('/desktop/'));
        if (emb2 && (emb2.url.includes('inner-click-test') || emb2.url.includes('iana.org'))) break;
      } catch {}
    }
  }
  check('mcp ' + tag + ' click learn-more', clickOk, 'ref=' + clickRef + ' want=' + clickWant);
  const clickDrove = !!(emb2 && (emb2.url.includes('inner-click-test') || emb2.url.includes('iana.org')));
  if (!clickDrove) {
    // Geometry triage (diagnostic only, not a check): a physical click
    // that misses for viewport reasons looks identical to a broken click
    // path — log viewport + link rect so the next failure is instantly
    // triaged instead of needing a CDP probe round-trip.
    console.log('  [triage] click missed; geometry:', await clickGeom());
  }
  check('mcp ' + tag + ' click drives embedded view', clickDrove, (emb2 && emb2.url.slice(0, 60)) || 'NO VIEW');
  await tool('mcp_client_disconnect', {}).catch(() => {});
}

// Best-effort CDP geometry snapshot for click-miss triage (see above).
// Never throws, never affects check counts — returns a log string.
async function clickGeom() {
  if (typeof WebSocket === "undefined") return "no-websocket (node < 22)";
  let ws = null;
  try {
    const l = await (await fetch('http://127.0.0.1:9333/json/list')).json();
    const t = l.find((x) => !x.url.includes('/desktop/'));
    if (!t) return "no-view";
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await Promise.race([
      new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", rej, { once: true });
      }),
      sleep(10000).then(() => { throw new Error("ws-timeout"); }),
    ]);
    let seq = 0;
    const pend = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    });
    const send = (method, params) => new Promise((res, rej) => {
      seq += 1;
      pend.set(seq, res);
      ws.send(JSON.stringify({ id: seq, method, params }));
      sleep(10000).then(() => { if (pend.has(seq)) { pend.delete(seq); rej(new Error("cdp-timeout")); } });
    });
    const r = await send("Runtime.evaluate", {
      expression: "JSON.stringify((() => { const a = [...document.querySelectorAll('a')].find((x) => x.textContent.trim() === 'Learn more'); if (!a) return null; const b = a.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), vw: window.innerWidth, vh: window.innerHeight }; })())",
      returnByValue: true,
    });
    ws.close();
    ws = null;
    return (r.result && r.result.result && r.result.result.value) || "no-link";
  } catch (e) {
    try { ws && ws.close(); } catch {}
    return "geom-error:" + String((e && e.message) || e).slice(0, 80);
  }
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
    "  await view.screenshot({ path: '" + EVIDENCE_DIR.replace(/\\/g, '\\\\') + "\\\\" + name + "' });",
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
  try { require('fs').unlinkSync(EVIDENCE_DIR + '\\' + name); } catch (e) { /* best-effort */ }
}

async function sectionBrowser() {
  // pwinfo: the bundled-runtime discovery every AI client starts from.
  const pi = await tool('browser_pw_info', {});
  check('browser pwinfo bundled', !!(pi && pi.pw_dir && pi.playwright_core_version),
    'core=' + (pi && pi.playwright_core_version));
  // fail path: a throwing script must report exit_code != 0 (bounded runner
  // surfaces the error instead of hanging until timeout).
  const fail = await tool('browser_run_script', {
    script: "(async () => { console.log('E2E-FAIL-PATH'); throw new Error('e2e-intentional'); })().catch(e => { console.log('FAIL:' + e.message); process.exit(1); });",
    timeout_secs: 60,
  });
  const fout = (fail && fail.stdout || '') + (fail && fail.stderr || '');
  check('browser_run_script fail path', !!(fail && fail.exit_code !== 0 && fout.includes('FAIL:e2e-intentional')),
    'exit=' + (fail && fail.exit_code));
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

  // Focus-trap regression: FOCUS the address bar without typing (the stuck
  // state is focus-without-blur — e.g. the user clicked the bar then the
  // native view, whose clicks never fire SPA blur), drive a navigation, and
  // require the bar to follow WITHOUT re-entering the panel. Pre-fix the
  // push is dropped and the bar stays stale.
  {
    const marker = 'focus-trap-' + Date.now();
    const list3 = await (await fetch('http://127.0.0.1:9333/json/list')).json();
    const spa3 = list3.find((t) => t.url.includes('/desktop/'));
    if (!spa3) {
      check('browser focus-trap bar follows', false, 'no desktop SPA target');
    } else {
      const ws3 = new WebSocket(spa3.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws3.onopen = res; ws3.onerror = rej; });
      const eval3 = (id, expression) => new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 15000);
        const onMsg = (m) => {
          const o = JSON.parse(m.data);
          if (o.id === id) { clearTimeout(t); ws3.removeEventListener('message', onMsg); resolve(o); }
        };
        ws3.addEventListener('message', onMsg);
        ws3.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
      const rawOf = (r) => {
        try {
          const raw = r && r.result && r.result.result && r.result.result.value;
          return raw !== undefined && raw !== null ? raw : null;
        } catch (e) { return null; }
      };
      await eval3(300, "(function(){ var el = document.querySelector('.browser-url'); if (!el) return 'no-bar'; el.focus(); return 'focused'; })()");
      const fscript = [
        "const { chromium } = require('" + PW_DIR.replace(/\\/g, '/') + "/node_modules/playwright');",
        "(async () => {",
        "  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 10000 });",
        "  const pages = browser.contexts().flatMap(c => c.pages());",
        "  const view = pages.find(p => !p.url().includes('/desktop/'));",
        "  if (!view) { console.log('NO_VIEW'); await browser.close(); return; }",
        "  await view.goto('https://example.com/" + marker + "');",
        "  console.log('NAV-OK');",
        "  await browser.close();",
        "})().catch(e => { console.log('FAIL:' + String(e).slice(0, 200)); process.exit(1); });",
      ].join('\n');
      await tool('browser_run_script', { script: fscript });
      let barOk = false;
      let barVal = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        const raw = await eval3(310 + attempt, "JSON.stringify({ url: (document.querySelector('.browser-url')||{}).value || '' })");
        try {
          const parsed = rawOf(raw) ? JSON.parse(rawOf(raw)) : null;
          barVal = (parsed && parsed.url) || '';
          if (barVal.includes(marker)) { barOk = true; break; }
        } catch (e) {}
        await sleep(2000);
      }
      // Restore: blur the bar so later runs/sections start from a clean state.
      await eval3(399, "(function(){ var el = document.querySelector('.browser-url'); if (el) el.blur(); return 'ok'; })()");
      await new Promise((resolve) => {
        ws3.onclose = resolve;
        setTimeout(() => { try { ws3.close(); } catch (e) {} }, 100);
        setTimeout(resolve, 3000);
      });
      check('browser focus-trap bar follows', barOk, 'bar=' + barVal.slice(0, 60));
    }
  }
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
