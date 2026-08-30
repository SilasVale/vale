// ui/Icon.tsx — the ONE icon set for the whole app. Every icon is a 24px
// stroke glyph (same family as the gateway console sidebar); BrandMark is
// the Vale "sunrise" gradient mark (matches scripts/render-brand-icon.py).
// No inline SVGs anywhere else — import from here.
import type { ReactNode } from "react";

export type IconName =
  | "terminal"
  | "browser"
  | "memory"
  | "plugins"
  | "settings"
  | "sessions"
  | "plus"
  | "close"
  | "export"
  | "chevron"
  | "edit"
  | "fullscreen"
  | "search"
  | "arrow-up"
  | "arrow-down"
  | "sun"
  | "moon";

const PATHS: Record<IconName, ReactNode> = {
  sun: (
    <>
      <circle cx="12" cy="12" r="4.5" />
      <line x1="12" y1="1.5" x2="12" y2="3.5" />
      <line x1="12" y1="20.5" x2="12" y2="22.5" />
      <line x1="4.6" y1="4.6" x2="6" y2="6" />
      <line x1="18" y1="18" x2="19.4" y2="19.4" />
      <line x1="1.5" y1="12" x2="3.5" y2="12" />
      <line x1="20.5" y1="12" x2="22.5" y2="12" />
      <line x1="4.6" y1="19.4" x2="6" y2="18" />
      <line x1="18" y1="6" x2="19.4" y2="4.6" />
    </>
  ),
  moon: (
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  ),
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>
  ),
  browser: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </>
  ),
  memory: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </>
  ),
  plugins: (
    <>
      <path d="M5 3h2v2h6V3h2v2h1.5A2.5 2.5 0 0 1 19 7.5v8A2.5 2.5 0 0 1 16.5 18h-13A2.5 2.5 0 0 1 1 15.5v-8A2.5 2.5 0 0 1 3.5 5H5V3Z" />
      <path d="M5 7h10.5a.5.5 0 0 0 .5-.5V8H4v-1.5a.5.5 0 0 0-.5-.5H5Z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  sessions: (
    <>
      <path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h9A2.5 2.5 0 0 1 17 5.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 14.5v-9Zm2.5-1a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-9a1.5 1.5 0 0 0-1.5-1.5h-9Z" />
      <rect x="6" y="6" width="8" height="8" rx="1.5" />
    </>
  ),
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  close: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  export: (
    <>
      <path d="M12 3v12" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 21h14" />
    </>
  ),
  chevron: (
    <>
      <polyline points="9 6 15 12 9 18" />
    </>
  ),
  edit: (
    <>
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </>
  ),
  fullscreen: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </>
  ),
  "arrow-up": (
    <>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </>
  ),
  "arrow-down": (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </>
  ),
};

/** Stroke icon. `size` in px (default 18), color via currentColor. */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The Vale "sunrise" brand mark — the SAME gradient used by the installer
 *  icon (scripts/render-brand-icon.py) and the favicon. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <linearGradient id="vale-brand-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f59f00" />
          <stop offset="1" stopColor="#e8590c" />
        </linearGradient>
        <radialGradient id="vale-brand-glow" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#fff8e1" stopOpacity=".55" />
          <stop offset="1" stopColor="#ffe8a3" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="48" height="48" rx="11" fill="url(#vale-brand-sky)" />
      <circle cx="21" cy="14" r="7.5" fill="url(#vale-brand-glow)" />
      <circle cx="21" cy="14" r="4" fill="#fff8e1" />
      <path fill="#ffffff" opacity=".78" d="M14 41Q26 16 44 41Z" />
      <path fill="#ffffff" d="M2 41Q12 20 24 41Z" />
    </svg>
  );
}
