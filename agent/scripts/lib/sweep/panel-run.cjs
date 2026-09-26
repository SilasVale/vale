// panel-run.cjs — the panel sweep's DEVICE-SIDE program, as a real module (round 267).
//
// IT WAS A TEMPLATE LITERAL in panel-design-sweep.mjs: 1012 lines — 62% of that file — with nineteen things
// interpolated into it (`${JSON.stringify(PROBE_SOURCE)}`, nine passes via `.toString()`, `${pageChecks("#root")}`,
// `${DIAG_SOURCE}`, `${MOTION}`, `${TIMING}`). Every one of those was a place where a backtick, a backslash or an
// interpolation-looking sequence in ANY of the interpolated text could end the host file mid-parse — the shape that
// cost this repository 53 recorded incidents — and why the Windows defaults carried double backslashes to survive
// one level of it. Here the program is ordinary code: the run-varying values arrive as a real module
// (`./pieces.cjs`), the payload's requires are resolved by the assembler, and nothing is hand-listed as
// "must also be embedded".
const P = require("./pieces.cjs");

const fs = require("fs");
// WHERE IT READS AND WRITES IS OVERRIDABLE, so the same sweep can run on the device (the defaults, exactly
// as before) or on any machine with a browser — which is what makes a CI job possible at all. Round 204:
// the design suite has only ever run when the loop remembered to run it, and a measured-and-verified
// objective should not depend on that. Nothing else about a device run changes.
const HARNESS = process.env.SUMMRISE_PANEL_HARNESS || P.config.harnessPath;
const REPORT_PATH = process.env.SUMMRISE_SWEEP_REPORT || P.config.reportPath;
// THE BUILD THIS SWEEP WAS EMITTED AGAINST. The audit stamps every harness with the stylesheet it
// inlined; baking the expectation here turns round 189's note into a check. A delivered fixture that
// predates a CSS fix otherwise reports findings that look live — a 17px tab strip against a 962px build —
// and nothing in the report distinguishes them from a regression.
const EXPECTED_HARNESS_BUILD = P.config.expectedHarnessBuild;
const PROBE = P.probe;
const { SURFACE, NAMES, REFLOW } = P.checks;
// THE ROOT SELECTOR IS AN ARGUMENT TO THE PROBES (round 271): it used to be substituted into their source text,
// which is how a Node-side identifier once reached page code. The mark axis travels with the surface probe's
// result, so it is evaluated alongside it and merged in, exactly where it used to be spliced.
const MARKS = P.marks;
const SELECTOR = P.config.selector;
const UNSTYLED = P.unstyled;
const TARGETS = P.targets;
const THEME = P.theme;
// THE SWEEP REPORTS ITSELF TO THE AGENT'S DIAGNOSTIC RING, so a caller whose tool call timed out can tell
// a run that is still working from one that was killed (round 181 lost half an hour to exactly that).
const diag = P.diag;
const focusPass = P.passes.focusPass;
const pressDelta = P.passes.pressDelta;
const pressPass = P.passes.pressPass;
// AND EVERY HELPER THAT FUNCTION CALLS. pressPass asks the DOM for the page's controls, and a version of this
// shipped WITHOUT this line: the emitted sweep called discoverPressTargets, the definition was not in the file, and
// the run died with "FATAL discoverPressTargets is not defined" — in CI, because no local gate RUNS the artifact
// (they plant defects in a report and judge it). The emitter checks its own output for exactly this now.
const discoverPressTargets = P.passes.discoverPressTargets;
const revealPass = P.passes.revealPass;
const ackPass = P.passes.ackPass;
const ackNotes = P.passes.ackNotes;
const idlePass = P.passes.idlePass;
const motionPass = P.passes.motionPass;
const MOTION = P.motion;
const TIMING = P.timing;
(async () => {
  const { acquireBrowser } = require(process.env.SUMMRISE_BROWSER_HELPER);
  const { page, close } = await acquireBrowser();

  // ── WHERE THE 436 SECONDS GO, in three numbers, because seven minutes of silence is not a measurement ──────────
  // The per-pass marks (round 1 of the standing goal) showed that this sweep's BODY — `pages` plus the focus, press,
  // idle, targets and ack axes that render inside its loop — is 436s of the sweep's 464s, and that the four passes
  // after it are 28s between them. So the cost is in the body, and the body prints NOTHING for seven minutes: "is it
  // the waits, the navigations, or the probes?" cannot be asked of a log with no lines in it.
  //
  // THREE BUCKETS, because they are the three things the body spends time on and each has a DIFFERENT fix: a fixed
  // `waitForTimeout` is padding a condition-based wait could replace; a navigation is the fixture loading; an
  // `evaluate` is a probe walking the DOM. They are counted at the SOURCE — the page's own methods — and not at the
  // 51 call sites, because a call site somebody forgets is a number that is quietly wrong, and the shared passes call
  // these too (13 waits and 20 evaluates in lib/design-sweep.mjs alone, which this wrapper also catches).
  //
  // IT IS A PASS-THROUGH: it must never change what the call returns, and `finally` is what keeps a rejected
  // navigation counted instead of vanishing from the budget.
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
  // AND THE WAITS ARE ATTRIBUTED TO THE LITERAL THAT ASKED FOR THEM. The first run of this budget (run 36242110766)
  // measured 1088 waits costing 429.8s of a 464.6s sweep — 92.5% — which says the sweep is mostly sleeping and does
  // NOT say which sleep to fix. 429.8s over 1088 calls averages 395ms, so the bulk is small waits rather than the
  // 1500-2200ms settles, and those two have OPPOSITE fixes: a settle after a load is padding a condition could
  // replace, while a short wait inside `ackPass` IS the sampling mechanism that measures when a control answers.
  // Guessing between them would be the mistake this suite exists to prevent, so the value is the key.
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

  // ── A SETTLE THAT WAITS FOR THE PAGE INSTEAD OF FOR THE CLOCK ───────────────────────────────────────────────────
  // The attribution (run 36242994398) put 206.3s of the sweep's 429.8s of waiting into four literals — 1800, 1500, 2000
  // and 2200ms, 116 calls — and reading the 35 sites says why they are all the same thing: `goto` → set the
  // getting-started flag → `reload` → sleep → measure. The sleep exists for ONE reason, that the probes must not
  // measure a page still filling in, and a clock answers that question badly in both directions: too short measures a
  // half-built page, too long wastes the difference. The budget says it is too long by most of 206 seconds.
  //
  // THE CONDITION IS THE ONE `idlePass` ALREADY TRUSTS. That pass asserts the panel writes NOTHING to the DOM while it
  // is settled (it observes for six seconds and fails on a single mutation), so "no mutation for QUIET_MS" is not a
  // guess about this page — it is the page saying it is ready, in the same language the suite already reads.
  //
  // IT IS CAPPED AT THE OLD VALUE, and that is what makes it safe to try: a page that never goes quiet waits exactly as
  // long as it does today, and `capped` counts how often that happened. `needed` is the evidence — if the settles
  // really need 206s, this will say so and the change gets reverted; if they need 30s, the difference is the win.
  // A run whose report stops matching (the panel's 142 surfaces / 142 names are the stable part) is a run where the
  // quiet came too early, and the number to raise is QUIET_MS.
  const QUIET_MS = 250;
  const SETTLE = { calls: 0, asked: 0, needed: 0, capped: 0 };
  const settle = async (asked) => {
    SETTLE.calls++;
    SETTLE.asked += asked;
    const t0 = Date.now();
    try {
      // A NAVIGATION DESTROYS THE OBSERVER, and that is correct: a new document must prove its own quiet. INSTALLED
      // ONCE PER DOCUMENT, not once per settle — two settles can share a document (one site follows a wait rather than
      // a reload), and the first version created a second observer each time, which is a leak that also doubles the
      // callbacks. Only the CLOCK is reset here; the console's payload, which navigates by hash and so keeps its
      // document, is written the same way for the same reason.
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

  const html = fs.readFileSync(HARNESS, 'utf8');
  // WHICH GENERATION OF THE HARNESS IS BEING MEASURED, in the report. The stamp is written by the audit that
  // generates the file; without it a delivered copy that predates a CSS fix reports findings that look real
  // (round 189: a 17px tab strip against a 962px build) and nothing distinguishes them from a live defect.
  const harnessBuild = (/<meta name="summrise-harness-build" content="([^"]+)"/.exec(html) || [])[1] || "(unstamped — an older generation)";
  // A STALE FIXTURE INVALIDATES EVERY MEASUREMENT BELOW IT, so this is a finding rather than a note. The
  // stamp is unknown only for harnesses generated before round 189, which are stale by definition.
  const harnessStale = harnessBuild !== EXPECTED_HARNESS_BUILD;
  const stamp = Date.now();
  await page.route('http://summrise.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'no-store' }, body: html }));

  await diag("start focus,pages pid=" + process.pid);
  const report = {
    harnessBuild,
    expectedHarnessBuild: EXPECTED_HARNESS_BUILD,
    ...(harnessStale ? { harnessStale: true } : {}),
    // WHICH PASSES RAN, recorded in the report itself. The sweep outgrew its caller's timeout in round
    // 90 (a check that cannot complete is a check that will quietly stop running), so passes are
    // selectable — and a PARTIAL report must not read as a clean one, which is why this list travels
    // with the data and the judge refuses a report that does not say it covered everything.
    passes: P.config.passes,
    rows: [], surfaces: [], reflow: [], names: [], timing: [], focus: [], motion: [], hover: [], unstyled: [], targets: [], themeChecks: [], sse: [],
  };
  // The harness publishes window.__sse (opened, fail). Read as data, judged by the shared clause.
  const SSE = "(() => window.__sse || null)()";
  const wants = (name) => report.passes === "all" || report.passes.split(",").map((p) => p.trim()).includes(name);

  // ── WHAT EACH PASS COSTS, because for seven minutes this run said nothing at all ────────────────
  // The `design` job is this repository's CI long pole — 823s of a 14-minute run, measured 2026-09-26
  // (run 36234166849, job 108382804074) — and THIS sweep is 464 of those seconds: the console is 241,
  // the landing 42, the judging 0.2. For those 464 seconds the log carried exactly ONE line, the row
  // count printed at the end, so "which pass costs what" could not be answered from CI at all and the
  // round before this one had to write the question down instead of the number. It is printed now, and
  // because the CI log timestamps every line these marks are also a clock.
  //
  // THE FIRST MARK IS NOT ONE PASS. `pages` renders the pages, and the focus, press, idle, targets and
  // ack axes run INSIDE its density/theme loop — interleaved by construction, because separating them
  // would mean rendering every page again. So the first number is `pages` plus those axes, and the four
  // after it (unstyled, hover, motion, reflow) are each exactly one pass.
  //
  // A PASS THAT DID NOT RUN PRINTS NOTHING: a mark for a pass the caller did not ask for would read as
  // a measurement of zero, which is the vacuity this suite refuses everywhere else.
  const SWEEP_T0 = Date.now();
  const passCost = (name) => console.log("pass " + name + " +" + (Date.now() - SWEEP_T0) + "ms");

  for (const [density, path_, vp] of [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]]) {
    for (const theme of ['light', 'dark']) {
      // THE PAGE MUST BE RENDERED FOR *EITHER* PASS. The focus block below lives in this loop, so
      // --passes=focus used to run it ZERO times: the mode list was empty, no page was loaded, no Tab
      // was pressed, and the report came back focus: [] — clean, and clean because nothing ran. The
      // full sweep hid it, since all includes pages. Same defect as the ones this suite keeps
      // finding in its own checks, this time in the wiring between two of them.
      const needsPage = wants("pages") || wants("focus") || wants("timing") || wants("hover") || wants("press") || wants("idle");
      for (const mode_ of needsPage ? (wants("pages") ? ['idle', 'relaxed'] : ['idle']) : []) {
        await page.setViewportSize(vp);
        const t0 = Date.now();
        await page.goto('http://summrise.test' + path_ + '?theme=' + theme + '&mode=' + mode_ + '&sessions=4&cb=' + stamp, { waitUntil: 'load' });
        await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('.side-row, .dtab, .tab', { timeout: 20000 });
        const toFirstRow = Date.now() - t0;
        await settle(1200);
        report.timing.push({ density, theme, mode: mode_, toFirstRowMs: toFirstRow, ...(await page.evaluate(TIMING)) });

        // FOCUS RINGS BY REAL TAB PRESSES, in ONE implementation shared with the console and the
        // extension (lib/design-sweep.mjs). It was copied between adapters once and the copies
        // drifted for two rounds; the loop lives in the core now.
        report.focus.push(await focusPass(page, 14, { density, theme }));

        // THE PRESS, ON THE SAME PAGE, RIGHT AFTER THE FOCUS PASS (round 55). It is the half feedback-check.mjs
        // cannot do: that gate proves an :active RULE EXISTS, and round 51 found the ACTIVE TAB dead with the rule
        // sitting right there in the sheet. Targets differ per density — the panel renders .tab where the desktop
        // renders .dtab — and one that is absent is a NOTE, not a finding, because the two surfaces do not carry
        // the same controls. The measured count is what keeps that from becoming a pass that presses nothing.
        //
        // IDLE REPAINT (round 64): the page is settled, the fixtures are static, and the panel should be writing
        // nothing at all. Anything it does write is a clock or a recomputation from unchanged inputs.
        // ONE PAGE, not six: the measurement is a SIX-SECOND window, and running it on every page of every density
        // and theme would spend two and a half minutes proving the same thing. Terminal is the panel's default page.
        if (wants("idle")) {
          const idle = await idlePass(page, 6000);
          report.idle = report.idle || [];
          // This is the page the mode loop just loaded — the default one, Terminal — because the rail walk that
          // names the other pages happens further down. Calling it label here was the first version's bug: there is
          // no such binding in this scope, and the device answered "label is not defined". (44th backtick.)
          report.idle.push({ density, theme, mode: mode_, page: density + "-Terminal", seconds: 6, ...idle });
        }
        if (wants("press")) {
          const pressTargets = ['.rail-btn', '.desktop-rail-btn', '.tab', '.dtab', '.side-row', '.side-add'];
          const pressRows = await pressPass(page, pressTargets, { density, theme, mode: mode_ });
          report.press = report.press || [];
          report.press.push({ density, theme, mode: mode_, measured: pressRows.filter((r) => !r.note).length, rows: pressRows });
        }

        const rail = await page.evaluate(() => {
          const r = document.querySelector('#icon-rail, .desktop-rail');
          return r ? [...r.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.title || '').trim()).filter((l) => l && !/theme|started/i.test(l)) : [];
        });
        for (const label of rail) {
          await page.evaluate((l) => {
            const r = document.querySelector('#icon-rail, .desktop-rail');
            const b = [...(r ? r.querySelectorAll('button') : [])].find((x) => (x.getAttribute('aria-label') || x.title || '').trim() === l);
            if (b) b.click();
          }, label);
          await page.waitForTimeout(450);
          const rows = await page.evaluate(PROBE);
          for (const row of rows) report.rows.push({ ...row, density, theme, mode: mode_, page: label });
          report.surfaces.push({ density, theme, mode: mode_, page: density + '-' + label, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
          report.names.push({ density, theme, mode: mode_, page: density + '-' + label, ...(await page.evaluate(NAMES, SELECTOR)) });
          // DID THE HARNESS DELIVER THE PUSH? The panel's connected state comes from a complete frame on
          // /api/events/term, and the fixture that serves it is the only thing that knows whether it was served.
          // This was a NOTE in the harness for many rounds ("with the stream shut, every panel measurement this
          // harness has ever produced was taken in a reconnecting state") and nothing asserted it, so a change that
          // broke the stream would have gone on being measured as if it were the product.
          report.sse.push({ density, theme, mode: mode_, page: density + '-' + label, ...(await page.evaluate(SSE)) });
        }
      }
    }
  }

  // THE EMPTY STATE, desktop density — the only one of the two that can be measured here.
  //
  // Round 152 added this for the PANEL density and measured it "clean". Round 153 looked at what that
  // surface actually rendered and found it was not the empty state at all: the rail said "Sessions
  // unavailable — reconnecting…", because in the panel harness the rail receives connected=false, while the
  // DESKTOP harness renders the real thing ("No sessions yet"). The contrast was clean in both cases, which
  // is exactly why the label mattered — a surface that measures the wrong state passes for the best reason.
  // The panel block was PRUNED rather than left in place with a caveat.
  //
  // One render, top level, no nesting arithmetic: this is the state a fresh install sees.
  // BOTH THEMES. These fixture surfaces carry COLOUR, and colour is the one thing a theme changes — measuring
  // them in light alone leaves a dark regression invisible, which is the gap rounds 148-161 spent their time
  // closing everywhere else. (The target-size and type-floor passes stay light-only on purpose: a box and a
  // font size do not change with the theme.)
  for (const theme of wants("pages") ? ['light', 'dark'] : []) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('http://summrise.test/desktop/?theme=' + theme + '&mode=relaxed&sessions=0&cb=' + stamp, { waitUntil: 'load' });
    await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
    await page.reload({ waitUntil: 'load' });
    await settle(2000);
    const rows = await page.evaluate(PROBE);
    for (const row of rows) report.rows.push({ ...row, density: 'desktop', theme, mode: 'relaxed', page: 'Desktop-empty' });
    report.themeChecks.push({ page: 'Desktop-empty', intended: theme, ...(await page.evaluate(THEME)) });
    report.surfaces.push({ density: 'desktop', theme, mode: 'relaxed', page: 'Desktop-empty', ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
    report.names.push({ density: 'desktop', theme, mode: 'relaxed', page: 'Desktop-empty', ...(await page.evaluate(NAMES, SELECTOR)) });
  }

  // THE NEW-SESSION MENU, WHICH ONLY A CLICK CAN RENDER (round 92). DesktopShell holds it: a .btn-new button with
  // aria-expanded, and a popover of role=menuitem buttons, each with an .nm-ico span carrying data-kind. The sweep
  // has PRESSED that button for many rounds — .btn-new is in the press targets — and never once photographed what
  // it opens, so the menu's item contrast, its target sizes and the per-kind icon colours have been unmeasured since
  // the menu replaced four buttons with one entry point. Desktop only, because the menu is: the panel density has no
  // .desktop-new at all.
  //
  // The entrance animation is new-menu-in (declared ATTENTION in chrome-stillness-check), so the wait after the
  // click is longer than the press pass's: this photographs the SETTLED menu, not its first frame.
  for (const theme of wants("pages") ? ['light', 'dark'] : []) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('http://summrise.test/desktop/?theme=' + theme + '&mode=idle&sessions=4&cb=' + stamp, { waitUntil: 'load' });
    await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
    await page.reload({ waitUntil: 'load' });
    await settle(1800);
    await page.evaluate(() => { const b = document.querySelector('.btn-new'); if (b) b.click(); });
    await page.waitForTimeout(700);
    const pname = 'Desktop-NewMenu-' + theme;
    const rows = await page.evaluate(PROBE);
    for (const row of rows) report.rows.push({ ...row, density: 'desktop', theme, mode: 'menu', page: pname });
    report.surfaces.push({ density: 'desktop', theme, mode: 'menu', page: pname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
    report.names.push({ density: 'desktop', theme, mode: 'menu', page: pname, ...(await page.evaluate(NAMES, SELECTOR)) });
    report.sse.push({ density: 'desktop', theme, mode: 'menu', page: pname, ...(await page.evaluate(SSE)) });
  }

  // THE PANEL DENSITY'S EMPTY STATE, RE-ADDED BECAUSE THE REASON IT WAS PRUNED HAS EXPIRED (round 91).
  //
  // Round 152 added this surface for the panel density and measured it "clean". Round 153 looked at what it had
  // actually rendered and found it was NOT the empty state: the rail said "Sessions unavailable — reconnecting…",
  // because in that harness the rail received connected=false. The desktop harness rendered the real thing ("No
  // sessions yet"); the panel block was PRUNED rather than left in place with a caveat, and the note kept the
  // sentence worth remembering: "a surface that measures the wrong state passes for the best reason."
  //
  // THE PREMISE HAS EXPIRED. Rounds 86 and 87 established — and CI now asserts on every run — that this harness DOES
  // open the SSE stream: the panel renders connected, 4142 text nodes contain no "Sessions unavailable" on a surface
  // whose harness did not report the failure fixture, and the judge FAILS a surface that regresses. So the block can
  // come back, and the clause that proved the harness connected is also what makes it safe to re-add: if the panel
  // renders the wrong state here again, THIS SURFACE fails instead of passing.
  for (const theme of wants("pages") ? ['light', 'dark'] : []) {
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=relaxed&sessions=0&cb=' + stamp, { waitUntil: 'load' });
    await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
    await page.reload({ waitUntil: 'load' });
    await settle(2000);
    const rows = await page.evaluate(PROBE);
    for (const row of rows) report.rows.push({ ...row, density: 'panel', theme, mode: 'relaxed', page: 'Panel-empty' });
    report.themeChecks.push({ page: 'Panel-empty', intended: theme, ...(await page.evaluate(THEME)) });
    report.surfaces.push({ density: 'panel', theme, mode: 'relaxed', page: 'Panel-empty', ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
    report.names.push({ density: 'panel', theme, mode: 'relaxed', page: 'Panel-empty', ...(await page.evaluate(NAMES, SELECTOR)) });
    // THE FLAG TRAVELS WITH THIS ONE, unlike the desktop block above: it is the whole reason the surface can exist.
    report.sse.push({ density: 'panel', theme, mode: 'relaxed', page: 'Panel-empty', ...(await page.evaluate(SSE)) });
  }

  // THE UPDATE CARD MID-RELEASE. ?busy=1 exists in the harness and NO SWEEP HAS EVER RENDERED IT: the mode
  // list is idle/relaxed, so the state an operator stares at while a release is running has been measured
  // zero times. Measured by hand first (113 rows, no failing text, and the one disabled control is the
  // Notifications button at opacity 0.45, which the probe marks inactive and WCAG exempts). One render of
  // the Settings page, where the card lives, on the same top-level recipe as the empty state.
  // BOTH DENSITIES. The desktop shell is what the operator actually uses, and it renders DIFFERENT markup
  // from the panel (dtab vs tab, a header row instead of a canvas top), so a defect in its busy card would
  // be invisible to a panel-only render. The rail lookup below already handled both rails — the desktop
  // render was simply never asked for.
  for (const [density, path_, vp] of wants("pages") ? [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]] : []) {
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize(vp);
    await page.goto('http://summrise.test' + path_ + '?theme=' + theme + '&mode=idle&sessions=3&busy=1&cb=' + stamp, { waitUntil: 'load' });
    await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
    await page.reload({ waitUntil: 'load' });
    await settle(1800);
    await page.evaluate(() => {
      const rail = document.querySelector('#icon-rail, .desktop-rail');
      const b = [...(rail ? rail.querySelectorAll('button') : [])].find((x) => /setting/i.test((x.getAttribute('aria-label') || '') + (x.textContent || '')));
      if (b) b.click();
    });
    await settle(1400);
    const rows = await page.evaluate(PROBE);
    const name = (density === 'desktop' ? 'Desktop-settings-busy' : 'Settings-busy');
    for (const row of rows) report.rows.push({ ...row, density, theme, mode: 'busy', page: name });
    report.themeChecks.push({ page: name, intended: theme, ...(await page.evaluate(THEME)) });
    report.surfaces.push({ density, theme, mode: 'busy', page: name, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
    report.names.push({ density, theme, mode: 'busy', page: name, ...(await page.evaluate(NAMES, SELECTOR)) });
  }
  }

  // EVERY RAIL PAGE, IN BOTH DENSITIES (round 41 of the standing goal). Every surface above renders the page the
  // app opens on, plus Settings — so the OTHER SIX rail pages were measured by nothing, in EITHER density, and
  // round 40 found a two-loud reading on one of them by probing them by hand. This walks the rail instead of the
  // URL: click each button, read back WHICH button is now active, and name the surface after it.
  //
  // THE READ-BACK IS THE POINT. A click that silently fails would measure the SAME page eight times and report
  // eight clean surfaces, which is the "a scan that read nothing is not a clean scan" trap wearing a progress bar.
  // Naming each surface by the label the app itself reports means a failed click shows up as a DUPLICATE page name
  // in the report rather than as coverage that is not there.
  for (const [density, path_, vp] of wants("pages") ? [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]] : []) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize(vp);
      await page.goto('http://summrise.test' + path_ + '?theme=' + theme + '&mode=idle&sessions=4&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(2000);
      const buttons = await page.evaluate(() => [...document.querySelectorAll('#icon-rail button, .desktop-rail button')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 18)));
      const readActive = () => page.evaluate(() => {
        const on = document.querySelector('#icon-rail button.active, .desktop-rail button.active') || document.querySelector('#icon-rail button[aria-current], .desktop-rail button[aria-current]');
        return on ? (on.getAttribute('aria-label') || on.textContent || '').trim().slice(0, 18) : '';
      });
      let previous = '';
      let pages = 0;
      // THE THEME THIS WALK STARTS FROM, so the undo below has something to compare against.
      const before = (await page.evaluate(THEME)).attr;
      for (let i = 0; i < buttons.length; i++) {
        await page.evaluate((k) => { const b = document.querySelectorAll('#icon-rail button, .desktop-rail button')[k]; if (b) b.click(); }, i);
        await settle(900);
        const active = await readActive();
        // NOT EVERY RAIL BUTTON IS A PAGE. Measured (round 41): the rail holds EIGHT buttons and only SIX are pages —
        // the seventh is the THEME TOGGLE and the eighth opens the getting-started guide. Clicking the toggle flips
        // the theme for every surface after it, which is how a run can label a DARK page as light and mean it. So a
        // click that does not move the active button is UNDONE and skipped: it is an action, not a destination.
        if (active === previous || !active) {
          await page.evaluate((k) => { const b = document.querySelectorAll('#icon-rail button, .desktop-rail button')[k]; if (b) b.click(); }, i);
          await page.waitForTimeout(600);
          // AND THE UNDO IS CHECKED. Round 41 clicked the action a second time to undo it and MOVED ON; if that click
          // lands on something that is not a toggle, or the app ignores it, every surface after it is rendered in the
          // other theme while this loop keeps saying the one it intended — which is exactly what CI reported in round
          // 73: six pages labelled light, rendered dark, with the light theme's warning ink on them.
          const after = (await page.evaluate(THEME)).attr;
          if (before && after && after !== before) {
            await page.evaluate((k) => { const b = document.querySelectorAll('#icon-rail button, .desktop-rail button')[k]; if (b) b.click(); }, i);
            await page.waitForTimeout(600);
            const back = (await page.evaluate(THEME)).attr;
            if (back && back !== before) report.railThemeDrift = (report.railThemeDrift || 0) + 1;
          }
          continue;
        }
        previous = active;
        pages++;
        const name = density + '-' + active;
        // THE LABEL COMES FROM THE PAGE, NOT FROM THE LOOP (round 74). The loop's own theme value is what it
        // INTENDED; the document's data-theme attribute is what it IS. They can disagree — that is the whole subject
        // of the theme-lie axis — and when they do, labelling the rows with the intention is how six contrast
        // findings were filed against a theme that was not on screen. One reading, used for every label, and the
        // disagreement is still recorded against the intention so the axis keeps its evidence.
        const themeRead = await page.evaluate(THEME);
        const pageTheme = themeRead.attr === 'dark' ? 'dark' : themeRead.attr === 'light' ? 'light' : theme;
        const rows = await page.evaluate(PROBE);
        for (const row of rows) report.rows.push({ ...row, density, theme: pageTheme, mode: 'rail', page: name });
        report.themeChecks.push({ page: name, intended: theme, ...themeRead });
        report.surfaces.push({ density, theme: pageTheme, mode: 'rail', page: name, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
        report.names.push({ density, theme: pageTheme, mode: 'rail', page: name, ...(await page.evaluate(NAMES, SELECTOR)) });
        // AND THE STATE A HOVER REVEALS, ASKED FOR RATHER THAN STUMBLED INTO (round 16). .side-actions is
        // display:none until the row is hovered, so the target probe has always read 0x0 and skipped it; the one
        // time it was measured, the press pass happened to leave the pointer on a row. This hovers a row, measures,
        // and parks the pointer again.
        if (wants("targets")) {
          const revealed = await revealPass(page, '.side-row', TARGETS, { density, theme: pageTheme, mode: 'reveal', page: name });
          if (revealed) report.targets.push(revealed);
        }
        // AND THE CONTROLS THIS PAGE HAS, WHICH NO LIST NAMED (round 15). The press pass ran on the Terminal surfaces
        // against a CURATED list, so a control on any other page had never been pressed: .device-logs-toggle — the
        // button that opens a log file's tail — had cursor:pointer and NO hover and NO press, and feedback-check
        // cannot see that shape (it demands a press only where a HOVER exists). The DOM is asked instead, deduped by
        // class+size and CAPPED, and the count travels into the report so the judge sizes its floor to THIS page:
        // the Browser page renders an explanation with one control, and one pressed is a complete pass there.
        if (wants("press")) {
          const pressed = await pressPass(page, [], {
            density, theme: pageTheme, mode: 'rail', page: name, discover: 16,
            // WHAT ANOTHER PASS ALREADY PRESSES: the mode passes own the rail buttons, the session tabs and the side
            // rows. Skipping them here is what lets the cap reach the page's OWN controls — the log toggles, the
            // archive rows, the view switches — which is the whole reason this pass exists.
            skip: ['.rail-btn', '.desktop-rail-btn', '.tab', '.dtab', '.side-row', '.side-add'],
          });
          report.press = report.press || [];
          report.press.push({
            density, theme: pageTheme, mode: 'rail', page: name,
            found: pressed.find((r) => r.found != null)?.found ?? null,
            measured: pressed.filter((r) => !r.note && r.changed).length,
            rows: pressed,
          });
        }
      }
      // THE COVERAGE IS WHAT CHANGED, not what was clicked: six pages is the fact, and a report that says fewer
      // means the rail stopped navigating rather than that the pages are clean.
      report.railPages = (report.railPages || 0) + pages;
    }
  }

  // SIXTEEN SESSIONS, IN BOTH DENSITIES — the state the operator actually complained about. Rounds 169-172
  // fixed ten identical pwsh labels, added the +N chip, moved the view switch out of the strip and cured a
  // strip that had collapsed to 35px. EVERY SURFACE IN THIS SUITE RENDERS 0, 3 OR 4 SESSIONS, so none of that
  // work has ever been drawn by a measuring run: a regression in the chip, or in the label disambiguation, or
  // in the desktop strip's separate renderer, would be invisible. 16 is the operator's own count.
  for (const [density, path_, vp] of wants("pages") ? [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]] : []) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize(vp);
      await page.goto('http://summrise.test' + path_ + '?theme=' + theme + '&mode=idle&sessions=16&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(2000);
      const rows = await page.evaluate(PROBE);
      const name = (density === 'desktop' ? 'Desktop-16-sessions' : 'Terminal-16-sessions');
      for (const row of rows) report.rows.push({ ...row, density, theme, mode: 'overflow', page: name });
      report.themeChecks.push({ page: name, intended: theme, ...(await page.evaluate(THEME)) });
      report.surfaces.push({ density, theme, mode: 'overflow', page: name, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density, theme, mode: 'overflow', page: name, ...(await page.evaluate(NAMES, SELECTOR)) });
    }
  }

  // THE TWO REMAINING FIXTURE STATES, both hand-measured in earlier rounds and swept by nothing. Round 158
  // closed this gap for the message tones and round 159 for the busy card; these are the last two the
  // harness can express.
  //
  //   ?fail=1        every device call fails, so the cards render their ERROR surfaces. This is what the
  //                  operator sees when the device is unreachable, and no sweep has ever rendered it.
  //   ?monitor=down  a monitor target that is down, which flips a chip and the alert strip.
  //
  // Same top-level recipe as the empty and busy surfaces.
  if (wants("pages")) {
    for (const [density, path_, vp] of [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]])
    for (const [page_, query, lands] of [
      ...['light', 'dark'].map((t) => ['Terminal-fail-' + t, '?theme=' + t + '&mode=idle&sessions=3&fail=1', 'Terminal']),
      ...['light', 'dark'].map((t) => ['Settings-monitor-down-' + t, '?theme=' + t + '&mode=idle&sessions=3&monitor=down', 'Settings']),
    ]) {
      await page.setViewportSize(vp);
      await page.goto('http://summrise.test' + path_ + query + '&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1800);
      await page.evaluate((want) => {
        if (want === 'Terminal') return;
        const rail = document.querySelector('#icon-rail, .desktop-rail');
        const b = [...(rail ? rail.querySelectorAll('button') : [])].find((x) => new RegExp(want, 'i').test((x.getAttribute('aria-label') || '') + (x.textContent || '')));
        if (b) b.click();
      }, lands);
      await settle(1400);
      const rows = await page.evaluate(PROBE);
      const qTheme = /theme=([a-z]+)/.exec(query)[1];
      const pname = (density === 'desktop' ? 'Desktop-' : '') + page_;
      report.themeChecks.push({ page: pname, intended: qTheme, ...(await page.evaluate(THEME)) });
      for (const row of rows) report.rows.push({ ...row, density, theme: qTheme, mode: 'fixture', page: pname });
      report.surfaces.push({ density, theme: qTheme, mode: 'fixture', page: pname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density, theme: qTheme, mode: 'fixture', page: pname, ...(await page.evaluate(NAMES, SELECTOR)) });
      // THE FAILURE SURFACES REPORT TOO, and they are the reason the flag travels WITH the reading: ?fail=1 rejects
      // every /api/ call, so this harness legitimately never opens the stream and the panel is SUPPOSED to say
      // "Sessions unavailable". A judge that guessed that from a page name would be reading a label; this reads the
      // fixture's own answer.
      report.sse.push({ density, theme: qTheme, mode: 'fixture', page: pname, ...(await page.evaluate(SSE)) });
    }
  }

  // THE DEVICE'S LAST-COMMAND OUTCOME, PHOTOGRAPHED (round 96). liveness.ts names this hole in its own
  // comment — "'Failed' is not here because no field reports it per session" — and the device reports it now
  // (last_exit_code), so the panel's session row wears a chip for a NON-ZERO code.
  // Every seed this harness
  // builds reports no code at all, so without a surface the chip exists on the wire and nowhere a sweep can
  // measure it: the same gap rounds 88-92 closed four times, and the fifth state found the same way.
  //
  // FOUR OF THE FIVE STATES ARE ON ONE PAGE, which is what makes this surface worth its renders: the ssh row's
  // last command FAILED (Some(1) -> the triangle), the busy serial row is WORKING, the first row holds a question
  // (WAITING), and the rest are IDLE. The marks probe compares states WITHIN a family on ONE page, so this is the
  // only surface where a collapsed failed/idle or failed/waiting can be caught at all; off is the fifth and
  // lives on the closed surface. The states that render IDENTICALLY are pinned by tests instead of pixels: exit
  // ZERO and absent both draw nothing, and liveness.test.ts is where that difference lives.
  //
  //
  // PANEL DENSITY ONLY: the desktop shell renders its own tab strip and no side list, so the chip has no
  // desktop surface to photograph — measured, not assumed (the press pass reports .side-row as NOT RENDERED
  // in that density).
  // THE APPROVAL GATE'S DISARMED STATE (round 29 of the standing goal). The harness only ever rendered the gate ARMED,
  // so its hollow ring — a GRAPHIC, so 3:1 — had never been measured by anything, and the live-panel probe found it at
  // 2.56 on the light surface. This surface exists so that state is photographed on every run: the extra rows are the
  // ring's cost, and the alternative was a defect the gates cannot see.
  // THE PLUGIN DOT'S LAST STATE (round 77 of the standing goal): ongoing. Same page click as the error surface, a
  // different fixture flag — and round 163's deletion of the plugins poll is what makes it safe to render at all.
  if (wants("pages")) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=idle&sessions=3&pwrun=1&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1500);
      await page.evaluate(() => {
        const rail = document.querySelector('.rail-btn[title="Plugins"]');
        if (rail) rail.click();
      });
      await settle(1200);
      const rname = 'PluginRunning-' + theme;
      const rrows = await page.evaluate(PROBE);
      for (const row of rrows) report.rows.push({ ...row, density: 'panel', theme, mode: 'plugin-running', page: rname });
      report.surfaces.push({ density: 'panel', theme, mode: 'plugin-running', page: rname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density: 'panel', theme, mode: 'plugin-running', page: rname, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density: 'panel', theme, mode: 'plugin-running', page: rname, ...(await page.evaluate(SSE)) });
    }
  }

  // THE PLUGIN DOT'S ERROR STATE (round 42 of the standing goal). One click, one failing reply: the playwright card's
  // Start POST answers 500 with the device's own words, so the row's dot takes the error silhouette AND the message is
  // printed beneath it. callApi only throws on an HTTP error status, so a fixture answering 200 with ok:false would
  // have rendered nothing at all. Round 26 recorded that ongoing (playwright RUNNING) hangs a sweep; this is the
  // opposite end of the same control and cannot: a FAILED start never spawns a browser.
  if (wants("pages")) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=idle&sessions=3&pwstart=fail&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1800);
      // THE PAGE THE CARD LIVES ON, WHICH THIS SURFACE NEVER VISITED (round 75). A device probe asked the page and the
      // page answered: with the plugin-fail flag loaded, the button and dot counts were both 0 and the body text was
      // the TERMINAL view — the plugin cards are on the Plugins PAGE. That is the third "one click the sweep never
      // made" (after the session view tabs in round 101 and the trajectory rounds in round 33), and the rail's buttons
      // carry their destination in title, MEASURED rather than guessed:
      // Terminal / History / Browser / Memory / Plugins / Settings.
      await page.evaluate(() => {
        const rail = document.querySelector('.rail-btn[title="Plugins"]');
        if (rail) rail.click();
      });
      await settle(900);
      await page.evaluate(() => {
        // THE REAL MARKUP, NOT A GUESSED SELECTOR (round 68). The classes come from PluginsPage.tsx:
        // .plug-actions holds the controls and each is a .plug-btn. The first version guessed
        // [class*="plugin"] and matched nothing, so the surface clicked no button, no request failed, and
        // plug-dot[error] had no surface while the fixture next to it was pinned and correct.
        const card = [...document.querySelectorAll('.plug-card, .plugin-card, li')]
          .find((c) => /playwright/i.test(c.textContent || '') && c.querySelector('.plug-btn'));
        const btn = card && [...card.querySelectorAll('.plug-btn')].find((b) => /^Start/.test((b.textContent || '').trim()));
        if (btn) btn.click();
      });
      await settle(1200);
      const fname = 'PluginStartFail-' + theme;
      const frows = await page.evaluate(PROBE);
      for (const row of frows) report.rows.push({ ...row, density: 'panel', theme, mode: 'plugin-fail', page: fname });
      report.surfaces.push({ density: 'panel', theme, mode: 'plugin-fail', page: fname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density: 'panel', theme, mode: 'plugin-fail', page: fname, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density: 'panel', theme, mode: 'plugin-fail', page: fname, ...(await page.evaluate(SSE)) });
    }
  }

  // THE MONITOR ALERT STRIP'S TWO TONES (round 39 of the standing goal). The device pushes a monitor-change frame
  // when a watched host changes state, and the strip that renders it is the ONE thing in this panel the device is
  // allowed to interrupt with — so both of its marks (the recovery, .monitor-mark.is-up, and the outage, the base
  // .monitor-mark) exist only behind that frame, and no surface had ever delivered one.
  if (wants("pages")) {
    for (const theme of ['light', 'dark']) {
      for (const [dir, label] of [['up', 'MonitorUp'], ['down', 'MonitorDown']]) {
        await page.setViewportSize({ width: 1280, height: 860 });
        await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=idle&sessions=3&monitorchange=' + dir + '&cb=' + stamp, { waitUntil: 'load' });
        await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
        await page.reload({ waitUntil: 'load' });
        await settle(1800);
        const mname = label + '-' + theme;
        const mrows = await page.evaluate(PROBE);
        for (const row of mrows) report.rows.push({ ...row, density: 'panel', theme, mode: 'monitor-' + dir, page: mname });
        report.surfaces.push({ density: 'panel', theme, mode: 'monitor-' + dir, page: mname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
        report.names.push({ density: 'panel', theme, mode: 'monitor-' + dir, page: mname, ...(await page.evaluate(NAMES, SELECTOR)) });
        report.sse.push({ density: 'panel', theme, mode: 'monitor-' + dir, page: mname, ...(await page.evaluate(SSE)) });
      }
    }
  }

  // THE BOOT CHIP'S OTHER TONE (round 34 of the standing goal), for the same reason as the approval gate's off state
  // one round earlier: a mark with two tones where only one is ever painted has one unmeasured silhouette, and the
  // note has been naming boot-mark info for rounds.
  if (wants("pages")) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=idle&sessions=3&boot=replaced&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1800);
      const bname = 'BootReplaced-' + theme;
      const brows = await page.evaluate(PROBE);
      for (const row of brows) report.rows.push({ ...row, density: 'panel', theme, mode: 'boot-replaced', page: bname });
      report.surfaces.push({ density: 'panel', theme, mode: 'boot-replaced', page: bname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density: 'panel', theme, mode: 'boot-replaced', page: bname, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density: 'panel', theme, mode: 'boot-replaced', page: bname, ...(await page.evaluate(SSE)) });
    }
  }

  if (wants("pages")) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=idle&sessions=3&appr=off&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1800);
      const aname = 'ApprovalOff-' + theme;
      const arows = await page.evaluate(PROBE);
      for (const row of arows) report.rows.push({ ...row, density: 'panel', theme, mode: 'approval-off', page: aname });
      report.surfaces.push({ density: 'panel', theme, mode: 'approval-off', page: aname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density: 'panel', theme, mode: 'approval-off', page: aname, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density: 'panel', theme, mode: 'approval-off', page: aname, ...(await page.evaluate(SSE)) });
    }
  }

  if (wants("pages")) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=pending&sessions=6&exitfail=1&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1800);
      const pname = 'LastFail-' + theme;
      const rows = await page.evaluate(PROBE);
      for (const row of rows) report.rows.push({ ...row, density: 'panel', theme, mode: 'exit-fail', page: pname });
      report.surfaces.push({ density: 'panel', theme, mode: 'exit-fail', page: pname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density: 'panel', theme, mode: 'exit-fail', page: pname, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density: 'panel', theme, mode: 'exit-fail', page: pname, ...(await page.evaluate(SSE)) });
    }
  }

  // THE SAME FAILURE ON THE ACTIVE SESSION (round 98). The surface above puts it on a quiet row, and the mark is
  // ALSO drawn on the accent-filled ACTIVE TAB — where the state's ink drew 2.16:1 in dark while no surface rendered
  // the combination. One render per theme, mode=idle so nothing outranks the failure, and the ACTIVE tab and row are
  // the ones carrying it.
  if (wants("pages")) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=idle&sessions=3&exitfail=active&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1800);
      const pname = 'LastFailActive-' + theme;
      const rows = await page.evaluate(PROBE);
      for (const row of rows) report.rows.push({ ...row, density: 'panel', theme, mode: 'exit-fail-active', page: pname });
      report.surfaces.push({ density: 'panel', theme, mode: 'exit-fail-active', page: pname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density: 'panel', theme, mode: 'exit-fail-active', page: pname, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density: 'panel', theme, mode: 'exit-fail-active', page: pname, ...(await page.evaluate(SSE)) });
    }
  }

  // THE OTHER VERDICT TONE ON THE DEVICE-LOGS CARD (round 100). The card derives its sentence from the four-way
  // table over summrise-update.log, so ONE payload can only ever render one tone: the default fixture has a receipt and
  // a start (OK), and this one has the receipt with no start (WARN — the CLI reached the device and the swap never
  // launched). The card's OK tone measured 3.33:1 as text the first time it was rendered at all; a tone with no
  // surface is a tone no sweep can measure, which is the rule rounds 96-99 keep relearning.
  if (wants("pages")) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=idle&sessions=3&logs=warn&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1500);
      const pname = 'LogsWarn-' + theme;
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('#icon-rail button, .desktop-rail button')].find((x) => /settings/i.test((x.getAttribute('aria-label') || '') + x.textContent));
        if (b) b.click();
      });
      await settle(1500);
      const rows = await page.evaluate(PROBE);
      for (const row of rows) report.rows.push({ ...row, density: 'panel', theme, mode: 'logs-warn', page: pname });
      report.surfaces.push({ density: 'panel', theme, mode: 'logs-warn', page: pname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density: 'panel', theme, mode: 'logs-warn', page: pname, ...(await page.evaluate(NAMES, SELECTOR)) });
    }
  }

  // THE TWO RECORD VIEWS, WHICH NO SWEEP HAS EVER RENDERED (round 101). The per-session view switch has three
  // tabs — Terminal, Trajectory (the raw audit timeline) and Path (the same work as steps, with a summary) — and
  // every surface in this suite leaves it on Terminal. The harness DOES serve the events when asked
  // (/api/sessions/<id> carries a goal, an approval armed/approved/granted, two commands with exit 0 and exit 1,
  // and their output), so both views have real content to draw; nothing ever clicked the tab. Every style they
  // use — the event dots and their states, the exit badges, the governance chips, the plan rows, the attention
  // rows — has therefore been measured by nothing at all, which is the same hole the History page's empty archive
  // sits in. ONE CLICK, and the cost of not making it was the panel's most information-dense two views.
  if (wants("pages")) {
    for (const [density, path_, vp] of [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]]) {
      for (const theme of ['light', 'dark']) {
        // AND ONCE WITH A TRIMMED TRAIL (round 83): TrajectoryView renders .traj-trimmed when first_seq > 1, a fact
        // only the device can state, and one no surface had ever carried — the wire-field-check gate found the field
        // missing from every fixture on its first run. Panel density only: the state is about the trail, and both
        // densities read the same view.
        for (const tab of ['Trajectory', 'Path']) {
          for (const trimmed of density === 'panel' ? [false, true] : [false]) {
          await page.setViewportSize(vp);
          await page.goto('http://summrise.test' + path_ + '?theme=' + theme + '&mode=idle&sessions=3&cb=' + stamp + (trimmed ? '&trimmed=1' : ''), { waitUntil: 'load' });
          await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
          await page.reload({ waitUntil: 'load' });
          await settle(1500);
          await page.evaluate((want) => {
            const btn = [...document.querySelectorAll('.view-switch button, .desktop-view-switch button')]
              .find((b) => (b.textContent || '').trim() === want);
            if (btn) btn.click();
          }, tab);
          // AND OPEN THE ROUNDS, WHICH IS THE CLICK THAT WAS STILL MISSING (round 33). Only the NEWEST round is
          // open by default, and the newest round is the fixture's live reboot — a command with no output yet — so
          // its body is (no output yet) and every event row (and its .traj-ev-dot) lived inside a COLLAPSED
          // round: the family measured 0 of 6 states across 128 surfaces while the view rendered perfectly. The note
          // only started saying so after round 31 added that trailing command, which is a fair illustration of how a
          // fixture change can hide a family: the sweep opened the tab (round 101) but never a round.
          if (tab === 'Trajectory') {
            await page.evaluate(() => {
              for (const head of [...document.querySelectorAll('.traj-round-head')].slice(0, 12)) head.click();
            });
            await settle(900);
          }
          await settle(1800);
          const pname = (density === 'desktop' ? 'Desktop-' : '') + tab + '-' + theme
            + (trimmed ? '-trimmed' : '');
          const rows = await page.evaluate(PROBE);
          for (const row of rows) report.rows.push({ ...row, density, theme, mode: 'record', page: pname });
          report.surfaces.push({ density, theme, mode: 'record', page: pname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
          report.names.push({ density, theme, mode: 'record', page: pname, ...(await page.evaluate(NAMES, SELECTOR)) });
          report.sse.push({ density, theme, mode: 'record', page: pname, ...(await page.evaluate(SSE)) });
          }
        }
      }
    }
  }

  // THREE STATES OF THE RECORD PAGE THAT NO SURFACE HAS EVER PHOTOGRAPHED (round 102). The History page's first
  // scope is the ARCHIVE, and every sweep has measured it EMPTY: the harness has served a populated one behind
  // ?rows=N since round 69, and no surface ever passed it — so the row list, its identity/reason/when columns and
  // its cost at scale were measured by nothing. Inside a row is the TRAIL of a recorded session, which is the one
  // place an operator can read a session that is over. And the page's SECOND scope ("Runs") reads /api/operation,
  // which no stub answered at all until this round.
  if (wants("pages")) {
    const gotoHistory = async () => {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('#icon-rail button, .desktop-rail button')].find((x) => /history/i.test((x.getAttribute('aria-label') || '') + x.textContent));
        if (b) b.click();
      });
      await settle(1500);
    };
    for (const theme of ['light', 'dark']) {
      // (a) THE ARCHIVE WITH CONTENT
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=idle&sessions=3&rows=50&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1500);
      await gotoHistory();
      const rowsName = 'ArchiveRows-' + theme;
      const rowsA = await page.evaluate(PROBE);
      for (const row of rowsA) report.rows.push({ ...row, density: 'panel', theme, mode: 'archive', page: rowsName });
      report.surfaces.push({ density: 'panel', theme, mode: 'archive', page: rowsName, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density: 'panel', theme, mode: 'archive', page: rowsName, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density: 'panel', theme, mode: 'archive', page: rowsName, ...(await page.evaluate(SSE)) });

      // (b) THE TRAIL INSIDE AN ARCHIVED SESSION — one click, the same page
      await page.evaluate(() => {
        const b = document.querySelector('.archive-row');
        if (b) b.click();
      });
      await settle(1800);
      const trailName = 'ArchiveTrail-' + theme;
      const rowsB = await page.evaluate(PROBE);
      for (const row of rowsB) report.rows.push({ ...row, density: 'panel', theme, mode: 'archive-trail', page: trailName });
      report.surfaces.push({ density: 'panel', theme, mode: 'archive-trail', page: trailName, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density: 'panel', theme, mode: 'archive-trail', page: trailName, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density: 'panel', theme, mode: 'archive-trail', page: trailName, ...(await page.evaluate(SSE)) });
    }
    for (const theme of ['light', 'dark']) {
      // (c) THE RUNS SCOPE
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=idle&sessions=3&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1500);
      await gotoHistory();
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('.view-switch button, .desktop-view-switch button')].find((x) => (x.textContent || '').trim() === 'Runs');
        if (b) b.click();
      });
      await settle(1800);
      const runsName = 'HistoryRuns-' + theme;
      const rowsC = await page.evaluate(PROBE);
      for (const row of rowsC) report.rows.push({ ...row, density: 'panel', theme, mode: 'runs', page: runsName });
      report.surfaces.push({ density: 'panel', theme, mode: 'runs', page: runsName, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density: 'panel', theme, mode: 'runs', page: runsName, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density: 'panel', theme, mode: 'runs', page: runsName, ...(await page.evaluate(SSE)) });
    }
  }

  // THE ACKNOWLEDGEMENT'S LATENCY, MEASURED AGAINST A SLOW NETWORK (round 19). Every response is delayed by
  // slowms, so a control whose feedback waits for the reply cannot hide: the panel's promise is that the pressed
  // control shows its busy state ON THE EVENT. Two controls per density, both themes — the monitor row's check now
  // (a network call with a visible result) and the add form's watch (a POST that also changes the page).
  const ACK_BUDGET_MS = 100;
  if (wants("ack")) {
    for (const [density, path_, vp] of [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize(vp);
        await page.goto('http://summrise.test' + path_ + '?theme=' + theme + '&mode=idle&sessions=3&slowms=900&cb=' + stamp, { waitUntil: 'load' });
        await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
        await page.reload({ waitUntil: 'load' });
        await settle(2200);
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('#icon-rail button, .desktop-rail button')].find((x) => (x.getAttribute('aria-label') || '').toLowerCase() === 'settings');
          if (b) b.click();
        });
        await settle(2200);
        const name = (density === 'desktop' ? 'Desktop-' : '') + 'Settings-ack-' + theme;
        // THE CURATED PAIR STAYS ON THIS PAGE, AND THE REASON IS MEASURED (round 20). Discovery was tried here
        // first: the Settings page renders the connect form's controls ahead of everything else, so a cap of eight
        // spent itself on three tabs and three unnamed buttons — and the tabs are a FALSE ACCUSATION, because the
        // first one is ALREADY ACTIVE and clicking it has nothing to do. The pass's __calls delta cannot excuse
        // them either: this page polls (update, monitors, vitals, restarts, logs), so a background request lands in
        // almost any window and "this control asked the device" becomes unattributable. The two controls below are
        // the ones whose work is known; discovery belongs on a page where every button does something, which is the
        // Memory page below.
        const rows = await ackPass(page, ['.monitor-btn', '.monitor-add .btn'], ACK_BUDGET_MS, { density, theme, mode: 'ack', page: name });
        report.ack = report.ack || [];
        for (const r of rows) report.ack.push(r);
      }
    }
  }

  // AND THE MEMORY PAGE, whose buttons write and delete device-local records (round 20). One page is not a survey:
  // the Settings surface answers for Settings, and the control nobody named is as likely to live here.
  if (wants("ack")) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto('http://summrise.test/panel/?theme=' + theme + '&mode=idle&sessions=3&slowms=900&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(2200);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('#icon-rail button, .desktop-rail button')].find((x) => (x.getAttribute('aria-label') || '').toLowerCase() === 'memory');
        if (b) b.click();
      });
      await settle(2200);
      const name = 'Memory-ack-' + theme;
      const rows = await ackPass(page, [], ACK_BUDGET_MS, {
        density: 'panel', theme, mode: 'ack', page: name, discover: 4,
        skip: ['.rail-btn', '.desktop-rail-btn', '.tab', '.dtab', '.side-row', '.side-add'],
      });
      report.ack = report.ack || [];
      for (const r of rows) report.ack.push(r);
    }
  }

  // THE UNSET GOAL, WHICH IS THE COMMON CASE (round 90). GoalBar's own comment calls an unset goal "normal (most
  // sessions)" and describes what it renders instead: "a QUIET affordance". Every fixture this harness has ever built
  // gave EVERY session a goal, so the affordance — a dashed-bordered button whose only content is a bare text node,
  // with no .goal-text span inside it — has never been rendered, while the state it replaces has been measured on
  // every page. Third round running that a surface for an unrendered state found the state was not what the sheet
  // alone could prove.
  if (wants("pages")) {
    for (const [density, path_, vp] of [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize(vp);
      await page.goto('http://summrise.test' + path_ + '?theme=' + theme + '&mode=idle&sessions=4&goal=none&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1800);
      const pname = (density === 'desktop' ? 'Desktop-' : '') + 'NoGoal-' + theme;
      const rows = await page.evaluate(PROBE);
      for (const row of rows) report.rows.push({ ...row, density, theme, mode: 'no-goal', page: pname });
      report.surfaces.push({ density, theme, mode: 'no-goal', page: pname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density, theme, mode: 'no-goal', page: pname, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density, theme, mode: 'no-goal', page: pname, ...(await page.evaluate(SSE)) });
    }
  }

  // THE HELD SESSION, PHOTOGRAPHED FOR THE FIRST TIME (round 89). held_by_human is the fact the panel is most
  // careful about — SessionControl reads it from the session record and will not flip the button until the server
  // agrees — and every fixture this harness has ever built set it FALSE. So the HUMAN state of the .sc-dot mark
  // (a solid fill against the ai state's inset ring) and the button's .held variant have never been rendered.
  // ONE session is held and the rest are not, because the marks probe compares states within a family and can only
  // see a collision between two states that are both on screen.
  if (wants("pages")) {
    for (const [density, path_, vp] of [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize(vp);
      await page.goto('http://summrise.test' + path_ + '?theme=' + theme + '&mode=idle&sessions=4&held=1&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1800);
      const pname = (density === 'desktop' ? 'Desktop-' : '') + 'Held-' + theme;
      const rows = await page.evaluate(PROBE);
      for (const row of rows) report.rows.push({ ...row, density, theme, mode: 'held', page: pname });
      report.surfaces.push({ density, theme, mode: 'held', page: pname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density, theme, mode: 'held', page: pname, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density, theme, mode: 'held', page: pname, ...(await page.evaluate(SSE)) });
    }
  }

  // THE FOURTH SILHOUETTE, PHOTOGRAPHED AT LAST (round 88). The mark language has four states — off, waiting,
  // working, idle — and this file's own note has said for many rounds that the page sweep, which photographs pages
  // and never presses, has never photographed 'off': a closed session is CLIENT state, so no URL parameter can
  // produce it. It is reachable by PRESSING, and the recipe is the harness's: click the tab's x to arm the two-step
  // close, click the confirm's Close, and read AFTER the tab's 0.15s background transition settles. Round 245 made
  // it stable — terminal_close removes the session from every later list answer, so the tombstone no longer lives
  // only inside a timing window.
  //
  // AND IT IS THE ONLY SURFACE WHERE ALL FOUR STATES CAN BE COMPARED AT ONCE, which is the point. The marks probe
  // groups a family's states per page and fails when two of them paint identically; until this surface existed, a
  // page could show working beside idle and never show off beside either. mode=pending keeps the pending approval,
  // so the diamond is here too.
  if (wants("pages")) {
    for (const [density, path_, vp] of [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize(vp);
      await page.goto('http://summrise.test' + path_ + '?theme=' + theme + '&mode=pending&sessions=4&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1800);
      // 1. arm the two-step close on the LAST tab, so the states the other surfaces rely on stay on screen.
      await page.evaluate(() => {
        const closes = [...document.querySelectorAll('.tab .tab-close')];
        if (closes.length) closes[closes.length - 1].click();
      });
      await page.waitForTimeout(250);
      // 2. confirm it. /api/tools/terminal_close is stubbed and succeeds.
      await page.evaluate(() => {
        const confirm = document.querySelector('.tab-confirm .btn-danger');
        if (confirm) confirm.click();
      });
      await page.waitForTimeout(700);
      const pname = (density === 'desktop' ? 'Desktop-' : '') + 'Closed-' + theme;
      const rows = await page.evaluate(PROBE);
      for (const row of rows) report.rows.push({ ...row, density, theme, mode: 'closed', page: pname });
      report.surfaces.push({ density, theme, mode: 'closed', page: pname, ...(await page.evaluate(SURFACE, SELECTOR)), marks: await page.evaluate(MARKS, SELECTOR) });
      report.names.push({ density, theme, mode: 'closed', page: pname, ...(await page.evaluate(NAMES, SELECTOR)) });
      report.sse.push({ density, theme, mode: 'closed', page: pname, ...(await page.evaluate(SSE)) });
    }
  }

  // WHY THE EVIDENCE DRAWER IS STILL NOT MEASURED, recorded so it is not re-attempted from scratch
  // (round 193). THIS HARNESS RENDERS THE REAL BUNDLE — panel.js and panel.css — and drives it with stubbed
  // API responses; it contains no hand-written markup at all. The drawer is opened only by
  // EmbeddedBrowserPane, which talks to the Electron shell's control server on 127.0.0.1:9444, so in a
  // browser there is no pane to open it from. Adding a hand-written drawer block would put the ONLY
  // fabricated markup in a fixture built on the real app, and it would measure my markup rather than the
  // component. The two honest routes are an app-level seam (a URL parameter that opens the drawer, which is
  // a test hook in shipped code) or measuring it inside Electron (which this repository has no runner for).
  // Neither is taken; the gap is real and named rather than assumed.
  // TARGET SIZE, WCAG 2.5.8, the FULL criterion. Nothing measured it before round 162 — the number 24 was
  // already in this suite as the threshold for whether a non-text element is a MARK, which is a different
  // question. Both densities, one render each, recorded like any other surface.
  for (const [density, path_, vp] of wants("pages") ? [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]] : []) {
    await page.setViewportSize(vp);
    await page.goto('http://summrise.test' + path_ + '?theme=light&mode=relaxed&sessions=3&cb=' + stamp, { waitUntil: 'load' });
    await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
    await page.reload({ waitUntil: 'load' });
    await settle(2000);
    report.targets.push({ density, mode: 'rest', ...(await page.evaluate(TARGETS)) });
  }
  if (wants("pages")) passCost("pages");

  // UNSTYLED CLASSES — the mirror of dead CSS, and the failure a PRUNE causes. Same collector the
  // console uses, from the shared core, embedded with JSON.stringify (round 88 shipped one embedded
  // in a template literal and the device received /s+/ where the source said /\s+/: the report listed
  // "btn btn-" and "rail-clu", finding 38 styled classes where the browser sees 221).
  for (const [density, path_, vp] of wants("unstyled") ? [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]] : []) {
    await page.setViewportSize(vp);
    await page.goto('http://summrise.test' + path_ + '?theme=light&mode=relaxed&sessions=3&cb=' + stamp, { waitUntil: 'load' });
    await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
    await page.reload({ waitUntil: 'load' });
    await settle(1500);
    report.unstyled.push({ page: density, ...(await page.evaluate(UNSTYLED)) });
  }
  if (wants("unstyled")) passCost("unstyled");

  // HOVER, measured rather than assumed. Nothing had ever looked at it: the static pair sweep reads
  // base rules and every rendered pass measures the resting DOM, while the panel carries 73 :hover
  // rules. Each interactive element is hovered in turn and the page measured while it is hovered.
  for (const [density, path_, vp] of wants("hover") ? [['panel', '/panel/', { width: 1280, height: 860 }], ['desktop', '/desktop/', { width: 1440, height: 900 }]] : []) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize(vp);
      await page.goto('http://summrise.test' + path_ + '?theme=' + theme + '&mode=relaxed&sessions=3&cb=' + stamp, { waitUntil: 'load' });
      await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
      await page.reload({ waitUntil: 'load' });
      await settle(1500);
      const underAA = [];
      // ONE PER FAMILY, not every instance. Re-running the whole-DOM probe after each hover costs a
      // pass over ~400 nodes, and 31 elements x 4 combinations made the sweep exceed the caller's
      // timeout twice. Hover styles are per-class, so the first element of each distinct class is the
      // same measurement at a quarter of the cost.
      const all = await page.$$('#root button, #root [role="button"], #root a');
      const seenClass = new Set();
      const handles = [];
      for (const h of all) {
        const key = await h.evaluate((el) => (typeof el.className === 'string' ? el.className : el.tagName));
        if (seenClass.has(key)) continue;
        seenClass.add(key);
        handles.push(h);
      }
      for (const h of handles) {
        // SKIP WHAT CANNOT BE HOVERED BEFORE ASKING. hover() waits out its timeout on a hidden or
        // zero-size element, and 31 elements x 4 passes of that made this pass longer than the whole
        // rest of the sweep (the first live run timed out at the call boundary, not in the page).
        //
        const box = await h.boundingBox();
        if (!box || box.width < 2 || box.height < 2) continue;
        try {
          await h.hover({ timeout: 400 });
        } catch (e) {
          continue;   // covered by something else in this viewport
        }
        await page.waitForTimeout(90);
        for (const r of await page.evaluate(PROBE)) {
          const need = r.need ?? 4.5;
          if (r.cr !== null && !r.inactive && r.cr < need) {
            underAA.push(r.sel + ' "' + String(r.text).slice(0, 16) + '" ' + r.cr + '<' + need + ' painted ' + r.paint + ' on ' + r.surface + ', ' + r.size + 'px ' + r.kind);
          }
        }
        await page.mouse.move(2, 2);
      }
      report.hover.push({ density, theme, interactive: handles.length, underAA: [...new Set(underAA)] });
    }
  }
  if (wants("hover")) passCost("hover");

  // REDUCED MOTION, measured rather than assumed: render both densities with the preference
  // EMULATED and ask the page which elements still have a running transition or animation. Reading
  // the stylesheet cannot answer this — a media query adds no specificity, so the answer depends on
  // cascade order, selector scope and xterm's runtime-injected sheet.
  for (const [density, path_] of wants("motion") ? [['panel', '/panel/'], ['desktop', '/desktop/']] : []) {
    await page.setViewportSize(density === 'panel' ? { width: 1280, height: 860 } : { width: 1440, height: 900 });
    // MEASURE IT TWICE, because "nothing animates under reduce" is only evidence if SOMETHING animates
    // without it. The old report carried one number, so a page with no transitions at all and a page
    // whose transitions were correctly suppressed both read as "animating: []" — the same vacuity this
    // suite keeps finding in its own checks. Normal first, then the same page with the preference set.
    await page.emulateMedia({ reducedMotion: null });
    await page.goto('http://summrise.test' + path_ + '?theme=light&mode=idle&sessions=3&cb=' + stamp, { waitUntil: 'load' });
    await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
    await page.reload({ waitUntil: 'load' });
    // ── THE LAST TWO CLOCKS IN THIS FILE, AND WHY THEY COULD NOT BE CONVERTED UNTIL NOW ───────────────────────────
    // Every other settle is covered by an equivalence the counts can see: one that fires early drops surfaces, names
    // or a rail page, and `{rows, surfaces, names}` moves. THIS pass's numbers are not in those three — `MOTION` reads
    // computed `transitionDuration` and `animationName`, so a page measured slightly early reports FEWER animations and
    // nothing in the counts would say so. That is what kept them clocks through three rounds of conversions.
    //
    // ROUND 10 GAVE EVERY AXIS ITS OWN LINE FOR EXACTLY THIS, and the motion numbers are `panel:13->0 desktop:11->0`.
    // A settle that fires early moves them, so the change is falsifiable now — which is the whole test, and the reason
    // the conversion waited for the instrument rather than the other way round. (The claim written here before, that
    // the axis "has no floor in the judge", was WRONG: round 134 fails `normal === 0` with "the check found nothing to
    // suppress". What was missing was the NUMBER a reader can compare, not the floor.)
    await settle(1600);
    const normal = await page.evaluate(MOTION);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload({ waitUntil: 'load' });
    await settle(1200);
    const reduced = await page.evaluate(MOTION);
    report.motion.push({
      density,
      normal: normal.animating.length,
      reduced: reduced.animating.length,
      stillAnimating: reduced.animating.slice(0, 6),
    });
  }
  await page.emulateMedia({ reducedMotion: null });
  if (wants("motion")) passCost("motion");

  // Reflow at the two widths WCAG 1.4.10 names, panel density only: the desktop density needs the
  // width it has, and its tab strip is the standard's own toolbar exception.
  for (const width of wants("reflow") ? [640, 320] : []) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('http://summrise.test/panel/?theme=light&mode=idle&sessions=3&cb=' + stamp, { waitUntil: 'load' });
    await page.evaluate(() => { try { localStorage.setItem('summriseGettingStarted', '1'); } catch (e) {} });
    await page.reload({ waitUntil: 'load' });
    await settle(1500);
    report.reflow.push({ width, ...(await page.evaluate(REFLOW, SELECTOR)) });
  }
  if (wants("reflow")) passCost("reflow");
  // THE BUDGET, printed LAST so it covers every pass: what the whole run spent in waits, navigations and probes.
  // `wait` is the bucket the per-pass marks cannot see — a fixed sleep is inside whichever pass called it — and it is
  // the one that can be given back without weakening anything if it turns out to be most of the body.
  {
    const spent = ["wait", "nav", "eval"].map((k) => `${k}=${BUDGET[k][0]}x/${(BUDGET[k][1] / 1000).toFixed(1)}s`).join(" ");
    console.log(`budget ${spent} of ${((Date.now() - SWEEP_T0) / 1000).toFixed(1)}s`);
    // SORTED BY WHAT EACH VALUE COST, not by how often it was asked for: a 90ms wait inside a sampling loop is not a
    // finding, and a 1500ms settle that runs 150 times is 225 seconds of the job.
    const top = [...BUDGET.waitByMs.entries()].sort((a, b) => b[1][1] - a[1][1]).slice(0, 8)
      .map(([asked, [n, ms]]) => `${asked}ms=${n}x/${(ms / 1000).toFixed(1)}s`).join(" ");
    console.log(`budget waits by the value asked for (top 8 of ${BUDGET.waitByMs.size}): ${top}`);
    // THE SETTLES ARE NOT IN `wait` ANY MORE — they no longer call `waitForTimeout` — so they get their own line, and
    // `asked` against `needed` is the whole question: equal means the clock was right, far apart means it was padding.
    console.log(`budget settle ${SETTLE.calls}x asked=${(SETTLE.asked / 1000).toFixed(1)}s needed=${(SETTLE.needed / 1000).toFixed(1)}s capped=${SETTLE.capped}`);
  }
  await diag("done rows=" + (report.rows || []).length + " findings-source-ready pid=" + process.pid);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report));
  console.log(JSON.stringify({ rows: report.rows.length, surfaces: report.surfaces.length, names: report.names.length }));
  // ── EVERY AXIS'S OWN NUMBER, because three of twelve cannot falsify a change ────────────────────────────────────
  // The line above has carried `rows`, `surfaces` and `names` since this sweep was written, and those three are the
  // ONLY evidence a CI log holds about what a run covered. That is enough for the contrast, hierarchy and naming axes
  // and for nothing else. Round 6 of the standing goal left this file's motion pass waiting on two CLOCKS for exactly
  // that reason — `MOTION` reads computed `transitionDuration` and `animationName`, so a page measured slightly early
  // reports FEWER animations and nothing in those three numbers would say so. The claim made there was that the axis
  // "has no floor in the judge"; re-reading it, **the floor IS there** (round 134: `normal === 0` fails with "the check
  // found nothing to suppress"), so what was missing is not a floor but A NUMBER A READER CAN COMPARE. This is it, for
  // every axis, on one line — so the next change to any of them is falsifiable from the log instead of from trust.
  //
  // THE FIRST READING (run 36251363816) IS THE REFERENCE, and it is also the proof the line was needed: motion
  // `panel:13->0 desktop:11->0` — the number round 6 could not see — hover `14i/0aa` and `11i/0aa`, focus `14p/14l/0m`
  // on all eight renders, press `11of11`/`12of12` on the rail walks, `ack 16r/8a`, targets `32c/10u 29c/9u 27c/8u`,
  // idle `1mut`/`7mut` per page (the live clock, exempt by name in CLOCKS), unstyled `1133c/0unread` in both densities,
  // reflow `640:ok 320:SCROLLS`, `102open/4fail` SSE, node counts 430-438 / 337-349. FOUR of those are questions nobody
  // could ask before — half the ack rows unacknowledged, ten undersized targets, a sideways-scrolling 320px document,
  // and mutations while "idle" on every page — and each is either exempted by a named clause in the judge or is a
  // finding that has been waiting for a reader.
  {
    const count = (a) => (report[a] || []).length;
    const axes = {
      motion: (report.motion || []).map((m) => `${m.density}:${m.normal}->${m.reduced}`),
      hover: (report.hover || []).map((h) => `${h.density}/${h.theme}:${h.interactive}i/${(h.underAA || []).length}aa`),
      // `p/l/m` COULD NOT TELL "ESCAPED" FROM "UNACCOUNTED" (round 21 of the standing goal). `focusPass` counts four
      // things — pressed, landed, escaped, and `unconfirmed` (the press whose ring the pixels could not confirm, which
      // the judge FAILS) — and this printed three. So `16p/15l/0m` on the console's routes page read as "one press went
      // nowhere", when the only way it can be green is `escaped: 1`: the tab cycle leaving the document. Two numbers
      // were missing from a line whose whole purpose is to be comparable, which is the third time this class has been
      // fixed here (the console's press label in round 13, the ack premise in round 11).
      focus: (report.focus || []).map((f) => `${f.density || f.page}/${f.theme || f.width || "-"}:${f.pressed || 0}p/${f.landed || 0}l/${f.missing || 0}m/${f.escaped || 0}e/${f.unconfirmed || 0}u`),
      // `4of?` SAID THE DENOMINATOR WAS UNKNOWN AND NOT WHY (round 21 of the standing goal). The mode loop HANDS this
      // pass a curated list — no `discover` — so `found` is null by construction and always will be; the rail walks
      // discover, so they carry `11found`. Printing `?` made a deliberate design look like a missing number, and the
      // word costs nothing: `list` says which of the two this row is.
      press: (report.press || []).map((p) => `${p.page || p.density}/${p.mode || "-"}:${p.measured || 0}pressed/${p.found == null ? "list" : p.found + "found"}`),
      ack: `${count("ack")}r/${(report.ack || []).filter((a) => a.acked).length}a`,
      targets: (report.targets || []).map((t) => `${t.density}/${t.mode}:${t.checked || 0}c/${t.undersized || 0}u`),
      idle: (report.idle || []).map((i) => `${i.density}/${i.page || "-"}:${i.mutations == null ? "?" : i.mutations}mut`),
      unstyled: (report.unstyled || []).map((u) => `${u.page}:${u.styledClasses || 0}c/${u.sheetsUnreadable || 0}unread`),
      // THE SCROLLER COUNT IS PART OF THE VERDICT, NOT DECORATION (round 22 of the standing goal). The panel's 320px
      // reflow finding is excused by a predicate in its judge — "every offending scroller is a tab child" — and
      // `.every()` on an EMPTY list is vacuously TRUE, so a row that names NO scroller would be excused by a reason it
      // does not satisfy. The probe only lists elements that are THEMSELVES horizontal scrollers
      // (`overflowX: auto|scroll`), so an element that is merely WIDE produces exactly that empty list. This prints the
      // count, because the excuse's premise has to be visible before anything is done about it.
      reflow: (report.reflow || []).map((r) => `${r.width}:${r.docScrollsSideways ? "SCROLLS" : "ok"}/${(r.sideScrollers || []).length}sc/${(r.overflowing || []).length}over`),
      nodes: (report.timing || []).map((t) => `${t.density}/${t.mode}:${t.nodes}`),
      sse: `${(report.sse || []).filter((s) => s.opened).length}open/${(report.sse || []).filter((s) => s.fail).length}fail`,
    };
    console.log(JSON.stringify({ axes }));
  }
  await close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
