# terminal-browser（zenbu-labs）技术调研报告

> 调研时间：2026 年（main 分支，commit `90ee8f5`）。目的：评估 Vale（Windows 服务 agent + Web 面板）转向"真像素终端"路线时，可否借鉴该项目的 Chromium 像素管线。

## 项目概览

terminal-browser 是一个"跑在终端里的真浏览器"。它用 Electron 的 offscreen rendering 从 GPU 直接读 Chromium 像素（macOS 走 shared texture/IOSurface，Linux 走共享内存 SHM），通过 kitty graphics protocol（`\x1b_G...` 转义序列）把像素画进支持该协议的终端（ghostty/kitty/tmux/wezterm 等）；同时监听终端上报的鼠标/键盘事件合成 `sendInputEvent`/CDP `Input.dispatchKeyEvent` 发给 Chromium，并用后台 Swift 程序补足终端拿不到的系统级输入（触控板、平滑滚动）。浏览器外壳 UI 由 Rust 图形引擎（pixel-core + tiny-skia/taffy/fontdue）自绘，React 通过自定义 reconciler（pixel-react）驱动，外层 UI 与网页内容合入同一张 Canvas 后整帧输出。

```
┌─────────────────────────────────────────────────────────────┐
│ 终端 (ghostty/kitty/tmux/wezterm...)                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  kitty graphics 像素 + 终端鼠标/键盘事件流             │  │
│  └───────────────────────────────────────────────────────┘  │
└───────────────▲───────────────────────────┬─────────────────┘
                │ 转义序列 (TTY)             │ 输入事件
┌───────────────┴───────────────────────────▼─────────────────┐
│ Rust 引擎 pixel-core (独立线程, N-API 桥)                    │
│  Tree(React 描述→布局 taffy)→Canvas(合成 多view+分割条+UI)   │
│  → 像素编码 kitty 协议 → 写 TTY (damage 区域更新)            │
│  输入: 解析终端事件 → 语义化 EngineKeyEvent/PointerEvent     │
├─────────────────────────────────────────────────────────────┤
│ Electron 主进程 (单 daemon)                                  │
│  runDaemon: Unix socket JSON-RPC, 每 TTY pane 一个 Session   │
│  offscreen BrowserWindow: 读 GPU 像素 → surface.present()    │
│  PageInput: 合成 mouseDown/rawKeyDown/char 等输入事件        │
│  CDP (remote-debugging-port) 暴露给 agent                    │
├─────────────────────────────────────────────────────────────┤
│ 浏览器 UI: React + pixel-react 自定义 renderer               │
│  (标签栏/URL 栏/命令面板, 与网页同画布分层)                  │
└─────────────────────────────────────────────────────────────┘
   ┌──────────────────────────────────────────────────────┐
   │ CLI (terminal-browser):  spawn/检测终端/查 TTY/分裂窗格│
   │  ls/action(agent)/ssh 隧道 / SQLite store (drizzle)   │
   └──────────────────────────────────────────────────────┘
```

## 关键实现细节

- **offscreen 渲染**（`browser/src/page/offscreen.ts`）：macOS 用 `useSharedTexture: true` + IOSurface，Linux 用 `useSharedMemory`（SHM fd）；**无 Windows 分支**。`paint.ts` 的 `presentPaint` 统一走 `surface.present()`，支持 texture/SHM/bitmap 三通路，带 damage 区域与 `BitmapPresenter` 帧合并。
- **引擎↔Node 桥**（`pixel-node/src/lib.rs`）：`PixelEngine` 构造时吃 `tty` + `wrapper`（tmux 透传），Rust 线程跑 `engine.pump()` 事件循环，通过 N-API threadsafe function 把事件 JSON 推给 Node；JS 侧 `apply_ops` 传 UI 操作、`update_surface` 传像素。`SurfaceMailbox` 做帧合并/缓冲回收。
- **输入合成**（`browser/src/page/input.ts`）：终端事件→`sendInputEvent`（mouseDown/mouseMove/mouseWheel/rawKeyDown/char/keyUp）+ CDP `Input.dispatchKeyEvent`（Enter、macOS 编辑命令如 `moveWordLeft`、粘贴），处理 dpi 缩放、wheel 余量、双击计数。
- **SSH 模式**（`cli/src/ssh.ts`）：**不是传帧**。`ssh -f -N -M -D <socks>` 起本地 SOCKS5，Chromium 网络请求全部走远程；另有 `--ssh-bundle` 把带 `start` 脚本的应用包 scp+tar 到远端执行，等 `READY <url>` 再打开。
- **多会话**：单 Electron daemon（`daemon.ts`，Unix socket，空闲 15s 退出），每个终端 pane 一个 Session（每 session 一个 key）；SQLite `instances` 表（key/pid/tty/socket/cdpPort/tabs/…）支持 `terminal-browser ls` 列出所有打开中的浏览器。
- **AI/agent 接口**：`terminal-browser action -- <agent-browser 命令>`：连接该浏览器 CDP 端口、把 tab 映射到 vercel-labs/agent-browser（v0.33.0）会话，拦截 open/close/new 走自家 socket；socket 控制命令含 `open-tab`/`activate-tab`/`close-tab`/`agent-touch`/`agent-release`（agent 操作时冻结页面交互，防人机互抢）。进程发现靠 `~/.local/state/terminal-browser-interop/instances/*.json` 广告 + PID 存活检查。

## License

**MIT**（`LICENSE`：Copyright 2026 Zenbu Labs, Inc.）。可自由 fork、修改、商用，仅需保留版权声明。依赖中 kitty graphics protocol 本身来自 kovidgoyal/kitty（GPLv3 项目，但**协议是开放规范**，仅实现协议无传染）；electron/agent-browser 等为各自许可。

## Windows 可移植性评估

**结论：架构思想可移植，代码不能直接搬。** Rust 引擎本身跨平台（rustix/tiny-skia/taffy/fontdue/arboard 均支持 Windows），但外围层深度绑定 Unix：

| 层 | 可移植性 | 说明 |
|---|---|---|
| Rust 像素引擎（合成/布局/字体） | ✅ 基本可复用 | 与 TTY 输出解耦，理论上可换输出后端 |
| Electron offscreen 读帧 | ⚠️ 需重写 | 目前仅 macOS(IOSurface)/Linux(SHM) 路径；Windows 需 bitmap fallback（`presentBitmap` 已有雏形）或 D3D shared texture（需自改 Electron） |
| 终端交互（kitty 协议/TTY 检测/tmux wrapper/`\x1b[14t` 像素查询） | ❌ 需替换 | Vale 是自绘终端窗口，应把"写 TTY"换成"写自绘 surface" |
| 输入层（终端转义输入 + Swift 后台监听） | ❌ 需重写 | Windows 上改用 Win32/低级键盘钩子或前端 DOM 事件直接驱动 |
| Unix socket 进程间通信/`~/.local` 路径/`process.kill(pid,0)` | ❌ 需重写 | 换 named pipe / 注册表/Windows 路径 |
| SSH 隧道（依赖系统 `ssh`/`tar`/`/tmp`） | ⚠️ 部分可用 | Windows OpenSSH 可用，但控制路径/别名解析逻辑要改 |
| Electron daemon + 多 session 模型、SQLite store、CDP agent 接口 | ✅ 架构可借鉴 | 与平台关系小 |

对 Vale 的启示：terminal-browser 验证了「Electron offscreen 读 GPU 像素 → 内存合成 → 输出到任意像素面」这条路线的可行性（README 称"不丢帧"）。Vale 若自绘终端窗口，**引擎侧（合成、帧合并、damage）可参考，输出端直接从"kitty 编码写 TTY"替换为"贴到自绘窗口 surface"**，输入端直接吃前端事件而不必经转义序列——反而比原项目简单（省掉终端协议适配层）。

## 可复用部分清单

1. `engine/crates/pixel-core`：Canvas 合成、taffy 布局、字体光栅化、多 view 分割条、damage 追踪（逻辑独立于 TTY）
2. `engine/crates/pixel-node`：SurfaceMailbox 帧合并/缓冲回收、N-API 线程桥模式
3. `browser/src/page/input.ts`：终端事件→Chromium 合成事件映射（可移植为前端事件→合成事件）
4. `browser/src/page/offscreen.ts` + `paint.ts`：offscreen 读取与三通路 present 模式（Windows 需要补第四通路）
5. 多 session 模型：daemon + per-pane Session + SQLite 实例表（`store/src/schema.ts`）
6. agent 控制协议：`action` CLI + socket 命令（`open-tab`/`agent-touch`/`agent-release`）+ CDP 暴露
7. App Mode：preload/main-script 自定义应用（对应 Vale 的 Web 面板可内嵌）

## 局限

- **平台**：官方只支持 macOS/Linux（README 声明 macOS/Linux 安装），Windows 无支持、无 CI、offscreen 无 Windows 路径。
- **无原生窗口**：一切输入都要经终端转义序列还原（键盘修饰符、滚轮精度、剪贴板图片都靠 hack），自绘窗口路线反而规避这些问题。
- **多会话受终端 pane 模型限制**：实例 key 绑定 TTY，脱离终端无法表达多会话。
- **agent 接口依赖 vercel-labs/agent-browser**（启动时 `cargo install` 编译，首次运行慢），且用 `performance.timeOrigin` 猜 tab 映射，比较脆弱。
- **SSH 模式**：SOCKS 代理方案只代理网络请求，本地渲染、远程应用仍需 bundle 约定（`start`/`stop`/`READY` 协议）。
- **记录功能**（record/）和 capture 是额外复杂度，与"真像素终端"核心无关。
- **风险提示**：offscreen 读帧依赖项目自有的 Electron patch（`ShmFrame` 类型注释明说 "based on an electron patch this project owns"），上游 Electron 版本跟进成本高——自绘窗口 + 原生 BrowserWindow 可完全绕开该 patch。
