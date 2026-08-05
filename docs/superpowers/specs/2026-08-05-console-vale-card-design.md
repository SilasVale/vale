# Console 概览页 Vale 卡片（设计）

日期：2026-08-05
状态：已批准（用户选择"Vale 放概览页"）

## Context

vale 命令功能（安装/渠道切换/provider 注册）已完成，但其网页入口分散：模型路由面板有"Vale 命令"安装区、密钥管理面板有"Vale 一键配置"卡。用户希望入口最浅、形态集中 —— **Vale 内容收敛为概览页的一个大卡片**（登录第一眼可见，不新增导航）。

网页边界（约束）：浏览器无法读写用户本机的 `~/.claude/settings.json` 或执行 vale —— 网页只做**信息展示 + 命令生成**，配置动作由用户在本机终端执行。

## 布局

**概览页**（三张卡片，顺序：Token → Vale → 路由状态）：

```
┌─ 概览 ───────────────────────────────────────┐
│  网关 Token  [复制][显示]                      │
│                                               │
│  ┌─ Vale ──────────────────────────────────┐  │
│  │  默认模型 [▾ qw/qwen3.8-max-preview]    │  │  ← 下拉，选项来自 /v1/models
│  │  [⚡ 一键配置 Vale]                     │  │  ← 点击复制复合命令
│  │  ── 渠道健康（实时）──                   │  │  ← /api/health
│  │  ds/ ✅  qw/ ✅  og/ ⚠️ degraded  or/ ✅│  │
│  │  推荐: qw/qwen3.8-max-preview           │  │
│  │  ── 命令速查 ──                         │  │
│  │  vale check · vale use <渠道|模型> ·    │  │
│  │  vale use auto · vale models · restore  │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  路由状态（switchboard，现状保留）             │
└───────────────────────────────────────────────┘
```

**移除**：
- 密钥管理面板的"Vale 一键配置"卡 → 移入概览 Vale 卡
- 模型路由面板的"Vale 命令"安装区 → 移入概览 Vale 卡
- 模型路由面板保留：渠道 switchboard + 客户端示例

## 组件与交互

### 1. 默认模型选择器
- 选项：`GET /v1/models`（带当前用户 token，`x-api-key`）返回的模型 id，按渠道前缀分组展示
- 默认选中推荐渠道的模型（`/api/health` 的 recommended.model）
- 加载失败：回退到内置列表（ds/qw/og/or 默认模型）

### 2. "一键配置 Vale" 按钮
- 点击生成**复合命令**并复制到剪贴板（按钮反馈"已复制 ✅"）：
  ```
  curl -fsSL <base>/api/vale-install | sh && vale provider add vale-gw \
    --base <base> --token <me.token> --model <选择的模型>
  ```
  - `<base>`：`https://<apiHost>`（apiHost 空则 `https://api.saisi.online`）
  - `<me.token>`：当前用户的网关 token（`/api/me`）
  - 复合命令 = 安装 + 注册一步完成（vale 未装时一次到位；已装时安装命令幂等无害）
- 按钮旁附提示："粘贴到终端回车，安装 + 注册一次完成；之后 vale use <渠道> 切换"

### 3. 渠道健康
- 数据：`GET /api/health`（公开，无鉴权）
- 渲染：一行渠道状态（`ds/ ✅` / `og/ ⚠️ degraded`）+ 推荐模型
- 每 30s 自动刷新（与概览 switchboard 同模式）

### 4. 命令速查
- 静态文本（i18n），列出 5 条常用命令

## 数据流

```
概览页加载（loadOverview）
  ├─ /api/me          → me.token（按钮用）
  ├─ /api/admin/public→ apiHost（按钮 base）
  ├─ /api/health      → 渠道状态 + 推荐（卡片渲染 + 30s 轮询）
  └─ /v1/models       → 模型选择器选项
```

## 实施文件

- `gateway/public/index.html`：概览页加 Vale 卡（在路由状态卡之前）
- `gateway/public/app.js`：i18n（zh/en）+ 渲染函数（模型选择器填充、复合命令生成、复制、渠道健康行、30s 轮询）+ init 绑定
- 移除：密钥管理面板 Vale 卡（HTML+JS）、模型路由面板安装区（HTML+JS）

## 验证

1. `node --check public/app.js` 通过
2. 部署后浏览器检查：概览页三卡顺序、Vale 卡模型下拉、按钮复制内容含真实 token 和所选模型、渠道健康 30s 刷新、密钥管理/模型路由无残留 vale 块
3. 粘贴复制的复合命令到终端 → 安装+注册成功 → `vale check` 正常
