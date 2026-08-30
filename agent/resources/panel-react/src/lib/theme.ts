// Theme (light default, dark optional) — persisted in localStorage, applied
// via body[data-theme] so the CSS custom properties flip in one place
// (tokens.css carries both sets). Light is the DEFAULT: the user prefers it.
export type Theme = "light" | "dark";

const KEY = "vale-theme";
const EVENT = "vale-theme-change";

export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch { /* ignore */ }
  return "light";
}

export function applyTheme(theme: Theme) {
  document.body.dataset.theme = theme;
}

export function setTheme(theme: Theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* ignore */ }
  applyTheme(theme);
  window.dispatchEvent(new Event(EVENT));
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

/** Subscribe to live theme flips (TerminalPane re-themes xterm on this). */
export function onThemeChange(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

// Apply immediately at module load — before React renders anything.
applyTheme(getTheme());
