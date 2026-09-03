# DSH Web 性能与稳定性排障记录（2026-08-27）

> 本次会话完整记录：dsh.saisi.online 从"莫名其妙停止"到"卡顿"的全部根因、
> 修复方法、以及最终确认的架构边界。供后续排障复用。

## 一、问题清单与最终状态

| 问题 | 根因 | 状态 |
|---|---|---|
| dsh 进程反复被杀（"莫名其妙停止"） | Node v22 的 `zlib.zstdDecompressSync` native 内存泄漏（每次调用泄漏 ~376KB，GC 不回收） | ✅ 已修复（升级 Node v24，泄漏降 95%） |
| 浏览器 502 / connection lost 循环 | 上述内存泄漏 → RSS 涨到 1G → PM2 `max_memory_restart` 杀进程 | ✅ 随内存修复消失 |
| cloudflared 不在 pm2 管理（外网全断） | 某次 `pm2 kill` 误杀了隧道进程，恢复时漏了它 | ✅ 已用 `cloudflared-run.sh` 加回 pm2 并 `pm2 save` |
| manifest CORS 报错 | Cloudflare Access 拦截 GET `/manifest.webmanifest`，302 到登录页无 CORS 头 | ✅ 已删前端 manifest 引用（PWA 安装功能放弃） |
| 页面卡顿（0.7-2.7s/请求） | Cloudflare anycast 把深圳/上海路由到 AMS/LAX（跨太平洋）；隧道端点锁死美国 | ⚠️ 架构限制，见下 |

## 二、内存泄漏根因（已解决）

**实验证据**（Node 各版本 zstd 解压测试）：

| Node 版本 | 100 次全会话读取泄漏 | 单次 zstdDecompressSync 泄漏 |
|---|---|---|
| v22.22.3 | +1687MB | ~376KB |
| v24.20.0 | +89MB | ~145KB |

**机制**：dsh 的会话持久化（`dsh-session-persistence-jsonl`）每次 append 事件都
逐帧解压整个会话文件（大会话几万帧，实测 `session-db2a4aff` 有 44478 帧），
`zstdDecompressSync` 的 native 内存不归还 OS，RSS 单调上涨。

**修复**：
```bash
# 安装 Node 24 并切换（nvm）
nvm install 24.20.0
nvm alias default 24.20.0
# 重装全局包
npm install -g @deepseek-ai/dsh pm2
# 重跑 trusted-host 补丁（每次升级 dsh 后都要跑）
bash patch-dsh-trusted-host.sh /home/zhengsaisi/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh
# 更新硬编码路径
#   ecosystem.config.js  script/interpreter → v24.20.0 路径
#   dsh-wrapper.sh / restart-plugin.js  DSH_BIN → v24.20.0 路径
```

**注意**：pm2 daemon 必须用新 node 启动（`pm2 kill` 后用 v24 的 pm2 重新 resurrect），
否则 daemon 的 PATH 仍指向旧 node，子进程还是旧版本。

**内存上限**：`ecosystem.config.js` 保持 `max_memory_restart: '2G'`（不要改回 1G，
1G 会在正常负载时误杀）。

## 三、卡顿排查全记录（结论：架构限制）

### 链路
```
浏览器(上海联通) → Cloudflare 边缘(AMS/LAX/NRT 动态) → cloudflared 隧道(→美国边缘) → 深圳服务器 dsh
```

### 已排查并排除的方案

| 方案 | 结果 |
|---|---|
| HTTP/3 (QUIC) 开启 | ✅ 有效（`zone settings/http3` off→on，浏览器走 h3，TLS 握手减半） |
| cloudflared `region: apac` | ❌ 无此区域（DNS 只有 `us`/`fed` 前缀，亚太隧道端点不存在） |
| cloudflared 换版本 | ❌ 新旧版本都不支持亚太区域（产品限制） |
| Vercel 中转（v.saisi.online 反代） | ❌ 实测更慢（多一跳，Vercel→隧道仍走 Cloudflare） |
| Vercel DNS-only（proxied=False） | ✅ 对 v.saisi.online 本身有效（TLS 0.18s），但对 dsh 无帮助 |
| 优选 IP 改 DNS（A 记录→Cloudflare IP） | ❌ **错误 1034 Edge IP Restricted**：隧道域名锁死 `cfargotunnel.com`，指向其他 Cloudflare IP 被拒 |
| Tailscale/ZeroTier | ⚠️ 免费但需设备装客户端，国内 NAT 打洞失败率高 |
| frp/rathole | ⚠️ 软件免费但需要一台有公网 IP 的中转机 |

### 关键结论
1. **隧道域名（dsh.saisi.online）的 CNAME 目标不能动**，必须指向
   `cfargotunnel.com`，否则 Cloudflare 返回 1034 Edge IP Restricted。
2. **cloudflared 隧道端点无亚太选项**：`region` 只有 `us`/`fed`/默认(global→美国)。
3. **Cloudflare anycast 路由是动态的**：深圳/上海的路由会在 AMS/LAX/NRT 之间变化。
   cf-ray 从 AMS 变成 NRT（东京）时，耗时从 0.7-2.7s 降到 0.37-0.57s ——
   这是意外触发的（DNS 折腾后 Cloudflare 重新路由），不可控、可能再变回去。

### 诊断命令速查
```bash
# 看当前节点
curl -sI https://dsh.saisi.online/ | grep -i cf-ray   # xxx-AMS / xxx-NRT

# 延迟分解
curl -s -o /dev/null -w "TLS %{time_appconnect}s 总 %{time_total}s\n" https://dsh.saisi.online/

# 隧道连接位置
ss -tnp | grep cloudflared | grep -v 127.0.0.1

# 测特定 IP 走哪个节点（路由探测）
curl -sI --max-time 6 --resolve dsh.saisi.online:443:<ip> https://dsh.saisi.online/ | grep -i cf-ray

# 内存
pm2 pid dsh | xargs -I{} sh -c 'awk "/VmRSS/{print \$2/1024\" MB\"}" /proc/{}/status'
```

### 后续若再变慢
- 先看 cf-ray：AMS/LAX = 路由变差了（等 Cloudflare 重新路由或接受）；NRT = 正常
- 不要改 DNS 指向其他 Cloudflare IP（会 1034）
- 唯一确定性提速：香港/国内公网 VPS 跑 frp 中转（需花钱，~30-50元/月）

## 四、web search 修复记录

### 问题
dsh 的 web-search-deepseek 插件配置 `apiKeyEnv: ANTHROPIC_API_KEY`，但该 key
只在进程环境变量，不在 dsh 的 credentials 服务（`.credentials.yaml`）——
插件解析失败（`WEB_PROVIDER_CREDENTIAL_MISSING`），web search 静默失效。

### 修复
```bash
# 1. 在 .credentials.yaml 的 refs 加 ANTHROPIC_API_KEY（值=网关 CLIENT_KEY）
#    或改 settings.yaml: apiKeyEnv: ANTHROPIC_API_KEY → VALE_API_KEY
# 2. 插件每次搜索动态读 credentials，无需重启
```

### 渠道能力实测（web search 服务器端支持）
| 渠道/模型 | 服务器端搜索 | 备注 |
|---|---|---|
| og/deepseek-v4-flash | ✅ | zen 原生，唯一当前可用 |
| ds/deepseek-v4-flash | ✅ | DeepSeek 官方，但账号余额不足 |
| cm/ 全系（含 claude/gpt/kimi/glm） | ❌ | 只返回 tool_use（客户端模式），或 400/403 |
| cm/deepseek-v4-flash | ❌ | 网关 web_search 分支明确排除 commandgoat |

### 最终方案：官方 web-search-deepseek 插件（已配置）
- 用 dsh 自带官方插件（`@deepseek-ai/dsh-web-search-deepseek`），不额外做 MCP
- settings.yaml 配置：
  ```yaml
  web-search-deepseek:
    baseURL: https://api.saisi.online/v1
    apiKeyEnv: VALE_API_KEY
    model: og/deepseek-v4-flash   # zen 原生服务器端搜索
    maxTokens: 4096
    maxUses: 5
  ```
- 关键：model 必须是支持服务器端搜索的（og/ 或 ds/），cm/ 不支持
- 注意：曾误做 MCP websearch（重复造轮子），已删除（配置 + 目录）

## 五、Cloudflare Access 应用（DSH Web）
- app id: `dac5bd42-b86b-4862-b18e-f939e801d843`
- `options_preflight_bypass: true` 已开启（只放行 OPTIONS，manifest GET 仍被拦）
- 策略：allow-me（email）+ 无 bypass（域名级，无法按路径放行）
