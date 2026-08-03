# vale-command 集成进 valegate（设备控制 = 管理员专属）

> 状态：**已实施**（monorepo `gateway/`，2026-08-02 上线）
> 日期：2026-08-02

## 背景与目标

用户已有两个 Vale 品牌产品：
- **valegate**（`ai.saisi.online`）—— AI 网关控制台（登录 + 管理员/用户角色 + 邀请码）
- **vale-command** —— 设备命令中心（headless MCP 服务器 + 网页面板），跑在各 Windows 机器上，通过 Cloudflare 隧道暴露到 `dN.command.saisi.online`

**目标**：把 vale-command 的设备控制集成进 valegate 控制台，作为**管理员登录后独有的「设备」模块** —— 用户在一个控制台里登录一次即可操作所有设备，无需再贴 vale-command 的 token。

## 关键架构结论（讨论过的坑，别再绕）

1. **vale-command 不能作为代码插件跑在 valegate 里**：valegate 是 Cloudflare Worker（边缘、无状态），而 vale-command 必须跑在 Windows 机器上（要碰串口/终端/真实浏览器）。"插件"只能是**前门集成模块**，不是代码嵌入。
2. **token 存 Cloudflare，但仅 admin 可见**：token 存进 valegate 的 KV（`devices:v1`，每设备 `{name, hostname, token}`），只有 `role.admin` 登录后才能增删改/查看（设备列表 masked，MCP 配置接口返回完整值）。**绝不对公网自动下发** —— 没有任何匿名 URL 能拿到 token。
3. **Claude Code（MCP）不受影响**：它直接用 vale-command 的 Bearer token（MCP 配置里配一次，可经控制台「复制 MCP 配置」取），与 valegate 无关。

## 架构

```
浏览器 ──登录 ai.saisi.online（valegate）──► [管理员] 设备模块
                                              │ 列出 d1/d2...
                                              ▼
                                       反向代理到 dN.command.saisi.online
                                       注入 Authorization: Bearer <设备token>
                                              ▼
                                     Windows 上的 vale-command（面板/MCP）
Claude Code ──► https://dN.command.saisi.online/mcp（直接用 token，不经过 valegate）
```

## 需求

### 必须
- valegate 控制台新增**「设备」区块**，仅 `role.admin` 可见/可用（普通用户 403）
- 设备列表（从配置/存储读：设备名 → `dN.command.saisi.online` → token）
- 反向代理到设备面板，服务端注入 Bearer token（token 只在 valegate 侧，用户浏览器不接触）
- 代理要正确处理：HTTP/HTTPS、SSE/MCP 的流式响应、长连接
- 设备 token 由管理员在控制台配置（一次）

### 非目标
- 不把 vale-command 代码跑进 valegate
- 不替换 Claude Code 用的 vale-command token

### 后续可选
- `command.saisi.online/dN` 路径包装（友好 URL，底下还是子域名隧道）
- vale-command 托盘「打开面板」自动带 token（本机浏览器免输入）

## 已实施（2026-08-02）

- **store.js**：`listDevices / saveDevices / getDevice / upsertDevice / deleteDevice`，KV key `devices:v1`。
- **index.js**（`handleConsole`，`role.admin` 段）：
  - `GET /api/devices` — 列表（token masked）
  - `POST /api/devices` — 添加/更新 `{name, hostname, token}`（校验 name/hostname/token）
  - `DELETE /api/devices/<name>`
  - `GET /api/devices/<name>/mcp` — 返回现成 MCP 配置 JSON（唯一返回完整 token 的接口）
  - `<any> /api/devices/<name>/proxy/<rest>` — 反向代理：注入 `Authorization: Bearer <token>`（服务端），`text/event-stream`/octet-stream 直通不缓冲，HTML/JS/CSS 文本把面板绝对路径重写到代理挂载点（`/api/devices/<name>/proxy`），避免 SPA 的 `/api/*`、`/app.js` 等断链。
- **public/app.js + index.html + style.css**：管理员「设备管理」面板（列表 / 添加 / 删除 / 复制 MCP 配置 / 打开面板）。

## 验证

- ✅ 普通用户登录 → 看不到「设备」导航（`data-admin-only` 门控）；未登录 `GET /api/devices` → 401
- ✅ 管理员：设备增删查、token masked、MCP 配置取回（14 项 Node API 测试 + 6 项路径重写单测）
- ✅ 反向代理端到端：代理真实 `d1.command.saisi.online` 面板根 → 200，HTML 正确重写为 `/api/devices/d1/proxy/*`；错误 token → 设备返回 401 被透传；不可达设备 → 502
- ⏳ 待人工确认：管理员用真实 token 配置设备后，从控制台点进面板操作（串口/终端/浏览器）、SSE 流式不卡顿
- ⏳ 待人工确认：Claude Code 直连 `dN.command.saisi.online/mcp` 不受影响

## 后续可选

- `command.saisi.online/dN` 路径包装（友好 URL，底下还是子域名隧道）
- vale-command 托盘「打开面板」自动带 token（本机浏览器免输入）
