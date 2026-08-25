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
npm test                                           # API 契约测试 (14)
LD_LIBRARY_PATH=~/chromium-libs/root/usr/lib/x86_64-linux-gnu \
  node test/e2e.mjs                                # 浏览器端到端 (15)
```

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
- 所有路径 `realpath` 后必须落在白名单根内（软链逃逸阻断）
- 原子写 + baseSha256 乐观锁；删除进 `<root>/.vale-studio-trash/`
- 文件监听是**定向的**：只 watch 已打开文件的目录（避免 inotify 耗尽）

## 深链协议

```
https://code.saisi.online/#/open?p=<绝对路径>&l=<行>&c=<列>&sel=<l.c-l.c>
```

DSH 页面侧由浏览器扩展 content-script 把消息里的路径改写成上述链接（P3，见设计文档 §3.4）。
