# ADR 0008 — 安装目录布局 v2（子目录分层）

- 状态：Accepted（2026-09-09，全量重排）
- 背景：安装根目录有 ~15 个散文件 + 3 种层级不一致的组件目录（`tools\node\` 目录 vs `tools\cloudflared.exe` 单文件 vs 顶层 `playwright\`），每轮迭代各写各的，没有布局契约。

## 目标布局（`<InstallDir>\`）

```text
vale-agent.exe[.new][.old]   留根：任务计划 Execute / Rust bootstrap / filelog 都 key off exe 路径
uninstall.exe                留根：NSIS 约定
etc\                         config.yaml, vale-agent.hostname, tunnel.yml,
                             .vale-release, boxed-versions.json
components\                  node\, npm-global\, cloudflared.exe,
                             playwright\（仅 node.exe + node_modules）,
                             vale-desktop-electron\（名不变，Electron 打包路径敏感）
scripts\                     ensure-desktop.ps1, desktop-pulse.vbs, start-desktop.ps1,
                             run-hidden.vbs, playwright-probe.ps1（自 playwright\ 拆出）,
                             vale-online-setup.ps1, vale-update.ps1（transient，自删）,
                             shell-integration\, fix-tunnel.ps1（legacy，被引用才跑）
<DataDir>\logs\              installer.log, install-result.txt, vale-update.log,
                             agent.log, startup.log（程序目录不再写日志）
<DataDir>\pwout\             AI 证据目录（ was 安装根；e2e 同步改）
```

根目录只留：双 exe（+ transient）+ 卸载器。`tools\` 目录消失。

## 配套修正（布局逼出来的三个真问题）

1. **ValeAgent 任务 Argument 传的是 exe 路径，Rust 拿 `argv[1]` 当 config 路径** —— config 搬家后该参数必须显式指向 `etc\config.yaml`，
   否则新 agent 把 exe 当 YAML 解析直接进 quarantine（ deterministic brick）。
   更新 swap（TS + Rust 两份）fail-closed 重指任务 Action（只换 Action，不碰触发器/主体，
   不触发密码交互框；重指失败则放弃 swap、重启旧任务）。
2. **Rust `agent_update` 的 swap 缺 DisplayVersion 回写**（TS 有）——补齐，否则该路径更新后
   控制面板版本 permanently stale。
3. **TS `vale-update.ps1` 用完不删** —— swap 尾加自删（Rust 那份本来就自删）。

## 迁移（老设备不经过 setup，只走 update）

- 新代码读新路径是唯一语义；兼容只做**一次性搬迁**，不做永久双读：
  - TS `setup` + TS swap 脚本：嵌入同一份 `migrateLayoutPs`（单源，test pin），
     stop 之后、swap 之前搬；门控：`etc\config.yaml` + `etc\vale-agent.hostname`
    不到位则放弃 swap、重启旧任务（fail-closed，设备保持旧版在线）。
  - Rust boot backstop（`paths.rs`）：新 agent 首次启动发现新缺旧有 → 搬（覆盖
    Rust-old-updater 无迁移逻辑的 307→308 一跳；幂等，搬完即止）。
- C1 附录：本次是 registry-root 解析规则之外**唯一**的版本化迁移例外，
  搬迁 shim 随布局稳定后删除，不演变为长期双读。

## 不做的

- exe 不搬（任务/S CM/Rust 三处 key off，收益为零风险最高）。
- `fix-tunnel.ps1` 语义不动（legacy guard，只是换目录）。
- `vale-playwright.zip` 根 staging 路径（Rust swap）只换目录不改语义。
