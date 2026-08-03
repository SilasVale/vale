// Vale Command UI — monochrome stroke icon set (16px grid, currentColor).
// One visual language across event feed, toolbars, and tabs — replaces the
// old emoji + text-glyph mix that had inconsistent weight and color.

const S = (path) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

export const svgIcons = {
  forward: S('<path d="m6 3 5 5-5 5"/>'),
  plus:    S('<path d="M8 3v10M3 8h10"/>'),
  close:   S('<path d="m4 4 8 8M12 4l-8 8"/>'),
  globe:   S('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11"/>'),
  terminal: S('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><path d="m4.5 6 2.2 2-2.2 2M8 10.2h3"/>'),
  ssh:     S('<rect x="4.5" y="7" width="7" height="5.5" rx="1.2"/><path d="M6.2 7V5a1.8 1.8 0 0 1 3.6 0v2"/>'),
  serial:  S('<path d="M5.5 1.8v3.4M10.5 1.8v3.4"/><path d="M3.5 5.2h9v3a4.5 4.5 0 0 1-4.5 4.5h0A4.5 4.5 0 0 1 3.5 8.2v-3Z"/><path d="M8 12.7v1.5"/>'),
  shell:   S('<path d="m3 4.5 3.2 3.5L3 11.5"/><path d="M8 11.5h5"/>'),
};
