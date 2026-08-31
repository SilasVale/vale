# d1 Browser 面板全面测试报告

> 测试对象：`https://d1.agent.saisi.online/panel/`（设备 d1 的 Vale Agent 面板 → Browser 页）
> 测试日期：2026-08-31
> 测试方式：Playwright headless 打开面板 + 设备侧 API/进程验证
> 架构背景：面板 SPA 由 `agent/resources/panel-react/` 构建，agent（`src/web.rs`）托管。
> Live 视图 = 前端 WS → agent `/api/browser/ws` relay → bridge.js（127.0.0.1:9224）→ headless chromium 截屏 JPEG 帧。
> Evidence 视图 = 轮询 `/api/browser/pwshots` + `/api/browser/pwshot`（pwout 目录，AI 工作痕迹截图）。

## 结论摘要

**核心链路是通的**：认证 → WS 连接 → Live 帧流 → Evidence 轮询 → 标签页管理 → 缩放 → 全屏都工作。
但存在 **1 个致命交互 bug、3 个显示/UX 缺陷、1 个环境遗留问题**，且**导航到多数外网失败**（环境限制）让面板看起来"坏了"，这是"显示需要重构"感知的主要来源。

> **2026-08-31 修复状态**：P0/P1/P2/P3 已修复并随 agent **1.0.118 / npm 1.2.114**（含 P1 的 .115）发布到 d1，
> 面板 UI 同时完成重构（runner 状态条 → 视图行紧凑 chip、删 fps、zoom 改 transform、
> 控件全面改用 chrome 主题变量）。P4 为 agent 端小改（待做）；P5 已现场清理；P6 属网络环境。

---

## ✅ 正常功能（已实测通过）

| 功能 | 结果 | 备注 |
|---|---|---|
| token 登录（?token= 注入） | ✅ | localStorage 保存，SSE 连接正常 |
| Browser 页导航（IconRail） | ✅ | `aria-label="Browser"` 按钮 |
| Live/Evidence 视图切换 | ✅ | 状态保持 |
| Live 帧流（bridge 截屏） | ✅ | blob URL 实时帧，1fps（静态页正常值） |
| 标签页：新建/切换/关闭 | ✅ | 推送到 bridge，多页签正确 |
| 缩放 75/100/125/150% | ✅ | 生效（修复后为 transform 缩放，可滚动） |
| 全屏切换 | ✅ | 成功进入/退出 fullscreen |
| Evidence 截图轮询/显示 | ✅ | 3s 轮询，缩略图+大图正常 |
| AI 活动指示器 | ✅ | 新截图 90s 内显示 |
| URL 历史（datalist） | ✅ | localStorage 记忆，去重 20 条 |
| AI runner 状态显示 + SSE 事件刷新 | ✅ | mount 拉取 + `playwright-changed` 事件驱动，工作正常 |
| 键盘/鼠标事件转发 | ✅ | 通过 WS 发送到 bridge |

## ❌ 问题清单

### P0 — 致命交互 bug：每一帧都从地址栏抢走焦点【已修复】
`BrowserPane.tsx` 旧代码 `<img onLoad={() => imgRef.current?.focus()}>`——`applyFrame` 每收一帧就更新 `img.src`，每次 `onLoad` 都**无条件 focus frame**。实测：
- 点击地址栏后约 **1 秒**（下一帧到达）焦点跳到 `browser-frame`（FOCUS_TIMELINE: 900ms url → 1000ms frame）
- 之后所有按键被 frame 的 `onKeyDown` 拦截、**发给远程浏览器**：地址栏输入 `https://example.com` 实测只进 `https://exam`，Enter 不触发导航
- jsdom 回归测试：3s 内 img load 事件 4 次，焦点必失

**修复**：首次帧到达时在 `useBrowser.applyFrame` 里 focus 一次；后续帧不再动焦点；用户主动点击 frame（onMouseDown）才把焦点交给远程页面。回归测试：首帧 focus 恰好一次、后续帧不 focus。

### P1 — 功能性 bug：非 http(s) URL 被强制加 `https://` 前缀【已修复】
`hooks/useBrowser.ts` `navigate()` 旧代码:
```ts
const u = url.startsWith("http") ? url : `https://${url}`;
```
- `data:text/html,...` → `https://data:text/html,...`（实测复现）
- `about:blank`、`chrome://...`、`file://...` 同样受害
- **修复**：已知 scheme 白名单原样保留（data/about/blob/file/chrome/view-source…），其余才补 `https://`（`localhost:3000`、裸主机名仍正确规范化）。回归测试覆盖。

### P2 — 显示缺陷：暗色主题下 tabstrip/urlbar 仍是浅色【已修复】
`styles/components.css`:
```css
.browser-tabstrip  { background: var(--ds-neutral-100); }   /* 实测 rgb(244,244,245) 不随主题 */
.browser-urlbar    { background: var(--ds-neutral-50); }    /* 实测 rgb(250,250,250) 不随主题 */
.browser-view-switch { background: #fff; }                  /* 硬编码白色 */
```
暗色主题下这些区域与暗色 viewport（rgb(19,20,24)）**严重割裂**，亮白一片。
- **修复**：改用 `--chrome-bg` / `--chrome-bg-2` / `--chrome-bg-3` 主题变量（实测暗色下 rgb(23,24,29)/rgb(31,32,38) 正确跟随）

### P3 — 显示缺陷：frame 高度溢出 viewport，图像被裁【已修复】
`.browser-frame` 旧样式只有 `width: 100%`，高度按 1280x800 原始比例自适应：
- 1440x900 窗口：frame 867px vs viewport 727px（溢出 140px，底部被裁）
- 800x600 窗口：frame 467px vs viewport 458px（仍溢出 9px）
- **修复**：`width/height: 100% + object-fit: contain`（实测 1440x900 下 frameH == vpH == 799，不再裁切）；zoom 从"width 百分比"改为 `transform: scale()`，100% 完整显示、放大后可滚动

### P4 — UX 缺陷：runner stop 后状态可能粘滞【未修复，agent 端】
`manager.rs stop()` 先 `notify_changed()` 推 SSE 事件，**进程退出后才真正释放端口**；面板收到事件立即 refresh，若 TCP 探测时端口仍监听则显示 running，且 stop 完成后**不再推第二次事件**，面板停在 running。
- **修复建议**：stop 完成后补推一次 `playwright-changed`；或 status 对"正在停止中"的实例返回 transitional 状态

### P5 — 环境遗留问题：d1 残留 zombie playwright 进程干扰 runner 启动
实测：面板/API start 多次报 `playwright-mcp did not become healthy`，原因是 9229 端口被残留的 wscript 启动器（PID 392）+ stdio 实例（PID 4416）干扰；清理后手动启动 playwright-mcp 立即成功。
- 根因：多次 start/stop 或外部计划任务与 agent spawn 竞争
- **建议**：agent `start()` 前除 `reap_leftovers()`（只清 playwright node + chromium）外，也检查并清理 wscript/run-hidden.vbs 残留；或 status() 对残留进程占端口的情况给出明确提示

### P6 — 环境限制：bridge chromium 访问外网失败（非代码 bug）
- wikipedia/google → `net::ERR_CONNECTION_RESET`（本机 curl 同样 000，网络策略限制）
- example.com/baidu.com → 正常
- **面板侧影响**：导航到受限网站显示 chrome-error 页，用户误以为面板坏了
- **建议**：前端在导航后检测 tab URL 为 `chrome-error://` 时显示友好错误条（"目标网站无法访问，可能是网络限制"），而不是展示 chrome-error 内容

---

## 复现步骤（以修复前的 P0/P1 为例）
1. 打开 `https://d1.agent.saisi.online/panel/?token=<token>`
2. 点 Browser 图标
3. 【P0】点击地址栏，停顿 1 秒以上继续打字 → 焦点被抢、字符"消失"（进了远程浏览器）
4. 【P1】地址栏输入 `data:text/html,<h1>test</h1>` 按 Go → 地址栏变成 `https://data:…`，导航失败

## 环境信息
- agent: `vale-agent.exe` **v1.0.118**（修复发布后；测试时为 v1.0.117）
- bridge: `D:\Vale\playwright\node.exe bridge.js 9224`（正常运行）
- playwright-mcp: 9229，external healthy（ValePlaywright 计划任务托管）
- 面板 UI 代码: `agent/resources/panel-react/src/components/BrowserPage.tsx` / `BrowserPane.tsx` / `hooks/useBrowser.ts`
- 桥接代码: `agent/resources/browser-bridge/bridge.js`
- agent 服务端: `agent/src/web.rs`（/api/browser/* 路由）+ `agent/src/plugins/playwright/manager.rs`（runner 管理）

## 相关代码位置速查
| 问题 | 文件 |
|---|---|
| 焦点抢占【已修复】 | `panel-react/src/hooks/useBrowser.ts` applyFrame + `BrowserPane.tsx` onLoad/onMouseDown |
| URL 规范化【已修复】 | `panel-react/src/hooks/useBrowser.ts` navigate() |
| 暗色主题【已修复】 | `panel-react/src/styles/components.css`（chrome 变量） |
| frame 适配【已修复】 | `panel-react/src/styles/components.css` .browser-frame（object-fit: contain） |
| runner 状态粘滞 | `agent/src/plugins/playwright/manager.rs` stop/notify |
| zombie 清理 | `agent/src/plugins/playwright/manager.rs` reap_leftovers |
| chrome-error 检测 | `panel-react/src/components/BrowserPane.tsx`（可加） |

## 修复发布记录
| 版本 | 内容 |
|---|---|
| agent 1.0.118 / npm 1.2.114 | P0 焦点修复 + 面板 UI 重构（runner chip、删 fps、transform zoom、chrome 主题变量、AI banner 浮动）+ P2/P3 |
| agent 1.0.118 / npm 1.2.115 | P1 URL scheme 规范化修复 + 回归测试 |

均通过 `npm pack → v.saisi.online/dl → index worker 部署（sha 冒烟）→ d1 vale update` 发布并线上复验。
