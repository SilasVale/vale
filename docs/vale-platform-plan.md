# Vale 平台整合计划（一个仓库 + 一个前门）

> 状态：**已批准，Phase 0 完成**（迁移进 monorepo），Phase 1 进行中
> 日期：2026-08-02
> 决策记录：把 vale 系列项目整合成一个 monorepo + 统一前门（valegate 控制台）。
> 已定：仓库 `vale`（GitHub: SilasVale/vale）、位置 `/home/zhengsaisi/vale/`、Index 并入前门、token 存 valegate KV（仅 admin）。

## 1. 目标

把三个 "Vale" 项目整合成**一个仓库 + 一个前门 + 统一命名**：

- **一个仓库**：monorepo，统一管理 valegate / vale-command / vale-command-index
- **一个前门**：valegate 控制台（ai.saisi.online）作为唯一入口，集成设备控制（管理员专属）
- **统一命名**：对外统一 "Vale 平台"，消除 ai-gateway / vale-command / vale-command-index 的割裂

## 2. 现状盘点

| 项目 | 代码位置（monorepo 内） | 运行环境 | 域名 | 技术栈 |
|---|---|---|---|---|
| valegate | `gateway/`（原名 ai-gateway） | Cloudflare Worker | ai.saisi.online | JS + 控制台（登录/角色/邀请码） |
| vale-command | `command/` | Windows 机器 | dN.command.saisi.online | Rust（MCP 服务器 + 面板 + 托盘） |
| vale-command-index | `index/` | Cloudflare Worker | command.saisi.online | JS（设备索引页） |

> 迁移源：`cloudflare/ai-gateway`、`cloudflare/vale-command-index`（cloudflare 仓库还含非 vale 项目，只搬 vale 子目录）、`/home/zhengsaisi/vale-command`。

## 3. 目标 monorepo 结构

```
vale/                        ← 新仓库（GitHub: SilasVale/vale）
  gateway/                    ← 来自 cloudflare/ai-gateway ✓ 已迁
  command/                    ← 来自 /home/zhengsaisi/vale-command（含 vale-tray）✓ 已迁
  index/                      ← 来自 cloudflare/vale-command-index ✓ 已迁
  docs/                       ← 统一文档（含本计划 + DEVICE-INTEGRATION.md）
  scripts/                    ← 统一构建：xwin 编译 command、wrangler 部署 gateway/index
  README.md                   ← 平台总览
```

## 4. 阶段划分

### Phase 0 — 命名与仓库
- 定新仓库名（`vale` / `valesuite`，用户定）
- 迁移 3 个项目进 monorepo，保留各自 git 历史（git subtree / filter-repo）
- 清理旧位置引用（README、部署脚本里的路径）

### Phase 1 — monorepo 整理
- 统一命名：目录、crate、Worker 名对齐 "vale" 品牌
- 统一文档：README、架构图、构建说明
- 统一 CI/构建脚本：`build.sh`（xwin 编译 command + wrangler 部署 gateway/index）
- 验证：command 的 cargo xwin 构建、gateway/index 的 wrangler 部署都从 monorepo 顶层跑通

### Phase 2 — 前门整合（valegate 设备模块）
按 `gateway/DEVICE-INTEGRATION.md` 实施（**已上线** 2026-08-02）：
- ✅ 控制台加「设备」区块，仅 `role.admin` 可见（普通用户 403/不可见）
- ✅ 设备列表（名 → dN.command.saisi.online → token），管理员增删改，token 存 KV（仅 admin）
- ✅ 反向代理到设备，注入 Bearer token（服务端，浏览器不接触 token）
- ✅ 处理 SSE/流式响应（event-stream 直通不缓冲）
- ✅ 设备模块显示「复制 MCP 配置」；Claude Code 直连 token 不受影响

### Phase 3 — 收尾
- ✅ 统一域名入口：ai.saisi.online 主入口（控制台），command.saisi.online 为下载/安装落地页
- ✅ 文档 + 部署清单更新（README / CLAUDE.md / 计划文档 / DEVICE-INTEGRATION.md）
- ✅ Worker 改名 `ai-gateway` → `vale-gate`（2026-08-03：重建 Worker、从 KV 恢复 secrets、重绑 ai.saisi.online + api.saisi.online，线上已验证）
- ✅ GitHub **`SilasVale/vale`（公开）** 已建并推送 main（2026-08-03），私有信息已审计：工作树 + 全历史无 token/密钥，`.dev.vars` 未入库
- ✅ 旧目录已删：`cloudflare/ai-gateway`、`cloudflare/vale-command-index`、原 `/home/zhengsaisi/vale-command`（stage-l 重构确认过时，已备份 `~/vale-stage-l-work.bundle` + `.patch`）
- ⚠️ `OPENROUTER_PROXY_URL` / `OPENROUTER_API_KEY` 是 write-only secrets 无法恢复，`or/` 路由回退到占位 URL，需重设

## 5. 关键决策（已确认）

1. 新仓库名：**`vale`**（GitHub: SilasVale/vale）
2. monorepo 位置：**`/home/zhengsaisi/vale/`**
3. vale-command-index：**并入 valegate 前门**（设备模块），`command.saisi.online` 退化为纯下载分发
4. 迁移后旧目录：`cloudflare/ai-gateway`、`cloudflare/vale-command-index` **待 Phase 3 确认后删除**

## 6. 风险

- **git 历史迁移**：3 个项目历史合并到 monorepo，需要 subtree/filter-repo，有冲突风险
- **vale-command 是活跃开发中的仓库**（有 worktree、未提交改动），迁移前需先提交干净
- **构建链路**：monorepo 后要保证 xwin 交叉编译 + wrangler 部署从顶层可跑通
- **前门整合**（Phase 2）是独立工作量，动 ai-gateway 的认证/代理逻辑，需单独测试

## 7. 验证清单

- [x] 三项目迁入 monorepo，保留 git 历史（git subtree），代码与原仓库一致
- [x] 迁移后 `cargo metadata` 在 `command/` 正常解析
- [x] 从 monorepo 顶层：`./scripts/build.sh command` 出 `vale-command.exe` + `vale-tray.exe`
- [x] `wrangler deploy`（gateway、index）从 monorepo 内成功（`./scripts/build.sh gateway|index`）
- [x] ai.saisi.online 控制台：普通用户看不到「设备」，未登录访问 `/api/devices` → 401（已部署验证）
- [x] 设备模块 API：14 项测试 + 6 项路径重写单测通过；代理真实 d1 面板根 → 200 且 HTML 正确重写
- [ ] 管理员用真实 token 配置设备后，从控制台点进面板操作（串口/终端/浏览器）— **待人工确认**
- [ ] MCP 流式响应在 valegate 代理下正常 — **待人工确认**
- [ ] Claude Code 直连 `dN.command.saisi.online/mcp` 不受影响 — **待人工确认**
