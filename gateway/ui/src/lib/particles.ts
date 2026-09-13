/**
 * The particle field: slow-drifting iridescent motes behind every surface.
 *
 * DECORATIVE ONLY, and that is a hard rule here rather than a style preference — the
 * project's token layer already states it ("no text colour is ever taken from it, so no
 * contrast measurement moves"). So this layer is:
 *   * a FIXED canvas at z-index 0, below `#root` at z-index 1, with `pointer-events: none`,
 *     so it can never intercept a click or enter the layout;
 *   * drawn at low alpha from the `--aura-*` palette, so the worst case is a slight tint
 *     behind existing surfaces rather than a new contrast pair to measure.
 *
 * IT RESPECTS `prefers-reduced-motion` BY NOT RUNNING AT ALL. A decorative animation that
 * ignores that setting is an accessibility defect, and the honest fallback is the static
 * wash the page already has — not a slower animation.
 *
 * COST IS BOUNDED BY AREA, not by a constant: a 4K window gets more motes than a laptop,
 * but the count is capped so a full-screen browser cannot spend the frame budget on
 * decoration. The loop also stops when the tab is hidden.
 */

interface Mote {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  hue: number;
  phase: number;
}

/** Motes per 100k px² of viewport, and a ceiling regardless of size. */
const DENSITY = 0.55;
const MAX_MOTES = 90;
/** Comfortably below any text; the field reads as a tint, not as content. */
const MAX_ALPHA = 0.5;

export function startParticleField(): () => void {
  if (typeof window === "undefined") return () => {};
  // The honest fallback: no animation, and the static wash stays visible.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return () => {};

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.dataset.valeParticles = "1";
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    zIndex: "0",
    pointerEvents: "none",
    display: "block",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return () => {};
  }

  let motes: Mote[] = [];
  let raf = 0;
  let dpr = 1;

  const readPalette = (): number[] => {
    // The hues come from the SAME tokens the wash uses, so the field cannot drift from the
    // palette — and a theme switch is picked up on the next resize by re-reading them.
    const cs = getComputedStyle(document.body);
    const pick = (name: string, fallback: number): number => {
      const raw = cs.getPropertyValue(name).trim();
      const m = raw.match(/^#([0-9a-f]{6})$/i);
      if (!m) return fallback;
      const n = parseInt(m[1], 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return fallback;
      let h = 0;
      if (max === r) h = ((g - b) / (max - min)) * 60;
      else if (max === g) h = (2 + (b - r) / (max - min)) * 60;
      else h = (4 + (r - g) / (max - min)) * 60;
      return (h + 360) % 360;
    };
    return [
      pick("--aura-1", 190),
      pick("--aura-3", 280),
      pick("--aura-4", 330),
    ];
  };

  let hues = readPalette();

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hues = readPalette();

    const want = Math.min(MAX_MOTES, Math.round(((w * h) / 100_000) * DENSITY * 10));
    while (motes.length > want) motes.pop();
    while (motes.length < want) {
      motes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.6 + Math.random() * 1.9,
        vx: (Math.random() - 0.5) * 0.16,
        vy: -0.05 - Math.random() * 0.18,
        hue: hues[Math.floor(Math.random() * hues.length)],
        phase: Math.random() * Math.PI * 2,
      });
    }
  };

  let last = 0;
  const frame = (t: number) => {
    raf = requestAnimationFrame(frame);
    // ~30fps is plenty for a drift this slow and halves the cost.
    if (t - last < 33) return;
    last = t;
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    for (const m of motes) {
      m.x += m.vx;
      m.y += m.vy;
      m.phase += 0.012;
      // Wrap rather than respawn, so the field never visibly pops.
      if (m.y < -8) m.y = h + 8;
      if (m.y > h + 8) m.y = -8;
      if (m.x < -8) m.x = w + 8;
      if (m.x > w + 8) m.x = -8;
      const twinkle = 0.55 + 0.45 * Math.sin(m.phase);
      ctx.beginPath();
      ctx.fillStyle = `hsla(${m.hue} 90% 62% / ${(MAX_ALPHA * twinkle * 0.35).toFixed(3)})`;
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf) {
      raf = requestAnimationFrame(frame);
    }
  };

  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibility);
    canvas.remove();
  };
}
