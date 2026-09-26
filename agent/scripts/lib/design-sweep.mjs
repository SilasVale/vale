// design-sweep — the shared core every UI's design sweep is built from.
//
// WHY IT EXISTS (round 59). Rounds 50, 56 and 58 wrote three sweep tools — the panel's, the
// console's and (ad hoc) the extension's — and by the third one the duplication was plain: the same
// in-page checks (headings, landmarks, overflow/clipping/slivers, accessible names, reflow), the
// same judge, the same report shape, three times over. Three copies of a *measurement* is worse than
// three copies of ordinary code: when one copy learns something the others stay wrong.
//
// The history of those lessons is exactly why this file exists:
//   * an ellipsis is NOT clipped text (a detector that cries wolf stops being read);
//   * a login gate legitimately has no `nav`, while a page must have exactly one `main`;
//   * a gradient is judged by its WORST stop (the probe's own rule, reused here);
//   * a sweep that reads nothing is not a sweep that found nothing.
//
// Each UI supplies only what is genuinely its own: the URL to serve, the page list, the API
// fixtures, and whether it has a nav at all.

// THE PANEL'S DECORATIVE WAIVERS, SHARED BY BOTH INSTRUMENTS (round 265).
//
// WHY THEY MOVED HERE. These entries were local to `panel-design-sweep.mjs`'s judge, and the other instrument
// that reads the same measurements — `panel-render-audit.mjs` — had never run (it crashed on a missing import
// until this round), so nobody had seen them disagree. The first run that worked reported TWO failures that the
// sweep waives on purpose: `span.approval-grant` at 1.19 light / 1.25 dark, the grant pill's outline, waived in
// a measured band with the reason that the pill's TEXT carries the signal. Two instruments, one measurement, two
// verdicts — so the policy lives in ONE place and both read it. The band semantics are the judge's: an entry
// waives the RATIOS it was measured at, and a row matching the selector at a DIFFERENT ratio is still a finding.
export const DECORATIVE_WAIVERS = [
  // PRUNED: THE WORKING DOT'S HALO WAIVER (round 21 of the standing goal). The entry was `/^div\.rail-dot$/`
  // with the band 2.25-2.45, written when the rows path reported that mark by that class string. The mark
  // language gained `data-live` and the row's selector became `div.mark.rail-dot`, so the pattern has matched
  // NOTHING for several rounds — measured, not assumed: across the whole 126-surface report it matches 0 of
  // 6,876 rows, and the 68 rows that DO name that element are all above their bar (6.50 light / 10.99 dark
  // against 3, and the dot's fill is held at exactly 3.00 by the panel gate, which fails on a mutation to
  // #8a2a07 at 1.90). Nothing needed the exemption any more, which is the definition of weight that stops
  // earning its place. The HOVER path's exemption lives in `ignore` and is untouched; if the halo ever
  // returns as a measured row, the band and its reason are in this file's history and in the design ledger.
  {
    // MEASURED, AND ONE WORD OF THE OLD REASON WAS WRONG (round 203). It read "its meaning is its text
    // (contrast-fixed for this chip already) and its dot" — THERE IS NO DOT. The chip is text plus a revoke
    // button, and the numbers this run produces are: the waived outline at 1.19 (it delimits the pill), the
    // command text at worst 5.53 of 4.5 across 88 rows, and the revoke control at 5.33 of 4.5. The two
    // contrast fixes the CSS documents — --muted at 4.31 for an 11px mono label, and --faint at 2.33 for the
    // one control that can undo a grant — both hold. The outline is the pill's edge; the word is the signal.
    match: /^span\.approval-grant$/,
    // FOUR SURFACES, FOUR RATIOS — 1.19, 1.20, 1.25, 1.27, measured on the device round 95 — because the outline
    // composites over a different surface on each.
    //
    // "AND NOTHING ELSE" IS TRUE NOW (round 23). The band was 1.10-1.35, which is ~0.09 wider on each side than any
    // ratio this suite has ever seen: a drift to 1.12 or 1.33 — real movement toward the 3:1 bar — would have been
    // waived silently. Measured across 32 rows on 126 surfaces: 1.19-1.27, four distinct values. The band is that
    // range plus the declared slack, and the slack is the only margin left to argue about.
    values: [[1.17, 1.29]],
    // PROBE ROUNDING ONLY: the ratios are printed to two decimals, so a true 1.185 reports as 1.19 and a band
    // written at the printed value would refuse it. Two hundredths is the smallest allowance that survives that.
    slack: 0.02,
    reason: "the grant chip's outline delimits the pill at 1.19; the signal is its command text (worst 5.53 of 4.5) and its revoke control (5.33 of 4.5) — both measured every run",
  },
  {
    // THE MENU'S ICON CHIP: ITS BACKGROUND DELIMITS, AND ITS GLYPH IS NOW MEASURED TOO (round 92, corrected
    // round 95). The first photograph of the new-session menu reported span.nm-ico at 1.05 dark / 1.10 light — a
    // 22px chip whose background is a subtle surface behind a coloured glyph, which is what a chip's background is
    // for. What this entry silences is THAT BACKGROUND.
    //
    // THE REASON IT CARRIED FOR FIFTY ROUNDS WAS TRUE WHEN WRITTEN AND IS NOW FALSE, which is why it is worth the
    // line: "the GLYPH ITSELF IS NOT MEASURED — the probe excludes SVG by design". Rounds 93-94 changed exactly
    // that — the svg ROOT is let through, and its paint counts where a shape computes it — so the per-kind lane
    // colour that carries this menu's meaning (--lane-ds for ssh, --lane-or for serial) DOES have a row now, and it
    // clears the 3:1 bar on every surface the sweep renders. A waiver that still claims its signal is unmeasured
    // would stop the next reader looking for the finding that can now appear.
    match: /^span\.nm-ico$/,
    // 1.05 light / 1.10 dark, the chip's own background — and the band is now that range plus the slack rather
    // than 1.00-1.15, which carried 0.05 of margin on each side that no measurement justified (round 23).
    values: [[1.03, 1.12]],
    slack: 0.02,
    reason: "the icon chip's BACKGROUND delimits a coloured glyph at 1.05/1.10; the glyph itself is measured by the SVG rule since round 94 and clears 3:1 — the lane colour it carries has its own row now",
  },
];

/** The in-page checks, as source text for the emitted browser script.
 *
 *  A FUNCTION OF THE ROOT SELECTOR, not a constant. These checks are evaluated IN THE PAGE by
 *  `page.evaluate(string)`, so an identifier from the Node side (the obvious `const ROOT_SEL`) is
 *  simply undefined there — measured: the extension sweep died on `ROOT_SEL is not defined` while
 *  the Node script defined it perfectly well. Inlining the selector at emit time makes that
 *  impossible to get wrong. */
// THE MARK-AXIS SOURCE, EXTRACTED SO THERE IS ONE COPY (round 30 of the standing goal). The live-panel probe needs
// the same measurement the sweeps' surface probe makes — families, per-state silhouettes, collisions — and a second
/** PAGE-SIDE PROBES MUST CARRY THEIR DEPENDENCIES, AND THIS IS THE ONE PLACE THAT DOES IT (round 271).
 *  `page.evaluate(fn)` serializes the function ALONE, so anything it closes over is undefined in the page — which is
 *  why these probes were template literals with helper source and the root selector substituted in at emit time. The
 *  selector is an ARGUMENT now, so no identifier from this side can leak into the page; the one helper a probe needs
 *  is bound here, once, at load, from its ONE module-level definition. Nothing else in this file composes source. */
function withHelpers(body, helpers) {
  const decls = Object.entries(helpers).map(([name, fn]) => "const " + name + " = " + fn.toString() + ";").join("\n");
  return new Function("return function probe(root) {\n" + decls + "\n" + body + "\n};")();
}

/** THE MARK AXIS: families, per-state silhouettes, collisions, ring+fill. */
export function marksProbe(root) {
    const families = new Map();
    // WHICH STATE-MARK CLASSES ARE ON SCREEN AT ALL (round 28). The probe attributes a mark to the family its
    // STATE hangs off — a mark tab-dot element with data-live is family mark — so a class like tab-dot can be
    // rendered on every tab and still never appear as a family of its own. Without this set, a judge asking "did
    // anything render family X?" cannot tell A CLASS NOTHING PUTS ON SCREEN from ONE THE PROBE ATTRIBUTES
    // ELSEWHERE, and the sheet-enumerated note reported both as gaps.
    const present = new Set();
    for (const el of document.querySelectorAll(root + ' *')) {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      // WHAT IS ON SCREEN IS COLLECTED BEFORE THE SIZE FILTER, because the two questions are different: present
      // answers "does this class exist on this page at all", and the filter below answers "is this a MARK". A
      // class on a full-width ROW (.run-row-state, .archive-state, .monitor-state) is on screen and is not a
      // mark, and collecting only from small elements made the judge call those "NO SURFACE RENDERED" — a queue of
      // false gaps, which is worse than no queue (round 32).
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/) : [];
      for (const c of cls) if (/(dot|dotcol|mark|led|chip|signal|state)$/.test(c)) present.add(c);
      if (r.width < 4 || r.height < 4 || r.width > 40 || r.height > 40) continue;
      const state = el.getAttribute('data-state') || el.getAttribute('data-live');
      // the family is the class the STATE rules hang off: with a data-attribute it is the first class, with a
      // modifier class it is everything except the last one
      const base = state ? cls[0] : cls.length > 1 ? cls.slice(0, -1).join('.') : null;
      const which = state || (cls.length > 1 ? cls[cls.length - 1] : null);
      if (!base || !which) continue;
      if (!/\.(dot|dotcol|mark|led|chip|signal|state)$|(dot|led|mark)$/.test(base)) continue;
      const bg = st.backgroundColor;
      // ZERO ALPHA IS NOT A FILL, IN WHATEVER SPELLING THE BROWSER RETURNS (round 76). This test excluded exactly
      // two strings — "transparent" and "rgba(0, 0, 0, 0)" — which are the two forms the SHEETS write. A COMPUTED
      // style returns a third: "color(srgb 0 0 0 / 0)", and a transparent ring was therefore read as a fill inside
      // its own ring. Six CI findings against the console's device LED, whose off state is a ring and correct.
      // Reading the components instead of matching strings covers all the syntaxes, and it cannot mistake a black
      // CHANNEL for an alpha: three components means opaque, whatever they are.
      const noFill = (c) => {
        if (/^transparent$/i.test(c)) return true;
        const inner = /(([^)]*))/.exec(c);
        if (!inner) return false;
        const parts = inner[1].split(/[s,/]+/).filter(Boolean);
        return parts.length > 3 && Number(parts[3]) === 0;
      };
      const filled = !!bg && !noFill(bg);
      const shadow = st.boxShadow;
      // DEFINED HERE, AND MISSING FOR NINE ROUNDS (round 55). The kind expression below has used 'inset' since
      // round 46 and nothing ever declared it — so this probe threw ReferenceError the moment it ran, and the
      // sweep's marks axis would have died in CI on the next push. It survived because round 46 verified the RULE
      // with a reimplementation on the device instead of running THIS probe, and the judge's self-test feeds the
      // judge a synthetic report rather than the probe's output. A reimplementation is not a test of the original.
      const inset = /inset/.test(shadow);
      // A FILL AND A RING AT ONCE IS ITS OWN KIND (round 46). Until now 'inset' won outright, so a mark that set a
      // background and inherited an inset shadow computed as 'ring' — distinct from a solid, and therefore passing.
      // That is how four broken plugin dots survived every sweep: the panel's own shape check had the same hole
      // (round 45), the console's found it by mutation (round 44), and this probe reported them as clean rings.
      // A BORDER IS A RING, AND THIS COULD NOT SEE ONE (round 88). The kind expression read FILLS and INSET
      // SHADOWS only, so every mark the panel draws with a border computed as 'empty' — including BOTH of its
      // rings: idle is 1.5px solid and off is 1.5px dashed, and the signature below could not tell them apart,
      // nor either of them from a mark that draws nothing at all. The hole was invisible for as long as no
      // surface rendered two border-drawn states side by side; the first surface that closed a session put off
      // beside idle and the collision was immediate.
      //
      // DASHED IS ITS OWN KIND, because that is the whole design decision the 'off' state encodes — a dash and not
      // a fade — and "shape first, colour second" means the signature must carry the dash. (Inside
      // the emitted template.)
      const bw = parseFloat(st.borderTopWidth) || 0;
      const bstyle = bw > 0 ? st.borderTopStyle : 'none';
      // A BORDER THAT PAINTS NOTHING IS NOT A RING (round 88). Width and style are not the whole question: a mark
      // can carry a transparent border for layout and fill itself, and counting that as a ring would report every
      // such mark as a FILL inside a RING. noFill, two lines up, already knows every spelling of "paints nothing".
      const bordered = bstyle !== 'none' && bstyle !== 'hidden' && !noFill(st.borderTopColor);
      const dashed = /dashed|dotted/.test(bstyle);
      const kind = inset && filled ? 'ring+fill'
        : bordered && filled ? 'ring+fill'
        : inset ? 'ring'
        : bordered ? (dashed ? 'dashed-ring' : 'ring')
        : filled && shadow !== 'none' ? 'halo'
        : filled ? 'solid' : 'empty';
      // A CLIPPED SHAPE IS A SHAPE, AND THE SIGNATURE COULD NOT SEE ONE (round 97). The panel's fifth state draws
      // its triangle with clip-path — a fill whose outline is cut — so without this term the failed mark and a
      // plain fill computed the SAME signature, and the collision check would have passed two states that paint
      // differently (or, worse, called a real collision clean). The four shape channels a mark can use are now all
      // in the signature: corner radius, rotation, clip, and the fill/ring/halo/dash KIND. The whole clip string is
      // carried rather than a boolean, because a second clipped shape would otherwise collide with this one.
      const clip = st.clipPath && st.clipPath !== 'none' ? st.clipPath : '-';
      const sig = [st.borderTopLeftRadius, st.transform === 'none' ? 'flat' : 'rotated', clip, kind].join('/');
      const key = base;
      if (!families.has(key)) families.set(key, new Map());
      families.get(key).set(which, sig);
    }
    const collisions = [];
    for (const [fam, states] of families) {
      if (states.size < 2) continue;
      const bySig = new Map();
      for (const [state, sig] of states) {
        if (bySig.has(sig)) collisions.push(fam + ': ' + bySig.get(sig) + ' and ' + state + ' paint identically (' + sig + ')');
        else bySig.set(sig, state);
      }
    }
    const ringFill = [];
    for (const [fam, states] of families) {
      for (const [state, sig] of states) if (sig.indexOf('ring+fill') >= 0) ringFill.push(fam + '[' + state + ']');
    }
    return {
      families: [...families].map(([f, m]) => f + '[' + [...m.keys()].join(',') + ']'),
      collisions: collisions.slice(0, 6),
      ringFill: ringFill.slice(0, 6),
      present: [...present].sort(),
    };
}

/** THE SURFACE PROBE: contrast rows, geometry, headings, landmarks, slivers — and the mark axis, which is why it is
 *  the one probe that also reports `marks`. */
export const surfaceProbe = withHelpers(`const desc = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\\\s+/).slice(0,2).join('.') : '') + (el.id ? '#' + el.id : '');
const heads = [...document.querySelectorAll('h1,h2,h3,h4')];
const lv = heads.map((e) => Number(e.tagName.slice(1)));
let skipped = 0;
for (let i = 1; i < lv.length; i++) if (lv[i] - lv[i - 1] > 1) skipped++;
const over = [], clipped = [], slivers = [];
for (const el of document.querySelectorAll(root + ' *')) {
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden') continue;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) continue;
  const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0);
  const scrolls = st.overflowX === 'auto' || st.overflowX === 'scroll';
  const ellipsises = st.textOverflow === 'ellipsis';
  if (el.scrollWidth > el.clientWidth + 1 && !scrolls && !ellipsises) over.push(desc(el) + ' ' + el.clientWidth + '<' + el.scrollWidth);
  if (own && el.scrollWidth > el.clientWidth + 1 && !ellipsises) clipped.push(desc(el));
  const text = (el.textContent || '').trim();
  if (own && text.length > 24 && r.width < 60) slivers.push(desc(el) + ' w=' + Math.round(r.width));
}
const loudResult = (() => {
  // FOUR SYNTAXES, because the browser does not hand back the one this was written for (round 57). Besides
  // rgb(r, g, b) and rgba(r, g, b, a) it returns rgb(r g b / a) and — for any colour the sheet declares with a
  // modern function — color(srgb 0.09 0.09 0.11 / 0.88), whose components are 0-1 floats. The old parser read those
  // as raw 0-255 numbers, produced garbage, and (before the fail-closed guard above) counted them.
  // (No backticks in this comment: the SURFACE body is carried in a template literal — see withHelpers.)
  const parse = (c) => {
    const m = /(?:rgba?|color)\\(([^)]+)\\)/.exec(c);
    if (!m) return null;
    const parts = m[1].split(/[\\s,/]+/).filter(Boolean);
    // ONLY THE NUMBERS: color(srgb 0.95 0.95 0.96 / 0.88) puts the COLOUR SPACE NAME first, and taking p[0] as r
    // made it NaN — which the fail-closed guard above then counted (six of them, measured round 59, every one of
    // them this one syntax). Filtering to finite numbers reads all four syntaxes with one rule.
    // (No backticks in this comment: the SURFACE body is carried in a template literal — see withHelpers.)
    const p = parts.map(Number).filter(Number.isFinite);
    const srgb = /^color\\(/.test(c);
    const scale = srgb && p.length >= 3 && p[0] <= 1 && p[1] <= 1 && p[2] <= 1 ? 255 : 1;
    return { r: p[0] * scale, g: p[1] * scale, b: p[2] * scale, a: p.length > 3 ? p[3] : 1 };
  };
  const isLoud = __loudnessOf;
  const loud = [];
  let unreadable = 0;
  const unreadableSamples = [];
  for (const el of document.querySelectorAll(root + ' *')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.5) continue;
    const c = parse(st.backgroundColor);
    if (!c || c.a < 0.5) continue;
    const { sat, l, loud: shouts } = isLoud(c);
    if (!Number.isFinite(sat) || !Number.isFinite(l)) { unreadable++; if (unreadableSamples.length < 3) unreadableSamples.push(st.backgroundColor); continue; }
    if (!shouts) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 14 || r.height < 12 || r.width * r.height < 400) continue;
    loud.push(desc(el) + ' ' + Math.round(r.width * r.height) + 'px2 ' + st.backgroundColor.replace(/\\s/g, ''));
  }
  return { list: [...new Set(loud)].slice(0, 6), unreadable, unreadableSamples };
})();
// ── HOW LONG IS A LINE OF PROSE ─────────────────────────────────────────────────────────────────────
// THE MEASURE (round 265). A line is read by its return: past roughly ninety characters the eye loses the
// start of the next one, which is why this sheet caps its ledes at 52ch / 56ch / 66ch / 72ch in five places.
// NOTHING MEASURED THAT. A paragraph could be added with no cap at all and every axis stayed green — which is
// exactly what the live panel showed: twelve single-line paragraphs of 93-206 characters on the Settings page
// at 1440px, in both densities, three blocks away from a History lede that had carried 66ch all along.
// COUNTED HERE, JUDGED BY THE CALLER (opts.proseFloor): the console and the landing carry the same numbers in
// their reports and are not failed by a floor somebody else chose until their own surfaces are measured.
const measureResult = (() => {
  const lineCount = (el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const rects = [...r.getClientRects()].filter((x) => x.width > 4 && x.height > 4);
    return Math.max(1, new Set(rects.map((x) => Math.round(x.top))).size);
  };
  const rows = [];
  let measured = 0;
  for (const el of document.querySelectorAll(root + ' *')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    // OWN text, not a container's: a row is a dozen spans, and its "line" is the row, not a sentence.
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0);
    if (!own) continue;
    // NOT CODE. A log line, a config snippet or a session id is MEANT to be one unbroken run; a rule about
    // where a sentence returns has nothing to say about it. (No backticks in this comment either.)
    if (el.closest('pre, code') || /mono|code/i.test(st.fontFamily)) continue;
    // AND NOT A DELIBERATE ONE-LINER (round 265). An element that ellipsises — nowrap plus text-overflow — is a
    // LABEL, not prose that failed to wrap: the plugin row's description is one, with its full text on a title
    // attribute, and a cap would truncate it SOONER rather than make it readable. The overflow axis already treats
    // this idiom as legitimate (it excludes ellipsised elements from its clipping findings); this axis learned the
    // same from a LIVE measurement — the plugin row's description reported 129 characters per line on the device
    // at 1440px, and the honest reading is that the line was never going to wrap.
    // (NO BACKTICKS ANYWHERE ABOVE: the SURFACE body is carried in a template literal — see withHelpers. The line
  // that used to warn about it was deleted by an edit, which is why the warning is repeated here.)
    if (st.textOverflow === 'ellipsis' || st.whiteSpace === 'nowrap') continue;
    const text = (el.textContent || '').trim();
    if (text.length < 60) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 4) continue;
    measured++;
    const lines = lineCount(el);
    rows.push({ sel: desc(el), cpl: Math.round(text.length / lines), chars: text.length, lines, w: Math.round(r.width), fs: Math.round(parseFloat(st.fontSize)), maxw: st.maxWidth });
  }
  // WORST FIRST, and the WIDTH AND MAX-WIDTH travel with each row: the finding has to say whether the line is
  // long because the surface is wide or because nothing capped it, and those are different repairs.
  rows.sort((a, b) => b.cpl - a.cpl);
  return { measured, worst: rows.slice(0, 5) };
})();
return {
  measure: measureResult,
  loud: loudResult.list,
  loudUnreadable: loudResult.unreadable,
  loudUnreadableSamples: loudResult.unreadableSamples,
  h1Count: heads.filter((e) => e.tagName === 'H1').length,
  firstIsH1: heads.length > 0 && heads[0].tagName === 'H1',
  skipped, mains: document.querySelectorAll('main').length, navs: document.querySelectorAll('nav').length,
  over: [...new Set(over)].slice(0, 8), clipped: [...new Set(clipped)].slice(0, 8), slivers: [...new Set(slivers)].slice(0, 8),
  // ── HOW MANY THINGS ON THIS PAGE ARE SHOUTING ─────────────────────────────────────────────────────────
  // "One focal point per surface" is the last clause of the spine and the only one with no continuous check:
  // it was measured by hand on four surfaces (panel Terminal 1, panel Settings 0, console Overview 0, landing 1
  // — the download CTA) and then not measured again. LOUD is an element whose FILL is genuinely saturated
  // (not white, black or grey) and big enough to be a surface rather than a dot. ONE is a page with something
  // to say; ZERO is a page that is all context, which is right for a form or a dashboard; TWO means nothing on
  // it is the focal point, because two things are asking to be looked at first.
  // ── THE MARK LANGUAGE, AS THE BROWSER ACTUALLY PAINTS IT ────────────────────────────────────────────────
  // The silhouettes are asserted against the SHEET by unit tests, and round 25 showed what that cannot see: a
  // rule later in the cascade overrode '.plug-dot[error]''s diamond and left a stray halo around it. The sheet
  // was right and the page was wrong. This reads the COMPUTED style of every state mark on the page, groups by
  // family, and reports any family whose states share a shape.
  //
  // A FAMILY is a mark's class without its state qualifier ('.cmd-dot[data-state="fail"]' → '.cmd-dot'), and a
  // STATE is whatever the element carries: 'data-state', 'data-live', or the second class. The signature is the
  // geometry that survives colour blindness — radius, rotation, and whether it is a fill, a ring or a haloed
  // fill — because colour is the SECOND channel and this check exists for the user who cannot read it.

  // DOES THIS SURFACE CLAIM A READ FAILED? (round 100) The fixture serves EVERY call on a normal surface, so a
  // page that says "could not be read" or "did not answer, so ..." is making a claim about the device that the
  // fixture contradicts. That is not a cosmetic defect: it is the panel BLAMING THE DEVICE for a question it
  // answered, and it has happened three times (the update card, the monitors in round 100, the restart history
  // in round 99) with every gate green, because a sentence is not a contrast ratio and nothing was reading them.
  // The judge pairs this with report.sse, which says whether the fixture rejected the calls on purpose.
  claims: (function () {
    const out = [];
    for (const el of document.querySelectorAll(root + ' *')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => (n.textContent || '').trim()).join(' ').trim();
      if (own.length < 12) continue;
      // A CLAIM, NOT A MENTION: the panel explains these very distinctions in prose ("a device that has no watch
      // list and a device that did not answer are different"), and an explanation must not be read as the claim.
      // The claim shapes all name what could not be read, which is what these patterns match.
      if (!/could not be read/i.test(own) && !/did not answer, so/i.test(own) && !/unavailable .{0,3} reconnecting/i.test(own)) continue;
      const cls = (el.getAttribute && el.getAttribute('class')) || el.tagName.toLowerCase();
      // THE DISPLAYED TEXT IS THE KEY, not the whole paragraph: the first run reported the same sentence FOUR times
      // per surface, because the card's paragraph is split across sibling nodes that differ past the cut.
      const claim = cls + ': ' + own.replace(/s+/g, ' ').slice(0, 70);
      if (out.indexOf(claim) < 0) out.push(claim);
    }
    return [...new Set(out)].slice(0, 5);
  })(),
};`, { __loudnessOf: loudnessOf });
/** THE ACCESSIBLE-NAME PROBE. */
export function namesProbe(root) {
const SEL = 'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="link"]';
const name = (el) => {
  const by = el.getAttribute('aria-labelledby');
  if (by) { const t = by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ').trim(); if (t) return t; }
  const label = el.getAttribute('aria-label'); if (label && label.trim()) return label.trim();
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && l.textContent.trim()) return l.textContent.trim(); }
    const wrap = el.closest('label'); if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button') && el.value) return el.value;
  }
  const text = (el.textContent || '').trim(); if (text) return text;
  // AN IMAGE WITH ALT TEXT NAMES ITS LINK (measured: the console's rail brand read as "title-only"
  // until this branch existed — a false positive in the detector, not a defect in the page).
  const img = el.querySelector('img[alt]'); if (img && img.alt.trim()) return img.alt.trim();
  const title = el.getAttribute('title'); if (title && title.trim()) return 'title-only: ' + title.trim();
  return '';
};
const unnamed = [], titleOnly = [];
let checked = 0;
for (const el of document.querySelectorAll(SEL)) {
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden') continue;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) continue;
  if (el.getAttribute('aria-hidden') === 'true') continue;
  checked++;
  const n = name(el);
  const d = el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '') + (el.id ? '#' + el.id : '');
  if (!n) unnamed.push(d);
  else if (n.startsWith('title-only:')) titleOnly.push(d + ' -> ' + n.slice(11));
}
return { checked, unnamed: [...new Set(unnamed)], titleOnly: [...new Set(titleOnly)] };
}

/** THE REFLOW PROBE: horizontal scrollers at whatever width the caller has set. */
export function reflowProbe(root) {
return ({
docScrollWidth: document.documentElement.scrollWidth,
viewport: window.innerWidth,
docScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
sideScrollers: [...new Set([...document.querySelectorAll(root + ' *')]
  .filter((el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 20 && el.scrollWidth > el.clientWidth + 2 && (st.overflowX === 'auto' || st.overflowX === 'scroll');
  })
  .map((el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '') + ' ' + el.clientWidth + '<' + el.scrollWidth))].slice(0, 8),
  // WHAT WIDENS THE DOCUMENT, WHEN NOTHING SCROLLS (round 23 of the standing goal). The panel's 320px row reads
  // `SCROLLS` with ZERO named scrollers, and its exemption excuses that by claiming "every offending scroller is a tab
  // child" — a claim an EMPTY list satisfies vacuously. `sideScrollers` cannot see the real cause: it lists only
  // elements that are THEMSELVES scrollers (`overflowX: auto|scroll`), so an element that is merely WIDE is invisible
  // to it, and `#tabs` already carries `overflow-x: auto` — the assumption that the tab strip is the culprit is
  // therefore wrong, and nothing in the report says which element it actually is. This names them: anything whose box
  // leaves the viewport, with the width that did it.
  //
  // **AND THE FIRST VERSION OF THIS LIST WAS WRONG, WHICH THE FIRST RUN SHOWED.** It named `div.tab right=740`,
  // `button.view-switch-btn right=494` and six more — every one of them content SCROLLED OUT of `#tabs`, whose
  // `getBoundingClientRect()` reports its LAYOUT position and not where it is on screen. A rect outside the viewport
  // is therefore two different facts: harmless (an element inside a scroll container, which cannot widen the document
  // because the container clips it) and causal (an element whose ancestors all show their overflow). Only the second
  // widens anything, so an element with a scrolling ancestor is excluded — `overflow-x` of `auto`, `scroll` or
  // `hidden` on any ancestor between it and the root.
  overflowing: [...new Set([...document.querySelectorAll(root + ' *')]
    .filter((el) => {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      if (!(r.width >= 40 && r.height >= 20 && (r.right > window.innerWidth + 1 || r.left < -1))) return false;
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const ps = getComputedStyle(p).overflowX;
        if (ps === 'auto' || ps === 'scroll' || ps === 'hidden') return false;
      }
      return true;
    })
    .map((el) => {
      const r = el.getBoundingClientRect();
      return el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '') + ' right=' + Math.round(r.right) + ' w=' + Math.round(r.width);
    }))].slice(0, 8),
});
}


/** Every class on screen that no parsed rule styles — asked of the BROWSER (CSSOM), not of the
 *  stylesheet read as text.
 *
 *  WHY IT LIVES HERE AND NOT IN AN ADAPTER: round 88 wrote this inline in the console sweep's emitted
 *  template, and on the device the pattern `/\\s+/` arrived as `/s+/` — so class names were split on
 *  the letter "s" and the report listed "btn btn-" and "rail-clu" as unstyled, with 38 classes found
 *  where the browser sees 221. A string that is embedded in another string needs escaping that a
 *  template literal does not give it; `JSON.stringify` does, which is why the contrast probe has been
 *  shipped this way all along.
 *
 *  `styledClasses` is returned BESIDE the list on purpose: a read that found no stylesheets proves
 *  nothing, and a caller must be able to tell that apart from a page with nothing to report. */

export const UNSTYLED_SOURCE = `(() => {
  const styled = new Set();
  const collect = (rules) => {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r.selectorText) {
        const m = r.selectorText.match(/\\.([A-Za-z_][\\w-]*)/g);
        if (m) for (const s of m) styled.add(s.slice(1));
      }
      if (r.cssRules && r.cssRules.length) collect(r.cssRules);
    }
  };
  // AN UNREADABLE SHEET IS NOT AN ABSENT ONE. A sheet the page cannot hand over (cross-origin, or a Rules
  // object the browser refuses) contributes no class names, so every class it styles looks UNSTYLED — a
  // false finding produced by a check that could not read its own basis. Counted and returned instead of
  // swallowed, so the judge can say the basis was incomplete rather than reporting a clean sheet.
  let sheetsUnreadable = 0;
  for (let i = 0; i < document.styleSheets.length; i++) {
    try { collect(document.styleSheets[i].cssRules); } catch (e) { sheetsUnreadable++; }
  }
  const unstyled = new Map();
  for (const el of document.querySelectorAll('#root *')) {
    const cls = typeof el.className === 'string' ? el.className : '';
    for (const c of cls.split(/\\s+/).filter(Boolean)) if (!styled.has(c)) unstyled.set(c, el.tagName.toLowerCase());
  }
  return { styledClasses: styled.size, sheetsUnreadable, classes: [...unstyled.keys()].sort(), tags: Object.fromEntries(unstyled) };
})()`;

/** The judge: one implementation of "is this report a defect", whatever UI produced it.
 *
 *  `opts.ignore` is a list of `{ match: RegExp, reason: string }` for findings this HARNESS cannot
 *  judge — never for findings that are inconvenient. Each suppression is printed with its reason, so
 *  a reader sees what was set aside and why rather than a clean line that hides it.
 */
/** THE FOCUS PROBE, in one place. It was written in the panel adapter, copied into the console's, and
 *  the copy kept the panel's two defects for two rounds after the panel's were fixed (rounds 133-135) —
 *  a strong check whose twin was stale. It is a shared source now, so the next fix lands once. The
 *  caller supplies the presses count and the navigation; this does the loop and the verdict.
 *
 *  Escaping to the body is COUNTED, not passed: a page with nothing focusable would otherwise report a
 *  clean sheet indistinguishable from a page with good rings. `judgeReport` fails a row that landed on
 *  nothing. */


/** THE SWEEP REPORTS ITSELF TO THE AGENT'S DIAGNOSTIC RING (round 196).
 *
 *  `terminal_diag_read` has returned an empty list for every call this session has ever made, and round 182
 *  established why: the ring works, is capped at 200, has roundtrip and multibyte tests — and NOTHING WRITES
 *  TO IT. Its documented design is "POST a diagnostic line from the calling client", so the client is the
 *  writer, and no client ever did.
 *
 *  What that costs was measured in round 181: a sweep call timed out, the report stayed stale for half an
 *  hour, and there was no way to tell a run that was still working from one that had been killed. Two lines —
 *  start and finish — retire that ambiguity, and the ring starts earning the place it already occupies.
 *
 *  Self-contained on purpose: the adapters inline this source into the emitted script, so it may not
 *  reference anything from this module. Failures are swallowed because a sweep must never die of bookkeeping:
 *  a device whose agent is down still needs its design measured. */
export async function diag(line) {
  try {
    // THIS READS THE TOKEN BY LINE PREFIX AND THE PATH WITH FORWARD SLASHES, AND THAT IS HISTORY RATHER THAN A RULE
    // NOW. It was written inside a template literal and emitted as /tokens*:s*.../ — every backslash eaten by one of
    // the three escaping layers — so it never matched and the catch below swallowed the evidence; it took a direct
    // endpoint probe to find. The shape that removed the hazard for good was not counting backslashes correctly: it
    // was moving this function out of the emitted text (round 272), where it is ordinary code and a regex would be
    // just a regex.
    const cfg = require("fs").readFileSync("D:/Summrise/etc/config.yaml", "utf8");
    let token = "";
    for (const l of cfg.split(String.fromCharCode(10))) {
      const t = l.trim();
      if (t.indexOf("device_token") === 0) { token = t.slice(t.indexOf(":") + 1).trim().replace(/["']/g, ""); break; }
    }
    if (!token) return;
    await fetch("http://127.0.0.1:18080/api/tools/terminal_diag_write", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      // FLAT, not wrapped in an arguments object. The agent's dispatch reads required fields at the TOP
      // LEVEL: a wrapped body answers 200 with invalid_params "missing required field: line", which round
      // 196 found by probing the endpoint after this helper's catch had swallowed it twice.
      body: JSON.stringify({ line: "sweep " + line }),
    });
  } catch (e) { /* a sweep must not die of bookkeeping */ }
}


/** WHICH VERDICTS TRUST A COMPUTED VALUE, AND WHY EACH ONE IS STILL HONEST (round 187).
 *
 *  Round 186 found the focus check reporting eighteen missing rings that the browser was painting — a
 *  computed style is not a painted pixel, and the check had been reading one and calling it the other. That
 *  is a CLASS, not an incident, so every other verdict in this library was audited against it:
 *
 *    * TARGET SIZE (2.5.8) is safe BY CONSTRUCTION: getBoundingClientRect returns the POST-transform box, so
 *      a control scaled down to 12px measures 12px. It was already paint-aware and did not need changing.
 *    * TYPE FLOOR could be fooled — getComputedStyle().fontSize is pre-transform, so a scale(0.5) would paint
 *      9px while reporting 18px — and the audit found 3 transformed elements in the panel with ZERO text
 *      leaves among them. No text in any of the three UIs is scaled, so the floor measures what it claims.
 *    * CONTRAST composites the element's own colours and opacity against its detected surface, so an
 *      ANCESTOR's opacity, a mix-blend-mode, a backdrop-filter or a filter would all invalidate the ratio.
 *      The audit found 25 text leaves in the console and not one with any of those in its ancestor chain.
 *    * UNSTYLED compares rendered class names against parsed selectors: no paint involved, nothing to fool.
 *
 *  Re-run the audit rather than believing this note if a UI ever gains a scale, a fade wrapper or a blend:
 *  the method is one page scan that walks every text leaf's ancestor chain and reports the four properties.
 */
/** THE FOCUS PASS, in one place, inlined into every adapter's emitted script by `.toString()` — the same
 *  trick PROBE_SOURCE uses. The loop is the part that drifted when it was copied: the panel's counted
 *  nothing and treated focus escaping to the body as a pass, and the console's copy kept both defects for
 *  two rounds after the panel's were fixed (rounds 133-135). It runs ON THE DEVICE because a Tab press
 *  must be a real one — a synthetic KeyboardEvent does not move focus. */
/**
 * THE PRESS, AS THE BROWSER RENDERS IT — one implementation, shared by every adapter (round 55).
 *
 * WHY IT EXISTS. `feedback-check.mjs` proves an `:active` RULE EXISTS in a sheet; it cannot see whether the press is
 * VISIBLE. Round 51 measured the panel's presses by hand and found the ACTIVE TAB dead — `.tab.active` and
 * `.tab:active` are both (0,2,0) and the state rule came later — and rounds 52-53 turned that class into a
 * sheet-level check. This is the other half: the same measurement, in the sweep, so a press that stops rendering is
 * caught on the page rather than in a stylesheet.
 *
 * WITHOUT CLICKING ANYTHING. `mouse.down()` then a read, then the pointer is MOVED OFF the element before
 * `mouse.up()`: releasing over the same control fires a click, and a pass that presses every button on every page
 * would navigate, close sessions and toggle the theme while measuring. The elements that answer a press are the same
 * ones that act on a click, which is exactly why the release has to happen somewhere else.
 *
 * A TARGET THAT IS NOT ON THE PAGE IS A NOTE, NOT A FINDING — the panel and the desktop render different controls —
 * but the caller records how many were measured, because a press pass that measured nothing is not a clean pass.
 */
/**
 * IDLE REPAINT, MEASURED AS DOM MUTATIONS (round 64).
 *
 * The objective lists idle repaint among the things a claim is verified by, and nothing measured it: `useNow` carries
 * the contract for one clock (round 62), and that is a unit test about one hook, not a measurement of the panel.
 *
 * WHY DOM MUTATIONS ARE THE RIGHT PROXY: React writes to the DOM only when the rendered output DIFFERS. So a panel
 * that re-renders on a timer while nothing has changed produces no mutations, and a panel that writes something is
 * writing something that changed. Under the harness's STATIC fixtures nothing ever changes, which makes the bar exact:
 * an idle panel should mutate NOTHING, and every mutation is either a clock or a re-render that recomputed a value
 * from unchanged inputs.
 *
 * NO REGEXES IN THIS FUNCTION, deliberately: it is inlined into the emitted script through `toString()`, and a single
 * backslash inside that template literal is eaten before the page sees it (rounds 55-58, four times).
 */
export async function idlePass(page, ms = 6000) {
  await page.evaluate(() => {
    const el = document.getElementById("root") || document.body;
    const state = { mutations: 0, byTarget: {}, samples: [] };
    window.__summriseIdle = state;
    // A TEXT NODE HAS NO IDENTITY, SO THE REPORT NAMES ITS PARENT (round 68). The first CI run of this pass reported
    // "6 DOM mutation(s) ... (#text x6)" — one per second, which is a live duration ticking and NOT a repaint, but
    // the report could not say WHICH text, so the finding was undiagnosable by construction. A characterData
    // mutation is about the parent element as far as a reader is concerned.
    const name = (node) => {
      const el = node.nodeType === 3 ? node.parentElement || node : node;
      const tag = el.tagName ? el.tagName.toLowerCase() : "#node";
      const cls = el.className && typeof el.className === "string" ? el.className.trim().split(" ")[0] : "";
      return tag + (el.id ? "#" + el.id : cls ? "." + cls : "");
    };
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        state.mutations++;
        const key = r.attributeName === "data-summrise-idle-probe" ? "__probe" : name(r.target);
        state.byTarget[key] = (state.byTarget[key] || 0) + 1;
        if (state.samples.length < 8) state.samples.push(key + " " + r.type + (r.attributeName ? ":" + r.attributeName : ""));
      }
    });
    observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    // THE INSTRUMENT PROVES IT IS ALIVE, because ZERO IS OTHERWISE UNFALSIFIABLE. An observer attached to the wrong
    // node, or a filter that matches nothing, reports a perfect idle panel forever — and "a scan that read nothing
    // is not a clean scan" is the trap this suite keeps catching. So the window opens with ONE deliberate mutation of
    // the panel's own root; it is counted like any other and subtracted by the judge, and a run that does not see it
    // is reported as a blind instrument rather than as a still panel.
    el.setAttribute("data-summrise-idle-probe", String(Date.now()));
    window.__summriseIdleStop = () => { observer.disconnect(); return { ...state, selfTest: state.byTarget.__probe !== undefined }; };
  });
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__summriseIdleStop());
}

/** WHAT THE PRESS ADDED, measured against the HOVERED state rather than the resting one.
 *
 *  A PRESS IS MEASURED AGAINST WHAT THE POINTER HAS ALREADY DONE (round 95). `pressPass` used to snapshot the
 *  control with the pointer parked away from it, so a sheet that answered `:hover` and had no `:active` rule at all
 *  still produced a difference — the hover did it — and the row read `changed: true`, which the judge reports as a
 *  press that renders. Measured on the device, on the landing's theme toggle, which has a `:hover` rule and NO press
 *  rule: resting -> hovered changes `background` and `color`; hovered -> pressed changes NOTHING. The pass could not
 *  see it, and no other gate could either (the landing's sheet is inline in `index/src/page.js`, which the
 *  sheet-level `feedback-check.mjs` did not read).
 *
 *  A hover ALWAYS co-occurs with a press, so the hover is the baseline the press has to beat: this is the same rule
 *  `feedback-check.mjs` applies to the sheet ("hover implies press"), carried to the pixels.
 *
 *  PURE ON PURPOSE. The DOM loop around it cannot be exercised off a browser, so the part that decides the verdict
 *  is a function with a test — the same reason `svgRootPaints` exists in the contrast probe. */
export function pressDelta(hovered, pressed) {
  const KEYS = ["transform", "opacity", "background", "filter"];
  if (!hovered || !pressed) return [];
  return KEYS.filter((k) => hovered[k] !== pressed[k]);
}

/** EVERY CONTROL ON THE PAGE, deduped by class+size — for the surfaces where no curated list applies.
 *
 *  WHY IT EXISTS (round 15 of the standing goal). The press targets are a CURATED list, which means a control nobody
 *  thought of is never pressed: `.device-logs-toggle` — a button that opens a log file's tail — had `cursor: pointer`
 *  and NO hover and NO press at all, and no gate could see it (`feedback-check` demands a press only where a HOVER
 *  exists, and the rendered pass had never visited that card). This asks the DOM instead of a list: every visible
 *  `button`, link and `[role=button|tab]`, deduped so fifty identical rows cost one press, capped so a busy page
 *  cannot turn a surface into a minute of clicking. The COUNT is returned, because the judge's floor has to know what
 *  the page HAD before it can say a pass proved nothing. */
export async function discoverPressTargets(page, cap, skip) {
  return page.evaluate(
    ({ cap, skip }) => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll(
        'button:not([disabled]), a[href], [role="button"], [role="tab"]',
      )) {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (r.width < 6 || r.height < 6 || st.display === "none" || st.visibility === "hidden") continue;
        // A BOX IS NOT A SURFACE (round 265). A CLOSED `<details>` KEEPS LAYOUT BOXES for its content in Chromium:
        // the Settings page's connect tabs measured 49x24 and were offered as targets while the pointer could not
        // reach them — `elementFromPoint` over them returns the section painted there instead. Twelve CI findings
        // were filed against `.connect-tab.on`, a control that presses correctly, before this was traced.
        // `checkVisibility` is the DOM's OWN answer and it accounts for what a rect cannot: an ancestor's
        // display/visibility, `content-visibility: hidden` (how a closed details hides its content), and
        // `content-visibility: auto` off-screen subtrees. Opacity is deliberately NOT asked about: a control
        // mid-fade is still hit-testable, so its press is still measurable.
        if (typeof el.checkVisibility === "function" &&
            !el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true, visibilityProperty: true })) continue;
        if (st.pointerEvents === "none") continue;
        if (skip.some((s) => el.matches(s))) continue;
        const cls =
          typeof el.className === "string" && el.className.trim()
            ? "." + el.className.trim().split(/\s+/)[0]
            : "";
        const key =
          el.tagName.toLowerCase() + cls + "|" + Math.round(r.width) + "x" + Math.round(r.height);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(el.tagName.toLowerCase() + cls);
      }
      return { found: out.length, targets: out.slice(0, cap) };
    },
    { cap, skip },
  );
}

/**
/** HOW LONG UNTIL THE CONTROL ACKNOWLEDGES THE PRESS — measured, against a stated budget (round 19).
 *
 *  The objective's clause is "immediate feedback on every input (pressed and acknowledged states that fire on the
 *  EVENT, not on the network ... inside a stated budget)". The panel has the mechanism (`useAck`: `setBusyOn(key)`
 *  runs in the same tick as the click) and a unit test that pins its shape — and NOTHING measured the claim as
 *  rendered, which is the only place it can be false: a handler that awaits anything before calling `run` looks
 *  identical in the source and answers a full network round trip late.
 *
 *  So the fixture is made SLOW (`?slowms=N`) and this times the gap between the press and the first visible
 *  acknowledgement on that control — `data-busy`, `aria-busy`, `disabled`, or any change in the painted properties
 *  the press pass already watches. `msToAck` is compared against `budgetMs` by the judge; `msToClear` is reported
 *  too, because that one is the network and the work, and it is NOT the promise being kept.
 */
/** EVERY ACK ROW'S NUMBERS, AS LINES — one definition for both sweeps (round 194).
 *
 *  The panel printed these from its own copy and the console printed NONE, so the console's rows reached `report.ack`, were
 *  judged, and were invisible: a run could show "0 findings" while saying nothing about whether any control answered. This
 *  lived in the panel's sweep, which is the defect this objective removes one layer out — the CONTENT belongs here, and each
 *  sweep still decides where to print it.
 *
 *  Round 26's reason for printing every row stands: the judge reports only failures, and a CI-only failure could not be
 *  compared with a clean device run without re-running both by hand — eight controls "never acknowledged" in CI and answered
 *  in 6-13 ms on the device, same sweep, same fixture. A measurement nobody can read is a measurement nobody can check. */
export function ackNotes(rows, where) {
  const out = [];
  for (const a of rows || []) {
    out.push(
      `note: ack ${where} ${a.sel} — acked=${a.acked} via=${a.via || "none"} ` +
        `ms=${a.msToAck === null || a.msToAck === undefined ? "-" : a.msToAck} budget=${a.budgetMs} ` +
        `presses=${a.presses ?? a.attempts ?? 1}`,
    );
    if (a.acked && (a.attempts || 1) > 1) {
      out.push(
        `note: ${where} ${a.sel} acknowledged only on the SECOND press — the first sample saw nothing, which on a loaded ` +
          `machine is a timing artefact and on a real control is an acknowledgement that depends on state`,
      );
    }
    if (typeof a.msToAck === "number" && typeof a.budgetMs === "number" && a.msToAck > a.budgetMs) {
      out.push(`note: ${where} ${a.sel} took ${a.msToAck}ms against a ${a.budgetMs}ms budget`);
    }
  }
  return out;
}

export async function ackPass(page, targets, budgetMs, label = {}) {
  const rows = [];
  // AND IT ASKS THE DOM TOO (round 20). Round 19 measured a CURATED pair on one page and found two controls with no
  // acknowledgement at all — which raises the obvious question the list cannot answer: how many others are there?
  // A list can only contain what somebody thought of, and the controls that answer nothing are exactly the ones
  // nobody thought about. `discover: N` takes every visible control (chrome skipped, deduped by class+size, capped),
  // so the pass measures what the page HAS.
  if (label.discover) {
    const skip = [...targets.filter((t) => !t.includes(",")), ...(label.skip || [])];
    const d = await discoverPressTargets(page, label.discover, skip);
    targets = [...targets.filter((t) => !t.includes(",")), ...d.targets];
  }
  const read = (sel) => page.evaluate((s) => {
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width < 6 || r.height < 6 || st.display === "none" || st.visibility === "hidden") continue;
      return {
        busy: el.getAttribute("data-busy") === "1" || el.getAttribute("aria-busy") === "true" || el.disabled === true,
        attr: el.getAttribute("data-busy") === "1" ? "data-busy" : el.disabled === true ? "disabled" : el.getAttribute("aria-busy") === "true" ? "aria-busy" : null,
        transform: st.transform, opacity: st.opacity, background: st.backgroundColor,
        where: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : ""),
      };
    }
    return null;
  }, sel);
  for (const sel of targets) {
    // SCROLL IT INTO VIEW FIRST, and clamp to the visible part — the rules the press pass learned the hard way
    // (rounds 15-16). The first run of THIS pass measured `.monitor-btn` and the monitor form's button at
    // y=1200-1430 in an 860px viewport: the clicks landed outside the page, nothing acknowledged, and the pass
    // reported a finding against two controls it had never touched. An instrument may move the page to reach a
    // control; it may not accuse one from a coordinate the control does not occupy.
    const box = await page.evaluate((s) => {
      for (const el of document.querySelectorAll(s)) {
        const before = el.getBoundingClientRect();
        const movedPage = before.top < 0 || before.bottom > innerHeight || before.left < 0 || before.right > innerWidth;
        if (movedPage) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (r.width < 6 || r.height < 6 || st.display === "none" || st.visibility === "hidden") continue;
        // A BOX IS NOT A SURFACE (round 265), in BOTH passes that press at a computed point: a control inside a
        // closed `<details>` keeps a layout box in Chromium while `elementFromPoint` over it returns whatever is
        // painted there, so the press lands on the wrong element and the control is accused of ignoring it. That is
        // how twelve CI findings were filed against `.connect-tab.on`, which presses perfectly. `checkVisibility` is
        // the DOM's own answer — an ancestor's display/visibility, `content-visibility: hidden` (a closed details),
        // and off-screen `content-visibility: auto` subtrees. Opacity is not asked about: a control mid-fade is
        // still hit-testable, so its press is still measurable.
        if (typeof el.checkVisibility === "function" &&
            !el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true, visibilityProperty: true })) continue;
        if (el.disabled === true) continue;
        const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
        const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
        if (right - left < 4 || bottom - top < 4) {
          return { offscreen: true, top: Math.round(r.top), viewport: innerHeight };
        }
        const cx = (left + right) / 2, cy = (top + bottom) / 2;
        const at = document.elementFromPoint(cx, cy);
        const reaches = !!(at && (at === el || el.contains(at) || at.contains(el)));
        return {
          x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), reaches, movedPage,
          covered: reaches ? null : at ? at.tagName.toLowerCase() : "nothing",
        };
      }
      return null;
    }, sel);
    if (!box) { rows.push({ sel, note: "not rendered on this page" }); continue; }
    if (box.offscreen) {
      rows.push({ sel, note: `could not be scrolled into the viewport (top=${box.top} of ${box.viewport}) — NOT pressed, and that is not evidence about its acknowledgement` });
      continue;
    }
    if (box.reaches === false) {
      rows.push({ sel, note: `${box.covered} is drawn over the point that would be pressed — NOT pressed, and that is not evidence about its acknowledgement` });
      continue;
    }
    // THE BASELINE IS THE HOVER, NOT REST (the rule the press pass learned in round 95, applied here). Reading the
    // control with the pointer parked away made its HOVER style look like an acknowledgement: `.monitor-btn` has a
    // hover rule like every other control, so the first run of this pass reported "acked via=paint, 6ms" for a
    // button whose only visible response was the pointer being over it. The pointer goes on FIRST, settles, and
    // THEN the baseline is taken — so a painted change has to be something the press caused.
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(260);
    // LET, NOT CONST: the retry below re-reads the baseline it compares against, and the emitted pass died in CI
    // with "Assignment to constant variable" — a RUNTIME error that --emit's syntax check cannot see, on a pass
    // whose every local gate passed. The device run that would have caught it was skipped because the change
    // looked like a judge-side one.
    let before = await read(sel);
    // DID THIS CONTROL ASK THE DEVICE ANYTHING? A discovery pass measures every visible control, and most of them
    // do not talk to the device at all — a tab that switches which snippet is shown, a disclosure, a focus target.
    // "No acknowledgement" is the right verdict only where there was something to wait for; elsewhere it is a NOTE.
    // The fixture counts every /api/ request (`window.__calls`), which is what makes the difference measurable
    // rather than guessed. (Round 20: the first survey called the connect form's already-active tab a control that
    // ignores a press, when clicking it had nothing to do.)
    const callsBefore = await page.evaluate(() => (window.__calls || []).length);
    // IS THE COUNTER THERE AT ALL? `(window.__calls || []).length` answers 0 for a page that has no counter, which is
    // indistinguishable from a page whose counter saw nothing — and that is exactly what happened on the console
    // (round 11 of the standing goal): only the PANEL's fixture installs `window.__calls`, so every console row got the
    // note "no request left this page" and was excused, and A CONSOLE CONTROL THAT NEVER ACKNOWLEDGED A PRESS COULD
    // NEVER FAIL THE RUN. The console installs a counter now; this flag is what keeps the two cases apart if another
    // sweep ever runs `ackPass` without one, because "unmeasured" must not read as "measured zero" — the failure this
    // whole suite is built to refuse.
    const hasCounter = await page.evaluate(() => Array.isArray(window.__calls));
    const t0 = Date.now();
    await page.mouse.down();
    await page.mouse.up();
    // THE PAGE'S OWN CLOCK, READ ONCE, RIGHT AFTER THE PRESS (round 26). Comparing the driver's clock with the
    // page's would be a bug waiting for a timezone; asking the page how many requests arrived in a window AROUND
    // that instant needs one clock and only one.
    const t0page = await page.evaluate(() => Date.now());
    let acked = null;
    let msToAck = null;
    let attempts = 1;
    let msFirstPress = null;
    for (let i = 0; i < 60; i++) {
      const now = await read(sel);
      // ACKNOWLEDGED means: the control says so (an attribute) OR it paints differently than it did at rest.
      const painted = now && before && (now.transform !== before.transform || now.opacity !== before.opacity || now.background !== before.background);
      if (now && (now.busy || painted)) { acked = now; msToAck = Date.now() - t0; break; }
      await page.waitForTimeout(16);
    }
    // AND NEVER ACCUSE ON ONE SAMPLE (round 26). A control is judged "never acknowledged" from a single press, and a
    // loaded CI runner produced eight of those for controls that answer in 6-13ms on the device — same sweep, same
    // fixture, different machine. One retry, after a settle, is the difference between a measurement and a coin
    // flip: the row records how many presses it took, so a control that needs two is not silently reported as fine.
    if (acked === null) {
      attempts = 2;
      await page.mouse.move(2, 2);
      await page.waitForTimeout(300);
      await page.mouse.move(box.x, box.y);
      await page.waitForTimeout(120);
      const again = await read(sel);
      if (again) before = again;
      // THE SECOND PRESS IS THE ONE THAT COUNTS, AND IT IS TIMED FROM ITSELF. CI reported every row as
      // "acknowledged the press after 1513ms — the budget is 100ms" because the metric ran from the FIRST press,
      // which on that runner never registered at all (the control answered in ~5ms to the second one). Timing from a
      // press the page never received measures the harness, not the control; `attempts` is what records that the
      // first one was lost, and the judge reports it as its own note.
      const t1 = Date.now();
      await page.mouse.down();
      await page.mouse.up();
      for (let i = 0; i < 60; i++) {
        const now = await read(sel);
        const painted = now && before && (now.transform !== before.transform || now.opacity !== before.opacity || now.background !== before.background);
        if (now && (now.busy || painted)) { acked = now; msToAck = Date.now() - t1; msFirstPress = t1 - t0; break; }
        await page.waitForTimeout(16);
      }
    }
    // AND BACK: the acknowledgement must CLEAR, or a control that spins forever is indistinguishable from one that
    // is still working. This is the network plus the work, so it is reported and not judged.
    let msToClear = null;
    for (let i = 0; i < 200; i++) {
      const now = await read(sel);
      if (now && !now.busy) { msToClear = Date.now() - t0; break; }
      await page.waitForTimeout(25);
    }
    // ATTRIBUTED TO THE PRESS, NOT TO THE PAGE'S OWN POLLING. The first version counted a request counter across
    // the whole window (`callsAfter > callsBefore`), and on a page that polls that is not evidence about the control
    // you pressed: CI reported the Memory surface's Cancel button — which only closes a popover — as a control that
    // never acknowledges, because a background request landed while it was being measured. This asks the page for
    // requests issued in the 250ms AFTER the press (60ms of slack before it), which a poll can only rarely imitate.
    const callsInPress = await page.evaluate(
      (t) => (window.__callTimes || []).filter((x) => x >= t - 60 && x <= t + 250).length,
      t0page,
    );
    const callsAfter = await page.evaluate(() => (window.__calls || []).length);
    const asked = callsInPress > 0;
    rows.push({
      sel, size: box.w + "x" + box.h, where: acked ? acked.where : (before ? before.where : sel),
      acked: acked !== null, via: acked ? acked.attr || "paint" : null, msToAck, msToClear, budgetMs, attempts, msFirstPress,
      asked, calls: callsInPress, callsInWindow: callsAfter - callsBefore, hasCounter,
      ...(acked || asked
        ? {}
        : { note: hasCounter
            ? "no request left this page in the 250ms after the press (0 of " + (callsAfter - callsBefore) + " in the whole window) — there is nothing this control was waiting for, so the row is not evidence about feedback"
            : "this page has NO request counter, so whether the control asked the device anything is UNMEASURED — the row is not evidence about feedback either way" }),
      ...label,
    });
    // AND PUT THE PAGE BACK: the next control is measured from rest, not from whatever this click did.
    await page.mouse.move(2, 2);
  }
  return rows;
}

/** MEASURE THE TARGETS A ROW REVEALS, ON PURPOSE (round 16 of the standing goal).
 *
 *  The target-size criterion is about what an operator can hit, and some of those targets exist only while their
 *  row is hovered: `.side-actions` is `display: none` until `.side-row:hover`, so the target probe — which reads
 *  what is on screen — has always read 0x0 and skipped them. The first time one was ever measured it was an
 *  ACCIDENT: the press pass parked the pointer over a row, the next navigation re-applied the hover, and the probe
 *  found a real 2.5.8 failure (two 22x22 buttons whose centres were 22px apart).
 *
 *  An instrument may not depend on where the last pass left the mouse, and it may not skip a state an operator
 *  sees. This asks for the revealed state explicitly and puts the page back afterwards, so the residue that
 *  produced the accidental finding cannot exist either. Returns null where the row is not rendered.
 */
export async function revealPass(page, rowSel, targetsSource, label = {}) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, rowSel);
  if (!box) return null;
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(320);
  const measured = await page.evaluate(targetsSource);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(80);
  return { revealed: rowSel, ...label, ...measured };
}

/**
 * A CONTROL THE PASS NEVER TOUCHED IS NOT A CONTROL THAT FAILED TO ANSWER.
 *
 * The pass takes the element's rect AS IT FINDS IT. For `.device-logs-toggle` that rect was y=1582 in an 860px
 * viewport, so the mouse moved to a coordinate outside the page, nothing was hovered, nothing was pressed, and the
 * first measurement read "press adds nothing" — a finding against a button that answers perfectly. Two corrections,
 * both about what an instrument is allowed to do:
 *
 *   * SCROLL ONLY IF THE ELEMENT IS NOT ALREADY FULLY VISIBLE, and then by the MINIMUM amount. An instrument may
 *     move the page to REACH a control; it may not rearrange the page it is measuring (centring every element
 *     unconditionally scrolled a panel out from under its own rail buttons).
 *   * PRESS THE VISIBLE PART, and say whether the pointer ARRIVED. The rect is clamped to the viewport, the point is
 *     hit-tested with `document.elementFromPoint`, and the row carries `reached`. The pass still PRESSES — a row is
 *     never dropped, because a pass that presses nothing proves nothing — and the JUDGE is where `reached: false`
 *     changes a verdict.
 */
export async function pressPass(page, targets, label = {}) {
  const rows = [];
  // THE DISCOVERED SET IS OPT-IN: a page of fifty archive rows must not cost fifty presses. The curated list stays
  // for the surfaces it was written for, and `discover` adds what the DOM knows that the list does not.
  let found = null;
  if (label.discover) {
    // THE CHROME IS ALREADY MEASURED, AND THE CAP IS SMALL. The rail walk presses the CONTENT controls of a page —
    // the mode passes already own the rail buttons, the session tabs and the side rows — so those are skipped here.
    // Without the skip the cap is spent on the rail itself: the Settings page renders seventeen distinct controls
    // and the first five were all rail buttons, which is how `.device-logs-toggle` stayed unpressed even after the
    // discovery existed. The skip list is the caller's (`label.skip`), because only the caller knows which controls
    // another pass already reaches.
    const skip = [...targets.filter((t) => !t.includes(",")), ...(label.skip || [])];
    const d = await discoverPressTargets(page, label.discover, skip);
    found = d.found;
    targets = [...targets.filter((t) => !t.includes(",")), ...d.targets];
    // A PAGE WITH NO CONTENT CONTROLS IS A FACT, NOT AN EMPTY SET. Without a row to carry it, `found` never reaches
    // the report, the judge falls back to its curated floor of two, and the harness's Browser page — an explanation
    // with nothing but the rail — is reported as a vacuous pass. It says what it is instead.
    if (targets.length === 0) {
      rows.push({
        sel: "(none)",
        note: "this page renders no controls outside the chrome another pass already presses",
        found,
      });
    }
  }
  const styleOf = (sel) => page.evaluate((s) => {
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width < 6 || r.height < 6 || st.display === "none" || st.visibility === "hidden") continue;
      const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "";
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        where: el.tagName.toLowerCase() + cls + (el.id ? "#" + el.id : ""),
        transform: st.transform, opacity: st.opacity, background: st.backgroundColor, filter: st.filter,
        hit: !!(top && (top === el || el.contains(top) || top.contains(el))),
      };
    }
    return null;
  }, sel);
  for (const sel of targets) {
    const box = await page.evaluate((s) => {
      for (const el of document.querySelectorAll(s)) {
        const before = el.getBoundingClientRect();
        const movedPage =
          before.top < 0 || before.bottom > innerHeight || before.left < 0 || before.right > innerWidth;
        if (movedPage) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (r.width < 6 || r.height < 6 || st.display === "none" || st.visibility === "hidden") continue;
        // A BOX IS NOT A SURFACE (round 265), in BOTH passes that press at a computed point: a control inside a
        // closed `<details>` keeps a layout box in Chromium while `elementFromPoint` over it returns whatever is
        // painted there, so the press lands on the wrong element and the control is accused of ignoring it. That is
        // how twelve CI findings were filed against `.connect-tab.on`, which presses perfectly. `checkVisibility` is
        // the DOM's own answer — an ancestor's display/visibility, `content-visibility: hidden` (a closed details),
        // and off-screen `content-visibility: auto` subtrees. Opacity is not asked about: a control mid-fade is
        // still hit-testable, so its press is still measurable.
        if (typeof el.checkVisibility === "function" &&
            !el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true, visibilityProperty: true })) continue;
        const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
        const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
        if (right - left < 4 || bottom - top < 4) {
          return { offscreen: true, top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: innerHeight, w: Math.round(r.width), h: Math.round(r.height) };
        }
        const cx = (left + right) / 2, cy = (top + bottom) / 2;
        const at = document.elementFromPoint(cx, cy);
        const reaches = !!(at && (at === el || el.contains(at) || at.contains(el)));
        return {
          x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), movedPage, reaches,
          covered: reaches ? null : at ? at.tagName.toLowerCase() + (typeof at.className === "string" && at.className ? "." + at.className.trim().split(/\s+/)[0] : "") : "nothing",
        };
      }
      return null;
    }, sel);
    if (!box) { rows.push({ sel, note: "not rendered on this page" }); continue; }
    if (box.offscreen) {
      rows.push({ sel, note: "could not be scrolled into the viewport (top=" + box.top + ", bottom=" + box.bottom + " of " + box.viewport + ") — NOT pressed, and that is not evidence about its press" });
      continue;
    }
    // HOVER FIRST, THEN READ, THEN PRESS. The order is the measurement: the hover must have SETTLED before the
    // baseline is taken, or a mid-transition value would be compared against a settled one and a control that only
    // answers a hover would read as answering a press again. These sheets transition in 120-200ms, so 260ms is the
    // settle; the old pass waited 80ms and read `before` before the move, which is why the anchor was the defect
    // rather than the wait.
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(260);
    const hovered = await styleOf(sel);
    await page.mouse.down();
    await page.waitForTimeout(140);
    const pressed = await styleOf(sel);
    // OFF THE ELEMENT FIRST — see the note above: releasing here would click it.
    await page.mouse.move(box.x, Math.max(0, box.y - 80));
    await page.mouse.up();
    await page.waitForTimeout(60);
    const props = pressDelta(hovered, pressed);
    // A PRESS NOTHING RECEIVED IS NOT A PRESS NOTHING ANSWERED — but the row IS still a measurement, and the JUDGE
    // is where `reached` changes the verdict. The pass presses what it was asked to press.
    //
    // AND "RECEIVED" IS DECIDED AT THE POINT ACTUALLY PRESSED (round 265). This read
    // `!(box.movedPage && hovered && hovered.hit === false)`: the hit test only counted when the element had to be
    // SCROLLED first, so a control that was already "in the viewport" by its rect but covered — the connect tabs
    // inside a closed `<details>`, where the section behind them takes the hit — was reported as a control that
    // ignores a press. `box.reaches` is `elementFromPoint` at the clamped centre, which IS the coordinate the press
    // uses; when it is false the pointer never arrived, and the row says so instead of accusing the control.
    const reached = box.reaches !== false;
    rows.push({
      sel, where: pressed ? pressed.where : hovered.where, size: box.w + "x" + box.h,
      // WHAT THE PAGE HAD, on every row of a discovered pass: the harness's Browser page renders an EXPLANATION with
      // exactly one control in a plain browser (round 45), and "measured 1" there is a COMPLETE pass, not a vacuous
      // one. The judge sizes its floor to this instead of to a constant.
      found,
      changed: props.length > 0, props, hovered, pressed, reached,
      ...(reached ? {} : { note: "the pointer never reached this control — " + box.covered + " is drawn over the point that was pressed — so this row is NOT evidence that it ignores a press" }),
      ...label,
    });
  }
  // AND THE POINTER GOES HOME (round 16). Leaving it where the last press ended meant the NEXT surface's probes ran
  // with whatever sat under that position still hovered: a session row kept its actions revealed, the target probe
  // measured a state nobody had asked for, and the finding it produced — a real 2.5.8 failure, as it happens — was
  // an accident. A pass that moves the pointer owns putting it back.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(60);
  return rows;
}

export async function focusPass(page, presses, label = {}) {
  await page.evaluate(() => document.body.focus());
  let landed = 0;
  let escaped = 0;
  let missing = 0;
  // HOW MANY THE PIXELS RESCUED FROM A WRONG VERDICT. Reported rather than hidden: a number that keeps
  // climbing means the computed-style check is drifting further from what the browser paints.
  let paintConfirmed = 0;
  // HOW OFTEN THE CHECK COULD NOT LOOK. Separate from missing on purpose: see the catch below.
  let unconfirmed = 0;
  const unconfirmedOn = [];
  // AND WHICH ONES. A count alone leaves the next reader to re-derive the finding — round 136 got
  // "missing: 11" from the extension and could not tell a real defect from a broken probe. The offenders
  // name themselves instead, in the same tag.class form the rest of the suite uses.
  const missingOn = [];
  // THE FIRST OFFENDER'S COMPUTED STYLES, so a surprising count explains itself. Round 136 got
  // "missing: 11" from the extension and could not tell a real defect from a misreading; the extension's
  // sheet DOES carry a :focus-visible ring and an input:focus box-shadow, so the next reader needs the
  // numbers, not another guess.
  let evidence = null;
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Tab");
    const verdict = await page.evaluate(() => {
      const el = document.activeElement;
      const name = (e) => {
        const cls = typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).join(".") : "";
        return e.tagName.toLowerCase() + cls + (e.id ? "#" + e.id : "");
      };
      if (!el || el === document.body) return { verdict: "escaped", where: "body" };
      const st = getComputedStyle(el);
      const visible =
        (parseFloat(st.outlineWidth) > 0 && st.outlineStyle !== "none") ||
        (st.boxShadow && st.boxShadow !== "none");
      return {
        verdict: visible ? "ok" : "no-ring",
        where: name(el),
        outline: st.outlineStyle + " " + st.outlineWidth + " " + st.outlineColor,
        boxShadow: String(st.boxShadow).slice(0, 60),
        focusVisible: el.matches(":focus-visible"),
        ringToken: getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim() || "(undefined)",
      };
    });
    if (verdict.verdict === "ok") landed++;
    else if (verdict.verdict === "escaped") escaped++;
    else {
      // A COMPUTED STYLE IS NOT A PAINTED RING, AND THIS IS WHERE THAT WAS PROVEN. Six rounds chased a
      // cascade that did not exist: a keyboard-focused console button reports "solid 0px" and boxShadow
      // "none" while the browser draws a 2px accent ring around it — confirmed by screenshot in round 186,
      // after a stale bundle, a cached sheet, a pointer leak, a missing !important and a layered-!important
      // hypothesis had each been tested and killed. getComputedStyle does not report what the UA paints for
      // :focus-visible on every control.
      //
      // SO THE STYLE CHECK IS A CANDIDATE, NOT A VERDICT, and the pixels are the authority. Capture the
      // element's neighbourhood while it is keyboard-focused, then blur and re-focus it programmatically —
      // which drops :focus-visible and therefore the ring — and compare. Different bytes mean something IS
      // painted and this was a false positive; identical bytes mean the control really has no focus
      // indication, which is the WCAG 2.4.7 failure this check exists to find. Only candidates pay for the
      // two screenshots, so a clean page costs nothing.
      let painted = false;
      let paintFailed = null;
      try {
        const box = await page.evaluate(() => {
          const e = document.activeElement;
          if (!e) return null;
          const r = e.getBoundingClientRect();
          return { x: Math.max(0, Math.floor(r.x - 6)), y: Math.max(0, Math.floor(r.y - 6)), width: Math.ceil(r.width + 12), height: Math.ceil(r.height + 12) };
        });
        if (box && box.width > 0 && box.height > 0) {
          const withRing = await page.screenshot({ clip: box });
          await page.evaluate(() => { const e = document.activeElement; if (e && e.blur) { e.blur(); e.focus(); } });
          const withoutRing = await page.screenshot({ clip: box });
          painted = !withRing.equals(withoutRing);
        }
        paintFailed = null;
      } catch (e) {
        // A CHECK THAT COULD NOT LOOK MUST NOT REPORT A FINDING, and must not report a pass either. The
        // first version set painted = false here, which turned a failed screenshot into "this control has no
        // focus indication" — the same false-finding shape that cost six rounds before round 186. Null means
        // UNCONFIRMED: counted separately, and treated by the judge as a failure of the CHECK, because a
        // measurement that did not happen is not evidence of anything (rounds 133-134's rule).
        paintFailed = String(e && e.message ? e.message : e).slice(0, 80);
      }
      if (painted === true) {
        landed++;
        paintConfirmed++;
      } else if (painted === null) {
        unconfirmed++;
        if (unconfirmedOn.length < 5) unconfirmedOn.push(verdict.where);
      } else {
        missing++;
        if (missingOn.length < 8) missingOn.push(verdict.where);
        if (!evidence) evidence = verdict;
      }
    }
  }
  return {
    ...label,
    pressed: presses,
    landed,
    escaped,
    missing,
    ...(paintConfirmed ? { paintConfirmed } : {}),
    ...(unconfirmed ? { unconfirmed, unconfirmedOn, ...(paintFailed ? { paintFailed } : {}) } : {}),
    ...(missingOn.length ? { missingOn } : {}),
    ...(evidence ? { why: { where: evidence.where, outline: evidence.outline, boxShadow: evidence.boxShadow, focusVisible: evidence.focusVisible, ringToken: evidence.ringToken } } : {}),
  };
}

/** THE MOTION MEASUREMENT, both states in order. A single reduced-motion number is vacuous — it looks
 *  the same whether the page honours the preference or has no motion at all (round 134). `render`
 *  re-renders the page and is supplied by the adapter. */
export async function motionPass(page, render, label = {}) {
  const count = async () => {
    const list = await page.evaluate(() => {
      const animating = [];
      for (const el of document.querySelectorAll("*")) {
        const st = getComputedStyle(el);
        const dur = parseFloat(st.transitionDuration) > 0 ? st.transitionDuration : null;
        const anim =
          st.animationName && st.animationName !== "none"
            ? st.animationName + " x" + st.animationIterationCount
            : null;
        if (!dur && !anim) continue;
        const key =
          typeof el.className === "string" && el.className
            ? "." + el.className.trim().split(/\s+/).join(".")
            : el.tagName.toLowerCase();
        animating.push(key + (dur ? " trans=" + dur : "") + (anim ? " anim=" + anim : ""));
      }
      return [...new Set(animating)];
    });
    return list;
  };
  await page.emulateMedia({ reducedMotion: null });
  await render();
  const normal = await count();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await render();
  const reduced = await count();
  await page.emulateMedia({ reducedMotion: null });
  return { ...label, normal: normal.length, reduced: reduced.length, stillAnimating: reduced.slice(0, 6) };
}

/** WCAG 2.5.8 TARGET SIZE (MINIMUM), the FULL criterion — which is not "24x24 or fail".
 *
 *  The rule is: a target must be at least 24x24 CSS px, OR have enough SPACING that a 24px circle centred on
 *  it does not overlap another target's circle. Most compact UIs satisfy it through the second clause, and a
 *  check that ignored that would report a dozen false findings and be turned off within a week. So this
 *  measures the distance to the nearest other target and applies the criterion as written.
 *
 *  Nothing measured this before round 162. The sweep's own probe uses 24px for a different question (whether
 *  a non-text element is a MARK rather than a block), which is how the number was already in the codebase
 *  without the criterion being checked. */
/** WHAT THE PAGE ACTUALLY RENDERED, as opposed to what the navigation asked for.
 *
 *  Round 175 shipped a two-theme fixture whose REPORT said `theme: light` for every render, because the three
 *  blocks recorded a hardcoded field while only the URLs had been changed — so `Terminal-fail-dark` reported
 *  light, and two same-named surfaces looked like one. The renders were right and the report lied about them,
 *  which is worse than not measuring: a dark regression would have been filed under light and compared
 *  against the wrong numbers.
 *
 *  This reads the theme off the PAGE — the stored preference the app itself uses, plus the body background,
 *  which is what the eye sees. The adapters record what this returns and FAIL when it disagrees with what
 *  they navigated to, so the family of bug that cost round 175 cannot come back quietly.
 *
 *  Two signals rather than one deliberately: a stubbed localStorage could agree while the painted background
 *  does not, and `bodyBackground` is the half that a reader would actually notice. */
/** IS A SURFACE LOUD — a saturated fill that competes for the page's focus?
 *
 *  ONE RULE, TWO AXES (round 78). This computation lived only inside the emitted probe, so nothing could ask the
 *  same question of a TOKEN. The rendered axis found the dark info chip (`#1a3a5c`, saturation 0.559) on the one page
 *  that renders that badge while the light one is a pale tint the rule skips by design (lightness above 0.9) — and a
 *  sheet-level check can find the same thing everywhere, on both UIs, without a browser.
 *
 *  THE BANDS ARE MEASURED, NOT CHOSEN: saturation 0.35 with a lightness between 0.2 and 0.9 is what an operator reads
 *  as "something shouting". HSL saturation is d / (1 - |2l - 1|), which is the form the probe has always used — and
 *  the one the probe's own gate checks. */
export function loudnessOf(colour) {
  const [R, G, B] = [colour.r / 255, colour.g / 255, colour.b / 255];
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const l = (mx + mn) / 2, d = mx - mn;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { sat, l, loud: Number.isFinite(sat) && Number.isFinite(l) && sat >= 0.35 && l >= 0.2 && l <= 0.9 };
}

export const THEME_SOURCE = `(() => {
  const body = getComputedStyle(document.body).backgroundColor;
  let stored = '';
  try { stored = localStorage.getItem('summrise-theme') || ''; } catch (e) { stored = '(unavailable)'; }
  // THE APP WRITES data-theme ON BODY, AND THIS READ html UNTIL ROUND 74. So the attr field came back "(none)" on every
  // surface this sweep has ever measured: the theme-lie axis had nothing to compare an intention against, and the
  // rail walk's new labels fell back to the loop's own value — which is how six contrast findings were filed against
  // the light theme while the pages were rendered dark. Body first, then the document element as a fallback for
  // surfaces that put it elsewhere. (No backticks: this source is embedded in an emitted template literal.)
  const attr = document.body.getAttribute('data-theme') || document.documentElement.getAttribute('data-theme') || '';
  return { stored, attr, bodyBackground: body };
})()`;

export const TARGETS_SOURCE = `(() => {
  const SEL = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"]';
  const els = [...document.querySelectorAll(SEL)].filter((el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && !el.disabled;
  });
  const name = (el) => {
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + cls;
  };
  const box = (el) => el.getBoundingClientRect();
  const centre = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const small = [];
  // ── THE SPACING EXCEPTION HAS TWO HALVES AND ONLY ONE WAS IMPLEMENTED (round 16 of the standing goal) ────────────
  // WCAG 2.5.8's exception reads: "if a 24 CSS pixel diameter circle is centered on the bounding box of each, the
  // circles do not intersect ANOTHER TARGET or the circle for another undersized target". That is two tests, and this
  // probe ran one of them: "nearest" is CENTRE-to-CENTRE, which is the circle-vs-circle half — correct against another
  // undersized target, and wrong against a LARGE one, where the circle has to clear the other target's BOX.
  //
  // It is wrong in the direction that hides defects. A 20x20 icon sitting 5px from the edge of a 200px-wide button has
  // its circle intersecting that button — the criterion fails — while the button's CENTRE is a hundred pixels away, so
  // the centre test excused it. Twenty-seven undersized targets pass on spacing today (10 on the panel's overview, 9
  // on rest, 8 on desktop, 2 on the console), and nothing said whether any of them is actually cramped.
  //
  // SO IT IS MEASURED BEFORE IT IS ENFORCED. "gapToBox" is the distance from this target's centre to the nearest other
  // target's BOX, and nearW/nearH name that neighbour, so the judge can count the rows that pass today and would fail
  // the full rule — a NOTE this round, a finding only once the number is known. Enforcing a criterion without knowing
  // what it will say is how a check becomes a surprise.
  // (NO BACKTICKS: this source is embedded in an emitted template literal, and the first version of this comment had
  // them around three identifiers — which ended the literal and made the whole module stop parsing. The gate caught it
  // at --emit, which is what that gate is for.)
  const boxGap = (c, r) => {
    const dx = Math.max(r.left - c.x, 0, c.x - r.right);
    const dy = Math.max(r.top - c.y, 0, c.y - r.bottom);
    return Math.hypot(dx, dy);
  };
  for (const el of els) {
    const r = box(el);
    if (r.width >= 24 && r.height >= 24) continue;
    const c = centre(r);
    let nearest = Infinity;
    let gapToBox = Infinity;
    let nearW = 0;
    let nearH = 0;
    let nearSel = null;
    // CONTAINMENT IS NOT CROWDING, AND THE CRITERION'S OTHER HALF CANNOT TELL THEM APART (round 17 of the standing
    // goal). A small control nested inside a larger TARGET — .side-action (22x22) lives inside .side-row, which is
    // role="button" with its own onClick — has its circle inside that row by construction, so a literal reading of
    // "the circles do not intersect another target" fails EVERY nested control in the product. That reading is not
    // this repository's: .side-actions carries a comment from 2026-09-21 that gives the two 22x22 buttons a 4px gap
    // precisely so their centres are 26px apart, calling centre distance "the criterion's own spacing clause, which is
    // the half a compact UI usually satisfies".
    //
    // SO THE TWO CASES ARE SEPARATED RATHER THAN LUMPED. A neighbour that CONTAINS this target (or that this target
    // contains) is not a crowding neighbour: a near-miss there lands on an ancestor, which is a different question —
    // nested interactive content — and it is reported as its own fact instead of being enforced as a size failure.
    // What IS enforced is the half that was never implemented: a small target whose circle reaches a neighbour BESIDE
    // it. insideSel names the container when there is one.
    // (NO BACKTICKS — and this is the SECOND round running that this comment had to be rewritten because of them. The
    // emitter's parse guard refuses it at --emit, which is the mechanism working; the cost is a wasted edit.)
    let insideSel = null;
    let insideW = 0;
    let insideH = 0;
    for (const other of els) {
      if (other === el) continue;
      const or_ = box(other);
      const d = dist(c, centre(or_));
      if (d < nearest) nearest = d;
      const contains = other.contains(el) || el.contains(other);
      if (contains) {
        if (!insideSel) { insideSel = name(other); insideW = Math.round(or_.width); insideH = Math.round(or_.height); }
        continue;
      }
      const g = boxGap(c, or_);
      if (g < gapToBox) { gapToBox = g; nearW = Math.round(or_.width); nearH = Math.round(or_.height); nearSel = name(other); }
    }
    small.push({
      sel: name(el),
      text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
      w: Math.round(r.width),
      h: Math.round(r.height),
      nearest: Number.isFinite(nearest) ? Math.round(nearest * 10) / 10 : null,
      // 24px circles overlap when their centres are closer than 24px.
      passesBySpacing: nearest >= 24,
      // THE OTHER HALF: the circle's radius is 12, so the criterion wants the centre at least 12px clear of every
      // target's box — every target that is not an ancestor or a descendant of this one.
      gapToBox: Number.isFinite(gapToBox) ? Math.round(gapToBox * 10) / 10 : null,
      nearSel, nearW, nearH,
      insideSel, insideW, insideH,
      passesByFullRule: nearest >= 24 && gapToBox >= 12,
    });
  }
  const bySel = new Map();
  for (const o of small) {
    const prev = bySel.get(o.sel);
    if (!prev || o.w * o.h < prev.w * prev.h) bySel.set(o.sel, o);
  }
  return { checked: els.length, undersized: small.length, distinct: [...bySel.values()] };
})()`;

export function judgeReport(report, opts = {}) {
  const findings = [];
  const notes = report.notes || (report.notes = []);
  const suppressed = [];
  for (const s of report.surfaces) {
    const where = s.width ? `${s.page}@${s.width}px` : s.page;
    if (s.h1Count !== 1 || !s.firstIsH1) findings.push(`${where}: h1 count ${s.h1Count}, first-is-h1 ${s.firstIsH1}`);
    if (s.skipped) findings.push(`${where}: ${s.skipped} skipped heading level(s)`);
    if (s.mains !== 1) findings.push(`${where}: ${s.mains} main landmark(s), expected exactly 1`);
    if (s.navs > 1) findings.push(`${where}: ${s.navs} nav landmarks — a page has one navigation`);
    // PREFIX, NOT EXACT. `navless: ["login"]` was an exact match on a page name, so when the console's login
    // page gained a dark render (`login-dark`, round 229) the page that has no navigation BY DESIGN was
    // reported as missing one. A navless entry names a FAMILY of renders — the same page in another theme, at
    // another width — and matching the name alone is the one-of-N shape this session keeps finding.
    else if (s.navs !== 1 && !(opts.navless || []).some((n) => String(s.page).startsWith(n))) {
      findings.push(`${where}: ${s.navs} nav landmark(s), expected exactly 1`);
    }
    for (const [kind, list] of [["overflow", s.over], ["clipping", s.clipped], ["sliver", s.slivers]]) {
      if (list && list.length) findings.push(`${where}: ${kind} — ${list.join("; ")}`);
    }
    // PROSE HAS A MEASURE, WHEN THE CALLER ASKS FOR ONE (round 265). A policy rather than a law of nature — a
    // dashboard's own answer may differ — so the floor travels in the caller's options and a UI that has not
    // measured this axis is not failed by a number somebody else picked. The row carries the width and the
    // computed max-width, because "this line is 206 characters because the surface is 1339px wide" and "because
    // no cap was ever written" want different repairs.
    if (opts.proseFloor) {
      for (const row of ((s.measure && s.measure.worst) || []).filter((x) => x.cpl > opts.proseFloor)) {
        // "PER LINE", NOT "ON ONE LINE": `cpl` is chars over rendered lines, so a block that wraps three times can
        // still be over the floor — and this axis's first CI run called a 477-character note "159 characters on ONE
        // line", a sentence about a defect that did not exist. The count is per line; the shape is the block's
        // (round 265).
        findings.push(`${where}: ${row.sel} renders ${row.cpl} characters PER LINE (${row.chars} chars in ${row.lines} line(s) over ${row.w}px at ${row.fs}px, max-width ${row.maxw}) — past ${opts.proseFloor} a reader loses the line return; this sheet's own ledes cap at 66ch`);
      }
    }
    // THE MARK LANGUAGE AS PAINTED. A family whose two states render identically is colour-only wherever a cascade
    // override or a missing rule made it so — the sheet can be right while the page is wrong, which is exactly how
    // `.plug-dot[error]` kept a stray halo through a unit test that passed (round 25).
    // A MARK THAT IS BOTH A FILL AND A RING IS NEITHER, and it is not a collision — no other state shares it, so the
    // distinctness check above would pass it. The vocabulary is solid / ring / halo / empty; this is what a rule
    // produces by accident when it sets a background and inherits an inset shadow, which is exactly the four
    // .plug-dot arms of round 45. Rendered, not read: the probe reports the computed kind per state.
    if (s.marks && (s.marks.ringFill || []).length) {
      findings.push(`${where}: ${s.marks.ringFill.length} mark(s) are a FILL inside a RING — the vocabulary is solid / ring / halo / empty, and a mark that is two of them is neither: ${s.marks.ringFill.join("; ")}`);
    }
    if (s.marks && (s.marks.collisions || []).length) {
      findings.push(`${where}: states of one mark paint identically — ${s.marks.collisions.join("; ")}`);
    }
    // ONE FOCAL POINT, AT MOST. Two loud surfaces means neither is the thing the page is about; the ceiling is
    // one, and zero is allowed because a form or a dashboard is all context and should not shout. A page that
    // needs an exception gets one here, by name, with the reason — the same shape as `navless`.
    // A COLOUR THE PROBE COULD NOT READ IS A FAILURE, not a skip: every comparison against NaN is false, so an
    // unreadable background used to pass every guard and be counted as loud (rounds 18-56, found in 55). Reporting
    // the count means the next occurrence is loud in the report instead of silently inflating it.
    // REPORTED, NOT FAILED — for now. Six backgrounds across 24 surfaces (measured round 57) are in a syntax this
    // parser still cannot read; every other colour is read and the axis agrees with the hand measurements. A NOTE is
    // the honest severity: a failure would block every run on a residue nobody has looked at yet, and silence is what
    // let this axis report nonsense for thirty-seven rounds. The count rides in the summary so it cannot be ignored.
    if (s.loudUnreadable) {
      const samples = (s.loudUnreadableSamples || []).slice(0, 2).join("; ");
      notes.push(`${where}: ${s.loudUnreadable} background(s) in a colour syntax this probe cannot read — skipped, not counted${samples ? " (" + samples + ")" : ""}`);
    }
    // THE EXCEPTION IS ABOUT ELEMENTS, NOT PAGE NAMES (round 68). It used to except a whole page by name prefix,
    // which hid its siblings — CI rendered `Terminal-16-sessions`, `Desktop-16-sessions`, `Desktop-Terminal-fail-dark`
    // and `Desktop-empty`, all two-loud with the SAME rail button and the new-session action, and none of them was
    // covered. Naming the ELEMENTS cannot widen: a page that starts shouting about something else still fails, which
    // is what round 42's own note warned a page-name exception could never do.
    const NAV_LOUD = [
      { match: /rail-btn|desktop-rail-btn/, why: "the rail button is WHICH PAGE YOU ARE ON (navigation state)" },
      { match: /^div\.tab|^button\.dtab/, why: "the active session tab is WHICH SESSION (navigation state)" },
      { match: /btn-new/, why: "the primary action on the page, which state-colour-check protects deliberately" },
      // THE APPROVAL GATE, which `state-colour-check` lists as a PURPOSE in its own right (round 69). It appears
      // only while a command is waiting for the operator, and on that page it is not competing with the primary
      // action — it IS the primary action. CI's next run named it in a loud finding, which is how the omission
      // became visible: the exception had listed the three navigation and action elements and not this one.
      { match: /approval-approve/, why: "the approval gate's Approve — the one control that outranks the page's action while a command is held" },
    ];
    const navLoud = (s.loud || []).every((entry) => NAV_LOUD.some((n) => n.match.test(String(entry))));
    if ((s.loud || []).length > 1 && !navLoud) {
      findings.push(`${where}: ${s.loud.length} loud elements — a page has ONE focal point at most — ${s.loud.join("; ")}`);
    }
  }
  for (const n of report.names || []) {
    const where = `${n.page}${n.width ? "@" + n.width + "px" : ""}`;
    if (n.unnamed.length) findings.push(`${where}: ${n.unnamed.length} control(s) with NO accessible name — ${n.unnamed.join(", ")}`);
    if (n.titleOnly.length) findings.push(`${where}: ${n.titleOnly.length} control(s) named only by title — ${n.titleOnly.join(", ")}`);
  }
  // HOW OFTEN THE COMPUTED-STYLE VERDICT WAS OVERRULED BY THE PIXELS. Not a finding — the pixels are the
  // authority and they said the ring is painted — but it is the number to WATCH: it was 18 out of 18 in
  // round 186, where the style check called every console ring missing while the browser drew all of them,
  // and six rounds went by before anyone looked at a screenshot. A count that keeps climbing means the
  // style check is drifting further from what is painted, and the next drift may not be benign.
  // WHICH HARNESS GENERATION WAS MEASURED. Round 189 lost an afternoon to a delivered harness that
  // predated a CSS fix: its inlined stylesheet collapsed the tab strip to 17px, the sweep reported overflow
  // that looked like a live defect, and a waiver hid it. The stamp travels in the report and is printed
  // here, so a reader can see at a glance that the fixture is older than the build it should match.
  if (report.harnessBuild) console.log(`note: harness build ${report.harnessBuild}`);
  // AND WHEN IT IS NOT THE BUILD THE SWEEP EXPECTED, THE WHOLE REPORT IS SUSPECT. Round 189 measured a
  // delivered harness two generations old: its inlined CSS collapsed the tab strip to 17px and the sweep
  // reported overflow that looked exactly like a live regression. A finding is the right weight — nothing
  // below can be trusted until the fixture is regenerated.
  // A DELIVERED COPY OLDER THAN THE BUILD MEASURES SOMETHING NOBODY CAN NAME. Same weight as a stale panel
  // harness, and the same evidence-free failure mode: a UI whose CSS has moved on reports findings that look
  // live. The check travels with every console and extension report.
  // AND WHEN IT IS CURRENT, SAY SO. The panel prints its harness generation on every run, so a reader always
  // knows which artifact was measured; the console and the extension were silent about it unless something
  // was wrong. Provenance that only appears in a failure is provenance nobody can check.
  if (report.entryCheck && !report.entryCheck.stale && !report.entryCheck.error) {
    console.log(`note: delivered entry ${report.entryCheck.bytes} bytes / sha ${report.entryCheck.sha} — matches the build`);
  }
  if (report.entryCheck && report.entryCheck.stale) {
    const e = report.entryCheck;
    findings.push(
      e.error
        ? `the delivered entry could not be read (${e.error}) — expected ${e.expected.bytes} bytes, sha ${e.expected.sha}`
        : `the delivered entry is ${e.bytes} bytes / sha ${e.sha} but this sweep was emitted against ${e.expected.bytes} / ${e.expected.sha} — every measurement below is of a stale build`,
    );
  }
  if (report.harnessStale) {
    findings.push(
      `the harness is build ${report.harnessBuild} but this sweep was emitted against ${report.expectedHarnessBuild} — ` +
        `every measurement below is of a stale fixture`,
    );
  }
  const paintTotal = (report.focus || []).reduce((a, f) => a + (f.paintConfirmed || 0), 0);
  const pressedTotal = (report.focus || []).reduce((a, f) => a + (f.pressed || 0), 0);
  if (paintTotal) {
    console.log(
      `note: the pixels overruled the computed-style focus verdict ${paintTotal} time(s) of ${pressedTotal} press(es) — ` +
        `the rings are painted, the style check cannot see them`,
    );
  }
  for (const f of report.focus || []) {
    // A CHECK THAT COULD NOT LOOK IS NOT A PASS. The pixel confirmation can fail (an offscreen element, a
    // clip the browser refuses), and the first version turned that into "no focus indication" — a false
    // finding. It is now its own verdict, and it FAILS the run, because an unperformed measurement proves
    // nothing either way.
    if (f.unconfirmed) {
      findings.push(
        `${f.page ? f.page + ': ' : ''}${f.unconfirmed} focus candidate(s) could not be confirmed against the pixels` +
          `${(f.unconfirmedOn || []).length ? ' — ' + f.unconfirmedOn.join(', ') : ''} — the check could not look, so it cannot say`,
      );
    }
    if (f.missing) findings.push(`${f.page ? f.page + ': ' : ''}${f.missing} Tab stop(s) with no visible focus ring`);
    // A RUN THAT LANDED NOWHERE IS NOT A PASSING RUN. Focus escaping to the body used to count as "ok",
    // so a page with nothing focusable reported a clean sheet — the same "a skip reads as a pass" defect
    // the colour sweep bans. A row that says it pressed keys and landed on nothing is a finding.
    if (f.pressed > 0 && f.landed === 0) {
      findings.push(
        `${f.density || ''}${f.theme ? '/' + f.theme : ''}: focus landed on nothing in ${f.pressed} Tab press(es) ` +
          `(${f.escaped} escaped to the body) — that is a report of no focusable targets, not of good focus rings`,
      );
    }
  }
  // A PRESS THAT RENDERS NOTHING IS A CONTROL THAT DOES NOT ANSWER (round 55). The same measurement that found the
  // panel's dead active tab by hand, in the sweep: `pressPass` presses each target with the pointer and compares the
  // computed style before and during. `feedback-check.mjs` proves the RULE exists; only this can see whether it
  // reaches the screen.
  for (const row of report.press || []) {
    // THE LABEL NAMES THE ITERATION, not just the surface: density/theme alone made a finding from the rail walk
    // indistinguishable from one from the mode loop, and both run on every density of this suite.
    const where = `${row.density || "?"}/${row.theme || "?"}${row.mode ? " " + row.mode : ""}${row.page ? " " + row.page : ""}`;
    // AND ONLY WHERE THE POINTER ARRIVED: a row the pass could not deliver a press to is not a control that ignored
    // one — the distinction that matters when an element sits below the fold.
    const dead = (row.rows || []).filter((r) => r.changed === false && r.reached !== false);
    for (const d of dead) findings.push(`${where}: ${d.sel} (${d.where}) renders NOTHING when pressed — before and during are identical (${d.size})`);
    for (const r of row.rows || []) {
      if (r.note && !/not rendered/.test(r.note)) console.log(`note: ${where} ${r.sel} — ${r.note}`);
    }
    // A PASS THAT PRESSED NOTHING IS NOT A CLEAN PASS — AND THE FLOOR IS WHAT THE PAGE HAS, not a constant. A curated
    // list expects a surface to render several of its selectors, so two is the bar. A DISCOVERED pass reports how
    // many controls the page had, and ONE control pressed is a complete pass on a page that has one: the harness's
    // Browser page is an explanation with a single control (round 45), and a floor of two called that vacuous.
    const floor = row.found == null ? 2 : Math.min(2, row.found);
    if (row.found != null && row.found > (row.rows || []).length) {
      console.log(`note: ${where} has ${row.found} control(s) and the pass pressed the first ${(row.rows || []).length} (cap) — the rest were not measured`);
    }
    if ((row.measured || 0) < floor) {
      findings.push(`${where}: the press pass measured ${row.measured || 0} control(s)${row.found == null ? "" : ` of the ${row.found} this page renders`} — a press pass that pressed nothing proves nothing`);
    }
  }
  // IMMEDIATE FEEDBACK HAS A BUDGET (round 19) — AND IT IS JUDGED HERE NOW, FOR EVERY SWEEP THAT MEASURES IT.
  //
  // This clause lived in `panel-design-sweep.mjs`, so the PANEL's acknowledgement rows were judged and the CONSOLE's
  // were not. The console has collected `report.ack` since it gained the pass — about 86s of CI per run, a third of
  // its sweep — and its judge had no clause for that array at all, while TWO COMMENTS ASSERTED THE OPPOSITE
  // (`console-run.cjs`: "the shared judge reads that array"; `ackNotes`'s own doc: the console's rows "were judged").
  // MEASURED, not inferred: one row describing a control that never acknowledged a press exits 1 under the panel's
  // judge and 0 under the console's — the same row, the same fixture. A console control that answers no press could
  // not fail the run, and the axis it was measured on cost a third of that sweep.
  //
  // ONE DERIVATION, so the two sweeps cannot drift apart again: the clause belongs to the REPORT SHAPE, not to a UI.
  // The panel's judge keeps only what is the panel's own; every row below is judged identically for both.
  for (const a of report.ack || []) {
    const where = `${a.density || "?"}${a.page ? " " + a.page : ""}`;
    // AN UNMEASURED PREMISE IS NOT AN EXCUSE (round 11 of the standing goal). The clause below excuses a control that
    // asked the device nothing — but only a page that HAS a request counter can tell "asked nothing" from "nobody
    // looked", and the console had none, so EVERY one of its rows was excused by a note claiming a measurement that
    // never happened, and a console control that never acknowledged a press could never fail the run. Both sweeps
    // install a counter now; this clause is what makes its absence a FAILURE rather than a footnote — the rule the
    // focus axis already follows ("a check that could not look must not read as a pass").
    if (a.hasCounter === false) {
      findings.push(`${where}: ${a.sel} was pressed on a page with NO request counter, so whether it asked the device anything is UNMEASURED — the acknowledgement axis proves nothing here`);
      continue;
    }
    if (a.note) { console.log(`note: ${where} ${a.sel} — ${a.note}`); continue; }
    if (!a.acked) {
      // ONLY WHERE THERE WAS SOMETHING TO WAIT FOR. A control that asked the device nothing (a tab switching a
      // snippet, a disclosure) cannot be late: its row says so rather than becoming a finding.
      if (a.asked === false) {
        console.log(`note: ${where} ${a.sel} — asked the device nothing, so there was nothing to acknowledge`);
        continue;
      }
      // WHAT THIS CAN HONESTLY CLAIM: the control never acknowledged the press in the window. Whether it asked the
      // device is NOT attributable from a request counter on a page that polls for its own reasons, so the finding
      // does not say it did.
      findings.push(`${where}: ${a.sel} (${a.where}) never acknowledged the press — no busy state and no painted change within the window (${a.size})`);
      continue;
    }
    // EVERY ROW'S NUMBERS, ON EVERY RUN (round 26). The judge reported only the failures, so a CI-only failure could
    // not be compared with a clean device run without re-running both by hand: eight controls "never acknowledged"
    // in CI and answered in 6-13ms on the device, same sweep, same fixture. A measurement nobody can read is a
    // measurement nobody can check.
    for (const line of ackNotes([a], where)) console.log(line);
    if (typeof a.msToAck === "number" && typeof a.budgetMs === "number" && a.msToAck > a.budgetMs) {
      findings.push(`${where}: ${a.sel} (${a.where}) acknowledged the press after ${a.msToAck}ms — the budget is ${a.budgetMs}ms, so this feedback waited on the ${a.msToClear}ms network round trip instead of firing on the event`);
    }
  }
  {
    const acked = (report.ack || []).filter((a) => a.acked);
    if (report.ack && report.ack.length && !acked.length) {
      findings.push(`the acknowledgement pass measured ${report.ack.length} control(s) and NONE acknowledged — a pass that proves nothing is not a pass`);
    }
  }

  // ── TARGET SIZE, IN ONE PLACE (round 20 of the standing goal) ───────────────────────────────────────────────────
  // This criterion lived in THREE judges — panel, console, landing — with three slightly different sentences, and in
  // round 17 only the PANEL's copy was strengthened with the spacing clause's second half. So one page judged by two
  // sweeps got two verdicts, which is the shape "one derivation" exists to prevent. It is here now and all three judge
  // it identically.
  //
  // THE TWO HALVES, AND WHY CONTAINMENT IS NOT ONE OF THEM. `passesBySpacing` is CENTRE-to-CENTRE — the circle-vs-circle
  // test, right against another undersized target and wrong against a LARGE one, where the circle has to clear that
  // neighbour's BOX. The probe computes both, plus `insideSel` (the container, when the target is nested). A nested
  // control's circle is inside its container by construction, so the literal reading of "the circles do not intersect
  // another target" fails EVERY nested control in the product: that is nested interactive content, a different question,
  // and it is NAMED below rather than enforced. What IS enforced is crowding — a small target whose circle reaches a
  // neighbour BESIDE it.
  for (const t of report.targets || []) {
    const where = [t.density, t.page, t.mode].filter(Boolean).join(" ") || "?";
    for (const u of t.distinct || []) {
      if (!u.passesBySpacing) {
        findings.push(`target size (${where}): ${u.sel} is ${u.w}x${u.h} and its nearest neighbour is ${u.nearest}px away — 2.5.8 wants 24x24 or 24px of spacing ("${u.text}")`);
        continue;
      }
      if (u.passesByFullRule === false) {
        findings.push(
          `target size (${where}): ${u.sel} is ${u.w}x${u.h} and its 24px circle reaches ${u.nearSel} (${u.nearW}x${u.nearH}) ` +
            `${u.gapToBox}px away — the spacing clause wants the centre 12px clear of another target's BOX, not only 24px from its centre ("${u.text}")`,
        );
      }
    }
    const nested = (t.distinct || []).filter((u) => u.insideSel);
    if (nested.length) {
      console.log(
        `note: target size (${where}): ${nested.length} of ${(t.distinct || []).length} undersized target(s) sit INSIDE another target — ` +
          `not a spacing failure (the circle is inside its container by construction), but a near-miss there activates the container: ` +
          nested.map((u) => `${u.sel} ${u.w}x${u.h} in ${u.insideSel} ${u.insideW}x${u.insideH}`).join("; "),
      );
    }
  }

  // A SURFACE MAY NOT CLAIM A READ FAILED WHEN THE FIXTURE ANSWERED EVERY CALL (round 100).
  //
  // This is the clause that would have caught rounds 99 and 100 by machine. A normal surface serves every endpoint,
  // so a page that says "could not be read" or "did not answer, so ..." is asserting something about the DEVICE that
  // the fixture contradicts — the panel blaming the device for a question it answered. It happened three times (the
  // update card, the monitors, the restart history) and no gate could see it: a sentence is not a contrast ratio,
  // and every instrument here was reading numbers.
  //
  // THE SURFACES THAT MEAN IT ARE EXCUSED BY THE FIXTURE'S OWN ANSWER, not by a list here: report.sse carries
  // whether the run rejected every API call on purpose (?fail=1), and on those pages the claim is TRUE.
  const rejectedCalls = new Set((report.sse || []).filter((s) => s.fail).map((s) => s.page));
  // THE PREMISE HAS TO HOLD BEFORE THE CLAUSE APPLIES: a claim is only FALSE where a fixture ANSWERED. The panel's
  // report carries that evidence (`sse` records per surface, including the ?fail=1 pages); the CONSOLE has no backend
  // at all — its sweep serves a static build, every API call fails for real, and "could not be read" on its Models
  // page is TRUE. A clause that failed that page would be the instrument lying about the console, which is the
  // defect this whole round is about, one level up. So a report that declares nothing about what it served is not
  // judged on this axis, and says so the first time it runs.
  const fixtureEvidence = (report.sse || []).length > 0;
  if (!fixtureEvidence && (report.surfaces || []).some((s) => (s.claims || []).length)) {
    console.log("note: read-failure claims are NOT judged here — this report declares nothing about what its fixture served, so the clause has no premise (the console has no backend)");
  }
  const excusedClaims = [];
  for (const s of fixtureEvidence ? report.surfaces || [] : []) {
    const claims = s.claims || [];
    if (!claims.length) continue;
    if (rejectedCalls.has(s.page)) {
      for (const c of claims) excusedClaims.push(`${s.page}: ${c}`);
      continue;
    }
    for (const c of claims) {
      findings.push(`${s.page} claims a read failed — "${c}" — while the fixture answered every call: either the panel is wrong about the device, or the fixture never stubbed an endpoint the card needs`);
    }
  }
  if (excusedClaims.length) {
    console.log(`note: ${excusedClaims.length} read-failure claim(s) on surfaces whose fixture REJECTS every call — true by construction:`);
    for (const w of [...new Set(excusedClaims)].slice(0, 4)) console.log(`  ${w}`);
  }

  // IDLE REPAINT (round 64). The objective lists it among the things a claim is verified by, and the measurement is
  // DOM mutations on a settled page under STATIC fixtures: React writes to the DOM only when the output differs, so
  // nothing changing means nothing written. The observer proves it is alive by seeing one deliberate mutation of the
  // panel's own root, and that is required — a blind observer reports a perfectly still panel forever.
  for (const row of report.idle || []) {
    const where = `${row.density || "?"}/${row.theme || "?"}/${row.page || "?"}`;
    const probe = (row.byTarget || {}).__probe || 0;
    const real = (row.mutations || 0) - probe;
    if (probe < 1) {
      findings.push(`${where}: the idle observer did not see its own probe mutation — a blind instrument reports a still panel forever, so this measurement proves nothing`);
    }
    if (real > 0) {
      const all = Object.entries(row.byTarget || {}).filter(([k]) => k !== "__probe");
      // A CLOCK IS NOT A REPAINT (round 69). The first CI run of the pass reported "6 mutations in 6s (#text x6)" —
      // one per second — and naming the PARENT turned it into `span.approval-left x6`: the approval countdown
      // counting down. That is a value that is SUPPOSED to change, and calling it a repaint of unchanged output
      // would be a false finding, which is worse than none. The exemptions are an explicit table with a reason
      // each, the same shape `state-colour-check` uses for the rules it deliberately does not judge: a table cannot
      // quietly grow the way a regex can, and the elements exempted are exactly the ones that render a live
      // duration.
      const CLOCKS = [
        { match: /^span\.approval-left$/, why: "the approval countdown — seconds until the gate closes" },
        { match: /^span\.cmd-duration$/, why: "a running command's elapsed time (the panel's one clock)" },
        { match: /^span\.traj-/, why: "the same elapsed time inside the trajectory view" },
        { match: /^\.details-duration$/, why: "the same elapsed time in the details column" },
      ];
      const clock = (name) => CLOCKS.find((c) => c.match.test(name));
      const repaints = all.filter(([name]) => !clock(name));
      const clocks = all.filter(([name]) => clock(name));
      if (clocks.length) {
        notes.push(`${where}: ${clocks.map(([k, v]) => `${k} x${v}`).join(", ")} changed while idle — a live duration, exempt by name with its reason in CLOCKS`);
      }
      if (repaints.length) {
        const targets = repaints.map(([k, v]) => `${k} x${v}`).join(", ");
        findings.push(`${where}: ${repaints.reduce((n, [, v]) => n + v, 0)} DOM mutation(s) in ${row.seconds}s while idle — nothing changed under static fixtures, so this is a repaint of unchanged output (${targets})`);
      }
    }
  }

  // REDUCED MOTION IS A CONTRACT, NOT A COURTESY. `motion` entries come from a render with the
  // preference EMULATED: anything still carrying a transition or an infinite animation under it is a
  // finding. Measured round 77 — the panel density honoured the preference and the desktop density
  // did not (19 elements with motion, 19 after), and the fix took four rounds of cause-finding:
  // cascade order, then selector scope, then specificity, then an id, because xterm.js injects its
  // stylesheet at runtime and no equal-specificity rule of ours can win.
  for (const m of report.motion || []) {
    // BOTH SHAPES: `animating` is the older single-number row, `stillAnimating` the newer one.
    const still = m.stillAnimating || m.animating || [];
    if (still.length) {
      findings.push(`reduced motion (${m.density || "?"}): ${still.length} element(s) still animate — ${still.slice(0, 3).join("; ")}`);
    }
    // A CHECK THAT FOUND NOTHING TO SUPPRESS PROVES NOTHING. Round 134 added the second measurement: if
    // nothing animates WITHOUT the preference either, then "nothing animates under reduce" says nothing
    // about the rule — the page has no motion to honour, or the probe matched nothing at all.
    if (typeof m.normal === "number" && m.normal === 0) {
      findings.push(
        `reduced motion (${m.density || "?"}): 0 elements animate WITHOUT the preference, so this result ` +
          `proves nothing about prefers-reduced-motion — the check found nothing to suppress`,
      );
    }
  }
  // HOVER IS A STATE, and until round 84 neither instrument looked at it: the static pair sweep reads
  // base rules, and the rendered passes measure the RESTING DOM. The panel carries 73 :hover rules —
  // exactly where a designer reaches for a lighter accent. Measured: 31 interactive elements, 24
  // hoverable in the harness, 0 under AA in either theme.
  // A CLASS THE PAGE RENDERS THAT NO RULE STYLES — the mirror of dead CSS, and the failure a prune
  // causes. Round 88 found three by hand; this is the same question, asked by the browser (CSSOM)
  // on every sweep. `opts.implicitStates` names classes that are unstyled ON PURPOSE because a base
  // rule already produces their appearance, each with the reason printed rather than hidden.
  // WHICH DECLARED CLASSES THIS RUN ACTUALLY SAW (round 24). `implicitStates` is the third list of exemptions the
  // suite keeps, after DECORATIVE (rows) and ignore (findings) — and like the other two it had no way to say that an
  // entry was not earning its place. The probe reports only classes with NO matching rule, so an entry stops being
  // used the moment the class disappears from the markup OR gains a rule: either way the reason attached to it is
  // being kept for nothing. Counted here, reported below with the size of the search.
  const declaredImplicit = Object.keys(opts.implicitStates || {});
  const seenImplicit = new Set();
  for (const u of report.unstyled || []) {
    for (const c of u.classes || []) if ((opts.implicitStates || {})[c]) seenImplicit.add(c);
  }
  for (const u of report.unstyled || []) {
    const all = u.classes || [];
    const waived = all.filter((c) => (opts.implicitStates || {})[c]);
    for (const c of waived) console.log(`note: ${c} is unstyled by design — ${opts.implicitStates[c]}`);
    const live = all.filter((c) => !(opts.implicitStates || {})[c]);
    if (live.length) {
      // THE WORDING MATTERS, and it took a round to get it right: a class with no matching rule is NOT
      // an unstyled element. A base class styles it (`.view` on `view terminal`), or an ATTRIBUTE does
      // (`tab-dot serial` is painted by a [data-kind] rule), or it is a deliberate test marker. What is
      // true — and what is worth failing on — is narrower: this name is on screen and nothing matches
      // it, so either it is an inert extra to prune or it needs a reason to stay.
      findings.push(`class name(s) with no matching rule on ${u.page || "?"}: ${live.join(", ")} — on screen, matched by nothing`);
    }
    // A READ THAT FOUND NO STYLESHEETS PROVES NOTHING (round 88's collector reported 38 styled
    // classes where the browser sees 221, and its empty findings looked like a clean page).
    // THE THRESHOLD IS THE MEASURED FAILURE, not a guess: the console's pages have 221 styled classes
    // and round 88's broken collector reported 38 — so a floor of 20 would not have caught it. 100 is
    // below every real page in either UI and above every broken read seen so far.
    // THE FLOOR IS PER-UI, because a page can be legitimately small. The extension's options page is
    // three controls styled by element and id selectors, and its sheet defines FOUR classes — a floor of
    // 100 would report "the collector read almost nothing" forever, which is the false alarm this
    // parameter removes. The panel and console keep the strict default.
    // A SHEET THE COLLECTOR COULD NOT READ IS A HOLE IN ITS BASIS, and every class that sheet styles looks
    // unstyled. The floor above catches a collector that read almost nothing; this catches one that read
    // almost everything — the failure the floor cannot see.
    if (u.sheetsUnreadable > 0) {
      findings.push(
        `unstyled check on ${u.page || "?"}: ${u.sheetsUnreadable} stylesheet(s) could not be read, so their classes look unstyled — the basis is incomplete`,
      );
    }
    if (typeof u.styledClasses === "number" && u.styledClasses < (opts.unstyledFloor ?? 100)) {
      findings.push(`unstyled check on ${u.page || "?"}: only ${u.styledClasses} styled classes found (floor ${opts.unstyledFloor ?? 100}) — the collector read almost nothing, so its silence means nothing`);
    }
  }
  {
    const unused = declaredImplicit.filter((c) => !seenImplicit.has(c));
    if (unused.length) {
      const classes = (report.unstyled || []).reduce((n, u) => n + (u.classes || []).length, 0);
      console.log(
        `note: ${unused.length} of ${declaredImplicit.length} declared unstyled-by-design class(es) were not seen in this run (${classes} unstyled name(s) over ${(report.unstyled || []).length} page(s)) — a reason nothing needs is weight; prune it or say why it stays:`,
      );
      for (const c of unused) console.log(`  ${c} — ${opts.implicitStates[c]}`);
    }
  }
  // THE TYPE FLOOR, IN THE RENDERED PAGE. designScale.test.ts pins the SCALE — names, order, and a 10px floor
  // — but a token being 10px and the rendered text being 10px are different claims, and only the second one
  // is what a reader experiences. Round 164 looked at the rows every sweep already collects: the panel's
  // smallest rendered size is 10 and the console's is 10.8, against 2035 and 590 text rows. Nothing was
  // wrong; this is what keeps it that way, because a one-off look is not a guard.
  for (const r of report.rows || []) {
    if (r.kind === 'graphic') continue;
    if (typeof r.size === 'number' && r.size > 0 && r.size < 10) {
      findings.push(`type floor: ${r.sel} renders at ${r.size}px on ${r.page || '?'} — the scale's floor is 10px ("${String(r.text || '').slice(0, 24)}")`);
    }
  }
  // A SCAN THAT COULD NOT READ MOST OF THE PAGE IS NOT A CLEAN SCAN. Rows the probe cannot measure are
  // excluded from judgement — correctly, since guessing at them is how a probe starts lying — but until
  // round 165 they appeared ONLY as a number in the summary line, so a report that had stopped measuring
  // anything would still exit 0 with "nothing above found a defect". That is the same vacuity this suite has
  // found in its own checks five times over, and the same rule it already applies to the unstyled scan: a
  // floor, stated with the number that failed it.
  //
  // Both live reports are at 0.0% (the panel's 496 gradient-surfaced rows are measured against their stops,
  // not skipped), so the floor is not a nuisance today — it is what would catch the day it is not.
  {
    const all = (report.rows || []).length;
    const blind = (report.rows || []).filter((r) => r.cr === null || r.cr === undefined || Number.isNaN(r.cr)).length;
    const floor = opts.unmeasurableFloor ?? 0.1;
    if (all > 0 && blind / all > floor) {
      findings.push(
        `only ${all - blind} of ${all} rows could be measured (${((blind / all) * 100).toFixed(1)}% unmeasurable, floor ${(floor * 100).toFixed(0)}%) — the absences below prove nothing`,
      );
    }
  }
  for (const h of report.hover || []) {
    if (h.underAA && h.underAA.length) {
      findings.push(`hover (${h.density || "?"}/${h.theme || "?"}): ${h.underAA.length} element(s) below AA while hovered — ${h.underAA.slice(0, 3).join("; ")}`);
    }
  }
  // THE HARNESS DELIVERED THE PUSH, OR THE MEASUREMENT IS OF ANOTHER PANEL. Every panel surface this suite has
  // ever measured was taken with the SSE fixture either serving a frame (connected) or refusing every call (the
  // failure surfaces, which are SUPPOSED to read as reconnecting). Nothing asserted which — so a fixture change that
  // shut the stream would silently turn every surface into a reconnecting panel and every finding into a statement
  // about a screen nobody sees. The harness publishes {opened, fail}; this is the clause that reads it.
  // AND THE RENDERED TEXT IS THE SECOND WITNESS, independent of the flag above. "Sessions unavailable" is the
  // panel's own sentence for a push that never arrived; on a surface whose harness did NOT report the failure
  // fixture, seeing it means the measurement describes a screen the operator never sees. Two signals, one fact —
  // the flag says what the fixture did, this says what the panel concluded from it, and a fixture that lies about
  // itself would have to lie in both places to get past.
  const harnessFailed = new Map((report.sse || []).map((r) => [r.page, r.fail === true]));
  for (const row of report.rows || []) {
    if (!/Sessions unavailable/i.test(String(row.text || ""))) continue;
    if (harnessFailed.get(row.page) === true) continue;      // the failure fixture is meant to say exactly this
    findings.push(`${row.page || "?"}: the panel renders "Sessions unavailable" and the harness did not report the failure fixture — this surface was measured with the push missing`);
  }
  for (const row of report.sse || []) {
    if (row.fail === true) continue;                       // a failure surface is meant to be disconnected
    if (row.opened !== true) {
      findings.push(`${row.page || "?"}: the harness never opened the SSE stream, so this surface was measured in the RECONNECTING state — the fixture failed, not the panel`);
    }
  }
  for (const r of report.reflow || []) {
    if (r.docScrollsSideways) {
      findings.push({ text: `reflow @${r.width}px: the document scrolls sideways (${r.docScrollWidth} > ${r.viewport})`, entry: r });
    }
    // A toolbar-style scroller is WCAG 1.4.10's own exception; reported, not failed.
    if (r.sideScrollers.length) console.log(`note: scrollers at ${r.width}px (allowed for toolbars) — ${r.sideScrollers.join("; ")}`);
    // AND WHAT WIDENS IT, WHEN NOTHING SCROLLS (round 23 of the standing goal). `sideScrollers` lists only elements
    // that are THEMSELVES scrollers, so a document widened by a merely-WIDE element produced `SCROLLS` with an EMPTY
    // scroller list — which is the state an exemption reading "every offending scroller is a tab child" satisfies
    // vacuously. This names the elements whose box leaves the viewport, so the next reader does not have to guess
    // which one it is (the panel's `#tabs` already carries `overflow-x: auto`, so the obvious guess was wrong).
    if (r.docScrollsSideways && (r.overflowing || []).length) {
      console.log(`note: the ${r.width}px overflow comes from — ${r.overflowing.join("; ")}`);
    }
  }
  const kept = [];
  // WHICH EXEMPTIONS THIS RUN ACTUALLY NEEDED (round 22). `DECORATIVE` reports the entries no row matched; this is
  // the same question for `ignore`, whose entries are consulted against FINDINGS rather than rows — the hover path's
  // dot exemption and the reflow harness artifact. An exemption nothing needs is weight in the one list a reader
  // consults, and the panel spent rounds discovering that the hard way (a waiver for `/^div\.rail-dot$/` had matched
  // nothing since a selector changed). Counted here because this is the only place that knows.
  const usedRules = new Set();
  for (const f of findings) {
    const text = typeof f === "string" ? f : f.text;
    const entry = typeof f === "string" ? null : f.entry;
    // An exemption may look at the REPORT ENTRY as well as the finding's text. The panel's tab-strip
    // artifact is only an artifact when the offending scrollers are tab children — a rule matching
    // the text alone would also hide a genuine 320px reflow defect, and the sweep's own gate caught
    // exactly that when the first version of this exemption was written.
    const rule = (opts.ignore || []).find((i) => (i.test ? i.test(text, entry) : i.match.test(text)));
    if (rule) {
      usedRules.add(rule);
      suppressed.push({ finding: text, reason: rule.reason });
    } else kept.push(text);
  }
  {
    // A NOTE, NOT A FINDING, and it names the size of the search: a run that measured one axis produces none of the
    // findings these entries exist for, and then every entry looks unused. The count is what lets a reader tell a
    // stale exemption from a partial run — the same reason the DECORATIVE note carries its row count.
    //
    // AND AN ENTRY MAY ANSWER THE QUESTION ITSELF (round 22). "Prune it or say why it stays" is only actionable if
    // there is somewhere to say it: an exemption whose reason still holds and whose pattern still fires — a GUARD for
    // a state that currently passes — declares `dormant: "<why it is expected to match nothing in a clean run>"`,
    // and the note then reports it as declared rather than as weight. An entry that is genuinely dead has nothing to
    // declare, which is exactly the one to prune (round 21's `/^div\.rail-dot$/` in DECORATIVE).
    const unused = (opts.ignore || []).filter((i) => !usedRules.has(i));
    const undeclared = unused.filter((i) => !i.dormant);
    const dormant = unused.filter((i) => i.dormant);
    if (undeclared.length) {
      console.log(
        `note: ${undeclared.length} of ${(opts.ignore || []).length} ignore entr(ies) matched none of this run's ${findings.length} finding(s) and does not say why it stays — an exemption nothing needs is weight; prune it, or declare it dormant with the measurement that makes it a guard:`,
      );
      for (const u of undeclared) console.log(`  ${u.reason}`);
    }
    for (const d of dormant) {
      console.log(`note: ignore entry dormant as declared — ${d.dormant}`);
    }
  }
  for (const s of suppressed) console.log(`note: set aside (${s.reason}) — ${s.finding}`);
  return kept;
}

/** How a sweep reports its result, so three tools read the same way. */
export function reportSummary(label, report) {
  const surfaces = report.surfaces.length;
  const blind = (report.rows || []).filter((r) => r.cr === null).length;
  // THE WORST LINE OF PROSE, in the summary, because a floor that only SPEAKS when it is crossed tells a reader
  // nothing about how close the rest of the run is to it (round 265). Absent when a sweep did not measure it.
  const prose = (report.surfaces || []).reduce((acc, s) => {
    const worst = ((s.measure && s.measure.worst) || [])[0];
    return worst && worst.cpl > acc.cpl ? worst : acc;
  }, { cpl: 0 });
  return (
    `${label}: ${(report.rows || []).length} text nodes · ${surfaces} surface(s) · ` +
    `${(report.names || []).length} name checks` +
    (prose.cpl ? ` · worst prose line ${prose.cpl} chars (${prose.sel})` : "") +
    (blind ? ` · ${blind} unmeasurable` : "")
  );
}

/**
 * THE STATES A SHEET DECLARES AND THIS RUN NEVER PAINTED (round 32, made shared in round 50).
 *
 * The panel learned this the expensive way: `cmd-dot` rendered four of its six states for rounds, and the two that had
 * no surface hid a missing rule and a colour-only pair. The note is the queue those rounds worked from — and until
 * round 50 it lived INSIDE `panel-design-sweep.mjs`, so the console and the landing had no such queue at all and their
 * unrendered states were silent. One implementation, three callers, because a second copy is how the two would drift.
 *
 * `cssText` is the sheet whose state rules define the families (the panel's BUILT sheet, the console's SOURCE sheets,
 * the landing's cropped <style> block); `report` is the sweep report whose surfaces carry `marks.families`/`present`.
 */
export function markCoverageNotes(cssText, report) {
  const out = [];
  const css = String(cssText || "").replace(/\/\*[\s\S]*?\*\//g, "");
  const seenByFamily = new Map();
  for (const s of report.surfaces || []) {
    for (const fam of (s.marks && s.marks.families) || []) {
      const m = /^([^[]+)\[([^\]]*)\]$/.exec(fam);
      if (!m) continue;
      if (!seenByFamily.has(m[1])) seenByFamily.set(m[1], new Set());
      for (const st of m[2].split(",")) if (st) seenByFamily.get(m[1]).add(st);
    }
  }
  {
// Every class the sheet gives a STATE rule to, by the probe's own family rule (a name ending in dot / dotcol /
// mark / led / chip / signal / state), so the two instruments cannot disagree about what a family is.
// THE CLASSES THE RUN PUT ON SCREEN, so a family with no painted states can be told apart from a family the
// probe attributes elsewhere: `mark tab-dot` is measured as `mark`, and reporting it as "no surface rendered
// tab-dot" would be a finding about the probe's naming, not about the page.
const onScreen = new Set();
for (const s2 of report.surfaces || []) for (const c of (s2.marks && s2.marks.present) || []) onScreen.add(c);
// A CLASS NAMED `*-state` IS NOT AUTOMATICALLY A MARK (round 32). The naming rule is deliberately loose, and it
// swept in three classes the sheet styles as a TEXT LINE — `.update-state` (a mono paragraph on the update card),
// `.notify-state` (the notifications card's line) and `.monitor-state` (the word beside the chip). Their
// is-error/is-ok/is-granted variants are INK on words, so the silhouette question does not apply to them and the
// colour-only distinction is fine: the text itself says which state it is. They are measured as TEXT by the
// contrast pass on every run. Declared here with a reason rather than filtered by a heuristic, because a
// heuristic would also hide the day one of them becomes a real mark.
const TEXT_STATE_CLASSES = {
  'update-state': 'a mono paragraph on the update card — its is-error/is-ok are ink on words',
  'notify-state': "the notifications card's line — is-granted/is-denied are ink on words",
  'monitor-state': 'the word beside the reachability mark — the mark next to it carries the shape',
};
const familyRule = /(dot|dotcol|mark|led|chip|signal|state)$/;
for (const m of css.matchAll(/\.([A-Za-z][\w-]*)(\[[^\]]+\]|\.[A-Za-z][\w-]*)/g)) {
  if (!familyRule.test(m[1])) continue;
  if (TEXT_STATE_CLASSES[m[1]]) continue;
  if (!seenByFamily.has(m[1])) seenByFamily.set(m[1], new Set());
}
for (const [family, rendered] of seenByFamily) {
  const declared = new Set();
  const re = new RegExp("\\." + family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\[[^\\]]+\\]|\\.[A-Za-z][\\w-]*)", "g");
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1];
    if (sel.startsWith("[")) declared.add(sel.slice(1, -1).replace(/"/g, ""));
    else declared.add(sel.slice(1));
  }
  if (!rendered.size && onScreen.has(family)) {
    out.push(
      `note: mark family ${family} declares ${declared.size} state(s) and the CLASS IS ON SCREEN — the probe did not record it as a family of its own, either because its marks carry a state attribute (the family is then the FIRST class, which is how mark tab-dot is measured as mark) or because they are larger than the 40px the mark probe measures. Not a missing surface; a naming and sizing question.`,
    );
    continue;
  }
  const missing = [...declared].filter((d) => !rendered.has(d) && !rendered.has(d.replace(/^data-(state|live|kind)=/, "")));
  if (missing.length) {
    out.push(
      `note: mark family ${family} declares ${declared.size} state(s) and this run rendered ${rendered.size} (${[...rendered].sort().join(", ") || "none"}) over ${(report.surfaces || []).length} surface(s) — NO SURFACE RENDERED ${missing.join(", ")}, so those silhouettes and their collisions are unverified`,
    );
  }
}

  }
  return out;
}
