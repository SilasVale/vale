# Vale Command — 部署指南（Windows 主机 + Cloudflare）

Vale Command 是一个 **headless MCP 服务器 + 网页面板**：跑在一台接有设备
（串口 + 网线）的 Windows 电脑上，通过 Cloudflare Tunnel 暴露到
`command.saisi.online`，任意位置的 Claude Code / 浏览器连过去操作设备。

本目录只包含**部署所需脚本和样例**，代码在仓库根目录。

## 一键安装（推荐）

在目标 Windows 机器上（管理员 PowerShell）跑一条命令：

```powershell
irm https://command.saisi.online/vale-command/vale-command-setup.ps1 | iex
```

脚本自动完成全部：下载 `vale-command.exe` → 生成配置+token → 装服务 →
装 cloudflared → Cloudflare 认证 → 建隧道 → 配 `d1.command.saisi.online` →
注册 cloudflared 服务 → 打印 token 和 Claude Code 配置。

**Cloudflare 认证二选一：**
- **交互式**（默认）：脚本中途弹浏览器，点一次 Authorize。适用于没有 API token 的情况。
- **API token**（无弹窗）：先设环境变量再跑。token 只需 `Tunnel:Edit` + `Zone:DNS:Edit`，只在安装时使用、不落盘：
  ```powershell
  $env:CLOUDFLARE_API_TOKEN = "cfat_..."
  irm https://command.saisi.online/vale-command/vale-command-setup.ps1 | iex
  ```

> 脚本和 exe 由 `command.saisi.online` 的 Worker 托管
> （cloudflare 仓库 `vale-command-index/public/vale-command/`）。
> 也可以在设备页直接下载 `vale-command-setup.bat`（双击自提权运行，等价于上面的 `irm | iex`）。

多设备：脚本接受 `-Hostname`，用 scriptblock 形式传参（`irm | iex` 传不了参数）：
```powershell
& ([scriptblock]::Create((irm "https://command.saisi.online/vale-command/vale-command-setup.ps1"))) -Hostname d2.command.saisi.online
```

## 目录

- `vale-command-setup.bat` — 一键安装入口（双击下载，自提权后拉取并运行 `vale-command-setup.ps1`）
- `vale-command-setup.ps1` — 完整一键安装脚本（下载 exe、装服务、Cloudflare 隧道、打印 token）
- `install-service.ps1` — 把 vale-command 注册为 Windows 自启服务
- `cloudflared-config.example.yml` — Cloudflare 隧道配置样例
- `claude-mcp.example.json` — Claude Code 的 MCP 配置样例
- `build-windows.ps1` — 在 Windows 本机构建 headless 二进制
- `build-linux-xwin.sh` — 在 Linux 交叉编译 Windows headless 二进制

## 架构

```
command.saisi.online（设备清单页，可选，见多设备）
dN.command.saisi.online ──Cloudflare Tunnel──► Windows 上的 vale-command ──► 设备(串口/网线)
Claude Code（任何地方）──HTTPS/MCP──► https://dN.command.saisi.online/mcp
浏览器（任何地方）──► https://dN.command.saisi.online（网页面板）
```

---

## 单机部署步骤

### 1. 构建 headless 二进制

**在 Windows 本机构建**（推荐）：

```powershell
.\deploy\build-windows.ps1
# 产出 target\release\vale-command.exe
```

**或在 Linux 交叉编译**（需要 `cargo xwin`）：

```bash
./deploy/build-linux-xwin.sh
# 产出 target/x86_64-pc-windows-msvc/release/vale-command.exe
```

> 特性说明：默认 `--features terminal,browser` 启用串口/SSH/PTY 终端和
> headless 浏览器（Edge/Chrome）。只要串口/终端可去掉 `browser`。

### 2. 安装并注册为服务

把 `vale-command.exe` 放到 `C:\vale-command\`，然后：

```powershell
.\deploy\install-service.ps1 -InstallDir "C:\vale-command"
```

脚本会：生成/更新 `config.yaml`（首次自动生成 Bearer token）、用 `sc create`
注册 `ValeCommand` 服务并设为自启、立即启动。

服务起来后看 token：

```powershell
Select-String -Path "C:\vale-command\config.yaml" -Pattern "auth_token"
```

### 3. Cloudflare Tunnel 暴露到公网

```powershell
winget install cloudflared
cloudflared tunnel login          # 浏览器授权（用现有 saisi.online 账户）
cloudflared tunnel create vale-command
cloudflared tunnel route dns vale-command d1.command.saisi.online
# 按 cloudflared-config.example.yml 填好 C:\Users\<你>\.cloudflared\config.yml
cloudflared service install       # 注册为自启服务
```

确认：浏览器打开 `https://d1.command.saisi.online`，输入 token 后看到面板。

### 4. 接入 Claude Code

在 Claude Code 配置里加一个 MCP server（把 `<TOKEN>` 换成 config.yaml 里的）：

```json
{ "mcpServers": { "vale-command": { "type": "http",
  "url": "https://d1.command.saisi.online/mcp",
  "headers": { "Authorization": "Bearer <TOKEN>" } } } }
```

> 新增 MCP 工具后需要重连/重启 Claude Code 才会刷新工具列表。

---

## 多设备（每台机器一个实例）

每台新机器重复上面的**第 1–3 步**，只改子域名编号（`d2.command.saisi.online`、
`d3.command.saisi.online` …），每个实例独立 token、互不影响。

可选的聚合页：一个极轻 Cloudflare Worker 作为 `command.saisi.online` 设备清单
（设备名 → 子域名），点进去是各台完整面板。见仓库 `deploy/` 之外的多设备说明。

---

## 安全

- 每个实例的 token 是独立的，首启自动生成；`/api/*` 与 `/mcp` 都要求 Bearer token。
- 面板静态资源无需 token，但数据接口需要；token 建议按子域名在浏览器里记忆。
- 浏览器/串口工具在 headless 下可用；`screenshot_ui`/`evaluate_ui` 仅桌面模式。

## 验证清单

```powershell
# 服务状态
sc query ValeCommand
# 本机 API
curl.exe -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:18080/api/status
# 隧道后的公网 API
curl.exe -H "Authorization: Bearer <TOKEN>" https://d1.command.saisi.online/api/status
# 设备 web 页（浏览器工具驱动 headless Edge 打开设备管理页）
curl.exe -H "Authorization: Bearer <TOKEN>" -X POST https://d1.command.saisi.online/api/tools/browser_navigate -d '{\"url\":\"http://<设备IP>/\"}'
```
