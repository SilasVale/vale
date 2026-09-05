# Vale Satellite Proxies

Independently deployed small proxy Workers / Vercel projects, invoked by the Vale gateway when `US_PROXY` is enabled (US egress), or used as dedicated entry points. The source was migrated in from `~/cloudflare` and `~/vercel-proxy` and unified under the `scripts/build.sh` deployment.

| Directory | Worker name | Purpose | Secrets |
|---|---|---|---|
| `zen-go-proxy/` | `opencode-go-proxy` | Dedicated direct entry for <opencode-host> (og transcoding merged into the gateway) | `OPENCODE_GO_API_KEY`, `CLIENT_KEY` (required — default-closed when unset) |
| `zen-us-proxy/` | `zen-us-proxy` | US egress proxy (D1 binding forces US-region edge → opencode zen; see D1 note below) | `OPENCODE_GO_API_KEY`, `CLIENT_KEY` (required — default-closed when unset) |
| `my-openrouter-proxy/` | `openrouter-proxy` | OpenRouter BYOK passthrough (BYOK-only: anonymous callers get 401, no built-in key exists to spend) | none — BYOK-only, no secret to configure |
| `vercel-proxy/` | Vercel project | `<mirror-host>/api/zen` + `/api/proxy` AI egress (both BYOK-only: caller key required), controlled `/api/github/{web\|raw\|api\|release}/...` GitHub HTTP reverse proxy, plus `/api/gform/{gle\|docs\|...}/...` Google Forms reverse proxy (body rewriting, anonymous public forms) (Vercel platform, not a Worker) | none — BYOK-only, no secret to configure |

Auth model: the zen proxies gate on `CLIENT_KEY` (constant-time compare, default-closed when unset); the OpenRouter paths (`my-openrouter-proxy`, `/api/proxy`, `/api/zen`) are BYOK-only — the caller always supplies their own upstream key and there is deliberately **no server-side key to leak, rotate, or configure**. Upstream fetches carry a 30s `AbortSignal.timeout`; 5xx responses use generic client text (detail stays in the worker/function log).

## Deployment

```bash
# All Cloudflare proxy Workers (zen-go / zen-us / openrouter)
./scripts/build.sh proxies

# Vercel egress proxy (requires vercel CLI + login)
./scripts/build.sh vercel-proxy
```

`./scripts/build.sh deploy` also deploys the three Cloudflare proxies.

## D1 bindings (geo-hack — read before touching)

- `zen-us-proxy` binds the `us-proxy-db` D1 database but **never queries it**. The binding is an intentional geo-hack: pinning a D1 database forces compute onto regions that host D1 (US/Europe), so egress to opencode zen leaves from US/European edges instead of congested Asian ones.
- ⚠️ **Do NOT remove the `zen-us-proxy` D1 binding** (`wrangler.jsonc` `d1_databases`): unbinding silently re-routes through Asian edges and the latency wins disappear with no error to alert you.
- `openrouter-proxy` carries **no** D1 binding (its earlier `us-proxy-db` binding was idle — the code never touched `env.DB` — and has been removed). It needs none: OpenRouter routing is not latency-sensitive the way zen is.

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
