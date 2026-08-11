# Vale 全站统一 — 苹果浅色风格

日期:2026-08-11
状态:已确认(用户指定苹果风格 + 浅色)

## 背景

Vale 全家桶的 6 处页面各有各的样式语言,品牌色不统一:
- **网关控制台**(gateway/public):暖白底 + 青绿 #0e9384 + Space Grotesk —— 最完整的一套
- **vale-agent 面板**(agent/resources/panel):浅蓝 #5b6cf0,无毛玻璃
- **index 下载站**(index/src/index.js 内嵌):蓝紫渐变 #5b6cf0→#8a6ff0
- **扩展 popup / options / terminal**(extension/):灰蓝,简陋
- **code viewer**(gateway/public/code/):与 console 同源,但独立文件

用户要求:**所有页面统一到苹果浅色风格**,包括 vale-agent 应用程序(tray 图标、面板、安装器)。

## 设计 token(统一基准)

```css
:root {
  /* 苹果浅色 */
  --bg: #f5f5f7;            /* 苹果系统灰底 */
  --surface: #ffffff;       /* 卡片/毛玻璃表面 */
  --surface-glass: rgba(255,255,255,0.72);  /* 毛玻璃 */
  --ink: #1d1d1f;           /* 苹果墨黑 */
  --muted: #6e6e73;         /* 次级文字 */
  --faint: #86868b;
  --line: rgba(0,0,0,0.08); /* 细分隔线 */
  --line-strong: rgba(0,0,0,0.14);

  --accent: #0e9384;        /* Vale 青绿(保留品牌色) */
  --accent-ink: #0b7a6e;
  --accent-soft: #e7f5f2;
  --danger: #dc2626;

  /* 苹果圆角 + 阴影 */
  --radius: 14px;
  --radius-sm: 10px;
  --radius-lg: 20px;
  --shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-lg: 0 12px 32px rgba(0,0,0,0.12);

  /* 苹果字体栈(系统 SF,回退 PingFang) */
  --font: -apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB",
          "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
  --font-display: -apple-system, "SF Pro Display", "PingFang SC", sans-serif;
  --font-mono: "SF Mono", ui-monospace, "JetBrains Mono", Consolas, monospace;
}
```

毛玻璃通用卡片:

```css
.glass {
  background: var(--surface-glass);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
```

品牌 mark:墨黑圆角方块 + 白色 V,圆角 10px,可选毛玻璃底。

## 改动清单

### 1. agent/resources/panel/(vale-agent 面板,web.rs include_str 内嵌)
- `index.html` / `panel.css` / `panel.js`:
  - CSS 换为统一 token;工具栏毛玻璃;xterm 白底墨字保留
  - **修复布局**:加 `window resize` + `visibilitychange` 监听,统一 `refitAll()` 对所有 session `fit.fit()`
  - favicon:内嵌 SVG 品牌 mark(web.rs 需加一行 serve)
- 构建:`cargo xwin check` + 重编译发布

### 2. extension/(popup / options / terminal)
- 三个页面的 HTML/CSS 换统一 token + 毛玻璃
- 图标:icons/ 换成统一品牌 mark(16/48/128)
- 重新 zip 打包 → index/public/vale-agent/vale-browser-control.zip

### 3. index/src/index.js(下载站)
- 内嵌 PAGE 的 CSS 换统一 token;「Vale Command」文案 → 「Vale Agent」
- favicon:内嵌 SVG
- 部署 index worker

### 4. gateway/public/(控制台)
- 保持浅色基准,但向苹果风格收拢:毛玻璃侧边栏、阴影/圆角微调
- favicon + 品牌 SVG
- 镜像 code/files/vale-gate/ 同步

### 5. code viewer(gateway/public/code/)
- 同 console 风格,跟随统一 token

### 6. vale-agent 应用本身
- tray 图标(tray-icon.png 32x32):换成统一品牌 mark
- 安装器(vale-agent-install.nsi)图标 + 面板 title/favicon
- 重编译 vale-agent + vale-tray

### 7. 目录重命名(顺手)
- `command/` → `agent/`(git mv 已完成)
- build.sh / build-installer.sh / README / CLAUDE.md / index.js 注释 / DEVICE-INTEGRATION.md 路径更新

## 验证

- `./scripts/build.sh` 全绿(cargo xwin check + build)
- 每个页面截图对比(浅色 + 毛玻璃 + 圆角)
- 扩展 zip 重打包,控制台下载链接可用
- 部署 gateway/index,线上检查
