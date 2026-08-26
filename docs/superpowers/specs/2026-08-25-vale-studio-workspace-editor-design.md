# Vale Studio — The saisi.online Workspace Code Editor with DSH Deep-Link Integration · Design

Date: 2026-08-25
Status: Design finalized (pending implementation)
Related: `gateway/public/code/` (old snapshot Source Viewer), `extension/` (browser extension), `~/.cloudflared/` (tunnel)

---

## 1. Goals and hard constraints

**Goal**: deliver a VS Code-grade code browsing/editing experience on saisi.online, operating on **the real workspace files DSH is working on** (live, editable, tracking disk changes), and let file paths in DSH chats jump in one click to the corresponding file + line on saisi.online.

**Hard constraints** (derived from the requirements, non-negotiable):

| # | Constraint | Implication |
|---|------|------|
| C1 | Files are real, live files, not snapshots | a file-serving backend must run on the same machine as DSH; a Cloudflare Worker cannot read the local disk directly |
| C2 | Editable like VS Code, saving back to disk | the backend must support atomic writes; the editor must have dirty-state management |
| C3 | paths in DSH → jump to a location in the editor | a stable deep-link URL protocol + a link-rewriting mechanism on the DSH page side are needed |
| C4 | Don't break existing deployments (dsh.saisi.online tunnel, ai.saisi.online Worker are all in production) | new components must be incremental; no patching of DSH itself (upgrades would wipe it) |
| C5 | Reachable from the public internet but with a security boundary | token auth + whitelisted path roots; by default listens only on 127.0.0.1, reachable only via the tunnel |
| C6 | Built-in integrated terminal like VS Code (real machine shell) | server-side PTY (node-pty) + WebSocket stream + xterm.js on the frontend; sessions survive page refresh/reconnect |

**Non-goals**: full LSP/debugger support (that's code-server's domain); multi-user collaboration. The integrated terminal is in scope (C6).

---

## 2. Overall architecture

Add a new subproject `studio/` (service name **vale-studio**): one process that both serves the static frontend and the file API, exposed as `code.saisi.online` through the existing cloudflared tunnel. The frontend is a lightweight workbench built on Monaco Editor (the same engine as VS Code).

```
┌────────────────────┐   ① click a file link (new tab)  ┌───────────────────────────────┐
│ dsh.saisi.online    │ ─────────────────────────────▶ │ code.saisi.online              │
│ (DSH Web UI)        │  #/open?p=…&l=596&c=12         │ Vale Studio frontend (Monaco)  │
└─────────┬──────────┘                                 │ + bottom terminal panel       │
          │ ② content-script rewrites                  │   (xterm.js)                  │
          │    the real paths in messages/             │ + same-origin REST/WS API     │
          │    tool calls into deep links              └──────────────┬────────────────┘
          ▼                                                           ▼ ③ same-origin fetch/WS
┌────────────────────────────┐            ┌─────────────────────────────────────┐
│ DSH session stream         │            │ vale-studio server (:7780, 127.0.0.1)│
│  · str_replace_editor calls│            │  · GET /api/roots    allowed roots   │
│  · read/glob/grep results  │            │  · GET /api/tree     lazy file tree  │
│  · absolute/relative paths │            │  · GET /api/file     read(+mtime/sha)│
│    in message text         │            │  · PUT /api/file     atomic write    │
└────────────────────────────┘            │  · WS   /api/watch   change push     │
                                          │  · WS   /api/term    PTY terminal IO │
        cloudflared (same tunnel,         │  · GET /api/git/*    status/log/diff │
        one more ingress)                 │  · whitelist roots + token +         │
        code.saisi.online ──▶ :7780       │    read-only switch                  │
                                          └─────────────────────────────────────┘
```

**Why this layering**:

- **Same origin (both frontend and API served by vale-studio)** → no CORS, no cache splits, one deployment.
- **Doesn't occupy the ai.saisi.online Worker** → the Worker is always online at the edge, but the files are local; when the machine is down, a Worker version would only show an error page — misleading. The old `/code/` snapshot page stays, with an "Open live editor" banner added at the top.
- **No DSH patching** → DSH upgrades are unaffected; links go through the browser extension's content-script (C4).

---

## 3. Component specs

### 3.1 vale-studio server (`studio/server.mjs`, Node 22 ESM)

**Minimal dependencies**: `chokidar` (file watching, more reliable than `fs.watch` recursive on Linux), `ws` (WebSocket), `node-pty` (real PTY, the native module the terminal needs; the local machine has a full gcc toolchain to build it). Everything else is zero-dependency (http, crypto, child_process from the built-ins). ripgrep is used if present, otherwise it degrades to a JS line-by-line search.

#### Configuration `~/.vale-studio/config.json`

```jsonc
{
  "port": 7780,
  "bind": "127.0.0.1",            // always listens on loopback; the only public entry is the tunnel
  "token": "<openssl rand -hex 32>",
  "readOnly": false,
  "terminal": { "enabled": true, "shell": "/bin/bash", "tmuxWrap": false },
  "maxFileSizeMB": 8,
  "roots": [                       // whitelisted workspace roots; absolute paths, no symlink escapes
    "/home/zhengsaisi/vale",
    "/home/zhengsaisi/bdk_bcm_5.04l.04p2"
  ]
}
```

Workspace awareness (key to C1): `GET /api/roots` returns the whitelist above, each entry with `{ exists, gitBranch, dirtyCount }`. **Enhancement (Phase 4)**: scan `~/.dsh/sessions` metadata for the cwd of active sessions and show them automatically in an "active workspaces" group (cwds outside the whitelist are shown read-only; clicking "add to whitelist" unlocks writing).

#### API contract (all require `Authorization: Bearer <token>` or a one-time `?token=` bootstrap)

| Method/route | Semantics | Key details |
|-----------|------|----------|
| `GET /api/roots` | list the allowed roots | with git branch/dirty count |
| `GET /api/tree?root=&dir=` | lazy directory load | returns `{name,type,size,mtime}[]`; hidden files collapsed by default |
| `GET /api/file?p=<abs>` | read a single file | returns `{content,mtimeMs,sha256,truncated}`; binary detection (NUL bytes) → marks `binary`, image types get a dataUrl |
| `PUT /api/file` | write | body has `p, content, baseSha256`; **optimistic lock**: returns `409 conflict` when baseSha ≠ the current sha (the disk was changed by DSH/someone else); write = temp file in the same directory + atomic `rename()` replacement; returns the new sha on success |
| `POST /api/mkdir` `DELETE /api/file` | create/delete | deletions go to `.vale-studio-trash/` (within the root), no real deletes |
| `WS /api/watch` | change push | clients subscribe to a root; chokidar events are debounced 200ms and pushed as `{path,event}`; the frontend uses this to show a "disk changed → reload?" banner (matching VS Code behavior) |
| `GET /api/search?q=&root=` | full-text search | ripgrep `--json -S`; results capped at 500; regex toggle |
| `GET /api/git/status\|log\|diff?p=` | git integration | calls git via `child_process`, cwd = the repo root containing the file |
| `POST /api/term` | create a terminal | body `{cwd?, cols, rows}`; returns `{id}`; default cwd = the selected root |
| `GET /api/terms` | list live terminals | all pty sessions held by the server (survive page refreshes) |
| `DELETE /api/term/:id` | end a terminal | SIGHUP → kill |
| `WS /api/term/:id` | terminal IO stream | binary frames = stdin/stdout pass-through; text control frames `{"resize":{cols,rows}}` |

**Terminal subsystem (C6, aligned with the VS Code integrated terminal)**:

- **Server**: node-pty spawns a login shell (`$SHELL -l`), env injects `TERM=xterm-256color`, `COLORTERM=truecolor`, `VSTUDIO_ROOT=<current root>`; each terminal gets its own session id.
- **Persistence**: the pty is held by the server, not the page — after a page refresh/network hiccup, the WS reconnect returns to the original session (the output buffer replays the last 2000 lines); optional enhancement: wrap spawn in `tmux new -A -s studio-<id>` so even a server restart can be recovered (Phase 4 toggle).
- **Multi-tab**: tab bar in the bottom panel (`bash`, `bash (vale)`… named by cwd), with new/switch/close; the explorer context menu "open terminal here" uses the file's directory as cwd.
- **Frontend**: xterm.js + the fit addon (the repo already has matching assets in `extension/terminal/vendor/`, same tech stack); `Ctrl+`` summons/dismisses the panel; link detection opens new tabs on click.
- **Fallback path**: if node-pty fails to build, fall back to `script -qfc bash /dev/null` (util-linux's built-in pty wrapper), functionally equivalent to 95% (no perfect window-size awareness, but resize messages + `stty` compensate).

**Security model (C5, item by item)**:

1. After `realpath()`, force a prefix match against a root; reject `..` and symlink escapes;
2. Wrong tokens uniformly return 404 (no 401/403 distinction leaked) + a per-IP circuit breaker at 10 failures/minute;
3. When `readOnly: true`, all write routes are disabled outright (not just hidden in the frontend);
4. 8MB size cap, oversized files are read-only previews;
5. Logs record only path hashes, never content;
6. **The terminal is a shell-level capability with its own gate**: `terminal.enabled` is a separate config item, forced off when `readOnly: true`; creating a terminal additionally requires the token to belong to a "confirmed session" (the frontend asks for a second confirmation the first time a terminal is opened, stored as a localStorage flag); once Cloudflare Access is deployed, this risk moves behind SSO.

### 3.2 Studio frontend (`studio/frontend/`, Vite + TypeScript + `monaco-editor`)

Layout modeled exactly on VS Code's three panes:

```
┌─────┬──────────────────────────────┬──────────────┐
│Activity│ Tabs [store.ts ●] [app.js]  │  Editor       │
│ bar   │ ├─ file tree / global search│  Monaco       │
│ 📄🔍  │ │   dual mode                │  · minimap    │
│ git   │ │  src/                      │  · line numbers│
│ ⚙     │ │  ▸ store.ts                │    /breakpoint│
│       │ └─ wrangler.jsonc            │    gutter     │
│       │                              │  · status bar │
│       │                              │    Ln/Col     │
└──────┴──────────────────────────────┴──────────────┘
```

Feature list (delivered incrementally in P1–P3):

- **P1**: lazy file tree, multi-tab, Monaco highlighting (ts/js/rust/c/json/yaml/md/shell built-ins suffice), `Ctrl+S` save (a three-way diff dialog on optimistic-lock conflict), line-number targeting, dirty dots, root switcher, dark theme (aligned with the saisi.online console style).
- **P2**: **integrated terminal** (multi-tab PTY, refresh-reconnect replay, "open terminal here") + `Ctrl+P` quick open (fuzzy filtering over the /api/tree cache), `Ctrl+Shift+F` global search (/api/search), external-change banner (WS).
- **P3**: git decorations (red/green markers in the file tree, inline change gutter drawn as a diff via Monaco decorations), markdown preview, image preview.

**Monaco packaging decision**: bundle the `monaco-editor` npm package locally (~3–5MB pre-gzip), **no CDN** — guarantees consistency on CN networks and offline; Vite splits chunks per worker.

### 3.3 Deep-link protocol (cross-system contract, frozen — will not change)

```
https://code.saisi.online/#/open
    ?p=/home/zhengsaisi/vale/gateway/src/store.ts   // absolute path (required)
    &l=596                                          // 1-based line number (optional)
    &c=8                                            // 1-based column (optional)
    &sel=596.8-604.35                               // selection (optional)
    &root=auto                                      // redundant hint, only speeds up root matching
```

- Use **hash routing**: neither the CF edge nor the tunnel touches the hash; switching files issues no page requests.
- Paths are always absolute — the content-script resolves relative paths when rewriting (see 3.4); the protocol itself leaves no ambiguity.
- First visit without a token: the frontend shows a token input, stores it in localStorage, then retries; `?token=` is only for one-time bootstrap links and is stripped from the address bar immediately after entry.

### 3.4 DSH → Studio jumps (browser extension content-script, chosen after comparing options)

| Option | Assessment |
|------|------|
| **A. Extension content-script rewrites the DOM (chosen)** | zero intrusion into DSH, upgrade-immune; the existing `extension/` project and options storage can be reused; it can handle tool-call headers, code-block titles in message text, and inline code |
| B. DSH client-plugin | the official mechanism (`/plugins/<id>/client.js` + `__DSH_BOOT__`), but it needs the pnpm dev:web build pipeline and tracks DSH's internal APIs — high maintenance cost |
| C. patch the installed lib | there's precedent (patch-dsh-trusted-host.sh), but every dsh upgrade needs re-patching — fragile |

Implementation (`extension/content/studio-links.js`; the manifest gains a `content_scripts` entry matching `https://dsh.saisi.online/*`):

1. A `MutationObserver` watches the session stream DOM;
2. Matching rules (in descending priority):
   - path text in tool-call card headers/params (the inputs and outputs of read, str_replace_editor, glob, grep all carry paths);
   - paths in fenced code block info lines (```` ```ts path=src/store.ts ````) or the first-line comment;
   - `(/?[A-Za-z0-9_./-]+\.(ts|js|mjs|rs|c|h|json|ya?ml|md|toml|ps1))(:\d+)?` in inline code and plain text;
3. Relative-path resolution: query `https://code.saisi.online/api/roots` for the whitelisted roots (the extension already has the token), completing to an absolute path by "longest matching prefix"; relative paths that fail to resolve are not rewritten (better fewer links than wrong links);
4. Rewrite to `<a href="…#/open?p=…&l=…" target="_blank">`, keeping the original text, with a dotted-underline style to distinguish it from ordinary links;
5. Add a toggle in the options page (default on) and custom extra domains.

**Model-side cooperation (optional, Phase 4, high payoff)**: the web surface's `system-prompt` persona can be extended via a profile patch with a line like "always use absolute paths when referencing workspace files", pushing the rewrite hit rate near 100%.

### 3.5 Deployment wiring (incremental, doesn't touch existing production)

1. Add a `vale-studio` app to `ecosystem.config.js` (pm2-managed, same pattern as dsh);
2. In `~/.cloudflared/<tunnel>.yml`, insert into the ingress before the 404:
   ```yaml
   - hostname: code.saisi.online
     service: http://localhost:7780
   ```
   and run `cloudflared tunnel route dns <tunnel> code.saisi.online`;
3. Add a `studio` target to `scripts/build.sh` (build the frontend dist + pm2 restart);
4. Add a banner at the top of the old `gateway/public/code/index.html` linking to `https://code.saisi.online/`.

---

## 4. Rejected alternatives

| Option | Rejection reason |
|------|---------|
| **code-server / OpenVSCode Server as a whole package** | the full VS Code experience is the strongest, but it's memory-heavy (hundreds of MB resident), UI customization clashes with the saisi.online brand, deep-linking to a specific line/column must bypass its internal routing; and its bundled terminal = shell directly exposed to the public internet, widening the attack surface. Kept as a backup for "after heavy use" |
| **just upgrade the gateway snapshot Viewer with Monaco** | violates C1: still a build-time snapshot, not a live workspace |
| **stuff the file API into the ai.saisi.online Worker + a device proxy** | one extra hop (Worker→device proxy→agent HTTP) with a complex auth chain; the files are on this very machine running DSH, so direct connection is shortest |

## 5. Risks and mitigations

| Risk | Mitigation |
|------|------|
| the user and DSH edit the same file at the same time | optimistic lock (baseSha256→409) + WS external-change banner; on conflict, offer a side-by-side "disk version / my version" comparison |
| filesystem exposed to the public internet | loopback binding + token + whitelist realpath validation + deletions into the trash; after Phase 4's Cloudflare Access (Zero Trust email OTP), the bare token can be turned off |
| latency from CN to the CF edge | same route as dsh.saisi.online (already in use, acceptable); local Monaco bundling avoids CDN jitter |
| terminal = shell exposed to the public internet | loopback binding + token + the separate `terminal.enabled` gate + read-only mode forces the terminal off; after Phase 4's Cloudflare Access it moves behind SSO; the server never records terminal output |
| ripgrep missing | probe at startup, fall back to JS search and flag it as slow |
| DSH updates break selectors | content-script rules are centralized in one config table; failure shows up as "no links" rather than an error |

## 6. Implementation phases (each phase independently usable, tree stays green)

- **P1 usable skeleton (first)**: server.mjs (roots/tree/file/watch + token + whitelist) + frontend (tree/tabs/Monaco/save/line targeting) + tunnel ingress + pm2. Acceptance: `curl` passes the API contract tests (node:test); opening code.saisi.online in a browser can edit and save files under ~/vale; content persists across process restarts.
- **P2 terminal + efficiency**: node-pty multi-tab terminal (refresh-reconnect replay, "open terminal here", Ctrl+`) + quick open, global search, external-change banner. Acceptance: `cargo test`/`git log` run in the browser with full-color output; after a 10s network drop and reconnect, the session and scroll buffer are still there; with readOnly=true the terminal API returns disabled.
- **P3 DSH integration**: extension content-script + options toggle; acceptance: have the agent read a file in a DSH session, click the path and land on the corresponding line in a new tab.
- **P4 polish**: git decorations, markdown/image preview, tmux session-persistence toggle, active-workspace auto-discovery, Cloudflare Access, persona patch to boost the link hit rate.