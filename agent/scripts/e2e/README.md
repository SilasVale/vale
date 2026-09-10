# Vale Agent E2E suite

Repeatable, device-side verification that the AI-facing surface works
end-to-end. Created round-273 to fix the "tests were one-off scripts in
pwout" gap — every round-264..268 verification now runs from one file.

## What it checks

| Section | Round source | Verifies |
|---|---|---|
| `terminal` | 268 | session open → list contains it → resize → session-mode execute (state:done) → run_in_background → terminal_read collects → terminal_write keystrokes → screen shows echo → unknown-session read evicted → close → history retains closed |
| `file` | 266 | stat → 2-page append upload (300KB) → single raw read download (1MiB cap) → list contains upload → missing-stat ok:false → text write+read |
| `workflow` | 267 | process_list → local execute → file_write → stat → memory_save → memory_search → memory_list → memory_update → search-updated → memory_export → memory_delete → delete-verified (zero hits) |
| `browser` | 268 | browser_pw_info bundled → run_script fail path (exit≠0) → browser_run_script drives the embedded view via CDP 9333 → SPA address bar follows → focus-trap: focused-but-untyped bar still follows AI navigation (no re-enter needed) |
| `panel` | 274 | AI writes a unique marker into a terminal session → the SPA's VISIBLE xterm must show it (display verification) |
| `evidence` | 277 | AI screenshot into pwout → GET /api/browser/pwshots (Evidence drawer data) lists it |
| `mcp` | 281/285 | stdio + http connect auto-select the embedded view; first browser_navigate drives it (regression). Click proof: snapshot -> browser_click on an injected same-origin link (Learn more fallback) must drive the view (round-313, deterministic since the external-link redirect chain flaked under load) |

## Usage (on the device)

```powershell
node e2e.js --token <agent-token>
node e2e.js --token <token> --only terminal,file   # subset
node e2e.js --token <token> --no-browser           # agent-only, no CDP
```

Env: `VALE_AGENT_TOKEN` also works; `--base` overrides the agent URL;
`VALE_PW_DIR` overrides the playwright dir (default `D:\Vale\playwright`).

| `governance` | round-9 of the game-design work | goal set -> the AI reads it off `terminal_list` -> gate armed -> an execute BLOCKS with its `intent`/`considered` -> approve+grant -> the granted family runs unasked -> revoke -> disarm -> **the audit trail explains all of it** |

Exit code 0 = all selected sections passed. Full run: 63 checks

## Which sections run where

`governance` is deliberately **platform-neutral** — it uses only tool calls and
HTTP, with no PowerShell and no path joining — so it is the one section that also
runs against a Linux agent on loopback:

```bash
# on any box with the agent built:
cargo build --features terminal --bin vale-agent
# config.yaml: server.host 127.0.0.1, a free port, a device_token
VALE_DATA_DIR=/tmp/vale-e2e/data ./target/debug/vale-agent /tmp/vale-e2e/config.yaml &
node agent/scripts/e2e/e2e.js --token <token> --base http://127.0.0.1:<port> --only governance
```

That is how the section was developed and how the audit-trail gap below was
found. The other sections are DEVICE-targeted by design and will partially fail
elsewhere: `terminal` runs `Write-Output` (PowerShell), and `file`/`evidence` join
paths with `\` under a hardcoded `C:\ProgramData\Vale\pwout`. Those failures
are the environment, not the agent — verified by pointing `VALE_EVIDENCE_DIR` at a
Linux directory, which moves `file` from an ENOENT abort to 6/7 with only the
backslash join failing.

## Why the trail assertions exist

Every check in `governance` passed on an early build while **arming the approval
gate left no trace in the audit trail at all** — the hold was recorded, the goal
was recorded, and the switch that decides whether commands run unasked was
invisible. Found only by driving a real agent end to end: each piece was
individually correct and only the joined-up history was missing. The trail
assertion is what turns that from a discovery into a failure.
(mcp section covers stdio+http auto-select AND AI click interaction —
snapshot -> browser_click {target} on the injected same-origin link
(Learn more fallback) must drive the embedded view, proving interactions
beyond navigation reach the page the user watches).
(terminal 9, file 7, workflow 11, panel 2, mcp 12 [stdio 6 + http 6], evidence 2, browser 5).

## Known device quirks (handled by the suite)

- Right after a playwright-driven navigation, the desktop SPA target may
  answer `Runtime.evaluate` without `result.value` for a few seconds
  (Electron CDP quirk, observed ~3s → fine at ~8s). The browser section
  polls generously and tolerates empty responses.
- Closing a CDP WebSocket immediately after `send` can trip Node's
  `UV_HANDLE_CLOSING` assert on Windows — the suite waits for the close
  handshake.
- Pulling the suite from `raw.githubusercontent.com` can be flaky from d1
  (remote closed connections); retry, or pin the commit SHA in the URL.

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
