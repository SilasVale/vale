# Vale Command Index — multi-device device list

A tiny Cloudflare Worker serving `command.saisi.online`: a dark "command
center" page listing every vale-command device. Click a card to open that
device's full panel (`dN.command.saisi.online`, behind its own Tunnel).

## Deploy

```bash
cd vale-command-index && wrangler deploy
```

Then add the custom domain **command.saisi.online** in the Cloudflare
dashboard (Workers → vale-command-index → Settings → Domains & Routes), same
as the other saisi.online workers. `workers_dev: false` so only the custom
domain is served.

## Add a device

1. Add one entry to `DEVICES` in `src/index.js`:
   `{ name: "Device 4", url: "https://d4.command.saisi.online" }`
2. On the new device machine, route its Tunnel to `d4.command.saisi.online`
   (see the vale-command `deploy/README.md`).
3. `wrangler deploy`.

No bindings/KV needed — the list is static in code. `/api/status` liveness
probes each device's public panel root (200 = up) to color the status dot.
