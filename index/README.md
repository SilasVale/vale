# Vale Command Index — installer / script distribution

A tiny Cloudflare Worker serving `<download-host>`: the download landing page
for the vale-command installer and setup scripts. Device management (registry +
MCP config + panel proxy) lives in the Vale console (admin-only) — this worker
only distributes the install artifacts and points users to the console.

## Deploy

```bash
cd index
wrangler var put CONSOLE_URL <console-url>   # the Vale console URL, admin login (vars are NOT committed)
wrangler deploy
```

Then add the custom domain **<download-host>** in the Cloudflare
dashboard (Workers → vale-command-index → Settings → Domains & Routes), same
as the other Vale workers. `workers_dev: false` so only the custom
domain is served.

The static assets in `index/public/` (the installer `.exe`, `vale-command-setup.ps1`,
`vale-command-setup.bat`) are served first via the `ASSETS` binding; everything
else hits the Worker, which renders the download page with the console link
from `CONSOLE_URL`. Note the installer `.exe` is gitignored — run
`./scripts/build-installer.sh` before deploying, or downloads 404.

## Installing Vale Command on a machine

Follow `command/deploy/README.md` — one-click install on the target Windows
machine (`irm https://<download-host>/vale-command/vale-command-setup.ps1 | iex`).
After install, register the device in the Vale console (Devices → generate a
registration key), which stores the device name / host / token.
