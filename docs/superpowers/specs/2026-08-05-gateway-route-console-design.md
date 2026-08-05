# 网页即控制台：网关侧渠道路由（重新设计）

日期：2026-08-05
状态：已批准（用户确认"配置上云、网页即控制台"方向）

## Context

vale 命令方案（本地 CLI + provider 仓库 + 复制命令到终端）经用户反馈存在四个不合理点：复制粘贴心智负担、CLI 存在感过强、配置分散三处（settings.json / providers.json / console）、页面形态别扭。

**根本问题**：配置放在本地，而用户想在网页上控制。

**重新设计**：把"当前渠道选择"上云 —— Claude Code 模型名固定为 `auto`（配一次永不改），网关按用户网页上的选择动态路由。**网页点一下 = 立即生效，无需本地工具、无需重启**。

## 架构

```
Claude Code（settings.json 配一次，固定）：
  ANTHROPIC_MODEL = "auto"
  ANTHROPIC_BASE_URL = https://api.saisi.online
  ANTHROPIC_API_KEY = 网关 token

请求 model="auto"
  → 网关查用户路由选择（store.js 缓存模式：内存为主，KV 每 isolate 24h 读一次）
  → 路由到所选渠道（如 qw/qwen3.8-max-preview）
  → 响应 model 字段 = 实际渠道模型名

网页 console（登录后概览页）：
  渠道卡片（健康状态 + 点击选择）→ PUT /api/me/route
  → KV write-through → 下一个请求立即走新渠道（无需重启）
```

## 网关改动

### 1. store.js — 用户路由选择（复用 cget/cset 缓存模式）

```js
export async function getUserRoute(env, id) {
  const key = `route:${id}`;
  const hit = cget(key);
  if (hit !== undefined) return hit;
  const v = (await env.KEYS.get(key)) || null;
  cset(key, v);
  return v;
}
export async function setUserRoute(env, id, model) {
  const key = `route:${id}`;
  await env.KEYS.put(key, model);
  cset(key, model); // write-through：切换立即生效（同 isolate 零延迟，跨 isolate ~1s KV 传播）
}
```

- route 值 = **完整模型名**（如 `qw/qwen3.8-max-preview`），与 `/api/me/route` 接口一致，未来支持任意模型
- 无选择（null）→ 回退推荐渠道（HEALTH_PRIORITY 第一个 ok）

### 2. index.js — `auto` 路由

handleGateway 中，`body.model === "auto"` 时：

```js
let model = body.model || "";
if (model === "auto") {
  model = await resolveAutoModel(env, user.id);
}
```

```js
export async function resolveAutoModel(env, uid) {
  const chosen = await getUserRoute(env, uid);
  if (chosen && isModelUsable(env, chosen)) return chosen;
  // 无选择或所选不可用（breaker open / 不在白名单）→ 推荐渠道
  const health = await buildHealth(env);
  const rec = health.recommended;
  return rec ? rec.model : "ds/deepseek-v4-flash";
}
```

- `isModelUsable`：模型在 MODELS 白名单且（og 渠道时）breaker 未开
- `auto` 在 count_tokens 同样处理（translate 渠道的本地估算逻辑保持）
- 响应 model 字段返回解析后的实际模型名（用户可见真实渠道）
- 无前缀模型名（如 `deepseek-v4-flash`）保持现状（default → ds），不特殊处理

### 3. console API — 读/改路由选择

handleConsole 的 session 区（/api/me 附近）：

```
GET  /api/me/route  → { model: "qw/qwen3.8-max-preview" | null }
PUT  /api/me/route  body { model: "qw/qwen3.8-max-preview" }
  → 校验模型在 MODELS 白名单（400 否则）
  → setUserRoute → { ok: true, model }
```

## 前端改动（console 概览页 Vale 卡改造为"控制台"）

```
┌─ 概览 ───────────────────────────────────────┐
│  网关 Token  [复制][显示]                      │
│                                               │
│  ┌─ 渠道切换 ──────────────────────────────┐  │
│  │  当前: qw/qwen3.8-max-preview  [自动]    │  │  ← GET /api/me/route + /api/health
│  │                                         │  │
│  │  ds/  deepseek-v4-flash     ✅ [使用]    │  │
│  │  qw/  qwen3.8-max-preview   ✅ [使用]◀   │  │  ← 点击 → PUT /api/me/route
│  │  og/  deepseek-v4-flash     ⚠️ degraded  │  │      → 高亮 + "已切换，下次请求生效"
│  │  or/  gpt-5.6-luna          ✅ [使用]    │  │
│  │                                         │  │
│  │  [自动选择健康渠道]（= 清除选择 → 推荐）   │  │
│  │  提示: 模型名配 auto，切换无需重启         │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  路由状态（switchboard，保留）                 │
└───────────────────────────────────────────────┘
```

- 移除：模型选择器下拉、一键配置按钮（vale CLI 安装入口移到"设置"小字/文档，CLI 降级为可选）
- 渠道卡片数据：/api/health（公开）+ /api/me/route（session）
- "自动"= PUT route { model: null }（清除选择 → 网关回退推荐渠道）

## 保留/降级

- vale CLI：功能保留（本地排查/离线场景可选），不再需要安装使用
- 渠道健康/断路器/probe/安装器端点：全部保留
- Claude Code 配置迁移：用户 settings.json 模型字段改为 `auto`（一次性，实施后协助）

## 验证

1. 单测：resolveAutoModel（有选择/无选择/选择不可用→推荐）、setUserRoute write-through、/api/me/route 校验
2. curl：PUT /api/me/route（session）→ GET 回读；model=auto 请求 → 路由到所选渠道（响应 model 字段验证）
3. 浏览器：概览渠道卡片点击切换 → 高亮 + 下一个 auto 请求走新渠道
4. 回归：ds/qw/og/or 显式模型名路由不变；count_tokens auto 正常；62 测试全绿

## 实施文件

- `gateway/src/store.js`：getUserRoute/setUserRoute
- `gateway/src/index.js`：resolveAutoModel + auto 分支 + /api/me/route 端点
- `gateway/public/index.html` + `public/app.js`：渠道切换卡（替换 Vale 卡）
- `gateway/test/`：新增 route 相关测试
