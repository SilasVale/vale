# Vale Studio

saisi.online 的工作区代码编辑器 + 集成终端。连接 **真实文件**（DSH 所在机器的磁盘），不是快照。

- **公网入口**: https://code.saisi.online （cloudflared 同一隧道的一条 ingress）
- **设计文档**: `docs/superpowers/specs/2026-08-25-vale-studio-workspace-editor-design.md`
- **前端**: 零构建 —— Monaco AMD loader（`vendor/monaco/vs`）+ xterm UMD（`vendor/xterm`）
- **后端**: Node 22 ESM，零框架；依赖 `ws` + `node-pty`（可选，降级 `script(1)`）

## 运行

```bash
pm2 start ecosystem.config.js --only vale-studio   # 生产（pm2 托管）
node server.mjs                                    # 手动
npm test                                           # API 契约测试 (17)
LD_LIBRARY_PATH=~/chromium-libs/root/usr/lib/x86_64-linux-gnu \
  node test/e2e.mjs                                # 浏览器端到端 (17)
```

## 功能

- **编辑**：单例 Monaco（多标签共享，按 model 切换），Ctrl+S 乐观锁保存，
  冲突时"从磁盘重载 / 强制覆盖"；图片内联预览；自动换行开关（设置视图）。
- **git 集成**：源代码管理侧栏（分支 + 变更列表）、文件树 M/A/D/U 徽章、
  活动栏角标、活动文件 diff gutter 增/改标注；保存后自动刷新。
- **终端**：多标签 PTY（node-pty / script 降级），tmux 会话跨重启持久并自动接管；
  面板顶部边缘可拖拽调高。
- **效率**：Ctrl+P 快速打开支持 `name:42` 行号直达与最近文件置顶；
  全局搜索输入即搜 + `<mark>` 高亮 + 截断提示；Ctrl+B 侧栏、Ctrl+J 终端；
  中键关闭标签；未保存时拦截页面刷新。
- **文件操作**：右键新建/重命名/删除（回收站）/复制路径/在此打开终端；
  mkdir/rename/trash/save 通过 watch 广播驱动树局部刷新。

## 配置 `~/.vale-studio/config.json`

```jsonc
{
  "port": 7780,
  "bind": "127.0.0.1",            // 永远只听回环；公网只走隧道
  "token": "<openssl rand -hex 32>",
  "readOnly": false,               // true 时写接口与终端全部关闭
  "terminal": { "enabled": true },
  "roots": ["/home/zhengsaisi/vale"]  // 白名单工作区根
}
```

## 安全要点

- 回环绑定 + Bearer token（错误统一 404 + 失败熔断）
- 所有路径 `realpath` 后必须落在白名单根内（软链逃逸阻断；rename 额外限定单根内）
- 原子写 + baseSha256 乐观锁；删除进 `<root>/.vale-studio-trash/`
- 文件监听是**定向的**：只 watch 已打开文件的目录（避免 inotify 耗尽）

## 快捷键

| 键 | 作用 |
|----|------|
| Ctrl+P | 快速打开文件（`name:行号` 直达） |
| Ctrl+S | 保存（乐观锁） |
| Ctrl+Shift+F | 全局搜索 |
| Ctrl+B / Ctrl+J | 侧栏 / 终端面板开关 |
| Ctrl+` | 终端面板开关 |
| Esc | 关闭弹层 |

## 深链协议

```
https://code.saisi.online/#/open?p=<绝对路径>&l=<行>&c=<列>&sel=<l.c-l.c>
```

DSH 页面侧由浏览器扩展 content-script 把消息里的路径改写成上述链接（P3，见设计文档 §3.4）。
