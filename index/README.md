# Vale Index — download landing page

A tiny Cloudflare Worker serving `agent.saisi.online`: the download landing
page for vale-agent (npm-only channel since 2026-08-28) and the static
release artifacts (versioned npm tgz + `vale-agent-latest.tgz` alias +
`version.json` discovery manifest). Device management lives in the Vale
console — this worker only distributes install artifacts.

## Deploy

```bash
cd index
CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare-token) npx wrangler deploy
```

Custom domain **agent.saisi.online** is bound in the Cloudflare dashboard
(`workers_dev: false`).

## Publishing a release (the ONLY supported path)

```bash
./scripts/publish-release.sh 1.2.N
```

from the repo root. It packs the npm tgz, stages it + the `latest` alias,
writes `version.json` (with the sha256 agent_update requires), prunes old
versions to the last 5 (round-309), commits, and deploys this worker. Then
push main and create the GitHub tag `v1.2.N` via the API — release.yml
builds the GitHub release asset.

Static assets in `index/public/` are served first via the `ASSETS` binding;
everything else hits the Worker (`/api/version` derives the update manifest
from `version.json`, round-297).

## Installing vale-agent on a machine

```bash
npm i -g https://agent.saisi.online/vale-agent/vale-agent-latest.tgz
vale setup            # pure local; --reg-key <key> registers with a console
vale update           # same channel
```

## Legacy redirects

- `/vale-agent/ValeAgent-Setup.exe` → the download page (NSIS retired).
