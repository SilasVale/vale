// console-run.cjs — the console sweep's DEVICE-SIDE program, as a real module (round 268).
//
// It was a 484-line template literal in console-design-sweep.mjs — 74% of that file — with sixteen interpolations
// (nine passes via `.toString()`, four probes and the page checks via `JSON.stringify`, `${DIAG_SOURCE}` as code, the
// baked entry stamp, the pass list). The landing and the panel moved first (rounds 266-267); this is the same move:
// the program is ordinary code, the run-varying values arrive as the generated pieces module beside it, and the
// assembler resolves the payload's own requires and compiles what it returns.
const P = require("./pieces.cjs");

const fs = require("fs");
const path = require('path');
// WHERE IT READS THE BUILT UI IS OVERRIDABLE, so the same sweep runs on the device (the default, exactly
// as before) or in CI against the repository's own build with nothing delivered in between — which is
// what makes the design checks continuous rather than remembered (rounds 204, 219). The panel's sweep
// has taken its paths from the environment since round 204; these two follow it.
const ROOT = process.env.SUMMRISE_SWEEP_ROOT || P.config.root;
const REPORT_PATH = process.env.SUMMRISE_SWEEP_REPORT || P.config.reportPath;

// THE ENTRY THIS SWEEP WAS EMITTED AGAINST. Both UIs are measured from a DELIVERED copy of their
// build, and nothing said which generation it was: round 184 found the console's directory holding eight
// files from four generations, and round 189 lost an afternoon to a stale PANEL harness whose collapsed
// tab strip read as a live regression. The panel's harness now stamps itself; these two carry the entry's
// digest instead, because a stale delivery always shows up in the file that names everything else.
const EXPECTED_ENTRY = P.config.expectedEntry;
// DERIVED FROM ROOT, NOT BAKED. Round 191 wrote this as the device path, so when round 219 made ROOT
// overridable the check kept looking at C:ProgramDataSummrise while the sweep served the repository — and
// CI reported ENOENT for a file that was right there. A check that names a location must follow the same
// override the thing it checks does.
const EXPECTED_ENTRY_PATH = path.join(ROOT, "index.html");
const PROBE = P.probe;
const UNSTYLED = P.unstyled;
const focusPass = P.passes.focusPass;
const pressDelta = P.passes.pressDelta;
const pressPass = P.passes.pressPass;
const ACK_BUDGET_MS = 100;
// AND THE ACK PASS (round 190). Same helper the panel uses, embedded the same way: it times the gap between a
// press and the first visible acknowledgement against the stated budget, and with discover it asks the DOM for every
// visible control instead of a list somebody thought of.
const ackPass = P.passes.ackPass;
const ackNotes = P.passes.ackNotes;
// AND THE HELPER pressPass CALLS: it asks the DOM for the page's controls. A borrowed helper that calls another
// one needs that one embedded too, or the run dies on the device with "is not defined" — the failure the emitted
// check below exists for.
const discoverPressTargets = P.passes.discoverPressTargets;
const idlePass = P.passes.idlePass;
const TARGETS = P.targets;
const THEME = P.theme;
// THE SWEEP REPORTS ITSELF TO THE AGENT'S DIAGNOSTIC RING, so a caller whose tool call timed out can tell
// a run that is still working from one that was killed (round 181 lost half an hour to exactly that).
const diag = P.diag;
const motionPass = P.passes.motionPass;
const { SURFACE, NAMES, REFLOW } = P.checks;
// THE ROOT SELECTOR IS AN ARGUMENT TO THE PROBES (round 271): it used to be substituted into their source text,
// which is how a Node-side identifier once reached page code. The mark axis travels with the surface probe's
// result, so it is evaluated alongside it and merged in, exactly where it used to be spliced.
const MARKS = P.marks;
const SELECTOR = P.config.selector;
const PASSES = P.config.passes;
const wants = (name) => !PASSES.length || PASSES.includes('all') || PASSES.includes(name);
const now = Date.now();
// The console's own render-smoke fixtures (gateway/ui/*-render-smoke.mjs), so the browser renders the
// same pages those tests assert against in jsdom — same data, real layout, real colours.
const API = {
  '/api/me': { username: 'admin', role: 'admin', token: 'tok-abc', keys: { DEEPSEEK_API_KEY: { configured: true, masked: 'sk-1' } } },
  '/api/me/keys': { keys: [
    { name: 'DEEPSEEK_API_KEY', configured: true, masked: 'sk-1', usage: 12 },
    { name: 'OPENAI_API_KEY', configured: false, masked: '', usage: 0 },
  ] },
  '/api/me/route': { effective: 'og/deepseek/deepseek-v4.1-flash' },
  '/api/me/usproxy': { enabled: false },
  '/api/status': { ok: true, version: '1.0.106' },
  '/api/version': { version: '1.0.106' },
  '/api/devices': { devices: [
    { name: 'd1', hostname: 'd1.agent.saisi.online', token: 'a1b2c3d4e5f6g7h8', registeredAt: now - 86400000, lastSeenAt: now - 60000, lastVersion: '1.0.106' },
    { name: 'd2', hostname: 'd2.agent.saisi.online', token: 'z9y8x7w6v5u4t3s2', lastVersion: '1.0.100' },
  ] },
  '/api/devices/install-cmd': { ok: true, version: '1.0.106', download: 'https://v.saisi.online/summrise-agent-latest.tgz' },
  '/api/devices/register-keys': { keys: [{ code: 'abcd1234', expiresAt: now + 3600000 }] },
  // THE FIELD THE PAGE ACTUALLY READS (round 53 of the standing goal). This said verdict: 'crashed', and
  // DevicesPanel reads st?.last_boot_kind === "crashed" — a field name the page does not read is a fixture saying
  // something nothing hears, so the crash row never rendered and sig-dot.err (ONE OF THREE STATES in that family) had
  // no surface in 136 sweeps. The gateway sends the real pair (plugins/mcp.ts forwards the probe's
  // lastBootKind/lastBoot), which is why this is a FIXTURE fix and not a product one: measured before changing it.
  // THE PUBLIC ROUTES, WHICH THE MODELS PAGE CANNOT RENDER WITHOUT (round 57 of the standing goal). Its provider rows
  // come from api.getPublicRoutes() (/api/admin/public), and Models.tsx sets failed when info.models is empty
  // — so with no fixture for this endpoint the page rendered its failure banner and NO ROWS, which is why prov-dot
  // (two declared states) had no surface in 136 sweeps while every other check stayed green. The body is the one the
  // console's own models-render-smoke.mjs uses, which is what this fixture table claims to be: the same /api bodies
  // the render smokes assert against in jsdom. my/ pairs with the provider below it (keyReady) so prov-dot.ok
  // renders, and the og/ + none rows give prov-dot.missing.
  // ONE ENTRY, NOT TWO (round 59). This key was in the table TWICE: the body below, and a later { enabled: false }
  // stub — and in a JS object literal the LAST key wins, so the real body never reached the page. Models.tsx needs
  // models/routes (it sets failed without them) while something else read enabled, so both fields live here.
  // A duplicate key in a fixture table is the two-copies-of-one-fact defect this objective exists to remove, and this
  // one was MINE: round 57 added the body without checking whether the key already existed.
  '/api/admin/public': {
    enabled: false,
    models: ['og/deepseek/deepseek-v4.1-flash', 'my/llama-3', 'deepseek/deepseek-v4.1-flash'],
    // or/ IS THE ROW THE OTHER DOT STATE NEEDS (round 62): /api/health already reports that channel as
    // ok: false, and ready = h?.ok !== false is what turns that into prov-dot.missing. Without a route for it the
    // failing channel had nothing to mark, which is why the family rendered only ok — a fixture that exists and no
    // row to apply it to, one step past the duplicate-key bug that hid the whole page.
    routes: [
      { prefix: 'og/', backend: 'og', models: ['deepseek/deepseek-v4.1-flash'] },
      { prefix: 'my/', backend: 'my', models: ['llama-3'] },
      { prefix: 'or/', backend: 'or', models: ['deepseek/deepseek-v4.1-flash'] },
      { prefix: 'none', backend: '', models: ['deepseek/deepseek-v4.1-flash'] },
    ],
  },
  '/api/plugins/status': { devices: { d1: { online: false, agent_up: true, tunnel_up: true, version: '1.0.106', checked_at: now, last_boot_kind: 'crashed', last_boot: 'run journal: previous run DID NOT EXIT CLEANLY — CRASHED or was killed; survived 61s' } } },
  // ALL FOUR CHANNELS, because the lane rules are per-channel: with only 'og' in the fixture the
  // three fills that do NOT flip with the theme never render, and a contrast fix for them could not
  // be seen. Measured round 79 — the ink/fill pairing differs per lane on purpose.
  // THE CHANNELS ARE KEYED BY id, WHICH IS WHAT THE PAGE READS (round 64): Models.tsx looks a row's health up with
  // health.find((h) => h.id === prefix || h.id === prefix.replace(//$/, "")), and this fixture wrote prefix:
  // instead — so every lookup missed, h was undefined, h?.ok !== false was TRUE, and prov-dot.missing could not
  // render however many failing channels the fixture carried. (or/ is the failing one; the others are healthy.)
  '/api/health': { channels: [
    { id: 'og/', ok: true },
    { id: 'ds/', ok: true },
    { id: 'or/', ok: false },
    { id: 'qw/', ok: true },
  ] },
  '/api/admin/providers': { providers: [{ prefix: 'my/', label: 'My Provider', baseURL: 'https://api.example.com', api: 'openai-completions', models: [{ id: 'llama-3' }], advertised: ['my/llama-3'], keyEnv: '', keyMasked: 'sk-9876', keyReady: true }], apis: [], filePrefixes: [] },
  '/api/admin/models': { models: [{ id: 'my/llama-3', label: 'llama-3' }] },
  '/api/admin/catalogue': { models: [{ id: 'my/llama-3', label: 'llama-3' }] },
  '/api/admin/users': { users: [{ username: 'operator', role: 'admin', createdAt: now - 86400000 }, { username: 'guest', role: 'user', createdAt: now - 3600000 }] },
};
// The console's own route table (gateway/ui/src/App.tsx) — every authenticated page it has.
const PAGES = [
  ['overview', '#/'],
  ['devices', '#/devices'],
  ['models', '#/models'],
  ['keys', '#/keys'],
  ['routes', '#/routes'],
  ['users', '#/users'],
];
const auth = { signedIn: true };

// AN EMPTY FLEET, which the console has never been measured in: the fixture table carries two devices and
// two keys, so every surface has always been rendered with content. A console with nothing registered is a
// real state (a fresh deployment) and the one most likely to have an undesigned blank pane. The route
// handler consults this, and every other fixture is untouched so the two passes differ in exactly one way.
const empty = { fleet: false };
// EVERY API CALL FAILS, for the pass that renders the console's error surfaces. Same shape as the empty and
// auth flags: a flag the route handler reads, not a fixture. The panel has had this since round 160 (?fail=1) and
// the console never did — so nothing had rendered what an operator sees when the worker cannot reach a device.
const fail = { api: false };
(async () => {
  const { acquireBrowser } = require(process.env.SUMMRISE_BROWSER_HELPER);
  const { page, close } = await acquireBrowser();

  // ── THE SAME TWO INSTRUMENTS THE PANEL HAS HAD SINCE ROUNDS 3-4, because this sweep is now the larger half ──────
  // The design job fell from 805-833s to 650s when the PANEL's settles stopped waiting for the clock, and this sweep
  // was left at 243s of that job with NO measurement of where its own time goes. The panel's numbers say what that
  // costs: 92.5% of its body was deliberate sleeping, and 116 fixed settles turned out to need 35.5s of the 206.2s
  // they asked for. There is no reason to expect a different answer here, and no way to know without measuring.
  //
  // THE BUDGET counts at the SOURCE — the page's own methods — rather than at the ten call sites, so a site somebody
  // forgets cannot make the number quietly wrong, and the shared passes' own waits and evaluates are caught too.
  const SWEEP_T0 = Date.now();
  const BUDGET = { wait: [0, 0], nav: [0, 0], eval: [0, 0], waitByMs: new Map() };
  const timed = (name, bucket, onCall) => {
    const original = page[name].bind(page);
    page[name] = async (...args) => {
      const t0 = Date.now();
      try { return await original(...args); } finally {
        const ms = Date.now() - t0;
        BUDGET[bucket][0]++;
        BUDGET[bucket][1] += ms;
        if (onCall) onCall(args[0], ms);
      }
    };
  };
  timed("waitForTimeout", "wait", (asked, real) => {
    const key = String(asked);
    const entry = BUDGET.waitByMs.get(key) || [0, 0];
    entry[0]++;
    entry[1] += real;
    BUDGET.waitByMs.set(key, entry);
  });
  timed("goto", "nav");
  timed("reload", "nav");
  timed("evaluate", "eval");

  // ── AND A SETTLE THAT WAITS FOR THE PAGE INSTEAD OF FOR THE CLOCK, CAPPED AT THE OLD VALUE ─────────────────────
  // Eight of the ten waits here are settle-shaped (1600ms x5, 1400, 1500, 1800) and every one follows a hash change
  // or a theme set — the SPA re-rendering — so the condition is the same one the panel uses and `idlePass` already
  // trusts: no DOM mutation for QUIET_MS means the page has stopped filling in. The cap is what makes it safe: a page
  // that never goes quiet waits exactly as long as it does today, and `capped` counts how often.
  //
  // ONE DIFFERENCE FROM THE PANEL, and it is the page's: the console navigates by `location.hash`, which does NOT
  // destroy the document, so the observer is installed ONCE and its clock is reset per settle. (The panel reloads, so
  // its observer is necessarily re-created each time; installing a second one there would have leaked.)
  const QUIET_MS = 250;
  const SETTLE = { calls: 0, asked: 0, needed: 0, capped: 0 };
  const settle = async (asked) => {
    SETTLE.calls++;
    SETTLE.asked += asked;
    const t0 = Date.now();
    try {
      await page.evaluate(() => {
        if (!window.__quietObs) {
          window.__quietObs = new MutationObserver(() => { window.__quiet.last = Date.now(); });
          window.__quietObs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        }
        window.__quiet = { last: Date.now() };
      });
      await page.waitForFunction((q) => !!window.__quiet && Date.now() - window.__quiet.last >= q, QUIET_MS, { timeout: asked });
    } catch (e) {
      // ONLY A TIMEOUT IS THE CAP. Anything else is a real failure and must not be absorbed into a counter.
      if (!/Timeout|timeout/i.test(String(e && e.message))) throw e;
      SETTLE.capped++;
    }
    SETTLE.needed += Date.now() - t0;
  };

  // ── THE REQUEST COUNTER, WITHOUT WHICH THIS SWEEP'S ACKNOWLEDGEMENT EXCUSE WAS ALWAYS ON ────────────────────────
  // `ackPass` decides whether a control that never showed a busy state had ASKED THE DEVICE ANYTHING, and it reads
  // `window.__calls` to answer that. Only the PANEL's fixture installs one (`panel-stub.cjs`), so on the console
  // `(window.__calls || []).length` was ALWAYS 0 — `asked` was always false, every non-acked row carried the note "no
  // request left this page in the 250ms after the press (0 of 0 in the whole window)", and the shared judge excused it.
  // **A CONSOLE CONTROL THAT NEVER ACKNOWLEDGED A PRESS COULD NEVER FAIL THE RUN** (round 11 of the standing goal):
  // the gap round 2 set out to close, arriving from the other side — that round gave the console a judge clause, and
  // this clause's excuse was structurally on for every row it would ever see. It is the shape this suite keeps finding:
  // a check whose premise was never installed reads exactly like a clean one.
  //
  // INSTALLED THE WAY THE PANEL'S STUB INSTALLS IT — a count of `/api/` fetches with a time beside each, because a
  // bare count cannot tell a control's own request from a background one on a page that polls (round 26). It goes in
  // through `addInitScript`, so it is present before the app's first line runs on every navigation, and the app's own
  // `fetch` is wrapped rather than replaced: the route handler below still serves every response.
  await page.addInitScript(() => {
    window.__calls = [];
    window.__callTimes = [];
    const real = window.fetch.bind(window);
    window.fetch = (...args) => {
      try {
        const u = String((args[0] && args[0].url) || args[0] || "");
        if (u.indexOf("/api/") >= 0) {
          window.__calls.push(u.replace(/^.*\/api\//, ""));
          window.__callTimes.push(Date.now());
        }
      } catch (e) {}
      return real(...args);
    };
  });

  await page.route('https://ai.saisi.online/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    // The login page exists only when /api/me answers 401, so it gets its own pass with the flag
    // flipped — not a fixture.
    if (auth.signedIn === false && p === '/api/me') {
      return route.fulfill({ status: 401, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ type: 'error', error: { message: 'unauthorized' } }) });
    }
    // /api/me IS EXEMPT, AND THAT IS THE WHOLE DIFFERENCE BETWEEN AN ERROR STATE AND A LOGIN PAGE. Failing every
    // call made the app believe nobody was signed in, so all six pages rendered the login screen — which has no
    // nav by design, and the first run of this pass reported exactly that six times. The panel's ?fail=1 fails
    // DEVICE calls, never auth; this does the same. The login page has its own pass.
    if (fail.api && p.startsWith('/api/') && p !== '/api/me') {
      return route.fulfill({ status: 500, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ type: 'error', error: { message: 'the device is unreachable' } }) });
    }
    if (p.startsWith('/api/')) {
      let body = API[p] === undefined ? {} : API[p];
      if (empty.fleet && p === '/api/devices') body = { devices: [] };
      if (empty.fleet && p === '/api/me/keys') body = { keys: [] };
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    }
    const file = p === '/' || p === '' ? 'index.html' : p.replace(/^\//, '');
    const full = path.join(ROOT, file);
    const body = fs.existsSync(full) ? fs.readFileSync(full) : fs.readFileSync(path.join(ROOT, 'index.html'));
    const ext = path.extname(full);
    const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.svg' ? 'image/svg+xml' : 'text/html; charset=utf-8';
    return route.fulfill({ status: 200, contentType: type, headers: { 'cache-control': 'no-store' }, body });
  });
  await diag("start console pid=" + process.pid);
  const report = { rows: [], surfaces: [], names: [], focus: [], press: [], idle: [], reflow: [], hover: [], unstyled: [], motion: [], targets: [], themeChecks: [] , entryCheck: (() => { try { const b = fs.readFileSync(EXPECTED_ENTRY_PATH); const c = require("crypto").createHash("sha256").update(b).digest("hex").slice(0, 12); return { bytes: b.length, sha: c, expected: EXPECTED_ENTRY, stale: b.length !== EXPECTED_ENTRY.bytes || c !== EXPECTED_ENTRY.sha }; } catch (e) { return { error: String(e.message).slice(0, 60), expected: EXPECTED_ENTRY, stale: true }; } })() };
  // THE CONSOLE IN DARK. It has a dark theme — body[data-theme=dark], applied before the first paint and
  // persisted in localStorage — and every section of this sweep hardcoded theme: 'light', so a dark
  // regression has been invisible here for as long as the sweep has existed. Round 175 found the same gap in
  // the panel's fixture surfaces; this is the second home, and it is being done before it costs anything.
  // ONE WIDTH, not all three: 1440 is where the console is used, and three widths of dark would double a run
  // that already takes minutes for a difference that width does not create.
  for (const [label, hash] of (wants('dark') ? PAGES : [])) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('https://ai.saisi.online/?cb=' + Date.now(), { waitUntil: 'load' });
    await page.evaluate((h) => {
      try { localStorage.setItem('summrise-theme', 'dark'); } catch (e) {}
      document.body.setAttribute('data-theme', 'dark');
      location.hash = h;
    }, hash);
    await settle(1600);
    // READ IT OFF THE PAGE rather than trusting the instruction (round 176's lesson).
    report.themeChecks.push({ page: label + '-dark', intended: 'dark', ...(await page.evaluate(THEME)) });
    const rows = await page.evaluate(PROBE);
    for (const r of rows) report.rows.push({ ...r, page: label + '-dark', width: 1440, density: 'console', theme: 'dark' });
    report.surfaces.push({ page: label + '-dark', width: 1440, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
    report.names.push({ page: label + '-dark', ...(await page.evaluate(NAMES, SELECTOR)) });
    // THE SAME WINDOW IN DARK, off the page that was just set to it. The panel's idle finding was a THEME-shaped
    // one once (the rail dot froze its paint across a flip), so the dark pass is not a formality here.
    if (wants('idle')) {
      const idle = await idlePass(page, 6000);
      report.idle.push({ page: label + '-dark', width: 1440, density: 'console', theme: 'dark', seconds: 6, ...idle });
    }
    // A FALSE POSITIVE WORTH REMEMBERING. While deciding whether this pass was needed I probed the page by
    // hand and got 4.3 for the active rail button — under AA, apparently a defect. The tested probe finds it
    // fine: the hand-rolled comparison read rgba(217, 72, 15, 0.9) as opaque and ignored what it composites
    // over, which is the ONE thing compositeStack exists to get right. The real maths is a few lines away in
    // lib/contrast-probe.mjs. Every exploratory probe of a colour should call it, because that is exactly the
    // moment the shortcut looks harmless.
    // HOVER IN DARK, on ONE page. The light hover pass found a dark-theme button at 1.94 when the PANEL
    // first ran it (round 84) — a hover colour that only exists in one theme is exactly what a
    // single-theme pass cannot see. One page rather than six: hover styles are per-class, the overview
    // carries the console's whole control vocabulary, and a full-DOM probe per hover per page would cost
    // six times what the question is worth.
    if (label === 'overview') {
      const all = await page.$$('button, [role="button"], a');
      const seenClass = new Set();
      const underAA = [];
      for (const h of all) {
        const key = await h.evaluate((el) => (typeof el.className === 'string' ? el.className : el.tagName));
        if (seenClass.has(key)) continue;
        seenClass.add(key);
        await h.hover();
        await page.waitForTimeout(40);
        for (const r of await page.evaluate(PROBE)) {
          if (r.kind !== 'graphic' && !r.inactive && r.cr < r.need) underAA.push(r.sel + ' ' + r.cr + '<' + r.need);
        }
      }
      // AND PUT THE POINTER BACK. Leaving the last hovered element under the cursor made the FOCUS pass that
      // follows measure a hovered control and report a ring that is not missing — a self-inflicted finding,
      // caught because the round's own report showed it. State must not leak between passes.
      await page.mouse.move(0, 0);
      report.hover.push({ page: 'overview-dark', width: 1440, density: 'console', theme: 'dark', interactive: all.length, underAA: [...new Set(underAA)] });
    }
  }
  await page.evaluate(() => { try { localStorage.setItem('summrise-theme', 'light'); } catch (e) {} document.body.setAttribute('data-theme', 'light'); });

  // 320 IS IN THE LIST BECAUSE WCAG 1.4.10 NAMES IT. The criterion asks whether content reflows at 320 CSS
  // pixels — 400% zoom on a 1280 viewport — and this sweep tested 1440/900/720, so its "WCAG reflow" claim was
  // measured at a width the criterion does not mention. Round 224 measured the console at 640, 480 and 320
  // before adding it, and all three are CLEAN (docOver 0); the only inner overflow is pre.mt-8, a code block
  // with its own horizontal scroller, which is the case 1.4.10 exempts for content that needs two dimensions.
  // The panel was not so lucky at 640 (round 215), and that is the point: the width a check does not render is
  // the width where a real failure can sit unremarked.
  for (const width of (wants('reflow') ? [1440, 900, 720, 640, 320] : [1440])) {
    await page.setViewportSize({ width, height: 900 });
    for (const [label, hash] of PAGES) {
      await page.goto('https://ai.saisi.online/?cb=' + Date.now(), { waitUntil: 'load' });
      await page.evaluate((h) => { location.hash = h; }, hash);
      await settle(1600);
      // ── THE REFLOW PROBE WAS IMPORTED AND NEVER RUN (round 12 of the standing goal) ─────────────────────────────
      // `REFLOW` has been destructured from the shared checks since this sweep was written, `report.reflow` has been
      // declared beside every other axis, and NOTHING EVER PUSHED A ROW — so the console's WCAG 1.4.10 claim rested on
      // round 224's HAND measurement ("640, 480 and 320 … all three are CLEAN (docOver 0)"), which nothing repeats,
      // while the panel has run this probe at 640 and 320 all along and the shared judge has a reflow clause waiting
      // for rows. The width this loop renders BECAUSE THE CRITERION NAMES IT was the width nothing asserted: a console
      // regression that scrolled sideways at 320px would have been invisible, in a sweep that renders 320px on purpose.
      // One probe per page per width, where the page is settled — the same place and the same call the panel uses.
      if (wants('reflow')) report.reflow.push({ page: label, width, ...(await page.evaluate(REFLOW, SELECTOR)) });
      if (wants('contrast')) {
        const rows = await page.evaluate(PROBE);
        for (const r of rows) report.rows.push({ ...r, page: label, width, density: 'console', theme: 'light' });
        report.surfaces.push({ page: label, width, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      }
      if (width === 1440) {
        // (a press-only run pays for this width and nothing else)
        if (wants('names')) report.names.push({ page: label, ...(await page.evaluate(NAMES, SELECTOR)) });
        // Rendered classes with no matching rule — the mirror of dead CSS, and the failure a prune
        // causes. The browser's parsed selectors are the authority (rounds 79-80 removed 300+ lines
        // from this sheet). The styled count travels with the list as the tripwire.
        if (wants('unstyled')) report.unstyled.push({ page: label, ...(await page.evaluate(UNSTYLED)) });
        // HOVER, the state round 84 added for the panel — where its first run found a dark-theme
        // button at 1.94. The console has its own 24 :hover rules and a different token set, and had
        // never been measured hovering. One element per control family, at the widest viewport only,
        // because hover styles are per-class and the cost is a full-DOM probe per hover.
        {
          const all = await page.$$('button, [role="button"], a');
          const seenClass = new Set();
          const underAA = [];
          for (const h of all) {
            const key = await h.evaluate((el) => (typeof el.className === 'string' ? el.className : el.tagName));
            if (seenClass.has(key)) continue;
            seenClass.add(key);
            const box = await h.boundingBox();
            if (!box || box.width < 2 || box.height < 2) continue;
            try {
              await h.hover({ timeout: 400 });
            } catch (e) {
              continue;
            }
            await page.waitForTimeout(90);
            for (const r of await page.evaluate(PROBE)) {
              const need = r.need ?? 4.5;
              if (r.cr !== null && !r.inactive && r.cr < need) {
                underAA.push(r.sel + ' "' + String(r.text).slice(0, 16) + '" ' + r.cr + '<' + need);
              }
            }
            await page.mouse.move(2, 2);
          }
          report.hover.push({ page: label, width, density: 'console', theme: 'light', interactive: all.length, underAA: [...new Set(underAA)] });
        }
        await page.evaluate(() => document.body.focus());
        // ONE implementation, shared with the panel and the extension (lib/design-sweep.mjs).
        if (wants('focus')) report.focus.push(await focusPass(page, 16, { page: label, width }));
        // RENDERED PRESSES — the axis the panel has had since round 51 and this console had only at SHEET level.
        // feedback-check.mjs proves an :active RULE exists; it cannot see whether the press reaches the screen, and
        // round 54 had to fix ten console controls (the rail button, the avatar, the logout item, the icon button,
        // the language button, the auth tab, .btn-dashed, .card-link, .dev-mini and every link) by reading the sheet
        // alone. This measures them as the browser paints them. The pointer is moved OFF the element before release
        // so nothing is clicked; a target this page does not render is a NOTE, and the measured count is what keeps
        // a pass that pressed nothing from reading as clean.
        // ── AND THE DOM, NOT ONLY THE LIST — WHICH ON THIS SWEEP FINDS NOTHING, AND THE REASON IS WORTH KEEPING ───
        // The argument for `discover` is this repository's own: "a list can only contain what somebody thought of, and
        // the controls that answer nothing are exactly the ones nobody thought about". It was added to the ack pass in
        // round 190 and to the PANEL's press pass in round 15, where it found `.device-logs-toggle` — a button with
        // `cursor: pointer` and no hover and no press at all, invisible to `feedback-check` (which demands a press only
        // where a HOVER exists) and absent from every curated list.
        //
        // **MEASURED HERE: `found` IS 0 ON EVERY CONSOLE PAGE** (run 364a3a3f — `5pressed/5absent/0found`,
        // `3pressed/7absent/0found`, …). `pressPass` adds the CURATED targets to the skip list by design ("the curated
        // list stays for the surfaces it was written for, and `discover` adds what the DOM knows that the list does
        // not"), and this console's curated selectors are BROAD CLASSES: `.btn` matches every button on the page, so
        // there is nothing left for the DOM to contribute. The ack pass beside it discovers eight per page because ITS
        // curated list is EMPTY — the two calls look alike and are not.
        //
        // SO THIS IS A SAFETY NET, NOT A COVERAGE INCREASE, and saying which is the difference between a measurement
        // and a claim. It costs one DOM query per page and it would catch the case the panel's did — a control whose
        // class is in nobody's list — which is the only case it can catch. The skip below is the ack pass's, for the
        // ack pass's reason: the rail button, the language button, the avatar and links are chrome the mode passes own.
        const pressRows = wants('press') ? await pressPass(page, ['.rail-btn', '.btn', '.icon-btn', '.lang-btn', '.auth-tab', '.btn-dashed', '.card-link', '.dev-mini', '.rail-avatar', '.user-pop-logout'], {
          page: label, width, discover: 8, skip: ['.rail-btn', '.lang-btn', '.avatar', 'a'],
        }) : [];
        // AND THE COUNT OF WHAT THE PAGE HAD, which this entry DROPPED while the panel's carried it (round 15 of the
        // standing goal). Without it two things were invisible: the judge's floor fell back to a constant 2 instead of
        // `min(2, found)` — "a pass that pressed nothing proves nothing" is only a real floor when the pass knows what
        // the page rendered — and, worse for this round, ADDING `discover` TO THE CALL ABOVE COULD NOT BE SEEN TO HAVE
        // DONE ANYTHING. It found no new controls (the curated ten already cover this console's content controls, and
        // the rest is chrome the mode passes own) and the log said nothing either way: the rows were identical before
        // and after. `pressPass` puts `found` on a row — on the "(none)" row when discovery finds nothing — and the
        // panel reads it back the same way this now does.
        if (wants('press')) report.press.push({
          density: 'console', theme: 'light', page: label, width,
          found: pressRows.find((r) => r.found != null)?.found ?? null,
          measured: pressRows.filter((r) => !r.note).length,
          rows: pressRows,
        });
        // IDLE REPAINT, AND THE CONSOLE HAD NEVER BEEN MEASURED FOR IT (round 79). The panel got this pass in round
        // 64 and it found a live duration being called a repaint; the console polls its own views twice a second, so
        // "the page is settled and writing nothing" is exactly the claim its live views could break. It runs on
        // EVERY console page, in both themes, because this sweep has three pages and a six-second window each —
        // 36 seconds for the whole axis, which is cheaper than the panel's two densities and six pages make it.
        // The window lives inside the 1440 block where the other per-class passes are, because width changes what
        // is on screen and the idle question is about what a settled page does.
        if (wants('idle')) {
          const idle = await idlePass(page, 6000);
          report.idle.push({ page: label, width, density: 'console', theme: 'light', seconds: 6, ...idle });
        }

        // AND IT RUNS LAST, AFTER THE IDLE MEASUREMENT (round 192). This pass CLICKS — it has to, to see whether the
        // control answers — and its first placement sat before the idle window, so the presses' own state updates were
        // reported as "a repaint of unchanged output" on two console pages. pressPass never had that problem because it
        // moves the pointer OFF the element before releasing.
        // THE ACKNOWLEDGEMENT'S LATENCY, which this end had never measured (round 190). The press pass proves a press
        // PAINTS; this proves the control ANSWERS, and how fast, against the stated 100 ms budget. discover asks the DOM
        // for every visible control rather than a list somebody thought of — a list can only contain what somebody thought
        // of, and the controls that answer nothing are exactly the ones nobody thought about. Chrome is skipped: the rail
        // and the language button are navigation, not actions.
        // ACKPASS RETURNS THE ROWS THEMSELVES, not an object around them: the panel iterates its result directly, and
        // reading the artefact is what settled it after CI said "ackRows.rows is not iterable". Parsing is not running, and
        // the emitted script parsing was never evidence that this line worked.
        const ackRows = wants('ack') ? await ackPass(page, [], ACK_BUDGET_MS, {
          density: 'console', theme: 'light', page: label, mode: 'ack', discover: 8,
          skip: ['.rail-btn', '.lang-btn', '.avatar', 'a'],
        }) : [];
        if (wants('ack')) {
          // ONLY the ack rows go into report.ack: the shared judge reads that array, and the press array is judged by
          // different rules (a row of another shape there would be read as a press that measured nothing).
          report.ack = report.ack || [];
          for (const r of ackRows) report.ack.push(r);
          // AND ITS NUMBERS ARE PRINTED (round 194): the rows reached the judge and were invisible, so a green run said
          // nothing about whether any control answered. The same shared lines the panel prints.
          for (const line of ackNotes(ackRows, 'console/' + label)) console.log(line);
        }
      }
    }
  }
  // REDUCED MOTION, both states, on the console's own overview page. The panel has had this since round
  // 134 and the console had nothing: the gap was recorded in round 136 when the pass was shared and left
  // unwired. render re-loads the page and re-applies the route, because the preference only takes
  // effect on a fresh style resolution.
  for (const width of (wants('motion') ? [1440] : [])) {
    await page.setViewportSize({ width, height: 900 });
    const render = async () => {
      await page.goto('https://ai.saisi.online/?cb=' + Date.now(), { waitUntil: 'load' });
      await page.evaluate((h) => { location.hash = h; }, '#/');
      await settle(1400);
    };
    report.motion.push(await motionPass(page, render, { page: 'overview', width, density: 'console', theme: 'light' }));
  }

  // ANSWERED: THE RINGS WERE NEVER MISSING (round 186). Eighteen "missing focus rings" across six pages
  // were a FALSE POSITIVE of this sweep's own verdict, and six rounds went into a cascade that was never
  // broken. The proof is a screenshot: a keyboard-focused console button paints a 2px accent ring while
  // getComputedStyle reports "outline: solid 0px" and "box-shadow: none" for the very same element.
  //
  // Each wrong explanation was tested and killed by measurement, which is why this took six rounds rather
  // than one: a stale bundle (183), a cached sheet (184), a pointer leak left by the dark-hover pass (182),
  // a missing !important (185 — shipped, loaded, changed nothing), and a layered !important (186 — there
  // are no layers in the sheet at all). Along the way the device's assets directory was found holding EIGHT
  // files from four generations, which is what let each wrong explanation look right; it is pruned.
  //
  // THE LESSON IS THE ONE THIS SESSION KEEPS RELEARNING: a computed style is not a painted pixel. The
  // shared focusPass now treats its computed-style verdict as a CANDIDATE and confirms every no-ring
  // finding against the pixels — two small screenshots per candidate, so a clean page pays nothing — and
  // reports how many verdicts the pixels overruled.
  // TARGET SIZE, WCAG 2.5.8 — the check round 162 added for the PANEL, wired here because a check that
  // exists in one UI and not the others is the pattern this suite keeps paying for (rounds 135-136, 141).
  for (const [label, hash] of (wants('targets') ? [['overview', '#/'], ['devices', '#/devices']] : [])) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('https://ai.saisi.online/?cb=' + Date.now(), { waitUntil: 'load' });
    await page.evaluate((h) => { location.hash = h; }, hash);
    await settle(1500);
    report.targets.push({ page: label, ...(await page.evaluate(TARGETS)) });
  }

  // AND THE UNSTYLED CENSUS VISITS IT TOO (round 25). The rendered surfaces above visit the Overview with nothing
  // registered; the CENSUS walked only the six populated pages, so the one class this console declares
  // unstyled-by-design was still unseen and its note still asked for it — while the surfaces that DO carry it had
  // just been measured. A declaration is exercised by the pass that asks the question, not by a different one.
  if (wants('unstyled')) {
    empty.fleet = true;
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('https://ai.saisi.online/?cb=' + Date.now(), { waitUntil: 'load' });
      await page.evaluate((a) => {
        try { localStorage.setItem('summrise-theme', a[0]); } catch (e) {}
        document.body.setAttribute('data-theme', a[0]);
        location.hash = a[1];
      }, [theme, '#/']);
      await settle(1600);
      report.unstyled.push({ page: 'overview-empty' + (theme === 'dark' ? '-dark' : ''), ...(await page.evaluate(UNSTYLED)) });
    }
    empty.fleet = false;
  }

  // THE EMPTY FLEET, as surfaces of its own. Two pages have a meaningful empty form — Devices and Keys —
  // and neither had ever been rendered without content. Same recipe as the panel's empty state: a top-level
  // pass, one render each, recorded like any other surface.
  // BOTH THEMES, for the same reason the fixture surfaces took both in round 175: an empty state is mostly
  // COLOUR and TYPE, and a dark regression in one would be invisible to a light-only render.
  {
    empty.fleet = true;
    for (const theme of ['light', 'dark']) {
      // THE OVERVIEW JOINS THE EMPTY FLEET (round 25), and the reason is a measurement rather than symmetry. The
      // stat-off declaration in this sweep's implicitStates waives a class with NO matching rule — the Overview
      // builds a stat-card plus a stat-<tone> class, the sheet has rules for ok/warn/info only, and the unstyled pass
      // reported "1 of 1 declared unstyled-by-design class(es) were not seen in this run (0 unstyled name(s) over 6
      // pages)". The class fires when a tone is off, which happens on three of the Overview's four stats when
      // there is nothing to report: no device online, no channels, no keys. The empty-fleet fixture already exists
      // and visited only #/devices and #/keys, so the Overview in that state — and the faint bars the off tone
      // paints — had never been rendered by anything. A state with no surface cannot be measured; this is the
      // surface.
      for (const [label, hash] of [['overview-empty', '#/'], ['devices-empty', '#/devices'], ['keys-empty', '#/keys']]) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('https://ai.saisi.online/?cb=' + Date.now(), { waitUntil: 'load' });
        await page.evaluate((a) => {
          try { localStorage.setItem('summrise-theme', a[0]); } catch (e) {}
          document.body.setAttribute('data-theme', a[0]);
          location.hash = a[1];
        }, [theme, hash]);
        await settle(1600);
        const name = label + (theme === 'dark' ? '-dark' : '');
        report.themeChecks.push({ page: name, intended: theme, ...(await page.evaluate(THEME)) });
        const rows = await page.evaluate(PROBE);
        for (const r of rows) report.rows.push({ ...r, page: name, width: 1440, density: 'console', theme });
        report.surfaces.push({ page: name, width: 1440, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
        report.names.push({ page: name, ...(await page.evaluate(NAMES, SELECTOR)) });
      }
    }
    empty.fleet = false;
  }

  // THE FAILURE STATE, for every page. The console's error surfaces — a card that could not load, a table with
  // nothing but a message — had never been rendered by anything, so their contrast, their type and their
  // states were unmeasured. One render per page with the flag up, recorded like any other surface.
  // BOTH THEMES. An error card is colour and type like any other state, and the operator's console may be dark
  // — a light-only render of it would leave exactly the regression this suite exists to catch.
  {
    fail.api = true;
    for (const theme of ['light', 'dark']) {
      for (const [label, hash] of PAGES) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('https://ai.saisi.online/?cb=' + Date.now(), { waitUntil: 'load' });
        await page.evaluate((a) => {
          try { localStorage.setItem('summrise-theme', a[0]); } catch (e) {}
          document.body.setAttribute('data-theme', a[0]);
          location.hash = a[1];
        }, [theme, hash]);
        await settle(1800);
        const name = label + '-fail' + (theme === 'dark' ? '-dark' : '');
        report.themeChecks.push({ page: name, intended: theme, ...(await page.evaluate(THEME)) });
        const rows = await page.evaluate(PROBE);
        for (const r of rows) report.rows.push({ ...r, page: name, width: 1440, density: 'console', theme });
        report.surfaces.push({ page: name, width: 1440, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
        report.names.push({ page: name, ...(await page.evaluate(NAMES, SELECTOR)) });
      }
    }
    fail.api = false;
  }

  // THE LOGIN PAGE, IN BOTH THEMES. It is the one surface an operator sees before anything else works, and it
  // is a CARD — colour, type and a form — so a light-only render leaves a dark regression unmeasured. Round
  // 229 checked every other pass in all three sweeps for the same thing and found this as the only one that
  // both renders colour AND lacked a dark counterpart; the motion pass is light-only too and stays that way, because
  // it asks whether animations are DISARMED rather than what colour anything is.
  auth.signedIn = false;
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('https://ai.saisi.online/?cb=' + Date.now(), { waitUntil: 'load' });
    await page.evaluate((t) => {
      try { localStorage.setItem('summrise-theme', t); } catch (e) {}
      document.body.setAttribute('data-theme', t);
    }, theme);
    await settle(1600);
    const name = 'login' + (theme === 'dark' ? '-dark' : '');
    report.themeChecks.push({ page: name, intended: theme, ...(await page.evaluate(THEME)) });
    for (const r of await page.evaluate(PROBE)) report.rows.push({ ...r, page: name, width: 1440, density: 'console', theme });
    report.surfaces.push({ page: name, width: 1440, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
    report.names.push({ page: name, ...(await page.evaluate(NAMES, SELECTOR)) });
  }
  await diag("done rows=" + (report.rows || []).length + " findings-source-ready pid=" + process.pid);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report));
  console.log(JSON.stringify({ rows: report.rows.length, surfaces: report.surfaces.length }));
  // ── EVERY AXIS'S OWN NUMBER, the line the panel got in round 10 and this sweep did not ──────────────────────────
  // The line above is the whole of what a CI log knows about this sweep's coverage: two numbers, for thirteen axes.
  // The cost of that was paid twice — round 10 could not convert the panel's motion settles because no number would
  // have shown a change, and round 11 could not see that this sweep's acknowledgement premise was never installed,
  // because `asked` is computed on every ack row and PRINTED NOWHERE. `ack` below carries all four of its parts:
  // rows, acknowledged, asked-the-device, and rows whose page had NO COUNTER (which the judge now fails outright).
  {
    const count = (a) => (report[a] || []).length;
    const axes = {
      // THE DENOMINATOR IS NOT "HOW MANY CONTROLS WENT UNMEASURED". This read `3of10` on every console page, which
      // looks like a coverage gap and is not one: the press pass is handed a CURATED ten-selector list and each page
      // renders three of them, so the other seven rows say "not rendered on this page" — and the judge suppresses
      // exactly those notes, because the absence of a control is not a defect in one. Measured from the log rather
      // than assumed: `console/light` appears ZERO times in the judging output, which is only possible if every
      // suppressed note matched /not rendered/. The honest reading is pressed/absent, with `found` appended where the
      // pass DISCOVERED its set instead of being handed one.
      press: (report.press || []).map((p) => {
        const rows = p.rows || [];
        const absent = rows.filter((r) => r.note && /not rendered/.test(r.note)).length;
        const measured = p.measured != null ? p.measured : rows.filter((r) => !r.note).length;
        return `${p.page}@${p.width}:${measured}pressed/${absent}absent${p.found == null ? "" : "/" + p.found + "found"}`;
      }),
      ack: `${count("ack")}r/${(report.ack || []).filter((a) => a.acked).length}a/${(report.ack || []).filter((a) => a.asked).length}asked/${(report.ack || []).filter((a) => a.hasCounter === false).length}nocounter`,
      // AND `p/l/m` COULD NOT TELL "ESCAPED" FROM "UNACCOUNTED" (round 21 of the standing goal). This sweep's routes
      // and users pages read `16p/15l/0m`, which looks like a press that went nowhere — and the only way that row can
      // be green is `escaped: 1`, the tab cycle leaving the document. `unconfirmed` is printed too because it is the
      // one of the four the judge FAILS ("a check that could not look is not a pass"), so a reader should see it at
      // zero rather than have to infer it.
      focus: (report.focus || []).map((f) => `${f.page || f.density}@${f.width || "-"}:${f.pressed || 0}p/${f.landed || 0}l/${f.missing || 0}m/${f.escaped || 0}e/${f.unconfirmed || 0}u`),
      hover: (report.hover || []).map((h) => `${h.page}@${h.width}:${h.interactive}i/${(h.underAA || []).length}aa`),
      motion: (report.motion || []).map((m) => `${m.page || m.density}:${m.normal}->${m.reduced}`),
      idle: (report.idle || []).map((i) => `${i.page}:${i.mutations == null ? "?" : i.mutations}mut`),
      targets: (report.targets || []).map((t) => `${t.page}:${t.checked || 0}c/${t.undersized || 0}u`),
      unstyled: (report.unstyled || []).map((u) => `${u.page}:${u.styledClasses || 0}c/${u.sheetsUnreadable || 0}unread`),
      // AND THE SCROLLER COUNT, for the same reason the panel prints it (round 22 of the standing goal): an excuse
      // whose premise is "every offending scroller is X" is vacuously satisfied by an EMPTY list, so the count is part
      // of the verdict. This sweep's rows are the ones that DID name scrollers — `pre.mt-8 228<401`, `pre 240<311` —
      // which is why the notes in the log belong to it and not to the panel.
      reflow: (report.reflow || []).map((r) => `${r.page}@${r.width}:${r.docScrollsSideways ? "SCROLLS" : "ok"}/${(r.sideScrollers || []).length}sc/${(r.overflowing || []).length}over`),
      themes: (report.themeChecks || []).map((t) => `${t.page}:${t.stored || "-"}`),
      entry: report.entryCheck ? `${report.entryCheck.bytes}b/${report.entryCheck.stale ? "STALE" : "current"}` : "?",
    };
    console.log(JSON.stringify({ axes }));
  }
  // THE BUDGET, printed LAST so it covers every pass — the same two lines the panel prints, so the two sweeps can be
  // compared without translating between them. `asked` against `needed` is the whole question: equal means the clock
  // was right, far apart means it was padding.
  {
    const spent = ["wait", "nav", "eval"].map((k) => `${k}=${BUDGET[k][0]}x/${(BUDGET[k][1] / 1000).toFixed(1)}s`).join(" ");
    console.log(`budget ${spent} of ${((Date.now() - SWEEP_T0) / 1000).toFixed(1)}s`);
    const top = [...BUDGET.waitByMs.entries()].sort((a, b) => b[1][1] - a[1][1]).slice(0, 8)
      .map(([asked, [n, ms]]) => `${asked}ms=${n}x/${(ms / 1000).toFixed(1)}s`).join(" ");
    console.log(`budget waits by the value asked for (top 8 of ${BUDGET.waitByMs.size}): ${top}`);
    console.log(`budget settle ${SETTLE.calls}x asked=${(SETTLE.asked / 1000).toFixed(1)}s needed=${(SETTLE.needed / 1000).toFixed(1)}s capped=${SETTLE.capped}`);
  }
  await close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
