# Workflow: Web UI — Admin Panel with React + Vite

**Trigger:** Manual (after workflow 02 is complete)
**Checkpoint:** Yes — after shell layout is working, after each major view is built, before final deploy.
**Push right:** Yes — build the full UI, then present summary.

## Objective

Build a production-grade admin panel for Vale Gate using React + Vite. The UI replaces the current inline HTML source viewer and adds device management, plugin management, and config editing views.

## Reference

DSH's web UI (`@deepseek-ai/dsh-web-app`) uses:
- React with a client-plugin architecture
- Vite for build tooling with HMR
- A shell that injects `window.__DSH_BOOT__` for runtime config
- Client plugins that register views, routes, and actions

We'll adopt a simpler version: React + Vite with a router, no client-plugin architecture (overkill for vale's current scale).

## Scope

- **Device management** — list/configure Vale agents, view status, push config, see logs.
- **Plugin management** — list installed plugins, enable/disable, view plugin state.
- **Config editor** — edit gateway config (YAML/JSON), preview changes, apply.
- **Source viewer** — the existing `public/code/` viewer, rebuilt as a React component.
- **Layout** — sidebar navigation, top bar with status, responsive.

## Steps

### Step 1: Scaffold the Vite project

1. In `gateway/`, create the UI project:
   ```bash
   cd gateway
   npm create vite@latest ui -- --template react-ts
   cd ui
   npm install
   ```

2. Configure `gateway/ui/vite.config.ts`:
   ```typescript
   import { defineConfig } from "vite";
   import react from "@vitejs/plugin-react";

   export default defineConfig({
     plugins: [react()],
     root: ".",
     build: {
       outDir: "../public/admin",  // Build output goes to gateway's public/
       emptyOutDir: true,
     },
     server: {
       proxy: {
         "/api": "http://localhost:8787",  // Proxy API calls to wrangler
       },
     },
   });
   ```

3. Add to `gateway/package.json`:
   ```json
   {
     "scripts": {
       "ui:dev": "cd ui && npm run dev",
       "ui:build": "cd ui && npm run build",
       "ui:preview": "cd ui && npm run preview"
     }
   }
   ```

4. Add `gateway/ui/` to `.gitignore` (except `src/` and `package.json`).

### Step 2: Set up routing and layout

1. Install React Router:
   ```bash
   cd gateway/ui && npm install react-router-dom
   ```

2. Create the shell layout:

   ```
   gateway/ui/src/
   ├── App.tsx              # Router setup
   ├── main.tsx             # Entry point
   ├── components/
   │   ├── Layout.tsx       # Shell: sidebar + topbar + outlet
   │   ├── Sidebar.tsx      # Navigation sidebar
   │   └── TopBar.tsx       # Status bar, user info
   ├── views/
   │   ├── Dashboard.tsx    # Overview / landing page
   │   ├── Devices.tsx      # Device management
   │   ├── Plugins.tsx      # Plugin management
   │   ├── Config.tsx       # Config editor
   │   └── SourceViewer.tsx # Source code browser (ported from current HTML)
   ├── api/
   │   └── client.ts        # API client (fetch wrapper)
   └── styles/
       └── globals.css      # Global styles, CSS variables
   ```

3. `Layout.tsx` — the shell:
   - Left sidebar (240px) with navigation links.
   - Top bar (52px) with title, status indicator, user dropdown.
   - Main content area with `<Outlet />`.
   - Responsive: sidebar collapses on mobile.

4. `Sidebar.tsx` — navigation:
   - Dashboard (home icon)
   - Devices (server icon)
   - Plugins (puzzle icon)
   - Config (gear icon)
   - Source (code icon)
   - Active state highlighting.
   - Collapse/expand toggle.

### Step 3: Build the API client

Create `gateway/ui/src/api/client.ts`:

```typescript
const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || res.statusText);
  }
  return res.json();
}

export const api = {
  // Devices
  getDevices: () => request<Device[]>("/devices"),
  getDevice: (id: string) => request<Device>(`/devices/${id}`),
  updateDevice: (id: string, config: Partial<Device>) =>
    request<Device>(`/devices/${id}`, { method: "PATCH", body: JSON.stringify(config) }),
  
  // Plugins
  getPlugins: () => request<PluginInfo[]>("/plugins"),
  togglePlugin: (name: string, enabled: boolean) =>
    request<void>(`/plugins/${name}/toggle`, { method: "POST", body: JSON.stringify({ enabled }) }),
  
  // Config
  getConfig: () => request<GatewayConfig>("/config"),
  updateConfig: (config: Partial<GatewayConfig>) =>
    request<void>("/config", { method: "PATCH", body: JSON.stringify(config) }),
  
  // Source
  getSourceManifest: () => request<SourceManifest>("/code/manifest.json"),
  getSourceFile: (path: string) => fetch(`/code/${path}`).then(r => r.text()),
};

// Types
interface Device { id: string; name: string; status: "online" | "offline"; lastSeen: string; config: Record<string, unknown>; }
interface PluginInfo { name: string; enabled: boolean; state: string; deps: string[]; }
interface GatewayConfig { plugins: Record<string, unknown>; auth: Record<string, unknown>; channels: Record<string, unknown>; }
interface SourceManifest { files: Array<{ name: string; path: string; group: string }>; }
```

### Step 4: Build each view

#### Dashboard (`Dashboard.tsx`)
- Summary cards: total devices, online devices, active plugins, last config change.
- Recent activity log (last 10 events).
- Quick actions: "Add Device", "Reload Plugins".

#### Devices (`Devices.tsx`)
- Table: name, status (green/red dot), last seen, actions (edit, logs, remove).
- Click row → detail panel (slide-in or modal).
- Detail panel: config editor (JSON), log viewer (tail -f style), status history.
- Bulk actions: select multiple → push config, remove.

#### Plugins (`Plugins.tsx`)
- Table: name, state (setup/ready/disposed/error), deps, enabled toggle.
- Click row → detail panel: full plugin info, setup log, config.
- Toggle switch to enable/disable (calls API, triggers hot reload).

#### Config (`Config.tsx`)
- Split view: JSON editor on left, preview diff on right.
- "Apply" button → sends PATCH to API, shows success/error toast.
- "Reset" button → reverts to last saved config.
- Use a simple `<textarea>` with monospace font for now (no Monaco editor — keep it light).

#### Source Viewer (`SourceViewer.tsx`)
- Port the existing `public/code/index.html` logic to React.
- Sidebar with file tree (grouped by `manifest.json`).
- Main area with syntax-highlighted code (use `highlight.js` or `shiki` for highlighting).
- Language toggle (zh/en) in the top bar.

### Step 5: Styling

Use CSS variables matching the existing `index.html` design system:

```css
:root {
  --bg: #f5f5f7;
  --surface: #fff;
  --surface-glass: rgba(255,255,255,.72);
  --ink: #1d1d1f;
  --muted: #6e6e73;
  --line: rgba(0,0,0,0.08);
  --accent: #0b7a6e;
  --accent-soft: #e7f5f2;
  --danger: #dc2626;
  --radius: 14px;
  --font-body: -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
  --font-mono: "SF Mono", ui-monospace, "JetBrains Mono", monospace;
}
```

- Glassmorphism top bar (backdrop-filter blur).
- Subtle shadows on cards.
- Smooth transitions on hover/click.
- Responsive breakpoints: 768px (tablet), 480px (mobile).

### Step 6: Build and integrate

1. Build the UI: `cd gateway/ui && npm run build`.
2. Output goes to `gateway/public/admin/`.
3. Add a gateway plugin that serves the admin UI:

```typescript
// gateway/src/plugins/built-in/admin-ui.ts
import type { Plugin } from "../types.ts";

export const adminUiPlugin: Plugin = {
  name: "admin-ui",
  deps: [],
  setup(ctx) {
    // Serve static files from public/admin/
    // Route: GET /admin/* → serve static file
    // Route: GET /admin → redirect to /admin/
    // SPA fallback: any unmatched /admin/* → serve index.html
  },
};
```

4. The admin panel is accessible at `https://vale-gate.example.com/admin/`.

### Step 7: Dev experience

1. In development, run `wrangler dev` for the API + `npm run ui:dev` for the Vite dev server.
2. Vite proxies `/api/*` to wrangler.
3. HMR works for React components.
4. No build step needed during development.

## Commit strategy

- `feat(gateway): scaffold React + Vite admin UI`
- `feat(gateway): add routing and shell layout`
- `feat(gateway): implement API client`
- `feat(gateway): build dashboard view`
- `feat(gateway): build device management view`
- `feat(gateway): build plugin management view`
- `feat(gateway): build config editor view`
- `feat(gateway): port source viewer to React`
- `feat(gateway): add admin UI serving plugin`
- `style(gateway): apply consistent design system to admin UI`

## Done criteria

- Admin panel is accessible at `/admin/`.
- All four views (Dashboard, Devices, Plugins, Config) work with real API calls.
- Source viewer is ported and functional.
- UI is responsive (works on tablet and mobile).
- Build output is under 200KB gzipped (no heavy dependencies).
- TypeScript strict mode passes.
- ESLint + Prettier pass.
