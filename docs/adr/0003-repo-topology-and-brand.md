# ADR 0003: 三仓库拓扑 — 平台 / 工具链 / 运维凭证分离

状态: 已采纳（复核于 2026-08-22 深夜）｜ 影响范围: 组织层面

## 背景

Vale 生态现有三个仓库，用户提出"是否合并到一起"：

| 仓库 | 内容 | 受众 | 变更节奏 |
|---|---|---|---|
| `vale` | 平台运行时：gateway(CF Worker) / agent(Windows Rust) / index(分发) / extension / proxies | 用户与设备 | 随时部署 |
| `vale-forge` | 开发者工具链 MCP：OpenWrt 编译(build) / 板子 SSH(board) / TAPD(tapd)，~3k 行 Rust | 固件开发者本机 | 本地 cargo build |
| `vale-deploy` | 运维凭证 + 重建手册：CF/GitHub/Vercel token、worker 清单、bootstrap.sh | 灾备恢复 | 极少变动 |

## 考虑过的方案

### 方案一：三仓合一（否决）
- deploy 并入公开 vale = 凭证隔离失效，安全红线
- forge 并入 vale 使主仓库背负 OpenWrt 编译上下文；发布节奏完全不同
（Worker 秒级部署 vs 本地 cargo）

### 方案二：forge → vale-tools 改名（否决）
- "forge"对构建语义准确且有辨识度；改名涉及 GitHub/目录/二进制/MCP 注册名/
  文档全套迁移，收益仅为字面直白

### 方案三（采纳）：保持三仓库 + 软整合
按受众分工——用户面(vale)、开发面(forge)、运维面(deploy)。客户端层已经
天然整合：Claude Code 同时注册 `vale-gate`(设备) 与 `forge`(工具链) 两路
MCP，无需网关代理。

落地项：
1. vale README 增补生态说明与品牌/安装文档互指
2. vale-dist 新增 npm 一键分发产物（`vale-agent-npm.tgz`）
3. vale-deploy bootstrap.sh 可选步骤追加 forge 安装（后续）
4. 已知命名漂移记录：`index/` 目录 ↔ Worker 名 `vale-dist`（保留现状，
   因 worker 改名需重绑域名）

## 后果

- 正向：职责边界清晰、凭证隔离保持、各仓库独立演进
- 代价：跨仓库变更需要多次提交推送（频率低，可接受）
- 安全备注：vale-forge `.mcp.json`（含网关 token）已停止追踪并加入
  gitignore；历史中的旧 token 建议择期轮换
