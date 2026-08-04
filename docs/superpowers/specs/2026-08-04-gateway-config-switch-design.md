# Vale 命令：网关渠道一键切换（设计）

日期：2026-08-04
状态：已批准（用户确认 node 实现）

## Context

用户通过 `~/.claude/settings.json` 使用 vale-gate 网关（api.saisi.online）的多个渠道（ds/qw/og/or）。现状：
- 渠道故障（如 og/ 上游 zen/go 挂了 45s 才失败）时，配置停在坏渠道，用户需手动 `cp` profile 文件切换，无健康信息、无验证、无回滚。
- 新增渠道（qw/）也要手工维护 profile 模板。

目标：一个跨平台的 `vale` 命令 + 网关公开端点 + 网页安装入口，实现"一键切换、自动验证、可回滚、健康可见"。

范围外的决策（明确不做）：
- 启动自动 hook / 定时轮询（用户否决，命令式为主）
- 网关服务端降级（用户否决，账单不透明）
- 渠道优先级做成可配置 JSON（YAGNI，内置常量即可）

## 架构

```
网页 console 模型路由区 → "Vale 命令"面板（安装命令 + 用法）

网关 vale-gate（新增公开端点，无鉴权，无敏感信息）
  ├─ GET /api/health          → 渠道状态 + 推荐
  ├─ GET /api/vale-cli        → vale 脚本本体（text/plain）
  ├─ GET /api/vale-install    → POSIX 一键安装器（内嵌 base64 脚本）
  └─ GET /api/vale-install.ps1→ Windows PowerShell 一键安装器

本地 vale 命令（~/.local/bin/vale，node 无依赖，跨平台）
  ├─ vale check               → 拉健康 + 显示当前配置渠道
  ├─ vale use <ds|qw|og|or>   → 探测 → 备份 → 改写 env → 原子写 → 提示重启
  ├─ vale use auto            → 按优先级 qw > ds > og > or 选健康渠道
  └─ vale restore             → 回滚最近的备份
```

## 网关端点

### GET /api/health（公开，所有域名可用）

响应：
```json
{
  "channels": [
    { "id": "ds", "ok": true,  "model": "ds/deepseek-v4-flash" },
    { "id": "qw", "ok": true,  "model": "qw/qwen3.8-max-preview" },
    { "id": "og", "ok": false, "model": "og/deepseek-v4-flash", "reason": "circuit open" },
    { "id": "or", "ok": true,  "model": "or/openai/gpt-5.6-luna:floor[1m]" }
  ],
  "recommended": { "channel": "qw", "model": "qw/qwen3.8-max-preview" }
}
```

- 健康判定：`og` 用 breaker 状态（`isChannelDegraded`）；其他渠道无 breaker，标记 `ok: true`（真实可用性由 vale 命令切换前的探测兜底）。
- `recommended`：按优先级常量 `qw > ds > og > or` 取第一个 `ok` 渠道。
- 放置：主 fetch 里在 hostname 分流之前处理（`path === "/api/health"`），保证 ai/api 域名也可访问。

### GET /api/vale-cli

返回 vale 脚本本体（`Content-Type: text/plain`）。脚本内容由网关以字符串常量内嵌（生成时从 `scripts/vale-cli.js` 读取打包，或作为独立模块导入 —— 采用独立文件 `gateway/src/vale-cli.js` 导出字符串，index.js 引用）。

### GET /api/vale-install（POSIX）

返回 sh 安装器：
```sh
#!/bin/sh
set -e
command -v node >/dev/null 2>&1 || { echo "error: Node.js required"; exit 1; }
DEST="${VALE_BIN:-$HOME/.local/bin}"
mkdir -p "$DEST"
echo "<base64 的 vale 脚本>" | base64 -d > "$DEST/vale"
chmod +x "$DEST/vale"
echo "installed: $DEST/vale"
echo "usage: vale check | vale use <ds|qw|og|or> | vale use auto | vale restore"
```

### GET /api/vale-install.ps1（Windows）

```powershell
$ErrorActionPreference = "Stop"
try { node --version | Out-Null } catch { Write-Error "Node.js required"; exit 1 }
$dest = Join-Path $HOME ".local\bin"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("<base64>"))
Set-Content -Path (Join-Path $dest "vale") -Value $script -Encoding UTF8 -NoNewline
Set-Content -Path (Join-Path $dest "vale.cmd") -Value '@echo off\r\nnode "%~dp0vale" %*' -Encoding ASCII
Write-Host "installed: $dest\vale  (command: vale)"
```

### console 面板

`gateway/public/` 的模型路由 section 增加"Vale 命令"块：两个平台的安装命令 + 用法（`vale check` / `vale use` / `vale restore`）。实现取决于 public/ 前端结构（见实施计划）。

## vale 命令（scripts/vale-cli.js → 打包为字符串）

node 实现，零依赖，跨平台（`os.homedir()` 定位配置）。

**模型映射（内置常量）**：
```js
const CHANNELS = {
  ds: { model: "ds/deepseek-v4-flash" },
  qw: { model: "qw/qwen3.8-max-preview" },
  og: { model: "og/deepseek-v4-flash" },
  or: { model: "or/openai/gpt-5.6-luna:floor[1m]" },
};
const PRIORITY = ["qw", "ds", "og", "or"];
```

**命令流程：**

`vale check`：
1. 读 `~/.claude/settings.json` 的 env 提取当前模型/渠道
2. `GET https://api.saisi.online/api/health`（base URL 从 settings.json 的 ANTHROPIC_BASE_URL 读取，无则默认）
3. 打印渠道状态表 + 当前配置 + 推荐

`vale use <channel>`：
1. 校验 channel 在映射表
2. 探测：POST `<base>/v1/messages`（max_tokens=1，用 settings.json 里的 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN）→ 非 200 拒绝切换
3. 备份：`settings.json` → `settings.json.bak-vale-<timestamp>`
4. 改写 env：`ANTHROPIC_BASE_URL`（保持，若缺失则设为 api.saisi.online）、模型字段（ANTHROPIC_MODEL + DEFAULT_* + SUBAGENT + SMALL_FAST 全部设为渠道模型名）、保留 token 字段
5. 原子写（临时文件 + rename）
6. 打印"已切换 qw/qwen3.8-max-preview，重启 Claude Code 生效"

`vale use auto`：拉 health → 按 PRIORITY 取第一个 ok → 走 use 流程；全挂则报错并建议检查网络。

`vale restore`：找最近的 `settings.json.bak-vale-*` → 原子恢复 → 提示重启。

**安全**：
- 脚本不显示/不存储 token（只读使用）
- 每次 use/restore 前自动备份（保留最近 5 份，旧删）
- 原子写防中断半文件
- 探测失败不切换

## 测试

- `gateway/test/vale-cli.test.mjs`：vale 脚本核心逻辑抽为可测模块 —— 模型映射、配置改写（读 mock settings.json → 断言 env 字段）、备份命名/清理、优先级选择。网络调用 mock。
- 网关端点测试：health 生成函数（channels/recommended 逻辑，breaker mock）。

## 验证

1. `npm test` 全绿（新增 vale 测试）
2. `wrangler dev` / 部署后：
   - `curl https://api.saisi.online/api/health` → 渠道状态 + 推荐
   - `curl https://api.saisi.online/api/vale-install | sh` → 安装 vale（本地 ~/.local/bin）
   - `vale check` → 显示状态
   - `vale use qw` → 备份 + 切换 + 提示
   - `vale use og` → 探测失败拒绝（zen 挂了，行为验证）
   - `vale restore` → 回滚
3. 网页 console 模型路由区显示安装面板

## 实施文件

- `gateway/src/index.js`：4 个公开端点 + health 生成函数 + console 面板数据
- `gateway/src/vale-cli.js`：vale 脚本源文件（导出字符串 + 可测核心函数）
- `gateway/scripts/` 或 inline：安装器模板（sh/ps1）
- `gateway/public/`：模型路由区面板
- `gateway/test/vale-cli.test.mjs`：测试
