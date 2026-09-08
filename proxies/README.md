# Vale Satellite Proxies

Independently deployed small proxy Workers / Vercel projects, invoked by the Vale gateway when `US_PROXY` is enabled (US egress), or used as dedicated entry points. The source was migrated in from `~/cloudflare` and `~/vercel-proxy` and unified under the `scripts/build.sh` deployment.

| Directory | Worker name | Purpose | Secrets |
|---|---|---|---|
| `zen-go-proxy/` | `opencode-go-proxy` | Dedicated direct entry for <opencode-host> (og transcoding merged into the gateway) | `OPENCODE_GO_API_KEY`, `CLIENT_KEY` (required — default-closed when unset) |
| `zen-us-proxy/` | `zen-us-proxy` | US egress proxy (D1 binding forces US-region edge → opencode zen; see D1 note below) | `OPENCODE_GO_API_KEY`, `CLIENT_KEY` (required — default-closed when unset) |
| `api-relay/` | **vrelay** (Oracle VPS, systemd node) — was the Vercel project until 2026-09-08 (free team paused at 304% of its transfer cap; project since DELETED) | `v.saisi.online/api/{zen,proxy,github,git,gform}` + the muse `/v1/responses` US exit on `oracle.saisi.online` | none — BYOK-only, no secret to configure |

(~~`my-openrouter-proxy/`~~ RETIRED 2026-09-07 — zero callers (off-path since 2026-08-22, upstream table), workers.dev URL TLS-dead; remote worker deleted, source in git history.)

Auth model: the zen proxies gate on `CLIENT_KEY` (constant-time compare, default-closed when unset); the OpenRouter paths (`/api/proxy`, `/api/zen`) and zen-us `/v1/responses` are BYOK-only — the caller always supplies their own upstream key and there is deliberately **no server-side key to leak, rotate, or configure**. Upstream fetches carry a 30s timeout that covers **waiting for response headers only** — streamed response bodies (long SSE generations, e.g. muse-spark via `/v1/responses`) are forwarded untimed so a long generation is never cut mid-stream. 5xx responses use generic client text (detail stays in the worker/function log).

## `/v1/responses` (muse-spark) — why BYOK on zen-us, and the US-exit caveat

`zen-us-proxy` also serves `POST /v1/responses` as a pure BYOK relay (Bearer → upstream), used for `og/muse-spark-*` Contributor (responses-only upstream, Meta region policy forces a US exit). Unlike `/v1/messages` it does NOT gate on `CLIENT_KEY`: the caller's own zen key rides as Bearer and is spent by the caller, not by this worker.

**US-exit history (verdicts, as of 2026-09-08):** Meta's Geographic Use Policy geo-locates the EGRESS IP reaching zen, so muse needs a real US origin. Three exits were tried live:

1. **Vercel relay** (`v.saisi.online/api/zen`, ORD edge) — served as the gateway default until 2026-09-07, then the free team used **304% of the 10 GB Fast Origin Transfer cap** (~30.4 GB / 30 d) and Vercel paused the account: EVERY route on `v.saisi.online` now answers `402 DEPLOYMENT_DISABLED`. Escape hatch: `MUSE_RESPONSES_EXIT=vercel` restores it if the team is ever resumed (4.5 MB body cap — long muse contexts exceed it).
2. **Cloudflare worker egress** (`zen-us-proxy`, WNAM D1 + `placement: aws:us-east-1`) — re-verified 2026-09-08 after a fresh redeploy: opencode still sees a non-US CF egress IP → `403 RegionError`. Placement hints do NOT pin egress. Do not point `MUSE_RESPONSES_EXIT` at `zen-us`.
3. **Oracle Cloud Always-Free ARM VM** (Phoenix) — the current gateway default (`MUSE_RESPONSES_EXIT` unset): `https://oracle.saisi.online/v1/responses` → grey-cloud DNS straight to the box → nginx → opencode. US egress clears the RegionError; verified end-to-end (125k-token context, `status: completed`). Runbook below.

## muse-spark Oracle relay — runbook

- **Box**: `VM.Standard.A1.Flex` 1 OCPU / 6 GB, `us-phoenix-1` AD-1, Ubuntu 26.04, public IP `132.226.90.175` (tenancy `e3122231591`). Free pool allows 4 OCPU / 24 GB across A1 VMs; a second box can be spun up for redundancy (Phoenix is capacity-flaky — retry across ADs).
- **DNS**: `oracle.saisi.online` A record, **proxied=false (grey cloud)**. Orange adds a CF origin-pull hop but does not shorten the user leg — measured no win (see latency note). TLS is served by the box itself.
- **TLS**: Let's Encrypt via `certbot --nginx` (http-01), systemd timer auto-renews. (Full mode would also work behind orange; LE keeps the box honest standalone.)
- **nginx** (`/etc/nginx/sites-available/proxy`): `location = /v1/responses` → `https://opencode.ai/zen/go/v1/responses` with `Host`/SNI `opencode.ai`; `client_max_body_size 50m`; `proxy_request_buffering off` (streams multi-MB bodies); **variable-form `proxy_pass` + `resolver 8.8.8.8 ipv6=off`** — static-form resolves at boot, cached AAAA records the box can't egress to, and paid IPv6 connect-retries per request. Everything else 404.
- **Firewalls**: Oracle Security List ingress `0.0.0.0/0 tcp 22,80,443` (a broad all-TCP rule exists — tighten it when convenient); box iptables allow 22/80/443, persisted via `iptables-persistent` (`netfilter-persistent save`).
- **Watchdog**: `/usr/local/bin/muse-relay-watchdog.sh` (cron `*/5`) POSTs a fake-key probe and expects `401` (= nginx→zen path + body limit healthy); anything else restarts nginx. It exists because of the 2026-09-08 incident below.
- **Body-size budget**: 1M-token contexts ≈ 5–15 MB of JSON (text ~4–5 B/token + escaping + message wrappers), so 50m ≈ 3–10× headroom. Earlier walls: zen/model context (400s), CF free upload (100 MB). Note muse spends `max_output_tokens` on reasoning (observed 497/500) — clients should send `reasoning.effort` low or budgets ≥1k.
- **Reload pitfall (lesson, 2026-09-08)**: a certbot-triggered reload hit transient DNS (`host not found in upstream "opencode.ai"`), systemd marked the unit **failed**, and nginx kept serving the OLD config silently — every later `systemctl reload` was a no-op (`Unit cannot be reloaded because it is inactive`) while 413s persisted. `nginx -T` reads the DISK config and will not catch this. After any reload doubt: `systemctl is-active nginx` + behavior probe; prefer `restart`. The variable-form proxy_pass also removes the boot-time resolution failure mode that caused it.
- **Latency measurements (why the box never fronts user traffic)**: interleaved curls from Guangzhou — direct `api.saisi.online` TTFB median ~0.65–1.0 s (CF anycast lands this ISP on **AMS**, ~250 ms RTT; Workers run AT the edge, so exactly one ocean crossing); Oracle-FRONTED `api` via this box: same median, brutal tails (up to 7.9 s — single public CN-outbound route to one IP, retransmit-prone; plus the front ADDS a second TLS chain user↔box + box↔CF instead of removing one). With muse routed through the box as US exit, gateway E2E (1.14–1.75 s) is statistically identical to the deepseek baseline (1.30–1.61 s); box→opencode TLS is 41 ms. The box's job is geo-correctness, intra-US only.
- **Rebuild checklist** (new box / compromise): create A1 (capacity retry) → `apt install nginx python3-certbot-nginx` → restore proxy file from git history (`gateway` commit `df9448ae` era) → move the grey-cloud A record to the new IP → `certbot --nginx -d oracle.saisi.online` → reinstall watchdog cron + persist iptables → update the default URL in `gateway/src/channels.ts` (or set the `MUSE_RESPONSES_EXIT` secret to override without deploying) → `./scripts/build.sh gateway`. **TODO**: the box's SSH private key was pasted into a chat during setup — rotate the authorized key on the instance when convenient.

## Deployment

```bash
# All Cloudflare proxy Workers (zen-go / zen-us / openrouter)
./scripts/build.sh proxies

# Vercel egress proxy (requires vercel CLI + login)
./scripts/build.sh api-relay
```

`./scripts/build.sh deploy` also deploys the two Cloudflare proxies.

## D1 bindings + placement (geo-pinning — read before touching)

- `zen-us-proxy` binds the **`zen-us-db-wnam`** (WNAM-primary) D1 database but **never queries it**. The binding is an intentional geo-pin: pinning a D1 database forces compute onto regions that host D1, keeping egress to opencode zen on Meta-permitted US edges. (The previous EU-primary `us-proxy-db` produced `403 RegionError` from EU edges — 2026-09-07; the WNAM primary + explicit `placement.region: aws:us-east-1` both point egress at the US east coast.)
- ⚠️ **Do NOT remove the `zen-us-proxy` D1 binding** (`wrangler.jsonc` `d1_databases`) **or weaken the placement**: unbinding/reverting silently re-routes through EU/Asian edges and the RegionError + latency wins disappear with no error to alert you.

## vrelay — the VPS API relay (migrated from Vercel, 2026-09-08)

`proxies/api-relay/api/*` are standard web-API edge handlers (`Request ->
Response`); they run VERBATIM under Node 24 on the Oracle box via
`server/entry.mjs` — a tiny http adapter that replicates vercel.json's
rewrites in-process (`/api/git/…` → `?path=…`), shims undici's `duplex:"half"`
for stream bodies, and preserves the Vercel sources byte-identical (they remain
deployable to Vercel if the team is ever resumed).

- **Service**: systemd `vrelay.service` (hardened unit, User=www-data, listen
  127.0.0.1:8081). Files live in `/opt/vrelay`.
- **TLS/routing**: nginx vhost `sites-available/vrelay` serves
  `v.saisi.online` + `openrouter.saisi.online` (grey-cloud A records on
  Cloudflare → LE certs via `certbot --nginx`; `/api/` → 8081,
  `client_max_body_size 500m` + `proxy_request_buffering off` for git pushes).
  The muse `= /v1/responses` exit stays on the `oracle.saisi.online` vhost.
- **Deploy/update**: `./scripts/build.sh api-relay` (wraps build-relay.sh + scp +
  with the gateway's tsc — no extra downloads) → scp `relay-bundle.tar.gz` →
  extract to `/opt/vrelay` (chmod a+r!) → `systemctl restart vrelay`.
- **DNS cutover was complete on 2026-09-08**: no consumer points at Vercel
  anymore (gateway `usProxyBase` default `https://v.saisi.online` now lands on
  the box unchanged — zero gateway config).
- **Watchdog** (`/usr/local/bin/muse-relay-watchdog.sh`, cron */5): asserts the
  nginx + vrelay systemd units AND behavior on both routes (fake-key probes
  must surface 401s); any failure → reset-failed, kill ORPHAN nginx masters,
  restart both. Orphan masters exist because of the reload-while-DNS-flaky
  incident the same day: stop/start churn left a 07:04 master holding :80/:443
  with a stale in-memory config while the unit read "failed" — every later
  `reload` silently no-op'd and port probes looked healthy. If you ever
  "reload" and behavior doesn't change, suspect exactly this.
- Known limits vs old Vercel: body cap now 500m (was ~4.5m FAILing long
  contexts — strictly better); no Vercel edge cache (nothing cached here
  anyway except gform's upstream etags); single region (phx AD-1) — a second
  box can reuse the same bundle + LE cert if redundancy is ever wanted.

## Git automatic URL rewriting

The relay provides a GitHub Smart HTTP reverse proxy at `/api/git/...`. Once configured, GitHub URLs in the repo do not need to change:

```bash
git config --global url."https://<git-mirror-host>/api/git/".insteadOf "https://github.com/"
```

Then run as usual:

```bash
git clone https://github.com/OWNER/REPO.git
git pull
git push
```

This entry only proxies to `github.com` and supports Git GET/HEAD/POST requests; SSH addresses `git@github.com:...` and CONNECT proxying for `HTTP_PROXY`/`HTTPS_PROXY` are out of scope for this entry.

Push-path size limit: the `/api/git` proxy rejects very large request bodies (~725MB → HTTP 413); full-history repushes must go direct to GitHub. Full runbook lives in `agent/AGENTS.md` (search "725MB" / "PUSH PATH MEASURED").

## Secret configuration

Only the two zen proxies take secrets. They are set via `wrangler secret put <NAME>` or the Cloudflare dashboard, **deploys do not clear already-set secrets**:

```bash
cd proxies/zen-go-proxy && CLOUDFLARE_API_TOKEN=$CF_TOKEN wrangler secret put OPENCODE_GO_API_KEY
cd proxies/zen-go-proxy && CLOUDFLARE_API_TOKEN=$CF_TOKEN wrangler secret put CLIENT_KEY
cd proxies/zen-us-proxy && CLOUDFLARE_API_TOKEN=$CF_TOKEN wrangler secret put OPENCODE_GO_API_KEY
cd proxies/zen-us-proxy && CLOUDFLARE_API_TOKEN=$CF_TOKEN wrangler secret put CLIENT_KEY
```

The OpenRouter paths need no secrets at all (BYOK-only — there is nothing to `wrangler secret put` or `vercel env add`).

> ⚠️ Sensitive files (`.client-key`, `.dev.vars`, `.wrangler/`, `.vercel/`) are not part of the repository — already excluded when migrated in; please do not commit them.
