# Vale Agent E2E suite

Repeatable, device-side verification that the AI-facing surface works
end-to-end. Created round-273 to fix the "tests were one-off scripts in
pwout" gap — every round-264..268 verification now runs from one file.

## What it checks

| Section | Round source | Verifies |
|---|---|---|
| `terminal` | 268 | session open → session-mode execute (state:done) → run_in_background → terminal_read collects |
| `file` | 266 | stat → 2-page append upload (300KB) → single raw read download (1MiB cap) |
| `workflow` | 267 | process_list → local execute → file_write → stat → memory_save → memory_search |
| `browser` | 268 | browser_run_script drives the embedded view via CDP 9333 → SPA address bar follows |

## Usage (on the device)

```powershell
node e2e.js --token <agent-token>
node e2e.js --token <token> --only terminal,file   # subset
node e2e.js --token <token> --no-browser           # agent-only, no CDP
```

Env: `VALE_AGENT_TOKEN` also works; `--base` overrides the agent URL;
`VALE_PW_DIR` overrides the playwright dir (default `D:\Vale\playwright`).

Exit code 0 = all selected sections passed.

## Prereqs

- Agent running on the device (port 18080 default).
- Section `browser`: Electron desktop up (CDP 9333) + bundled playwright.
- Test artifacts land in `D:\Vale\pwout\` and are cleaned up by the suite.

## Maintenance notes

- Tool calls go through `POST /api/tools/{name}` with body = args object
  (no `{tool,args}` wrapper) — the shape external AI clients use.
- `terminal_open` returns the sid as a string in `.result`.
- Do NOT run the terminal section from inside the session you want to test
  (busy-lock deadlock — round-70 lesson).
