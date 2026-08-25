# Vale Studio —— saisi.online 工作区代码编辑器与 DSH 深链互通 · 设计

日期：2026-08-25
状态：设计定稿（待实施）
关联：`gateway/public/code/`（旧快照 Source Viewer）、`extension/`（浏览器扩展）、`~/.cloudflared/`（隧道）

---

## 1. 目标与硬约束

**目标**：在 saisi.online 上提供 VS Code 级别的代码浏览/编辑体验，操作对象是 **DSH 正在工作的真实工作区文件**（实时、可编辑、随磁盘变化），并且 DSH 聊天里的文件路径可以一键跳转到 saisi.online 上对应的文件+行号。

**硬约束**（由需求推导，不可妥协）：

| # | 约束 | 推论 |
|---|------|------|
| C1 | 文件是实时的真实文件，不是快照 | 必须有一个跑在 DSH 同一台机器上的文件服务后端；Cloudflare Worker 无法直接读本机磁盘 |
| C2 | 和 VS Code 一样可编辑并保存回磁盘 | 后端必须支持原子写入；编辑器必须有 dirty 管理 |
| C3 | DSH 内路径 → 编辑器定位跳转 | 需要定义稳定的深链 URL 协议 + DSH 页面侧的链接改写机制 |
| C4 | 不破坏现有部署（dsh.saisi.online 隧道、ai.saisi.online Worker 均在生产） | 新增组件必须是增量的；不 patch DSH 本体（升级会丢） |
| C5 | 公网可达但有安全边界 | token 认证 + 路径白名单根目录；默认只监听 127.0.0.1，仅隧道可达 |
| C6 | 内置 VS Code 同款集成终端（真机 shell） | 服务端 PTY（node-pty）+ WebSocket 流 + 前端 xterm.js；会话在页面刷新/重连后存活 |

**非目标**：完整 LSP/调试器（那是 code-server 的领域）；多用户协作。集成终端在范围内（C6）。

---

## 2. 总体架构

新增一个子项目 `studio/`（服务名 **vale-studio**），一个进程同时承担「静态前端托管」和「文件 API」，经既有 cloudflared 隧道暴露为 `code.saisi.online`。前端用 Monaco Editor（VS Code 同款内核）自建轻量工作台。

```
┌────────────────────┐   ① 点击文件链接(新标签)   ┌───────────────────────────────┐
│ dsh.saisi.online    │ ───────────────────────▶ │ code.saisi.online              │
│ (DSH Web UI)        │  #/open?p=…&l=596&c=12   │ Vale Studio 前端 (Monaco)      │
└─────────┬──────────┘                           │ + 底部终端面板 (xterm.js)       │
          │ ② content-script 把消息/工具调用       │ + 同源 REST/WS API             │
          │ ② content-script 把消息/工具调用       └──────────────┬────────────────┘
          │    中的真实路径改写为深链链接                          │ ③ 同源 fetch/WS
          ▼                                                     ▼
┌────────────────────────────┐            ┌─────────────────────────────────────┐
│ DSH 会话流                  │            │ vale-studio 服务端 (:7780, 127.0.0.1)│
│  · str_replace_editor 调用   │            │  · GET /api/roots     允许的工作区根  │
│  · read/glob/grep 结果       │            │  · GET /api/tree      懒加载文件树    │
│  · 正文里的绝对/相对路径       │            │  · GET /api/file     读(+mtime/sha)  │
└────────────────────────────┘            │  · PUT /api/file     原子写           │
                                          │  · WS   /api/watch   变更推送         │
        cloudflared (同一隧道加一条 ingress)│  · WS   /api/term    PTY 终端流       │
        code.saisi.online ──▶ :7780       │  · GET /api/git/*    status/log/diff │
                                          │  · 白名单根目录 + token + 只读开关     │
                                          └─────────────────────────────────────┘
```

**为什么这样分层**：

- **同源（前端和 API 都由 vale-studio 提供）** → 无 CORS、无缓存分裂、一次部署。
- **不占用 ai.saisi.online Worker** → Worker 在边缘永远在线，但文件在本机；机器下线时 Worker 版只会显示错误页，反而误导。旧 `/code/` 快照页保留，顶部加一条"打开实时编辑器"横幅即可。
- **不 patch DSH** → DSH 升级不受影响；链接改走浏览器扩展 content-script（C4）。

---

## 3. 组件规格

### 3.1 vale-studio 服务端（`studio/server.mjs`，Node 22 ESM）

**依赖最小化**：`chokidar`（文件监听，比 `fs.watch` recursive 在 Linux 上可靠）、`ws`（WebSocket）、`node-pty`（真 PTY，终端必需的原生模块；本机有完整 gcc 工具链可编译）。其余零依赖（http、crypto、child_process 用内置）。ripgrep 若存在则用，不存在降级为 JS 逐行搜索。

#### 配置 `~/.vale-studio/config.json`

```jsonc
{
  "port": 7780,
  "bind": "127.0.0.1",            // 永远只听回环，公网入口只有隧道
  "token": "<openssl rand -hex 32>",
  "readOnly": false,
  "terminal": { "enabled": true, "shell": "/bin/bash", "tmuxWrap": false },
  "maxFileSizeMB": 8,
  "roots": [                       // 白名单工作区根；绝对路径，禁止软链逃逸
    "/home/zhengsaisi/vale",
    "/home/zhengsaisi/bdk_bcm_5.04l.04p2"
  ]
}
```

工作区感知（C1 的关键）：`GET /api/roots` 返回上述白名单，每项附 `{ exists, gitBranch, dirtyCount }`。**增强项（Phase 4）**：扫描 `~/.dsh/sessions` 元数据里活跃会话的 cwd，自动出现在"活跃工作区"分组（不在白名单内的 cwd 以只读方式展示，点击"加入白名单"才解锁写）。

#### API 契约（全部要求 `Authorization: Bearer <token>` 或 `?token=` 一次性引导）

| 方法/路由 | 语义 | 关键细节 |
|-----------|------|----------|
| `GET /api/roots` | 列出允许的根 | 附 git 分支/dirty 数 |
| `GET /api/tree?root=&dir=` | 目录懒加载 | 返回 `{name,type,size,mtime}[]`；隐藏文件默认折叠 |
| `GET /api/file?p=<abs>` | 读单文件 | 返回 `{content,mtimeMs,sha256,truncated}`；二进制探测（NUL 字节）→ 标记 `binary`，图片类型给 dataUrl |
| `PUT /api/file` | 写 | body 含 `p, content, baseSha256`；**乐观锁**：baseSha ≠ 当前 sha 时返回 `409 conflict`（磁盘已被 DSH/他人改过）；写法 = 同目录临时文件 + `rename()` 原子替换；成功返回新 sha |
| `POST /api/mkdir` `DELETE /api/file` | 建/删 | 删除进 `.vale-studio-trash/`（根内），不做真删除 |
| `WS /api/watch` | 变更推送 | 客户端订阅 root；chokidar 事件去抖 200ms 推 `{path,event}`；前端据此显示"磁盘已修改 → 重新加载?"条幅（VS Code 行为对齐） |
| `GET /api/search?q=&root=` | 全文搜索 | ripgrep `--json -S`；限制结果 500 条；正则开关 |
| `GET /api/git/status\|log\|diff?p=` | git 集成 | `child_process` 调 git，cwd 取文件所在仓库顶 |
| `POST /api/term` | 创建终端 | body `{cwd?, cols, rows}`；返回 `{id}`；默认 cwd=所选根目录 |
| `GET /api/terms` | 列出活终端 | 服务端持有的全部 pty 会话（跨页面刷新存活） |
| `DELETE /api/term/:id` | 结束终端 | SIGHUP → kill |
| `WS /api/term/:id` | 终端 IO 流 | 二进制帧=stdin/stdout 直通；文本控制帧 `{"resize":{cols,rows}}` |

**终端子系统（C6，VS Code 集成终端对齐）**：

- **服务端**：node-pty spawn 登录 shell（`$SHELL -l`），env 注入 `TERM=xterm-256color`、`COLORTERM=truecolor`、`VSTUDIO_ROOT=<当前根>`；每个终端独立会话 id。
- **持久性**：pty 由服务端持有而非页面——页面刷新/网络抖动后 WS 重连即回到原会话（输出缓冲回放最近 2000 行）；可选增强：spawn 时包一层 `tmux new -A -s studio-<id>`，连服务端重启都能恢复（Phase 4 开关）。
- **多标签**：底部面板 tab 条（`bash`、`bash (vale)`…按 cwd 命名），支持新建/切换/关闭；资源管理器右键"在此打开终端"以文件目录为 cwd。
- **前端**：xterm.js + fit 插件（仓库 `extension/terminal/vendor/` 已有同款资产，技术栈一致）；`Ctrl+`` 呼出/收起面板；链接检测点击新开标签。
- **降级路径**：node-pty 编译失败时回退 `script -qfc bash /dev/null`（util-linux 自带 pty 包装），功能等价 95%（无窗口尺寸感知的完美处理，仍可用 resize 消息 + `stty` 补偿）。

**安全模型（C5，逐条落地）**：

1. `realpath()` 后强制前缀匹配某个 root，拒绝 `..` 与软链逃逸；
2. token 错误统一 404（不泄露 401/403 区别）+ 每 IP 10 次/分钟失败熔断；
3. `readOnly: true` 时所有写路由直接关闭（不只是前端隐藏）；
4. 大小上限 8MB，超限只读预览；
5. 日志只记路径哈希不记内容；
6. **终端是 shell 级能力，单独设闸**：`terminal.enabled` 独立配置项，`readOnly: true` 时强制禁用；创建终端的请求额外要求 token 属于"已确认会话"（前端首次开启终端时二次确认一次，存 localStorage 标记）；上线 Cloudflare Access 后此风险收敛到 SSO 之后。

### 3.2 Studio 前端（`studio/frontend/`，Vite + TypeScript + `monaco-editor`）

布局完全对标 VS Code 三栏：

```
┌──────┬────────────────────────────┬──────────────┐
│活动栏 │ 标签页 [store.ts ●] [app.js ]│  编辑器        │
│ 📄🔍 │ ├─ 文件树 / 全局搜索 双模式   │  Monaco        │
│ git  │ │  src/                     │  · minimap     │
│ ⚙    │ │  ▸ store.ts               │  · 行号/断点槽位 │
│      │ └─ wrangler.jsonc           │  · 状态栏: Ln/Col│
└──────┴────────────────────────────┴──────────────┘
```

功能清单（P1–P3 逐级交付）：

- **P1**：文件树懒加载、多标签、Monaco 高亮（ts/js/rust/c/json/yaml/md/shell 内置即可）、`Ctrl+S` 保存（乐观锁冲突时弹三方对比）、行号定位、dirty 圆点、根目录切换器、暗色主题（对齐 saisi.online 控制台风格）。
- **P2**：**集成终端**（多标签 PTY、刷新重连回放、"在此打开终端"）＋`Ctrl+P` 快速打开（基于 /api/tree 缓存的模糊过滤）、`Ctrl+Shift+F` 全局搜索（/api/search）、外部变更提示条幅（WS）。
- **P3**：git 装饰（文件树红绿标记、行内 change gutter 用 Monaco decoration 画 diff）、markdown 预览、图片预览。

**Monaco 打包决策**：`monaco-editor` npm 包本地打包（约 3–5MB gzip 前），**不用 CDN**——保证 CN 网络与离线一致性；Vite 按 worker 分 chunk。

### 3.3 深链协议（跨系统契约，定死不再改）

```
https://code.saisi.online/#/open
    ?p=/home/zhengsaisi/vale/gateway/src/store.ts   // 绝对路径（必填）
    &l=596                                          // 1-based 行号（可选）
    &c=8                                            // 1-based 列号（可选）
    &sel=596.8-604.35                               // 选区（可选）
    &root=auto                                      // 冗余提示，仅加速根匹配
```

- 用 **hash 路由**：CF 边缘与隧道都不会碰 hash；切文件不发页面请求。
- 路径一律绝对路径 —— content-script 改写时负责解析相对路径（见 3.4），协议本身不留歧义。
- 未带 token 的首次访问：前端显示 token 输入框，存 localStorage 后重试；`?token=` 仅用于一次性引导链接并在进入后立即从地址栏剥离。

### 3.4 DSH → Studio 的跳转（浏览器扩展 content-script，方案对比后选定）

| 方案 | 评价 |
|------|------|
| **A. 扩展 content-script 改写 DOM（选定）** | 零侵入 DSH，升级免疫；已有 `extension/` 项目与 options 存储体系可复用；能同时处理工具调用头、正文代码块标题、行内 code |
| B. DSH client-plugin | 官方机制（`/plugins/<id>/client.js` + `__DSH_BOOT__`），但需要 pnpm dev:web 构建管线且跟随 DSH 内部 API，维护成本高 |
| C. patch 安装后的 lib | 已有先例（patch-dsh-trusted-host.sh），但每次 dsh 升级都要重打，脆弱 |

实现（`extension/content/studio-links.js`，manifest 增加 `content_scripts` 匹配 `https://dsh.saisi.online/*`）：

1. `MutationObserver` 监听会话流 DOM；
2. 匹配规则（优先级递减）：
   - 工具调用卡片头部/参数区的路径文本（read、str_replace_editor、glob、grep 的输入输出都带路径）；
   - 围栏代码块信息行 ```` ```ts path=src/store.ts ```` 或首行注释里的路径；
   - 行内 code 与纯文本中 `(/?[A-Za-z0-9_./-]+\.(ts|js|mjs|rs|c|h|json|ya?ml|md|toml|ps1))(:\d+)?`；
3. 相对路径解析：向 `https://code.saisi.online/api/roots` 查询白名单根（扩展已配 token），按"最长命中前缀"补全为绝对路径；解析失败的相对路径不改写（宁可少链接不可错链接）;
4. 改写为 `<a href="…#/open?p=…&l=…" target="_blank">`，保留原文本，样式加虚线下划线区分普通链接;
5. options 页加开关（默认开）与自定义额外域名。

**模型侧配合（可选，Phase 4，收益大）**：web surface 的 `system-prompt` 行 persona 可通过 profile patch 追加一句"引用工作区文件时始终使用绝对路径"，让改写命中率接近 100%。

### 3.5 部署接线（增量，不动现有生产）

1. `ecosystem.config.js` 增加 `vale-studio` 应用（pm2 守护，同 dsh 模式）；
2. `~/.cloudflared/<tunnel>.yml` ingress 在 404 之前插入：
   ```yaml
   - hostname: code.saisi.online
     service: http://localhost:7780
   ```
   并 `cloudflared tunnel route dns <tunnel> code.saisi.online`；
3. `scripts/build.sh` 增加 `studio` 目标（构建前端 dist + pm2 restart）；
4. 旧 `gateway/public/code/index.html` 顶部加横幅链到 `https://code.saisi.online/`。

---

## 4. 备选方案否决记录

| 方案 | 否决原因 |
|------|---------|
| **code-server / OpenVSCode Server 整包** | 完整 VS Code 体验最强，但内存重（常驻数百 MB）、UI 定制与 saisi.online 品牌割裂、深链到具体行列需绕过其内部路由；且它自带终端=把 shell 直接暴露公网面，安全面扩大。作为"重度使用后"的备选保留 |
| **只升级 gateway 快照 Viewer 加 Monaco** | 违反 C1：仍是构建期快照，不是实时工作区 |
| **把文件 API 塞进 ai.saisi.online Worker + 设备代理** | 多一跳（Worker→设备代理→agent HTTP），鉴权链复杂；而文件就在跑 DSH 的这台机器上，直连最短 |

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 用户编辑 vs DSH 同时改同一文件 | 乐观锁（baseSha256→409）+ WS 外部变更条幅；冲突时提供"磁盘版/我的版"双开对比 |
| 公网暴露文件系统 | 回环绑定 + token + 白名单 realpath 校验 + 删除进回收站；Phase 4 上 Cloudflare Access（Zero Trust email OTP）后可关掉裸 token |
| CN 到 CF 边缘延迟 | 与 dsh.saisi.online 同路（用户已在用，可接受）；Monaco 本地打包避免 CDN 抖动 |
| 终端=把 shell 暴露到公网面 | 回环绑定 + token + 独立 `terminal.enabled` 闸门 + 只读模式强制关闭终端；Phase 4 上 Cloudflare Access 后收敛到 SSO 后面；服务端不记录终端输出内容 |
| ripgrep 不存在 | 启动探测，降级 JS 搜索并标注慢速 |
| DSH 改版导致选择器失效 | content-script 规则集中在一张配置表；失效表现为"没有链接"而非报错 |

## 6. 实施阶段（每阶段独立可用、树保持绿）

- **P1 骨架可用（先行）**：server.mjs（roots/tree/file/watch + token + 白名单）＋前端（树/标签/Monaco/保存/行定位）＋隧道 ingress＋pm2。验收：`curl` 过 API 契约测试（node:test），浏览器打开 code.saisi.online 能编辑保存 ~/vale 下文件，重启进程内容持久。
- **P2 终端 + 效率**：node-pty 多标签终端（刷新重连回放、"在此打开终端"、Ctrl+`）＋快速打开、全局搜索、外部变更条幅。验收：浏览器里跑 `cargo test`/`git log` 全彩输出；断网 10 秒重连后会话与滚动缓冲仍在；readOnly=true 时终端接口返回禁用。
- **P3 DSH 打通**：扩展 content-script + options 开关；验收：在 DSH 会话里让 agent 读一个文件，点路径新标签直达对应行。
- **P4 打磨**：git 装饰、markdown/图片预览、tmux 会话持久开关、活跃工作区自动发现、Cloudflare Access、persona patch 提升链接命中率。
