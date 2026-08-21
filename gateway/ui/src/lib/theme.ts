/**
 * Theme (dark mode) — persisted in localStorage, applied via
 * body[data-theme="dark"] so the CSS custom properties flip in one place.
 * Applied before React mounts (see main.tsx) to avoid a light flash.
 */

export type Theme = "light" | "dark";

const KEY = "valegate-theme";

export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* ignore */
  }
  return "light";
}

export function applyTheme(theme: Theme) {
  document.body.dataset.theme = theme;
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

// Apply immediately at module load (main.tsx imports this first).
applyTheme(getTheme());
