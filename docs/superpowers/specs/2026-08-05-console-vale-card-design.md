# Vale Card on the Console Overview Page (Design)

Date: 2026-08-05
Status: Approved (user chose "Vale on the overview page")

## Context

The vale command functionality (install / channel switching / provider registration) is complete, but its web entry points are scattered: the model routing panel has a "Vale Command" install section and the secret management panel has a "Vale one-click config" card. The user wants the shallowest entry and a consolidated form — **all Vale content converges into one big card on the overview page** (visible immediately after login, no new navigation).

Web boundary (constraint): the browser cannot read or write the user's local `~/.claude/settings.json` or run vale — the web page only does **info display + command generation**; the actual configuration is done by the user in a local terminal.

## Layout

**Overview page** (three cards, in order: Token → Vale → Route status):

```
┌─ Overview ──────────────────────────────────┐
│  Gateway Token  [Copy][Reveal]              │
│                                             │
│  ┌─ Vale ─────────────────────────────────┐  │
│  │  Default model [▾ qw/qwen3.8-max-preview]│  │  ← dropdown, options from /v1/models
│  │  [⚡ One-click Vale config]             │  │  ← click copies the composite command
│  │  ── Channel health (live) ──            │  │  ← /api/health
│  │  ds/ ✅ qw/ ✅ og/ ⚠️ degraded or/ ✅   │  │
│  │  Recommended: qw/qwen3.8-max-preview    │  │
│  │  ── Command cheat sheet ──              │  │
│  │  vale check · vale use <channel|model>· │  │
│  │  vale use auto · vale models · restore  │  │
│  └─────────────────────────────────────────┘  │
│                                             │
│  Route status (switchboard, kept as-is)     │
└──────────────────────────────────────────────┘
```

**Removed**:
- The "Vale one-click config" card in the secret management panel → moved into the overview Vale card
- The "Vale Command" install section in the model routing panel → moved into the overview Vale card
- The model routing panel keeps: the channel switchboard + client examples

## Components & interactions

### 1. Default model selector
- Options: model ids returned by `GET /v1/models` (with the current user's token as `x-api-key`), grouped by channel prefix
- Defaults to the recommended channel's model (`recommended.model` from `/api/health`)
- On load failure: fall back to a built-in list (ds/qw/og/or default models)

### 2. "One-click Vale config" button
- Clicking generates a **composite command** and copies it to the clipboard (button shows "Copied ✅"):
  ```
  curl -fsSL <base>/api/vale-install | sh && vale provider add vale-gw \
    --base <base> --token <me.token> --model <chosen model>
  ```
  - `<base>`: `https://<apiHost>` (falls back to `https://api.saisi.online` when apiHost is empty)
  - `<me.token>`: the current user's gateway token (`/api/me`)
  - Composite command = install + register in one step (one-shot when vale is not installed; the install command is idempotent and harmless when already installed)
- Hint next to the button: "Paste into a terminal and press Enter: install + register in one go; afterwards switch with `vale use <channel>`"

### 3. Channel health
- Data: `GET /api/health` (public, no auth)
- Rendering: one row of channel statuses (`ds/ ✅` / `og/ ⚠️ degraded`) + the recommended model
- Auto-refresh every 30s (same pattern as the overview switchboard)

### 4. Command cheat sheet
- Static text (i18n) listing the 5 common commands

## Data flow

```
Overview page load (loadOverview)
  ├─ /api/me          → me.token (used by the button)
  ├─ /api/admin/public→ apiHost (the button's base)
  ├─ /api/health      → channel status + recommendation (card rendering + 30s polling)
  └─ /v1/models       → model selector options
```

## Implementation files

- `gateway/public/index.html`: add the Vale card to the overview page (before the route status card)
- `gateway/public/app.js`: i18n (zh/en) + render functions (model selector population, composite command generation, copy, channel health row, 30s polling) + init bindings
- Remove: the secret management panel Vale card (HTML+JS), the model routing panel install section (HTML+JS)

## Verification

1. `node --check public/app.js` passes
2. Browser check after deploy: three-card order on the overview page, the Vale card model dropdown, copied button content contains the real token and chosen model, channel health refreshes every 30s, no leftover vale blocks in secret management / model routing
3. Paste the copied composite command into a terminal → install + register succeeds → `vale check` works