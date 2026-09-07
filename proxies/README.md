# Vale Satellite Proxies

Independently deployed small proxy Workers / Vercel projects, invoked by the Vale gateway when `US_PROXY` is enabled (US egress), or used as dedicated entry points. The source was migrated in from `~/cloudflare` and `~/vercel-proxy` and unified under the `scripts/build.sh` deployment.

| Directory | Worker name | Purpose | Secrets |
|---|---|---|---|
| `zen-go-proxy/` | `opencode-go-proxy` | Dedicated direct entry for <opencode-host> (og transcoding merged into the gateway) | `OPENCODE_GO_API_KEY`, `CLIENT_KEY` (required — default-closed when unset) |
| `zen-us-proxy/` | `zen-us-proxy` | US egress proxy (D1 binding forces US-region edge → opencode zen; see D1 note below) | `OPENCODE_GO_API_KEY`, `CLIENT_KEY` (required — default-closed when unset) |
| `vercel-proxy/` | Vercel project | `<mirror-host>/api/zen` + `/api/proxy` AI egress (both BYOK-only: caller key required), controlled `/api/github/{web\|raw\|api\|release}/...` GitHub HTTP reverse proxy, plus `/api/gform/{gle\|docs\|...}/...` Google Forms reverse proxy (body rewriting, anonymous public forms) (Vercel platform, not a Worker) | none — BYOK-only, no secret to configure |

(~~`my-openrouter-proxy/`~~ RETIRED 2026-09-07 — zero callers (off-path since 2026-08-22, upstream table), workers.dev URL TLS-dead; remote worker deleted, source in git history.)

Auth model: the zen proxies gate on `CLIENT_KEY` (constant-time compare, default-closed when unset); the OpenRouter paths (`/api/proxy`, `/api/zen`) and zen-us `/v1/responses` are BYOK-only — the caller always supplies their own upstream key and there is deliberately **no server-side key to leak, rotate, or configure**. Upstream fetches carry a 30s timeout that covers **waiting for response headers only** — streamed response bodies (long SSE generations, e.g. muse-spark via `/v1/responses`) are forwarded untimed so a long generation is never cut mid-stream. 5xx responses use generic client text (detail stays in the worker/function log).

## `/v1/responses` (muse-spark) — why BYOK on zen-us, and the US-exit caveat

`zen-us-proxy` also serves `POST /v1/responses` as a pure BYOK relay (Bearer → upstream), used for `og/muse-spark-*` Contributor (responses-only upstream, Meta region policy forces a US exit). Unlike `/v1/messages` it does NOT gate on `CLIENT_KEY`: the caller's own zen key rides as Bearer and is spent by the caller, not by this worker.

**Current caveat (2026-09-05):** a Cloudflare worker egress does NOT clear the Meta RegionError — zen geo-locates the CF egress IP (EU edges → `403 RegionError: This model is not available in your country`). Only the Vercel relay (`v.saisi.online/api/zen`, edge in ORD/Chicago) is verified to clear it. The gateway therefore defaults muse to the Vercel relay (`MUSE_RESPONSES_EXIT` unset); `zen-us` remains a configurable exit for when a US-pinned CF egress becomes available.

## Deployment

```bash
# All Cloudflare proxy Workers (zen-go / zen-us / openrouter)
./scripts/build.sh proxies

# Vercel egress proxy (requires vercel CLI + login)
./scripts/build.sh vercel-proxy
```

`./scripts/build.sh deploy` also deploys the two Cloudflare proxies.

## D1 bindings + placement (geo-pinning — read before touching)

- `zen-us-proxy` binds the **`zen-us-db-wnam`** (WNAM-primary) D1 database but **never queries it**. The binding is an intentional geo-pin: pinning a D1 database forces compute onto regions that host D1, keeping egress to opencode zen on Meta-permitted US edges. (The previous EU-primary `us-proxy-db` produced `403 RegionError` from EU edges — 2026-09-07; the WNAM primary + explicit `placement.region: aws:us-east-1` both point egress at the US east coast.)
- ⚠️ **Do NOT remove the `zen-us-proxy` D1 binding** (`wrangler.jsonc` `d1_databases`) **or weaken the placement**: unbinding/reverting silently re-routes through EU/Asian edges and the RegionError + latency wins disappear with no error to alert you.

## Git automatic URL rewriting

`vercel-proxy` provides a GitHub Smart HTTP reverse proxy at `/api/git/...`. Once configured, GitHub URLs in the repo do not need to change:

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
