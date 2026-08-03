# Unified Device MCP Server — Implementation Plan

## Context

用户在服务器（10.10.61.93）上使用 Claude Code，需要访问本机（172.16.0.177）上的物理设备。本机可以通过 SSH、串口和浏览器 CDP 连接设备。需要构建一个统一的 MCP 服务器运行在本机，单二进制、纯 Rust、无 Node.js 依赖。

## Architecture

```
服务器 Claude Code (10.10.61.93)
      │
      │  MCP SSE (HTTP)
      ▼
本机 (172.16.0.177 :3000)
┌──────────────────────────────────────────┐
│     unified-mcp-server (Rust 单二进制)    │
│                                          │
│  SSH 模块 (ssh2)     ←→  SSH 设备        │
│  串口模块 (serialport) ←→  串口设备       │
│  浏览器模块 (chromiumoxide) ←→ Chrome CDP │
│                                          │
│  MCP 协议层 (rmcp, SSE transport)         │
└──────────────────────────────────────────┘
```

## Tech Stack

| 组件 | Crate | 说明 |
|------|-------|------|
| MCP 协议 | `rmcp` | Rust MCP SDK，支持 SSE transport |
| SSH | `ssh2` | libssh2 绑定，支持密码/密钥认证、SCP、SFTP |
| 串口 | `serialport` | 跨平台串口通信，阻塞 I/O |
| 浏览器 | `chromiumoxide` | Chrome DevTools Protocol 客户端，WebSocket 直连 |
| 异步运行时 | `tokio` | 全异步架构 |
| 配置 | `serde` + `serde_yaml` | YAML 配置文件解析 |

## MCP Tools (27 total)

### SSH (6)
| 工具 | 参数 | 说明 |
|------|------|------|
| `ssh_connect` | host, port, username, password/key_path | 建立连接，返回 session_id |
| `ssh_execute` | session_id, command, timeout | 执行命令，返回 stdout/stderr/exit |
| `ssh_disconnect` | session_id | 断开连接 |
| `ssh_list_sessions` | — | 列出所有活跃会话 |
| `ssh_upload` | session_id, local, remote | SCP 上传文件 |
| `ssh_download` | session_id, remote, local | SCP 下载文件 |

### Serial (7)
| 工具 | 参数 | 说明 |
|------|------|------|
| `serial_list_ports` | — | 列出可用串口 |
| `serial_open` | port, baud_rate, data_bits, parity, stop_bits | 打开端口，返回 port_id |
| `serial_write` | port_id, data (hex/utf8) | 写入数据 |
| `serial_read` | port_id, timeout_ms | 读取数据，返回 hex |
| `serial_close` | port_id | 关闭端口 |
| `serial_set_dtr_rts` | port_id, dtr, rts | 控制 DTR/RTS 线 |
| `serial_list_open_ports` | — | 列出已打开端口 |

### Browser (14)
| 工具 | 参数 | 说明 |
|------|------|------|
| `browser_navigate` | url | 导航到 URL，返回页面快照 |
| `browser_snapshot` | — | accessibility tree + ref 编号 |
| `browser_click` | ref | 点击元素 |
| `browser_type` | ref, text | 输入文字 |
| `browser_press_key` | key | 按键 |
| `browser_screenshot` | full_page? | 截图，返回 base64 PNG |
| `browser_evaluate` | js_code | 执行 JavaScript |
| `browser_wait_for` | selector_or_text, timeout | 等待元素/文本出现 |
| `browser_scroll` | direction, amount | 滚动页面 |
| `browser_tab_new` | url | 新建标签页 |
| `browser_tab_list` | — | 列出标签页 |
| `browser_tab_select` | tab_id | 切换标签页 |
| `browser_tab_close` | tab_id | 关闭标签页 |
| `browser_console` | — | 获取控制台消息 |

## Source Tree

> Updated after the 2026-08 optimization pass — the layout below is the
> current one. `vale-command-core/` holds the framework (Plugin/ToolDef/DeviceError/
> EventBus/Config); `src-tauri/` is the desktop shell; `src/ui/` is the
> no-build-step ES-module panel (transport.js / view.js / events.js / tabs.js).

```
vale-command/
├── Cargo.toml            # workspace root; vale-command lib + headless bin
├── config.yaml           # embedded as DEFAULT_CONFIG_YAML
├── vale-command-core/         # framework: Plugin, ToolDef, DeviceError, EventBus,
│                         #   Config (auth token via getrandom)
├── src/
│   ├── main.rs           # headless MCP-server binary
│   ├── bootstrap.rs      # config load/create + token (shared with desktop)
│   ├── state.rs          # AppState + PluginRegistry wiring
│   ├── desktop_api.rs    # pure payload builders for Tauri commands
│   ├── mcp/server.rs     # rmcp ServerHandler; bind()/serve_with_token
│   ├── web.rs            # web panel (Tower service) + TokenGate for /mcp
│   ├── plugins/
│   │   ├── mod.rs        # PluginRegistry (tools cached at register)
│   │   ├── browser/      # 18 tools (tools.rs = one fn per tool)
│   │   └── terminal/     # 12 tools + SessionBuf + clean_terminal_output
│   └── tools/
│       ├── browser.rs    # BrowserManager (internal lock, CDP, webview helper)
│       ├── terminal/     # TerminalManager + TermBackend trait (pty/ssh/serial/
│       │                 #   secrets/stub)
│       ├── cdp.rs        # WebSocket CDP client (port 19623)
│       ├── serial.rs     # SerialPool (std Mutex)
│       └── ssh.rs        # russh session
├── src-tauri/            # desktop shell (commands.rs, setup.rs, main.rs)
├── src/ui/               # panel frontend (no npm, embedded via include_bytes!)
└── tests/                # integration.rs + mcp_integration.rs (HTTP + auth)
```

## Configuration (config.yaml)

```yaml
server:
  host: "0.0.0.0"
  port: 3000
  name: "device-gateway"

ssh:
  default_timeout_secs: 30

serial:
  default_baud_rate: 115200
  default_timeout_ms: 1000

browser:
  chrome_cdp_url: "ws://127.0.0.1:9222"
  page_load_timeout_secs: 30
```

## Error Handling

All errors carry enough context for the AI to self-diagnose:
- `SshConnectFailed { host, reason }`
- `SessionNotFound { id }`
- `CommandTimeout { session, timeout }`
- `CommandFailed { exit_code, stderr }`
- `ElementNotFound { selector }`
- `PortNotOpen { id }`
- etc.

## Deployment

1. **Precondition**: Chrome running with `--remote-debugging-port=9222`
2. **Build**: `cargo build --release`
3. **Run**: `./unified-mcp-server --config config.yaml`
4. **Systemd**: Optional auto-start service
5. **Claude Code config**: Register `http://172.16.0.177:3000/sse` as SSE MCP server

## Verification

1. `cargo build --release` compiles without errors
2. Start Chrome with `--remote-debugging-port=9222`
3. Start server: `./unified-mcp-server --config config.yaml`
4. `curl http://172.16.0.177:3000/sse` responds with SSE stream
5. Test each module with a minimal tool call:
   - SSH: connect to known host, run `whoami`
   - Serial: list ports, open a loopback port if available
   - Browser: navigate to `about:blank`, take screenshot
