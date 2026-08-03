# Vale 平台

Vale 是一个统一的设备控制 + AI 网关平台：在 **一个仓库** 里管理前门、设备端与设备索引，对外统一 "Vale" 品牌。

```
ai.saisi.online  ── Vale Gate（前门）── 登录一次，管 AI + 设备
                         │ 代理（服务端注入 token）
   dN.command.saisi.online  ── Vale Command（设备端，Windows）
                                    │ Claude Code 直连 /mcp（token）
                                    └ 串口 / 终端 / 浏览器控制
command.saisi.online  ── Vale Index（下载分发 + 安装）
```

## 结构

| 目录 | 项目 | 运行环境 | 域名 | 说明 |
|---|---|---|---|---|
| `gateway/` | **Vale Gate**（前门，原 valegate / ai-gateway） | Cloudflare Worker | ai.saisi.online | Vale 控制台（登录/角色）+ AI 网关（BYOK 路由）+ 设备管理（MCP 配置 / 面板代理） |
| `command/` | **Vale Command** | Windows（Rust） | dN.command.saisi.online | headless MCP 服务器 + 网页面板 + 系统托盘 |
| `index/` | **Vale Index** | Cloudflare Worker | command.saisi.online | 安装包/脚本下载分发 |
| `docs/` | 统一文档 | — | — | 平台计划、设备集成设计 |

> 原三个独立项目（valegate / vale-command / vale-command-index）已整合进本仓库，git 历史经 `git subtree` 保留。

## 构建与部署

```bash
# 构建 command（Windows 交叉编译，需 cargo-xwin）
./scripts/build.sh command

# 构建 NSIS 安装包并 staging 下载文件到 index/public/vale-command/
# （*.exe 被 gitignore，需先跑这个再部署 index，否则下载 404）
./scripts/build-installer.sh

# 部署 Worker（需 CLOUDFLARE_API_TOKEN 或 ~/.cloudflare-token）
./scripts/build.sh gateway
./scripts/build.sh index

# 全量：构建 + 部署
./scripts/build.sh deploy
```

详见 `command/CLAUDE.md`（Rust 构建指南）与 `docs/vale-platform-plan.md`（平台整合计划）。

## 核心设计

- **Vale Command**：跑在每台 Windows 机器上，headless MCP 服务器（`/mcp`，token 门控）+ 网页面板（`/`）。经 Cloudflare Tunnel 暴露到 `dN.command.saisi.online`，每机一个独立子域与 token。
- **token**：安装时生成/从 Cloudflare 获取，存 `config.yaml`；MCP 用 `Authorization: Bearer <token>` 直连。Phase 2 起 token 同时存 Vale Gate（KV，仅 admin 可见），控制台可复制每台设备的 MCP 配置。
- **Claude Code 直连**：`{ "mcpServers": { "vale-command": { "type": "http", "url": "https://dN.command.saisi.online/mcp", "headers": { "Authorization": "Bearer <token>" } } } }`
