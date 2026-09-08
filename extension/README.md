# Vale Code Links (extension)

Rewrites workspace file paths that appear in the DSH panel
(`https://dsh.saisi.online` chat — tool-call headers, prose, code blocks)
into one-click links that open the file's folder in code-server
(`https://vscode.saisi.online`, behind Cloudflare Access).

Pure vanilla JS, no build step — load the folder as an unpacked extension.
Since the studio retirement (ADR 0006) there is no extension-held token and
no server probe: resolution is purely local (absolute paths link as-is,
relative paths resolve against the workspace base). code-server URLs open
folders, not file+line — the line number rides in the link tooltip.

## Install

1. Chrome/Edge → `chrome://extensions` → enable Developer mode → **Load
   unpacked** → select this `extension/` folder.
2. Open the extension's **Options** page → set:
   - **code-server origin** — e.g. `https://vscode.saisi.online`
   - **Enable** the "rewrite paths in DSH into code-server links" toggle.
   (A `studioOrigin` key from older versions is reused as-is; only the
   default changed.)
3. Open `https://dsh.saisi.online` — file paths in the chat become links.

## Notes

- The original text node is replaced wholesale with a single `<span>` wrapper
  so streaming appends never fight it; the options toggle turns it off.
- The Vale Browser Control half of this extension (device Chrome pairing +
  `chrome.debugger` driving via the gateway) was removed in round-262 — the
  Vale desktop Electron shell replaced it. The gateway's extension-pairing
  endpoints were removed with it (round-340).
