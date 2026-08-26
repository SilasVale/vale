# Vale Site-wide Unification — Apple Light Style

Date: 2026-08-11
Status: Confirmed (user specified the Apple style + light theme)

## Background

The 6 pages of the Vale family each have their own style language; the brand color isn't unified:
- **Gateway console** (gateway/public): warm-white background + teal green (currently #0b7a6e, after the AA revision) + Space Grotesk — the most complete set
- **vale-agent panel** (agent/resources/panel): light blue #5b6cf0, no frosted glass
- **index download site** (embedded in index/src/index.js): blue-purple gradient #5b6cf0→#8a6ff0
- **extension popup / options / terminal** (extension/): gray-blue, crude
- **code viewer** (gateway/public/code/): same source as the console, but as a standalone file

User requirement: **unify all pages to the Apple light style**, including the vale-agent application (tray icon, panel, installer).

## Design tokens (unified baseline)

```css
:root {
  /* Apple light */
  --bg: #f5f5f7;            /* Apple system gray background */
  --surface: #ffffff;       /* card / frosted-glass surface */
  --surface-glass: rgba(255,255,255,0.72);  /* frosted glass */
  --ink: #1d1d1f;           /* Apple ink black */
  --muted: #6e6e73;         /* secondary text */
  --faint: #6e6e73;         /* AA revision (2026-08-12): #86868b → #6e6e73, text on white 3.62→5.07:1 */
  --line: rgba(0,0,0,0.08); /* fine divider line */
  --line-strong: rgba(0,0,0,0.14);

  --accent: #0b7a6e;        /* AA revision (2026-08-12): #0e9384 → #0b7a6e, white text 3.80→5.22:1; the brand teal is kept as the old-value comment on --accent-ink */
  --accent-ink: #0b7a6e;
  --accent-soft: #e7f5f2;
  --danger: #dc2626;

  /* Apple radii + shadows */
  --radius: 14px;
  --radius-sm: 10px;
  --radius-lg: 20px;
  --shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-lg: 0 12px 32px rgba(0,0,0,0.12);

  /* Apple font stack (system SF, falling back to PingFang) */
  --font: -apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB",
          "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
  --font-display: -apple-system, "SF Pro Display", "PingFang SC", sans-serif;
  --font-mono: "SF Mono", ui-monospace, "JetBrains Mono", Consolas, monospace;
}
```

Generic frosted-glass card:

```css
.glass {
  background: var(--surface-glass);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
```

Brand mark: ink-black rounded square + white V, 10px radius, optional frosted-glass background.

## Change list

### 1. agent/resources/panel/ (vale-agent panel, embedded via include_str in web.rs)
- `index.html` / `panel.css` / `panel.js`:
  - Swap the CSS to the unified tokens; frosted-glass toolbar; keep xterm's white background with ink text
  - **Layout fix**: add `window resize` + `visibilitychange` listeners, and a single `refitAll()` that calls `fit.fit()` on all sessions
  - favicon: inline SVG brand mark (web.rs needs one extra serve line)
- Build: `cargo xwin check` + recompile for release

### 2. extension/ (popup / options / terminal)
- Swap the three pages' HTML/CSS to the unified tokens + frosted glass
- Icons: replace icons/ with the unified brand mark (16/48/128)
- Re-zip the package → index/public/vale-agent/vale-browser-control.zip

### 3. index/src/index.js (download site)
- Swap the embedded PAGE CSS to the unified tokens; "Vale Command" copy → "Vale Agent"
- favicon: inline SVG
- Deploy the index worker

### 4. gateway/public/ (console)
- Keep the light baseline but pull it toward the Apple style: frosted-glass sidebar, shadow/radius fine-tuning
- favicon + brand SVG
- Sync the mirrored code/files/vale-gate/

### 5. code viewer (gateway/public/code/)
- Same style as the console, following the unified tokens

### 6. The vale-agent application itself
- Tray icon (tray-icon.png 32x32): replace with the unified brand mark
- Installer (vale-agent-install.nsi) icon + panel title/favicon
- Recompile vale-agent + vale-tray

### 7. Directory rename (while at it)
- `command/` → `agent/` (git mv already done)
- Path updates in build.sh / build-installer.sh / README / CLAUDE.md / index.js comments / DEVICE-INTEGRATION.md

## Verification

- `./scripts/build.sh` all green (cargo xwin check + build)
- Screenshot comparison for each page (light + frosted glass + rounded corners)
- The extension zip is re-packed; the console download link works
- Deploy gateway/index; check live