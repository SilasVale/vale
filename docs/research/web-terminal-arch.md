# Rust Web 终端架构研究报告（webterm / wspty / ttyd / node-pty）

> 研究范围：与 Vale（Rust agent + xterm.js 前端）技术栈最接近的两个 Rust 项目
> **fubarnetes/webterm** 与 **capyloon/wspty**，另附两个"快速扫一眼"项目：
> **tsl0922/ttyd**（前端 + C 后端）与 **microsoft/node-pty**（Windows ConPTY 管道层）。
>
> 所有结论均来自一手源码（`raw.githubusercontent.com` / GitHub API 文件树），引用到文件级。
> 检索时间：2026-09-01。

---

## 0. 总览表

| 项目 | 语言/异步模型 | PTY 创建 | WS 协议 | 会话模型 | Windows 支持 |
|---|---|---|---|---|---|
| [fubarnetes/webterm](https://github.com/fubarnetes/webterm) (master) | Rust + actix 0.8 / actix-web 1.0 / tokio 0.1；actor 模型 | `tokio-pty-process`（forkpty，**仅 Unix**） | **terminado JSON 协议**（文本帧）；原始二进制帧直通 | 每 WS 连接一个 PTY actor | **无**（依赖 `tokio-pty-process`，只支持 Unix） |
| [capyloon/wspty](https://github.com/capyloon/wspty) (main) | Rust + tokio 1.x + tokio-tungstenite；async/await | 自研 `PtyMaster`：`posix_openpt/grantpt/unlockpt` + `AsyncFd`（**仅 Unix**） | **goterm 二进制协议**（首字节 type tag + payload） | 每 WS 连接一个 PTY + 3 个并发 task | **无**（`std::os::unix` 专用代码） |
| [tsl0922/ttyd](https://github.com/tsl0922/ttyd) (main) | C + libwebsockets(libuv) | Unix: `forkpty`；Win: **ConPTY**（动态加载 kernel32） | **1 字节命令 + payload 的二进制协议** | 每 WS 连接一个 PTY | **有**：原生 ConPTY |
| [microsoft/node-pty](https://github.com/microsoft/node-pty) (main) | TS + Node native addon (N-API) | Unix: `forkpty`；Win: **ConPTY**（kernel32 或捆绑 conpty.dll） | 不涉及 WS（库，只给 `Socket`/`fd`） | 每 Terminal 一个 agent | **有**：最完整的 ConPTY 参考实现 |

四个项目共享同一核心架构：**一个 WS 连接 ↔ 一个 PTY 会话**；WS 消息 = 窄协议（首字节/首元素区分 输入 vs 输出 vs resize）；没有"命令完成"语义，全部是**纯流式**。

---

## 1. fubarnetes/webterm（Rust + actix + tokio-pty-process）

仓库很小（约 5 个源文件），是"Rust 版 Jupyter terminado 协议"的最小实现。

### 1.1 架构

- **actor 对**：每个 WS 连接创建两个 actix actor：
  - `Websocket` actor：`actix_web_actors::ws` 的 WS 上下文（`src/lib.rs`），持有 `Addr<Terminal>`；
  - `Terminal` actor：普通 actix `Context`（`src/lib.rs`），持有 `AsyncPtyMasterWriteHalf` 与 `Child`。
- **PTY 创建**（`src/lib.rs` `Terminal::started`）：
  ```rust
  let pty = AsyncPtyMaster::open()?;          // tokio-pty-process 封装 forkpty
  let child = self.command.spawn_pty_async(&pty)?;
  let (pty_read, pty_write) = pty.split();
  ```
  即 **Unix `forkpty`**（经 `tokio_pty_process`），`spawn_pty_async` 是 `CommandExt` 扩展。**没有任何 Windows 分支**——Windows 上不可用。
- **WS 对接**：`ws::start(Websocket::new(handler(&req)), &req, stream)`，`Websocket::started` 里用 `Terminal::new(ctx.address(), command).start()` 拉起 PTY actor，两个 actor 互持对方地址、用 actix 消息传递数据。

### 1.2 数据流

- **PTY → WS**（`src/lib.rs`）：
  `FramedRead::new(pty_read, BytesCodec)` 以 `add_stream` 挂到 Terminal actor 的 event loop → 每读到一块字节，构造 `TerminadoMessage::Stdout(IO(bytes))` 通过 `self.ws.do_send(...)` 发给 Websocket actor → `Handler<event::TerminadoMessage>` 里 `serde_json::to_string` 后用 `ctx.text(json)` 发 **WS 文本帧**。
- **WS → PTY**（`src/lib.rs` `StreamHandler<ws::Message>`）：
  - `Text(t)`：先尝试 `TerminadoMessage::from_json` 解析：
    - `["stdin", data]` → `do_send(Stdin)` → `pty.write(data)`；
    - `["set_size", rows, cols]` → `Resize` → `event::Resize::new(pty, rows, cols).wait()`（`src/event.rs`，对 `PtyMaster::resize` 做 future 封装）；
    - 解析失败则按原始字节处理（`IO::from(t)`）。
  - `Binary(b)`：直接当原始输入字节 `IO::from(b)`。
- **线程模型**：**单线程事件循环 + actor 信箱**。actix 的 `do_send` 是异步投递，消息按投递顺序进入对方信箱、顺序处理；输出侧 `add_stream` 保证 PTY 读到的字节按序产生消息。两端方向（WS→Terminal、Terminal→WS）内部各自有序，两个方向之间没有跨方向的顺序约束（也不需要）。
- **心跳**：`ctx.run_interval(5s)` 发 `ping`，10s 无 `pong` 则 `ctx.stop()`。
- **退出**：`Terminal::stopping` 里 `child.kill()` + `child.wait()`，然后 `do_send(ChildDied())`，Websocket 收到后 `ctx.close(None)`。

### 1.3 协议（`src/terminado.rs`）

- **JSON 文本帧**，Jupyter terminado 风格数组：
  - 客户端 → 服务端：`["stdin", "..."]`、`["set_size", rows, cols]`
  - 服务端 → 客户端：`["stdout", "..."]`
- 原始二进制帧也可以作为输入直接写入 PTY（兼容 xterm attach 风格客户端）。
- **没有消息序号/去重/ACK**；文本帧的 `Stdout` 序列化用 `String::from_utf8_lossy`（**非 UTF-8 字节会被替换字符破坏**，这是该协议在二进制输出下的硬伤）。
- **无多路复用**：一个连接只服务一个 PTY。多会话要靠多连接。

### 1.4 前端（`templates/term.html`）

直接使用 **xterm.js 旧版 attach 与 terminado addon**：

```js
Terminal.applyAddon(terminado);
...
sock.addEventListener('open', function() {
    term.terminadoAttach(sock);
    term.fit();
});
```

即：**@xterm/addon-attach/terminado 直连**（项目停留在 xterm.js 2.x/3.x 时代），无自定义前端协议层，无 offset/sequence 去重机制。resize 由 `window.onresize → term.fit()` 触发，`terminadoAttach` 在 resize 时发 `set_size`。

---

## 2. capyloon/wspty（Rust + tokio + tokio-tungstenite）

仅 3 个源文件（`src/lib.rs`、`src/server.rs`、`src/main.rs`），README 声明：**wire protocol 沿用 [freman/goterm](https://github.com/freman/goterm)，PTY/tokio 集成受 tokio-pty-process 启发**。

### 2.1 架构

- **PTY 创建**（`src/lib.rs` `PtyMaster::new`）：**不依赖任何 pty crate，直接用 libc**：
  `posix_openpt(O_RDWR | O_NOCTTY)` → `grantpt` → `unlockpt` → `fcntl(F_SETFL, O_NONBLOCK)` → 包进 `tokio::io::unix::AsyncFd<File>`。
- **会话建立**（`PtyCommand::run`）：
  1. 开 master；
  2. `open_sync_pty_slave()`：macOS 用 `ptsname`，其它平台用 `ptsname_r`，打开 slave 端；
  3. `Command::stdin/stdout/stderr` 都指向 slave 的 clone；
  4. `pre_exec`（fork 后 exec 前）：`close(master_fd)` + `setsid()` + `ioctl(0, TIOCSCTTY)` 把自己变成控制终端；
  5. spawn 后起一个后台 task：`select!` 等待 `child.wait()` **或** `stopper.recv()`（收到即 `start_kill`），1 秒后关闭 master——**PTY 生命周期与 WS 连接绑定，连接断开即杀子进程**。
- **线程模型**：纯 **tokio async/await**，每个连接 `tokio::spawn` 三个并发 task（见下），无共享可变状态、无锁（`Arc<AsyncFd>` 只读共享）。

### 2.2 数据流（`src/server.rs`）

单连接内三路并发：

```
WS 流入 ──> handle_websocket_incoming ──> PtyMaster(写) ──> slave ──> 子进程
PTY 流出 <── handle_pty_incoming      <── PtyMaster(读, clone) <── slave <── 子进程
WS 流出 <── write_to_websocket        <── mpsc::UnboundedReceiver<Message> <── (以上两个生产者的 sender clone)
```

- **WS → PTY**：`handle_websocket_incoming` 循环 `incoming.next()`，按**二进制帧首字节**分派：
  - `0` → `data[1..]` 写入 PTY（输入）；
  - `1` → `data[1..]` 是 `{cols, rows}` JSON，调 `resize`；
  - `2` → 回发一个 `[1]`（客户端"ping/应答"用途）；
  - `Ping` → 回 `Pong`；
  - 连接结束 → `stop_sender.send(())` 触发杀掉子进程。
- **PTY → WS**：`handle_pty_incoming` 循环 `read_buf`，每块前置 `buffer[0] = 0`（type tag），经 `websocket_sender.send(Message::Binary(...))` 进 mpsc。
- **顺序保证**：PTY→WS 只有**一个生产者**（`handle_pty_incoming`），mpsc 保持投递顺序，`write_to_websocket` 单消费者顺序 `send`——严格有序。WS→PTY 也只有 `handle_websocket_incoming` 一个生产者，同一 task 内顺序写 PTY，也严格有序。**两个方向独立有序，无跨方向依赖**。
- 注意：mpsc 是 `UnboundedSender`（无背压），`handle_pty_incoming` 与 `write_to_websocket` 之间没有流控——PTY 输出洪峰时 WS 写入不保证成功（`send` 失败即 `bail` 整个连接）。

### 2.3 协议（goterm 风格二进制）

- **二进制帧**：`[type: u8][payload]`
  - 服务端 → 客户端：`0x00 + 输出字节`
  - 客户端 → 服务端：`0x00 + 输入字节`、`0x01 + resize JSON`
- **无 JSON 封装、无多路复用、无序号/去重**。一个 WS 连接 = 一个 PTY。
- 输入方向有个特例：连接建立后先 `ws_incoming.next()` **读第一条 Text 消息当要执行的命令**（默认 `/usr/bin/bash`），之后才 `spawn`——"命令在 URL/握手里定死"的极简模型。

### 2.4 与 xterm.js

项目本身不打包前端；README 指到 `assets/index.html`（旧版 xterm.js + 自定义 WS 代码，不在仓库内）。按 goterm 协议，前端需要自己给每个帧加/剥首字节 type tag——**不是 attach addon 直连，是自定义协议适配**。

### 2.5 Windows

**完全不支持**：`lib.rs` 顶部直接 `use std::os::unix::prelude::*`，`posix_openpt` 等 libc 调用无 cfg 分支。这是纯 Unix 实现。

---

## 3. tsl0922/ttyd（C + libwebsockets；前端 `html/src/`）

> 用户点名要看的 `client.js` 在**旧版仓库**里；当前 main 分支已把它迁移为
> `html/src/components/terminal/xterm/index.ts`（TS + React 壳，webpack 构建）。
> 以下以 main 分支为准。

### 3.1 前端数据流（`html/src/components/terminal/xterm/index.ts`）

- **二进制协议，首字节命令**：
  ```ts
  enum Command {
    OUTPUT='0', SET_WINDOW_TITLE='1', SET_PREFERENCES='2',   // 服务端 → 客户端
    INPUT='0', RESIZE_TERMINAL='1', PAUSE='2', RESUME='3',   // 客户端 → 服务端
  }
  ```
  服务端→客户端全是 `binaryType='arraybuffer'` 的二进制帧：`onSocketData` 取 `rawData[0]` 为命令，`slice(1)` 为数据；`OUTPUT` 直接交给 `writeFunc` → `terminal.write`。
- **客户端 → 服务端**：`sendData` 用 `TextEncoder` 拼 `[INPUT][bytes]`；resize 发 `[RESIZE_TERMINAL]` + `{columns, rows}` JSON。
- **关键：显式背压/流控**（这是四个项目里唯一的流控实现）：
  ```ts
  const { limit, highWater, lowWater } = this.options.flowControl;
  this.written += data.length;
  if (this.written > limit) {
      terminal.write(data, () => {            // xterm 消化完回调
          this.pending = Math.max(this.pending - 1, 0);
          if (this.pending < lowWater) socket.send(encode(Command.RESUME));
      });
      this.pending++;
      this.written = 0;
      if (this.pending > highWater) socket.send(encode(Command.PAUSE));
  }
  ```
  即：**xterm.js 的 `write` 回调驱动 `PAUSE/RESUME` 命令**，服务端 `pty_pause`/`pty_resume` 就是 `uv_read_stop`/`uv_read_start`（`src/pty.c`）——PTY 侧读停 = 内核缓冲区自然背压。这是"PTY 输出洪峰"问题的教科书解法。
- **重连**：断线后 `refreshToken()` 再 `connect()`；`onSocketOpen` 时 `terminal.reset()` + 重发首帧（`AuthToken` + 窗口大小）。
- **无去重/序号**：服务端输出是纯流；断线重连靠整屏 `terminal.reset()` 兜底，而不是消息级 offset。

### 3.2 服务端（`src/protocol.c`、`src/server.c`、`src/pty.c`）

- **单线程事件驱动**：libwebsockets（libuv 外接 loop）+ 每连接一个 `pss_tty`。`process_read_cb` 把 `pty_buf_t` 挂到 `pss->pty_buf` 后 `lws_callback_on_writable`，在 `LWS_CALLBACK_SERVER_WRITEABLE` 里 `wsi_output`（`[OUTPUT][buf]`）再 `pty_resume`——**读一段、发一段、停一停**（单缓冲 + 暂停/恢复的节流）。
- **PTY**：Unix 用 `forkpty` + `uv_pipe`（`pty.c` `#else` 分支，master fd 复制两份，一个读一个写）；Windows 用 ConPTY（见 §5.2 对比）。
- **退出语义**：`process_exit_cb` 依据 `exit_code == 0 ? 1000 : 1006` 作为 WS 关闭码；`process_read_cb` 里 `eof && !process_running` 同样处理。**没有"命令完成"标记，纯流式**；前端只能靠 WS close 感知结束。

---

## 4. microsoft/node-pty（Windows ConPTY 管道层）

node-pty 是库不是服务器，但它的 Windows 层是 **ConPTY + 命名管道的权威参考实现**，且刚重构成了"worker 线程排水"模型（2025-2026 年修复了 `ClosePseudoConsole` 死锁，见 issue #375/#763）。

### 4.1 整体：原生 addon 只做 ConPTY，管道 IO 全在 JS 侧

- 原生侧 `src/win/conpty.cc`（N-API）暴露 5 个函数：
  - `startProcess(file, cols, rows, debug, pipeName, inheritCursor, useConptyDll)`：创建**两条命名管道**（`\\.\pipe\<pipeName>-in` / `-out`，128KB 缓冲，`CreateNamedPipeW`）→ `CreatePseudoConsole(size, hIn, hOut, 0, &hpc)`（或 `conpty.dll` 的 `ConptyCreatePseudoConsole`）→ 返回 `{pty, conin, conout, fd:-1}`，**此时尚未 spawn 子进程**。
  - `connect(id, cmdline, cwd, env, useConptyDll, exitCb)`：`ConnectNamedPipe(hIn/hOut)`（阻塞式 server 端 accept）→ `CreateProcessW` 且 `STARTUPINFOEXW` + `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 属性把子进程挂到 ConPTY → `SetupExitCallback` 用**独立 std::thread + Napi::ThreadSafeFunction** 等进程退出（不走 libuv 线程池）。
  - `resize/clear/kill`：分别 `ResizePseudoConsole`（kernel32）或 `ConptyResizePseudoConsole`（conpty.dll，`clear` 仅 conpty.dll 有）；`kill` 里 `ClosePseudoConsole` + 关管道句柄（useConptyDll 时再 `TerminateProcess`）。
  - 关键细节：**`useConptyDll` 开关**——默认用系统 `kernel32.dll` 的 `CreatePseudoConsole`，可选加载仓库捆绑的 `conpty.dll`（`third_party/conpty/<ver>/`，含 `OpenConsole.exe`，新版 API 如 `ConptyClearPseudoConsole`/`ConptyReleasePseudoConsole`）。
- TS 侧 `src/windowsPtyAgent.ts` 编排：
  - **输入**：`fs.openSync(term.conin, 'w')` 得到写句柄 → `new Socket({fd, writable:true})`，`WindowsTerminal._doWrite` 就是 `inSocket.write(data)`（`src/windowsTerminal.ts`）。
  - **输出**：**不在主线程读 `conout` 管道**——`ConoutConnection`（`src/windowsConoutConnection.ts`）起一个 `worker_threads` worker，worker 里 `conoutSocket.connect(conoutPipeName)` 直连 ConPTY 输出管道，再 `createServer` 监听 `<pipeName>-worker`，把 `conoutSocket.pipe(workerSocket)` 拷给主线程的 `_outSocket`（`src/worker/conoutSocketWorker.ts`、`src/shared/conout.ts`）。**排水必须发生在别的线程，否则 `ClosePseudoConsole` 会在输出没排空时死锁**（注释里引了 microsoft/terminal#1810、vscode#76548）。
  - **就绪握手**：worker `onReady` → 先 `connectSocket`（主线程 Socket 连上 worker 的管道）→ 再调 `conptyNative.connect()`——**严格保证 `ConnectNamedPipe` 之前客户端已就位**，避免主线程事件循环被阻塞（issue #763）。
  - **退出后的排水**：`_$onProcessExit` 后不立即关 socket，而是 `_flushDataAndCleanUp`：1 秒（`FLUSH_DATA_INTERVAL`）定时器，期间任何新 data 都会重置定时器，确保 `exit` 事件发出前把尾部输出发完。
- `src/windowsTerminal.ts`：ready 语义 = **收到第一块 data 才算 ready**；`_write`/`resize`/`kill` 在 ready 前都进 `_deferreds` 队列延迟执行——解决"连接建立前就写"的竞态。

### 4.2 数据流小结（单方向单生产者）

```
conout 管道 → worker线程Socket → pipe 到主线程 _outSocket → 'data' → emit('data') → 消费
conin 管道   ← _inSocket.write()  ← WindowsTerminal._write()
```

- 输出侧只有一个生产者（worker 的 `conoutSocket`），`Socket.pipe` 保序；输入侧 `Socket.write` 由 Node 写队列保序。**无序号/去重**——`Socket`/管道本身保证顺序。
- 与 wspty 的对照：两者都是"管道/流 + 单生产者保序"，但 node-pty 把读端放到独立线程/worker 防死锁，wspty 用 `AsyncFd` 在同一 reactor 里读。

---

## 5. Windows ConPTY 处理对比（重点）

### 5.1 两种 ConPTY 接入方式

| | ttyd | node-pty |
|---|---|---|
| 动态加载 | `uv_dlopen("kernel32.dll")` 找 `CreatePseudoConsole/ResizePseudoConsole/ClosePseudoConsole`（`src/pty.c` `conpty_init`） | N-API 编译期声明，运行时 `GetProcAddress`；可选加载捆绑 `conpty.dll` |
| 输入管道 | `CreateNamedPipeA`，名字 `\\.\pipe\ttyd-term-in-<pid>-<count>`，`uv_pipe_connect` 异步连 | `CreateNamedPipeW`，`\\.\pipe\<random>-in`；服务端 `ConnectNamedPipe`（阻塞）由 `connect()` 调，JS 侧先让 worker 连上才调 |
| 输出管道 | 同输入管道（`\\.\pipe\ttyd-term-out-...`），libuv 读 | `\\.\pipe\<random>-out`，**worker 线程**读再 pipe 给主线程 |
| 子进程 | `CreateProcessW` + `STARTUPINFOEXW` + `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`（`conpty_setup`/`pty_spawn`） | 同（`PtyConnect`） |
| 退出检测 | `RegisterWaitForSingleObject(hProcess, conpty_exit)` → `uv_async_send` 回事件循环（不阻塞 loop） | 独立 `std::thread` `WaitForSingleObject` → `Napi::ThreadSafeFunction` 回调回主线程 |
| resize | `pResizePseudoConsole(pty, COORD)` | `ResizePseudoConsole` 或 `ConptyResizePseudoConsole` |
| 关闭 | `pClosePseudoConsole` + `TerminateProcess`；`process_free` 里 `DeleteProcThreadAttributeList` | `ConptyClosePseudoConsole` + 关管道；worker 排水 1s 后再 terminate |

共同点：ConPTY 的两端都是**命名管道**（byte 模式，128KB 缓冲），子进程通过 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 属性挂接；都动态解析 API 以兼容旧 Windows（ttyd 要求 Win10 1809+，node-pty 同理）。

### 5.2 关键差异：输出管道的读端在哪个线程

- **ttyd**：输出管道由 **libuv 事件循环**（`uv_pipe` + `uv_read_start`）读取。这正是 node-pty 注释里点名要避免的模型——`ClosePseudoConsole` 文档要求"关闭前先关闭/排空输出"，若事件循环同时又在等 ConPTY 的输出，可能死锁。ttyd 用 `pty_pause`（`uv_read_stop`）+ WS 背压缓解，但它没有把读端挪到别的线程。
- **node-pty**：输出管道读端在 **`worker_threads` 工作线程**（`conoutSocketWorker`），主线程通过本地 IPC 管道再拿数据；关闭时先排水 1 秒再 `worker.terminate()`。这是针对 `ClosePseudoConsole` 死锁问题的完整修复（issue #375、#763、microsoft/terminal#1810、vscode#76548）。

### 5.3 两个 Rust 项目都没有 Windows 支持

- **webterm**：`tokio-pty-process` 的 `AsyncPtyMaster::open()` = `forkpty`，无 cfg(windows) 路径。
- **wspty**：`posix_openpt`/`grantpt`/`unlockpt` + `std::os::unix::prelude`，纯 Unix。

若 Vale 要在 Windows 上做 PTY，需要自己走"ConPTY + 命名管道"路线（参考 ttyd/node-pty 的模式），或引入支持 Windows 的 pty crate（如 `portable-pty`，不在本次研究范围内）。

---

## 6. 完成检测（"等待命令完成"语义）

**四个项目全部是纯流式，没有任何"命令完成"语义**：

- webterm：退出 = `ChildDied` → WS close（`src/lib.rs`）。
- wspty：`child.wait()` 只是内部清理（杀进程/关 master），不向前端发"完成"消息；前端唯一感知是 WS 断开。
- ttyd：退出 → WS close code `1000`(成功)/`1006`(非零)，前端 `onSocketClose` 处理（`src/protocol.c`）。
- node-pty：`exit` 事件（携带 exit code）在尾部输出排水后发出（`windowsPtyAgent.ts` `_flushDataAndCleanUp`）。

即：**"命令是否跑完"只能由前端从 WS 关闭/`exit` 事件推断**，或者后端在 shell 层包一层"输出结束哨兵"（这些项目都没有）。若 Vale 需要"等待命令完成"（如 agent 执行完命令再读输出），需要自己设计：例如在命令后追加 `echo <unique-marker>` 并在输出流里检测（stream 级别解析），或让 PTY 会话在 `EOF`（slave 端全部关闭）时发结构化事件。

---

## 7. 与 xterm.js 的对接对比

| 项目 | 对接方式 | 去重/序号 |
|---|---|---|
| webterm | **xterm.js 2.x attach/terminado addon 直连**（`term.terminadoAttach(sock)`），addon 内部按 terminado JSON 编解码 | **无** |
| wspty | 自定义前端（goterm 二进制协议：首字节 type + payload），不在仓库内 | **无** |
| ttyd | **自定义协议层**（首字节命令 + payload，`onSocketData`/`sendData` 手动编解码）+ xterm.js `write()` | **无**（断线重连靠 `terminal.reset()` 整屏重绘） |
| node-pty | 库本身不碰 xterm.js；`data` 事件 → `term.write`，`term.onData` → `pty.write`（xterm 官方 demo 模式） | **无**（`Socket` 管道保序，无消息级序号） |

**结论：所有项目都依赖底层传输（TCP/WS/管道）的 FIFO 保序，没有任何 offset/sequence 去重机制。** 唯一接近"去重"的是 ttyd 的重连整屏 reset。

---

## 8. 对 Vale 的启示（数据流模型要点）

1. **每会话单生产者原则**：PTY→WS 只允许一个读 task 作为唯一生产者（wspty 的 mpsc 模式 / node-pty 的 worker pipe 模式），顺序由单生产者 + FIFO 传输天然保证；多生产者并发写 WS 必然引入乱序。
2. **背压不能省**：wspty 的无界 mpsc 在 PTY 洪峰时直接丢连接；ttyd 的 PAUSE/RESUME + `uv_read_stop` 是现成范本，xterm.js 的 `write` 回调是天然的水位信号。
3. **Windows 路线图**：Rust 侧目前两个参考项目都无 Windows；要支持 ConPTY 需自建命名管道 + 子进程属性挂接，且**输出管道读端应放独立线程/任务**（node-pty 的 worker 模型是死锁问题的正解）。
4. **"完成检测"是缺口**：四个项目都是纯流式。Vale 若需"命令完成"语义，必须在协议里自己加（哨兵/EOF 事件），不能指望现成项目。
5. **协议极简**：`[type][payload]` 二进制（ttyd/goterm）比 terminado JSON 更适合二进制输出（webterm 的 `from_utf8_lossy` 是反例）。

---

## 附：引用的源码文件

| 文件 | 用途 |
|---|---|
| `fubarnetes/webterm` `src/lib.rs` / `src/terminado.rs` / `src/event.rs` / `src/server.rs` / `Cargo.toml` / `templates/term.html` | §1 全部 |
| `capyloon/wspty` `src/lib.rs` / `src/server.rs` / `src/main.rs` / `Cargo.toml` / `README.md` | §2 全部 |
| `tsl0922/ttyd` `html/src/components/terminal/xterm/index.ts` / `src/protocol.c` / `src/server.c` / `src/pty.c` | §3、§5.1 |
| `microsoft/node-pty` `src/windowsPtyAgent.ts` / `src/windowsTerminal.ts` / `src/windowsConoutConnection.ts` / `src/worker/conoutSocketWorker.ts` / `src/shared/conout.ts` / `src/win/conpty.cc` | §4、§5.1 |

（注：ttyd 的 `client.js` 已是历史文件；当前前端入口为 `html/src/components/terminal/xterm/index.ts`。）
