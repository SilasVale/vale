# Vale Studio

The workspace code editor + integrated terminal for <host>. Connects to **real files** (the disk of the machine where DSH runs), not snapshots.

- **Public entry point**: https://<code-host> (one ingress on the same cloudflared tunnel)
- **Design doc**: `docs/superpowers/specs/2026-08-25-vale-studio-workspace-editor-design.md`
- **Frontend**: zero-build — Monaco AMD loader (`vendor/monaco/vs`) + xterm UMD (`vendor/xterm`)
- **Backend**: Node 22 ESM, zero framework; depends on `ws` + `node-pty` (optional, falls back to `script(1)`)

## Running

```bash
pm2 start ecosystem.config.js --only vale-studio   # production (pm2-managed)
node server.mjs                                    # manual
npm test                                           # API contract tests (17)
LD_LIBRARY_PATH=~/chromium-libs/root/usr/lib/x86_64-linux-gnu \
  node test/e2e.mjs                                # browser end-to-end (17)
```

## Features

- **Editing**: singleton Monaco (shared across tabs, switched per model), Ctrl+S optimistic-lock save,
  reload-from-disk / force-overwrite on conflict; inline image preview; word wrap toggle (settings view).
- **git integration**: source control sidebar (branch + change list), file-tree M/A/D/U badges,
  activity bar badge, diff gutter add/change markers on the active file; auto-refresh after save.
- **Terminal**: multi-tab PTY (node-pty / script fallback), tmux sessions persist across restarts and are automatically re-attached;
  the panel's top edge can be dragged to make it taller.
- **Efficiency**: Ctrl+P quick open supports `name:42` line-number jumps with most-recently-used files on top;
  global search searches as you type + `<mark>` highlighting + truncation notice; Ctrl+B sidebar, Ctrl+J terminal;
  middle-click closes tabs; page refresh is blocked when there are unsaved changes.
- **File operations**: context menu for new/rename/delete (trash)/copy path/open terminal here;
  mkdir/rename/trash/save drive partial tree refreshes via watch broadcasts.

## Configuration `~/.vale-studio/config.json`

```jsonc
{
  "port": 7780,
  "bind": "127.0.0.1",            // always listens on loopback; public access only via the tunnel
  "token": "<openssl rand -hex 32>",
  "readOnly": false,               // when true, all write endpoints and the terminal are disabled
  "terminal": { "enabled": true },
  "roots": ["/home/zhengsaisi/vale"]  // whitelisted workspace roots
}
```

## Security notes

- Loopback binding + Bearer token (uniform 404 on errors + failure circuit breaker)
- After `realpath`, every path must land inside a whitelisted root (symlink escape blocked; rename additionally confined to a single root)
- Atomic writes + baseSha256 optimistic lock; deletions go to `<root>/.vale-studio-trash/`
- File watching is **targeted**: only watches the directories of open files (avoids exhausting inotify)

## Shortcuts

| Key | Action |
|----|------|
| Ctrl+P | Quick open file (`name:line` jump) |
| Ctrl+S | Save (optimistic lock) |
| Ctrl+Shift+F | Global search |
| Ctrl+B / Ctrl+J | Toggle sidebar / terminal panel |
| Ctrl+` | Toggle terminal panel |
| Esc | Close overlay |

## Deep-link protocol

```
https://<code-host>/#/open?p=<absolute-path>&l=<line>&c=<column>&sel=<l.c-l.c>
```

On the DSH page side, the browser extension's content-script rewrites paths in messages to the above link (P3, see design doc §3.4).