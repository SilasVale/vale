# Vale Studio Links (extension)

Rewrites workspace file paths that appear in the DSH panel
(`https://dsh.saisi.online` chat — tool-call headers, prose, code blocks)
into one-click deep links that open the file at the right line in Vale
Studio (`https://code.saisi.online`).

Pure vanilla JS, no build step — load the folder as an unpacked extension.

## Install

1. Chrome/Edge → `chrome://extensions` → enable Developer mode → **Load
   unpacked** → select this `extension/` folder.
2. Open the extension's **Options** page → set:
   - **Studio origin** — e.g. `https://code.saisi.online`
   - **Studio token** — from `~/.vale-studio/config.json`
   - **Enable** the "rewrite paths in DSH into Studio deep links" toggle.
3. Open `https://dsh.saisi.online` — file paths in the chat become links.

## Notes

- Relative paths are resolved against the server's whitelist roots via a
  cheap `/api/stat` probe (no file contents transferred); results cached.
- The original text node is replaced wholesale with a single `<span>` wrapper
  so streaming appends never fight it; the options toggle turns it off.
- The Vale Browser Control half of this extension (device Chrome pairing +
  `chrome.debugger` driving via the gateway) was removed — the Vale desktop
  Electron shell replaced it.
