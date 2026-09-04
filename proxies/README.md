# Vale Satellite Proxies

Independently deployed small proxy Workers / Vercel projects, invoked by the Vale gateway when `US_PROXY` is enabled (US egress), or used as dedicated entry points. The source was migrated in from `~/cloudflare` and `~/vercel-proxy` and unified under the `scripts/build.sh` deployment.

| Directory | Worker name | Purpose | Secrets |
|---|---|---|---|
| `zen-go-proxy/` | `opencode-go-proxy` | Dedicated direct entry for <opencode-host> (og transcoding merged into the gateway) | `OPENCODE_GO_API_KEY`, `CLIENT_KEY` (required — default-closed when unset) |
| `zen-us-proxy/` | `zen-us-proxy` | US egress proxy (D1 binding forces US-region edge → opencode zen) | `OPENCODE_GO_API_KEY`, `CLIENT_KEY` (required — default-closed when unset) |
| `my-openrouter-proxy/` | `openrouter-proxy` | OpenRouter BYOK passthrough (BYOK-only: anonymous callers get 401, the built-in key is never spent anonymously) | `OPENROUTER_API_KEY` |
| `vercel-proxy/` | Vercel project | `<mirror-host>/api/zen` + `/api/proxy` AI egress, controlled `/api/github/{web|raw|api|release}/...` GitHub HTTP reverse proxy, plus `/api/gform/{gle|docs|...}/...` Google Forms reverse proxy (body rewriting, anonymous public forms) (Vercel platform, not a Worker) | `OPENROUTER_API_KEY` (Vercel env) |

## Deployment

```bash
# All Cloudflare proxy Workers (zen-go / zen-us / openrouter)
./scripts/build.sh proxies

# Vercel egress proxy (requires vercel CLI + login)
./scripts/build.sh vercel-proxy
```

`./scripts/build.sh deploy` also deploys the three Cloudflare proxies.

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

## Secret configuration

Worker secrets are set via `wrangler secret put <NAME>` or the Cloudflare dashboard, **deploys do not clear already-set secrets**:

```bash
cd proxies/zen-go-proxy && CLOUDFLARE_API_TOKEN=$CF_TOKEN wrangler secret put OPENCODE_GO_API_KEY
```

For the Vercel project, run `vercel env add OPENROUTER_API_KEY production` under `proxies/vercel-proxy/`.

> ⚠️ Sensitive files (`.client-key`, `.dev.vars`, `.wrangler/`, `.vercel/`) are not part of the repository — already excluded when migrated in; please do not commit them.