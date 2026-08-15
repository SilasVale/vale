# Vale Agent 管理界面 — 对标 DeepSeek Harness 设计(v2,评审修订版)

## 背景与目标

vale agent 目前只有终端面板(`/panel`)+ 状态卡(`/`)。对标 dsh(127.0.0.1:3080)的完整管理界面。

**评审后范围修正**:dsh 的 AI-session 架构(会话持久化、LLM 轨迹、上下文组装)在 Vale 是终端命令审计轨迹——**轨迹 = 终端审计日志**(`/api/sessions/{sid}` 已完整提供),不是 AI 轨迹。界面是**终端会话管理**,不是 LLM 会话管理。

## 架构决策(v2)

| 决策 | 选择 | 理由 |
|---|---|---|
| 界面位置 | 设备本地(**127.0.0.2:18080**)+ 云端入口(复用现有 proxy) | 设备离线可看(agent 活着时) |
| 技术栈 | React + Vite **单 iife bundle**(无 code-split)+ 单一全局 CSS | 匹配现有 vite 配置 + web.rs 资产白名单 |
| playwright 管理 | **随包分发 node.exe + playwright-mcp,用 Edge channel**(`--browser msedge`),按需启停 | 设备必有 Edge,免 150MB Chromium;按需避免常驻 SYSTEM 浏览器 |
| 数据流 | 本地直调 agent API;云端经 `/api/devices/<n>/proxy` 代理(已存在) | 零新链路 |
| 轨迹 | **终端审计日志**(复用 `/api/sessions/{sid}`),**不新增 `/api/sessions/detail`** | 已有 endpoint 完整服务 |

## 界面结构(v2,修正映射)

| dsh 视图 | Vale 界面(修正后) |
|---|---|
| AppFrame(三列可调:侧边栏/中/详情) | App 根:侧边栏(会话列表)+ 主区(会话)+ 右列(详情,可调/可关) |
| ChatView + ToolCallTree(工具卡) | **命令卡流**:每个命令一张卡(命令/实时输出/退出码/时长/展开复制),点卡 → 详情列 |
| DetailsPanel(单调用检查器) | **详情列**:点命令卡 → 显示该调用的参数(JSON)+ 输出 + 退出码 |
| TrajectoryView(会话轨迹 tab) | **轨迹 tab**(会话内):`/api/sessions/{sid}` 事件分组,回合分组、搜索、折叠、加载更早 |
| ConfigurablePluginsTab | **插件状态页**(只读目录:状态点/启用标签)+ **playwright 启停区**(Vale 特有) |
| JobListAction(后台作业) | 插件启停/更新进度条(会话头 popover) |
| TodoPanel / ApprovalPanel / ContextMeter | **第一版不做**(评审:语义是 LLM 代理专用,且拖入未定义 agent API) |

**会话持久化**:复用现有 `/api/sessions`(列表)+ `/api/sessions/{sid}`(审计 JSONL)。侧边栏会话行:标题/相对时间/重命名/归档。

## 新增 API(agent 侧,v2 精简)

```
GET  /api/plugins/status          # playwright 运行状态/版本(其余用 /api/spec)
POST /api/plugins/playwright/start  # 按需启动:spawn node.exe playwright-mcp --port 9229 --browser msedge
POST /api/plugins/playwright/stop   # 停止(先断开 mcp_client 连接,再 taskkill /T)
```

- **不新增** `/api/sessions/detail`(已有 `/api/sessions/{sid}`)
- 全部走 **check_auth**(web.rs:252 已覆盖所有 /api/*,非 TokenGate——TokenGate 只包 /mcp)
- 路由改动:handle_request 的 match 加 2 个 exact arm + 1 个 guard arm(web.rs:426-537)
- 插件进程状态:放 **AppState 的 `Arc<PlaywrightManager>`**(持 Child + 状态),web.rs 读取;不塞 PluginRegistry

## 安全(v2,评审补强)

1. **playwright 显式 127.0.0.1 绑定 + per-launch secret**(argv/env 传递,mcp_client_connect 校验后才分发工具)——防 DNS rebinding + 端口 squatting
2. **start 后轮询健康**(127.0.0.1:9229/mcp)再报成功;stop 先断 mcp_client 再 taskkill
3. **UI XSS 纪律**:轨迹/命令输出**一律 text-only 渲染**(不 innerHTML),CSP 收紧,localStorage token 不注入 DOM
4. **修正地址**:127.0.0.2:18080(默认绑定);web.rs Host 门禁加 127.0.0.2 到 loopback 集
5. **声明**:playwright 是设备上第二个信任域(9229),以 Edge channel + SYSTEM 受限账户缓解;若设备无人工浏览,rebinding 面小(明确假设)

## 打包(v2,修正)

- 只捆绑 **node.exe(LTS 20+)+ playwright-mcp node_modules**(~40-50MB 安装包),**不捆绑 Chromium**(用设备 Edge)
- NSIS:silent-upgrade 分支加 playwright bundle 解压;Uninstall 段加 bundle 目录
- 按需启停(不 boot-spawn)——避免常驻 SYSTEM 浏览器

## 实施顺序(v2,按评审砍范围)

1. **Phase 1(核心)**:agent 薄 API(仅 playwright status/start/stop,复用 /api/spec + /api/sessions)+ 本地 React UI(侧边栏、插件页、会话详情列、轨迹 tab)
2. **Phase 2**:云端"打开面板"按钮(复用现有 proxy + 扩展 popup)
3. **Phase 3**:打包(msedge channel 优先)

**明确**:新 UI **替换**现有 `/panel`(不是并存);这是**单个实现计划**,不是路线图。

## 视觉设计(dsh 质感 × Vale teal 主题)

**dsh 视觉语言**(已研究透,源码参考):
- **几何**:胶囊按钮(radius 18, h36)、高圆角卡片、Figma 精确规格
- **token 系统**:`--dsw-static-neutral-*`(50-1000 灰阶)、`--dsw-static-deepseek-*`(品牌蓝)、`--dsw-static-amber-*`(警示)
- **动效**:`--ds-ease-in-out: cubic-bezier(0.4,0,0.2,1)`、`--ds-transition-duration` 0.2s / fast 0.1s / slow 0.3s、`prefers-reduced-motion` 尊重
- **组件质感**:StateDot(状态点)、Pill、Toast、HoverCard、JsonTree、TerminalBlock、自定义滚动条

**Vale 落地**(dsh 质感 + Vale 品牌):
- **配色**:dsh 的 neutral 灰阶体系保留;品牌色用 Vale 的 `--accent #0b7a6e`(teal)替代 dsh 的 deepseek 蓝;警示用 amber 同 dsh
- **token 命名**:`--ds-ease-in-out`、`--ds-transition-duration*` 直接照搬;Vale 增加 `--vale-accent` 别名
- **几何/动效/组件**:照 dsh 的胶囊按钮、3 列可拖 grid、StateDot、JsonTree、TerminalBlock、hover/tooltip、自定义滚动条
- **字体**:SF Pro(Apple)+ PingFang SC(中文),同 Vale 现有

## 验证

- 本地:start → 9229 监听 → mcp_client_connect 连上(带 secret)→ 轨迹 tab 显示 `/api/sessions/{sid}` 事件分组
- 安全:无 token 的 9229 访问被拒;UI 渲染命令输出无 XSS
- 打包:Setup.exe 装到干净 Windows(无 Node)→ UI 可用,playwright 用 Edge 启停
