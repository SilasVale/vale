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
dashboard (Workers → vale-dist → Settings → Domains & Routes), same
as the other Vale workers. `workers_dev: false` so only the custom
domain is served.

The small static assets in `index/public/` (the setup script, agent/tray
binaries, and browser extension) are served first via the `ASSETS` binding;
the installer `.exe` is served from the Vercel mirror at
`https://<mirror-host>/dl/ValeAgent-Setup.exe` because it exceeds the Workers
Assets per-file limit. Run `./scripts/build-installer.sh` before deploying so
the installer and mirror artifacts are refreshed. The legacy installer path
`/vale-agent/ValeAgent-Setup.exe` redirects to the mirror.

## Installing Vale Command on a machine

Follow `agent/deploy/README.md` — one-click install on the target Windows
machine (`irm https://<download-host>/vale-agent/vale-agent-setup.ps1 | iex`).
After install, register the device in the Vale console (Devices → generate a
registration key), which stores the device name / host / token.
