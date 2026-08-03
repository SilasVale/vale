# Vale 平台 — monorepo 指南

Vale = 一个仓库 + 一个前门：`gateway/`（Vale Gate Worker）、`command/`（Vale Command Windows）、`index/`（Vale Index Worker）、`docs/`。

## 构建

统一入口 `scripts/build.sh`：

```bash
./scripts/build.sh command           # Windows 交叉编译 vale-command + vale-tray（需 cargo-xwin）
./scripts/build.sh gateway|index     # wrangler 部署对应 Worker（需 CLOUDFLARE_API_TOKEN）
./scripts/build.sh deploy            # 全量
```

各子项目有独立构建文档：
- **command**：`command/CLAUDE.md`（cargo xwin 交叉编译、特性门控、MCP 工具新增、Windows 冒烟清单）
- **gateway / index**：Worker 部署见各自 `wrangler.jsonc`，构建即 `wrangler deploy`

## 约定

- **提交**：conventional commits + 阶段标签（`fix(stage-x)`、`feat(stage-x)` 等），每个提交保持工作树绿。
- **改动子项目**：在对应子目录内验证（command 跑 cargo test/clippy/xwin check；gateway/index 跑 wrangler deploy）。
- **Worker 名**：gateway Worker 已改名 `vale-gate`（2026-08-03）。若 dashboard 里 `ai.saisi.online` 仍绑定旧的 `ai-gateway` worker，需手动重绑到 `vale-gate` 并可在重绑后删掉旧 worker。
- **计划**：`docs/vale-platform-plan.md`（整合路线）、`gateway/DEVICE-INTEGRATION.md`（设备模块设计）。
