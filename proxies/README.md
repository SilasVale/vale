# Vale Satellite Proxies

独立部署的小型代理 Worker / Vercel 项目,由 Vale 网关在 `US_PROXY` 开启时调用(美国出口),或作为专有入口使用。源码从 `~/cloudflare` 与 `~/vercel-proxy` 迁入,统一纳入 `scripts/build.sh` 部署。

| 目录 | Worker 名 | 用途 | 密钥 |
|---|---|---|---|
| `zen-go-proxy/` | `opencode-go-proxy` | opencode.saisi.online 专属直连入口(og 转译已并入网关) | `OPENCODE_GO_API_KEY`,可选 `CLIENT_KEY` |
| `zen-us-proxy/` | `zen-us-proxy` | 美国出口代理(D1 绑定强制美区边缘 → opencode zen) | `OPENCODE_GO_API_KEY` |
| `my-openrouter-proxy/` | `openrouter-proxy` | OpenRouter BYOK 透传(用户自带 key,无则回退内置) | `OPENROUTER_API_KEY` |
| `vercel-proxy/` | Vercel 项目 | `v.saisi.online/api/zen` + `/api/proxy` 出口(Vercel 平台,非 Worker) | `OPENROUTER_API_KEY`(Vercel env) |

## 部署

```bash
# 全部 Cloudflare 代理 Worker(zen-go / zen-us / openrouter)
./scripts/build.sh proxies

# Vercel 出口代理(需要 vercel CLI + 登录)
./scripts/build.sh vercel-proxy
```

`./scripts/build.sh deploy` 也会一并部署三个 Cloudflare 代理。

## 密钥配置

Worker 密钥通过 `wrangler secret put <NAME>` 或 Cloudflare 面板设置,**部署不会清除已设置的 secret**:

```bash
cd proxies/zen-go-proxy && CLOUDFLARE_API_TOKEN=$CF_TOKEN wrangler secret put OPENCODE_GO_API_KEY
```

Vercel 项目在 `proxies/vercel-proxy/` 下 `vercel env add OPENROUTER_API_KEY production`。

> ⚠️ 敏感文件(`.client-key`、`.dev.vars`、`.wrangler/`、`.vercel/`)不纳入版本库——迁入时已排除,请勿提交。
