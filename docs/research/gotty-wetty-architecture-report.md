# GoTTY 与 WeTTY 架构研究报告

> 研究对象（均为 2026-08 拉取的 master/main 最新源码）：
>
> - **GoTTY** — https://github.com/yudai/gotty（Go，已停止维护，HEAD 仍用 godep + `kr/pty`）
> - **WeTTY** — https://github.com/butlerx/wetty（**TypeScript/Node.js，不是 Go 项目**；`krishnasrinivas/wetty` 是原版，butlerx/wetty 是当前活跃维护的 fork，默认分支为 `main`）
>
> **先纠正一个前提**：butlerx/wetty **不是 Go 项目**。`package.json` 声明 `"type": "module"`、`"bin": "./build/main.js"`，核心依赖为 `node-pty ^1.1.0`、`socket.io ^4.8.3`、`@xterm/xterm ^6.0.0`（来源：[package.json](https://github.com/butlerx/wetty/blob/main/package.json)）。下文 "wetty 的实现" 全部指 Node.js 实现。

---

## 1. 架构：gotty 的 client.go / server.go / backend 怎么组织？PTY 由谁持有？

### 1.1 目录结构（gotty master）

gotty 没有 `client.go` / `server/process.go`，实际分层为：

| 目录 | 文件 | 职责 |
|---|---|---|
| `main.go` | — | CLI 入口（codegangsta/cli），解析参数、构造 `localcommand.NewFactory`、`server.New`、`server.Run` |
| `server/` | `server.go`、`handlers.go`、`ws_wrapper.go`、`middleware.go`、`handler_atomic.go` 等 | HTTP + WebSocket 层：`Server`（`factory Factory` + `options *Options` + `upgrader *websocket.Upgrader`） |
| `webtty/` | `webtty.go`、`master.go`、`slave.go`、`message_types.go`、`errors.go` | **核心协议引擎 `WebTTY`**：桥接 "master"（WS 连接）与 "slave"（PTY）两端 |
| `backend/localcommand/` | `local_command.go`、`factory.go`、`options.go` | 唯一内置 backend：用 `kr/pty` 启动本地命令 |

关键接口（[webtty/master.go](https://github.com/yudai/gotty/blob/master/webtty/master.go)、[webtty/slave.go](https://github.com/yudai/gotty/blob/master/webtty/slave.go)）：

- `type Master io.ReadWriter` — 即 WebSocket 连接（`server/ws_wrapper.go` 把它适配成 `io.ReadWriter`）
- `type Slave interface { io.ReadWriter; WindowTitleVariables() map[string]interface{}; ResizeTerminal(columns, rows int) error }` — 即 PTY

### 1.2 PTY 由谁持有？

**`LocalCommand` 持有 PTY**（[backend/localcommand/local_command.go](https://github.com/yudai/gotty/blob/master/backend/localcommand/local_command.go)）：

```go
type LocalCommand struct {
    cmd       *exec.Cmd
    pty       *os.File        // kr/pty.Start(cmd) 返回的 master fd
    ptyClosed chan struct{}
}
```

- `New()` 中 `pty.Start(cmd)` 创建 PTY，`cmd.Stdin/Stdout/Stderr` 被接到 PTY slave 端；
- 生命周期：`New` 里起一个 goroutine `cmd.Wait()`，进程退出后 `pty.Close()` 并 `close(ptyClosed)`；`Close()` 先发 `closeSignal`（默认 SIGINT，factory 里默认值注释写 SIGHUP），超时（`closeTimeout`）后 SIGKILL；
- `ResizeTerminal` 通过 `syscall.SYS_IOCTL` + `TIOCSWINSZ` 改窗口尺寸（**仅类 Unix**）。

### 1.3 谁创建 backend？——1 连接 = 1 进程

连接装配全在 HTTP handler 内（[server/handlers.go](https://github.com/yudai/gotty/blob/master/server/handlers.go) 的 `processWSConn`）：

1. `conn.ReadMessage()` 读第一条文本消息 → 解析 `InitMessage{AuthToken, Arguments}` → 校验 token；
2. `slave, err = server.factory.New(params)` —— **每个 WS 连接调用一次 factory，即每个浏览器连接启动一个新的本地命令进程**；
3. `webtty.New(&wsWrapper{conn}, slave, opts...)` → `tty.Run(ctx)`；
4. `defer slave.Close()` —— 连接断开即杀进程。

`localcommand.Factory.New()` 每次执行 `exec.Command` + `pty.Start`（[factory.go](https://github.com/yudai/gotty/blob/master/backend/localcommand/factory.go)）。所以：

> **gotty 默认是 1 连接 : 1 PTY : 1 进程**，进程归连接所有，连接关 = 进程关。没有共享终端池。共享要靠 tmux（README 明确推荐 `gotty tmux new -A -s gotty top`）。

`server/server.go` 还提供：`--once`（`atomic.CompareAndSwapInt64` 保证只接一个客户端，断开后 cancel 整个 server）、`--max-connection`、`--timeout`（counter + timer 空闲超时，见 `handler_atomic.go`）。

---

## 2. 数据流：输出 PTY→WS 和输入 WS→PTY 的具体代码路径

### 2.1 核心：两个 goroutine + 两个 channel（错误汇合）

[webtty/webtty.go](https://github.com/yudai/gotty/blob/master/webtty/webtty.go) 的 `Run(ctx)`：

```go
errs := make(chan error, 2)
go func() { // 读 slave(PTY) → 写 master(WS)
    buffer := make([]byte, wt.bufferSize)   // 默认 1024
    for {
        n, err := wt.slave.Read(buffer)
        if err != nil { return ErrSlaveClosed }
        err = wt.handleSlaveReadEvent(buffer[:n])
        if err != nil { return err }
    }
}()
go func() { // 读 master(WS) → 写 slave(PTY)
    for {
        n, err := wt.masterConn.Read(buffer)
        if err != nil { return ErrMasterClosed }
        err = wt.handleMasterReadEvent(buffer[:n])
        if err != nil { return err }
    }
}()
select {
case <-ctx.Done(): err = ctx.Err()
case err = <-errs:
}
```

**不是 `io.Copy`**：是两段显式的手写 Read/Write 循环，各自有 1024B 缓冲。**没有数据 channel 做缓冲** —— 只有 `errs chan error`（容量 2）用来把两个方向的终止原因汇合到 `select`。任何一端 EOF/出错，`Run` 返回，`processWSConn` 返回，handler 的 `defer conn.Close()` + `defer slave.Close()` 收尾。

### 2.2 输出路径（PTY → WS）

```
slave.Read(buf)  →  handleSlaveReadEvent  →  base64.StdEncoding.EncodeToString(data)
→  masterWrite(append([]byte{Output /* '1' */}, base64...))
→  wsWrapper.Write → conn.NextWriter(websocket.TextMessage) → writer.Write(p)
```

- 每条 WS 消息 = 1 字节类型头 + base64 载荷（不是 JSON 帧，是单字节前缀的自定义协议）；
- base64 编码是为了**避免终端字节流中的控制字节破坏 WebSocket 文本帧**（也把 0xFF 之类的二进制内容安全化）。

### 2.3 输入路径（WS → PTY）

```
wsWrapper.Read → conn.NextReader()（只接受 TextMessage，二进制帧被跳过）
→ 按首字节分发 handleMasterReadEvent：
   '1' Input       → 若 permitWrite（-w 开关）→ slave.Write(data[1:])
   '2' Ping        → masterWrite([]byte{Pong})
   '3' ResizeTerminal → JSON 解析 {columns, rows} → slave.ResizeTerminal(cols, rows)
   （其余 → error "unknown message type"）
```

### 2.4 并发写保护

PTY 侧 goroutine、Ping 响应、初始化消息都写 master，用 **`writeMutex sync.Mutex`** 串行化 `masterWrite`（WebSocket 的 `NextWriter` 并发调用不安全）。slave 方向只有一个 goroutine 写，无需锁。

### 2.5 wetty 的数据流（对照）

```
服务端 spawn.ts：pty.spawn('/usr/bin/env', [...])  // node-pty
  term.onData(data) → tinybuffer(socket, 2ms, 524288) → socket.emit('data', chunk)   // 输出
  socket.on('input', s → term.write(s))                                              // 输入
  socket.on('resize', {cols,rows} → term.resize(cols,rows))
客户端 wetty.ts：term.onData → socket.emit('input')；socket.on('data') → term.write()
```

wetty 用 **Socket.IO 事件**（`data` / `input` / `resize` / `login` / `logout` / `commit` / `disconnect`）而非自定义二进制前缀协议。

---

## 3. 多客户端：1:1 还是 N:1？

| | gotty | wetty |
|---|---|---|
| 默认模型 | **N 个连接 = N 个进程（1:1）**。每个 WS 连接在 `processWSConn` 里独立 `factory.New()` | **1:1**：每个 Socket.IO 连接 `spawn()` 一个 node-pty |
| 输出广播 | **没有广播**。没有共享 PTY 概念；每连接独占一个 PTY，输出只发给自己的 WS | 无广播；每连接独立 PTY |
| 输入仲裁 | 不需要仲裁 —— 每个输入只喂给自己的进程 | 不需要 |
| N:1 共享 | 靠 **tmux** 间接实现：`gotty tmux new -A -s gotty top`。多个连接各自 attach 同一个 tmux 会话，PTY 是 tmux 的，gotty 只是中继 | 无 |
| 连接数限制 | `--max-connection`、`--once`（counter 在 `handler_atomic.go`，用 atomic） | 无内置限制 |

**结论**：两者都是 **1:1**。gotty 的 README "Sharing with Multiple Clients" 一节明确说 *"GoTTY starts a new process with the given command when a new client connects... users cannot share a single terminal with others by default"*，然后给出 tmux 方案。

### 3.1 如果要 N:1（广播/仲裁）该怎么做？

gotty 的架构里没有这个能力；要实现 N:1 需要自己加一层：把 `Slave` 换成"多路复用器"（内部一个真实 PTY + 一个 `sync.RWMutex` 保护的 subscriber 列表，输出扇出给所有 master，输入从单一仲裁者接受或直接多写）。ttyd 的 `--max-clients`（基于 zlib 的 tty.js 协议多客户端复用）是 gotty 系里少数实现 N:1 的例子，可参考 `docs/research/ttyd-architecture-report.md`。

---

## 4. 顺序保证：有没有乱序问题？怎么解决的？

### 4.1 gotty：单生产者，天然有序，无乱序

- **输出**：只有一个 goroutine 读 PTY、写 WS（`handleSlaveReadEvent`），写入由 `writeMutex` 串行化 → **字节顺序与 PTY 读出顺序完全一致**，无乱序；
- **输入**：只有一个 goroutine 读 WS，`slave.Write` 是同步阻塞调用 → 输入按 WS 消息到达顺序写入 PTY；
- **无序号/无 ACK/无重传**：协议里没有序号或确认机制。TCP（WS over TCP）+ 单 goroutine 是它全部的顺序保障。本地回环 / 局域网下 PTY 字节流不会乱序，因为根本没有并发写路径。
- 注意：**没有背压**。PTY 输出洪峰时 `masterWrite` 阻塞在 `NextWriter` 上，PTY 侧读循环停住，PTY 缓冲区反压到进程；WS 关闭时读循环报错退出。这是"阻塞式反压"，不是丢弃。

### 4.2 wetty：TCP 顺序 + node-pty 单回调

- node-pty 的 `onData` 按事件顺序回调；`tinybuffer` 聚合（2ms 定时或超 512KB 立即 flush）保持拼接顺序 → Socket.IO 消息按序到达，xterm.js 顺序写入。无乱序设计需求。
- **wetty 有显式流控**（见下），gotty 没有。

---

## 5. 完成检测：有没有"等待命令完成"语义？协议是纯流式还是有消息类型？

### 5.1 没有完成语义，纯流式

- gotty/wetty 的协议**没有** "command finished" 消息。PTY 是持续会话（交互式 shell），进程退出只表现为 **PTY EOF**：
  - gotty：`slave.Read` 返回 err → `ErrSlaveClosed` → `Run` 退出 → 连接关闭（closeReason 记为 slave 名字）。客户端只看到连接断开；
  - wetty：`term.onExit` → `socket.emit('logout')` → 前端 `disconnect` 处理（弹"disconnected"覆盖层）。退出码只进日志。
- 没有 exit code、没有输出与退出码的关联语义、没有"等命令返回"的请求/响应模型。**想等命令完成并拿退出码，这两个项目都不提供**；需要自己包一层（如 `sh -c 'cmd; echo $?'`）或在协议外加一条退出消息。

### 5.2 gotty 协议是有消息类型的（单字节前缀 + base64）

[webtty/message_types.go](https://github.com/yudai/gotty/blob/master/webtty/message_types.go)，WS subprotocol 名 `"webtty"`：

```
客户端 → 服务端：  '0' Unknown  '1' Input  '2' Ping  '3' ResizeTerminal
服务端 → 客户端：  '0' Unknown  '1' Output(base64)  '2' Pong  '3' SetWindowTitle
                  '4' SetPreferences  '5' SetReconnect
```

- 初始化序列（`sendInitializeMessage`）：连接建立后服务端先发 `SetWindowTitle` →（可选）`SetReconnect` →（可选）`SetPreferences`，然后才进入双向流；
- 心跳：客户端每 30s 发 `Ping`，服务端回 `Pong`（js/src/webtty.ts）；
- 重连：`SetReconnect` 告知客户端断线后 N 秒自动重连（服务端**每次连接都新建进程**，所以重连 = 新进程，状态丢失——README 也承认这一点，靠 tmux 保状态）；
- **类型区分是"带外控制 + 数据流"而非"消息级完成/响应"**：类型只用于控制面（标题/偏好/尺寸/心跳），数据面是单方向持续字节流。

### 5.3 wetty 协议：Socket.IO 事件

事件类型：`data`(PTY→client)、`input`(client→PTY)、`resize`、`login`/`logout`（进程生命周期通知）、`commit`（流控 ACK）、`disconnect`。同样是流式 + 生命周期事件，无命令完成语义。`logout` 是最接近"完成检测"的东西，但它只携带 exit code 到日志，不携带"哪些输出属于这次命令"。

---

## 6. Windows 支持

| | gotty | wetty |
|---|---|---|
| 语言 | Go | TypeScript/Node.js |
| PTY 库 | **`github.com/kr/pty`**（vendor 在仓库内；仅 Linux/Darwin/FreeBSD，`pty_unsupported.go` 对 Windows 直接报错） | **`node-pty ^1.1.0`**（Windows 上有原生 WinPTY/ConPTY 支持） |
| Windows 支持 | **不支持**。README "Development" 节明写 *"Windows is not supported now"*；`local_command.go` 里 `syscall.SIGINT`/`TIOCSWINSZ`/`SYS_IOCTL` 均为 Unix 专用 | **node-pty 本身跨平台**（含 Windows 的 conpty），但 wetty 的容器/文档以 Linux 为主；默认命令是 `/usr/bin/env`、`/bin/login`、`ssh`，在 Windows 上需自行配 `--command`。实践上 wetty 在 Windows 下可用但非一等公民 |
| 进程生命周期 | `exec.Cmd` + signal（SIGINT→SIGKILL 兜底） | node-pty `kill()`；`term.pause()/resume()` 流控 |

补充：`kr/pty` 是 `creack/pty` 的前身（作者同一人，creack/pty 是其社区维护后继版）。gotty 因为依赖 godep 锁死版本，一直没迁到 creack/pty。

---

## 7. 并发模型与背压总结（对比表）

| 维度 | gotty | wetty |
|---|---|---|
| 连接↔进程 | 1:1（每 WS 新进程，`--once` 可限 1） | 1:1（每 socket 新 pty） |
| 读 PTY 线程 | 1 goroutine，1024B buffer 循环 | node-pty 事件回调（`onData`） |
| 写 WS 串行化 | `writeMutex` 保护 `NextWriter` | Socket.IO 自身串行 + `tinybuffer` 聚合 |
| 读 WS | 1 goroutine 循环，`NextReader` 过滤非文本帧 | socket.io 事件分发 |
| 错误/终止汇合 | `errs chan error`(cap 2) + `select`（ctx.Done 或任一端错误） | 事件驱动（`onExit`/`disconnect`/`logout`） |
| 顺序保证 | 单生产者单消费者 + TCP；无序号无 ACK | 单生产者 + TCP；无序号 |
| 背压 | 阻塞式：`NextWriter` 阻塞 → PTY 读停 → 内核 PTY 缓冲反压 | **显式低/高水位流控**：服务端 `FlowControlServer`(low=2^19, high=2^21) 超阈值 `term.pause()`，客户端 `FlowControlClient`(ackBytes=2^18) 在 xterm 写回调里发 `commit` ACK，服务端低于 low 后 `term.resume()` |
| 消息协议 | 自定义单字节前缀 + base64 文本帧，subprotocol `webtty` | Socket.IO 命名事件 + 字符串载荷 |
| 命令完成检测 | 无（PTY EOF = 连接断） | 无（`logout` 事件带 exit code 进日志） |
| 窗口尺寸 | 客户端发 `ResizeTerminal` JSON，服务端 ioctl | 客户端发 `resize` 事件，`term.resize(cols,rows)` |
| 心跳 | 客户端 30s Ping，服务端 Pong | Socket.IO 层 `pingInterval: 3000, pingTimeout: 7000`（socketServer/socket.ts） |
| 重连 | 服务端通知 `SetReconnect`，客户端定时重连（新进程） | 无服务端级重连；`disconnect` → 前端覆盖层提示 |
| 认证 | 首条 WS 消息 `InitMessage{AuthToken}` + 可选 Basic Auth / mTLS | 无内置认证（默认走系统 login/ssh） |

---

## 8. 对本项目（Vale 终端架构）的可借鉴点

1. **gotty 的 WebTTY 抽象**（Master/Slave 接口 + 单字节前缀协议）是干净的最小模型：数据面单字节流 + 控制面消息类型，双向各一个 goroutine + `select` 汇合错误，代码量 ~150 行，易于在 Rust/Go 中复刻；
2. **wetty 的显式流控**（pause/resume + commit ACK + 低/高水位）解决了 gotty 的阻塞式背压问题，对长输出（`cat bigfile`）更稳，值得借鉴；
3. **两者都没有命令完成语义** —— 若 Vale 需要"执行命令并等退出码"，必须在协议层自己加（如 `\x04` 前缀的 exit 消息或 per-command 会话帧）；
4. N:1 共享（多客户端看同一终端）两者都不原生支持，gotty 的答案是 tmux；若 Vale 需要，可参考 ttyd 的 max-clients 实现（见 `docs/research/ttyd-architecture-report.md`）。

---

## 附录：源码位置索引

gotty（master, sha a080c85）：
- 协议引擎：https://github.com/yudai/gotty/blob/master/webtty/webtty.go
- 消息类型：https://github.com/yudai/gotty/blob/master/webtty/message_types.go
- Master/Slave 接口：https://github.com/yudai/gotty/blob/master/webtty/master.go 、https://github.com/yudai/gotty/blob/master/webtty/slave.go
- 后端（PTY 持有者）：https://github.com/yudai/gotty/blob/master/backend/localcommand/local_command.go
- factory（每连接新进程）：https://github.com/yudai/gotty/blob/master/backend/localcommand/factory.go
- WS 装配：https://github.com/yudai/gotty/blob/master/server/handlers.go
- WS 适配 io.ReadWriter：https://github.com/yudai/gotty/blob/master/server/ws_wrapper.go
- HTTP 服务/限流：https://github.com/yudai/gotty/blob/master/server/server.go
- 前端协议解析：https://github.com/yudai/gotty/blob/master/js/src/webtty.ts
- README（多客户端/Windows 声明）：https://github.com/yudai/gotty/blob/master/README.md

wetty（main, sha be65513）：
- PTY 生命周期 + 数据流：https://github.com/butlerx/wetty/blob/main/src/server/spawn.ts
- 服务端流控：https://github.com/butlerx/wetty/blob/main/src/server/flowcontrol.ts
- 客户端流控：https://github.com/butlerx/wetty/blob/main/src/client/wetty/flowcontrol.ts
- 客户端装配：https://github.com/butlerx/wetty/blob/main/src/client/wetty.ts
- Socket.IO 配置：https://github.com/butlerx/wetty/blob/main/src/server/socketServer/socket.ts
- 依赖清单：https://github.com/butlerx/wetty/blob/main/package.json
