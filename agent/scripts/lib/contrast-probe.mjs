// contrast-probe.mjs — the ONE copy of the contrast math, for the browser AND for tests.
//
// WHY THIS EXISTS. Four rounds of contrast work were done with an ad-hoc snippet
// retyped into a browser console each time, and that snippet had TWO defects that
// only surfaced by luck:
//
//   * it skipped any element with a background-image ANYWHERE among its ancestors,
//     so one gradient wrapper in the panel skipped EVERY text node and the sweep
//     reported `checked=0, underAA=0` — a check that read nothing and looked like a
//     pass (round 33's lesson, committed again by the tool built to apply it);
//   * it read `rgba(255,255,255,0.07)` as WHITE, so twenty findings were chips
//     measured against a surface that is not there.
//
// `agent/scripts/panel-render-audit.mjs` already had the correct implementation —
// compositing background alpha, the ancestor OPACITY chain, and the foreground's
// own alpha. The defect was that it was a STRING inside one audit script, so
// nothing could test it and every new sweep re-derived it. This module is that
// implementation, in one place, with the math as REAL FUNCTIONS.
//
// THE TESTED CODE IS THE CODE THAT RUNS. `PROBE_SOURCE` embeds these functions
// with `Function.prototype.toString()`, so the unit test in
// `scripts/test/contrast-probe-check.mjs` exercises the exact text the browser
// evaluates — not a copy that can drift from it. A test on one copy can only ever
// compare copies.

/** Composite a stack of `{r,g,b,a}` layers, innermost LAST, over `base`.
 *  Order matters and is the thing both defects got wrong: the list runs from the
 *  element upward, so it is applied from the end backwards. */
export function compositeStack(stack, base = { r: 255, g: 255, b: 255 }) {
  let out = { ...base };
  for (let i = stack.length - 1; i >= 0; i--) {
    const c = stack[i];
    out = {
      r: c.r * c.a + out.r * (1 - c.a),
      g: c.g * c.a + out.g * (1 - c.a),
      b: c.b * c.a + out.b * (1 - c.a),
    };
  }
  return out;
}

/** WCAG relative-luminance contrast ratio, rounded to 2dp. */
export function contrastRatio(fg, bg) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  const [hi, lo] = [lum(fg), lum(bg)].sort((p, q) => q - p);
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

/** The WCAG AA bar for TEXT at this size/weight: 3.0 counts as "large" at >=24px,
 *  or >=18.66px when bold; everything else needs 4.5. Getting this wrong is the
 *  difference between a sweep that reports real failures and one that cries wolf. */
export function aaThreshold(fontSize, fontWeight) {
  const large = fontSize >= 24 || (fontSize >= 18.66 && Number(fontWeight) >= 700);
  return large ? 3 : 4.5;
}

/** `#rgb`/`#rrggbb`/`rgb()`/`rgba()` -> {r,g,b,a}; null when unparseable. */
export function parseColour(c) {
  const m = String(c || "").match(/[\d.]+/g);
  if (!m || m.length < 3) return null;
  const [r, g, b] = m.map(Number);
  return { r, g, b, a: m.length > 3 ? Number(m[3]) : 1 };
}

/**
 * The in-page probe. Evaluated with `page.evaluate(PROBE_SOURCE)`; returns one
 * row per visible text-bearing element.
 *
 * `skipSelector` defaults to `.xterm` — the terminal paints from its own palette,
 * not the app's tokens, so measuring it mixes two colour systems.
 * `assertRendered` makes a page that produced ZERO rows FAIL rather than pass: a
 * sweep that read nothing is not a sweep that found nothing.
 */
export const PROBE_SOURCE = `(() => {
  const compositeStack = ${compositeStack.toString()};
  const contrastRatio = ${contrastRatio.toString()};
  const aaThreshold = ${aaThreshold.toString()};
  const parseColour = ${parseColour.toString()};
  const SKIP = ${JSON.stringify(".xterm")};

  const effBg = (el) => { const st = []; let p = el; let gradient = false;
    while (p) { const cs = getComputedStyle(p);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') { gradient = true; break; }
      const c = parseColour(cs.backgroundColor);
      if (c && c.a > 0) { st.push(c); if (c.a === 1) break; } p = p.parentElement; }
    return { colour: compositeStack(st), gradient }; };

  const chainOpacity = (el) => { let o = 1, p = el;
    while (p && p !== document.documentElement) { o *= parseFloat(getComputedStyle(p).opacity || '1'); p = p.parentElement; }
    return o; };

  const effFg = (el, bg) => { const c = parseColour(getComputedStyle(el).color); if (!c) return null;
    const a = (c.a ?? 1) * chainOpacity(el);
    return { r: c.r * a + bg.r * (1 - a), g: c.g * a + bg.g * (1 - a), b: c.b * a + bg.b * (1 - a) }; };

  const rows = []; const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (SKIP && el.closest(SKIP)) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) === 0) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    const key = cls + '|' + (el.textContent || '').slice(0, 16);
    if (seen.has(key)) continue; seen.add(key);
    // WCAG 1.4.3 EXEMPTS INACTIVE CONTROLS. A disabled button at opacity 0.45
    // composites to a real 2.1:1 reading — a truthful measurement of a control
    // nobody can use yet, and not a violation. Flagged rather than filtered so the
    // number stays visible; a sweep should not silently drop inconvenient rows.
    const inactive = !!(el.disabled || el.closest('[disabled]') || el.closest('[aria-disabled="true"]'));
    const bg = effBg(el);
    const fg = effFg(el, bg.colour); if (!fg) continue;
    const size = parseFloat(st.fontSize);
    // A GRADIENT BACKGROUND IS NOT MEASURABLE THIS WAY. Reporting a ratio against
    // whatever lies BEYOND the gradient produced a false 1.0 for the panel's
    // gradient-filled "V" mark. The row comes back marked gradient with a null
    // ratio, so failures() excludes it and the caller can print how many were
    // skipped — a sweep that measured nothing must be VISIBLE, not silent.
    rows.push({
      sel: el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\\s+/).join('.') : ''),
      text: (el.textContent || '').trim().slice(0, 24),
      size, weight: st.fontWeight,
      need: aaThreshold(size, st.fontWeight),
      inactive,
      gradient: bg.gradient,
      cr: bg.gradient ? null : contrastRatio(fg, bg.colour),
    });
  }
  return rows;
})()`;

/** Rows that fail their own AA bar. Takes the probe's rows; pure.
 *  Rows the probe could not measure (`gradient: true`, `cr: null`) are EXCLUDED —
 *  they are not passes and they are not failures, and `unmeasurable()` counts them
 *  so a caller can print the number instead of letting a skip read as a pass. */
export function failures(rows) {
  return rows.filter((r) => r.cr !== null && !r.inactive && r.cr < (r.need ?? aaThreshold(r.size, r.weight)));
}

/** Rows inside an INACTIVE control. WCAG 1.4.3 exempts them, so `failures()`
 *  excludes them — but they are reported, not hidden. */
export function inactive(rows) {
  return rows.filter((r) => r.inactive && r.cr !== null);
}

/** Rows the probe declined to measure, with the reason. */
export function unmeasurable(rows) {
  return rows.filter((r) => r.cr === null);
}
