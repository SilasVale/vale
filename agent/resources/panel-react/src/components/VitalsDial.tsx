// VitalsDial — the panel's radial instrument.
//
// WHY A DIAL AND NOT TWO MORE NUMBERS. CPU and memory are proportions of a whole,
// and a proportion's honest form is an arc: it is read at a glance, in the same eye
// movement, without parsing digits. The digits are still printed beside it, because
// the arc is a SUMMARY and a summary must never be the only channel — the same rule
// the state palette in tokens.css follows, where colour alone was measured to be
// insufficient and every state gained its own silhouette.
//
// IT NEVER INVENTS A VALUE. `cpu`/`mem` are null until the agent has two samples to
// subtract (see useAgentVitals), and null renders the empty track with a dash in the
// readout. An instrument that says 0% when it means "unknown" is worse than one that
// says nothing.
//
// Sizing: the SVG is 40×40 viewBox with two concentric arcs, drawn to be legible
// down to about 18px. Everything scales from `size`; there is no raster step.
import type { AgentVitals } from "../hooks/useAgentVitals";

const R_OUTER = 16;
const R_INNER = 11.5;
const STROKE = 3.2;
const C_OUTER = 2 * Math.PI * R_OUTER;
const C_INNER = 2 * Math.PI * R_INNER;

/** Severity band for one reading. Used for the arc's colour ONLY — the number is
 *  what carries the value, so a reader who cannot separate the hues loses nothing. */
function band(pct: number): "ok" | "warn" | "crit" {
  if (pct >= 90) return "crit";
  if (pct >= 75) return "warn";
  return "ok";
}

function Arc({
  r,
  circumference,
  pct,
  tone,
}: {
  r: number;
  circumference: number;
  pct: number | null;
  tone: string;
}) {
  const filled = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <>
      <circle className="dial-track" cx="20" cy="20" r={r} strokeWidth={STROKE} fill="none" />
      {/* Rendered whenever a reading EXISTS, even at zero: `0%` and `unknown` must be
          distinguishable in the DOM, and drawing no element for a known zero makes
          them identical. At 0 the dashoffset is the whole circumference, so it paints
          nothing — the difference lives in the markup, not on the screen. */}
      {pct !== null && (
        <circle
          className="dial-arc"
          data-tone={tone}
          cx="20"
          cy="20"
          r={r}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - filled / 100)}
          transform="rotate(-90 20 20)"
        />
      )}
    </>
  );
}

export function VitalsDial({
  cpu,
  mem,
  size = 22,
}: Pick<AgentVitals, "cpu" | "mem"> & { size?: number }) {
  const readout = (v: number | null) => (v === null ? "unknown" : `${Math.round(v)}%`);
  return (
    <span
      className="vitals-dial"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`CPU ${readout(cpu)}, memory ${readout(mem)}`}
      title={`CPU ${readout(cpu)} · MEM ${readout(mem)}`}
    >
      <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
        {/* Outer arc = CPU, inner arc = memory. The order is fixed and the arcs are
            never re-purposed, so the shape itself is the legend. */}
        <Arc r={R_OUTER} circumference={C_OUTER} pct={cpu} tone={cpu === null ? "ok" : band(cpu)} />
        <Arc r={R_INNER} circumference={C_INNER} pct={mem} tone={mem === null ? "ok" : band(mem)} />
      </svg>
    </span>
  );
}
