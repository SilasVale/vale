# ttyd 架构研究报告：一个 C 语言 Web 终端的完整实现

> 研究日期：2026-09（基于 `tsl0922/ttyd` main 分支源码，clone 于 2026-09）
> 研究方式：直接阅读源码（primary source），所有行号引用均基于本地 clone `/tmp/ttyd-src` 核对
> 涉及文件：`src/pty.c`（493 行）、`src/protocol.c`（406 行）、`src/server.c`（636 行）、`src/utils.c`（190 行）、`src/pty.h`、`src/server.h`
> **注意：仓库中不存在 `src/websocket.c`** —— ttyd 的 WebSocket 处理全部内嵌在 `protocol.c` 的 libwebsockets 回调 `callback_tty` 中，不存在独立的 websocket 模块。

---

## 0. 架构总览

ttyd 是一个"单进程、单事件循环、一对多（1 PTY : N WebSocket 客户端）"的架构：

- **libuv**（`uv_loop_t`）驱动整个事件循环：PTY 读、PTY 写、进程退出检测、信号处理（`server.c:436-442` 创建 `uv_signal_t`）。
- **libwebsockets**（`lws_context`）以 foreign loop 方式挂在同一个 libuv 事件循环上（`server.c:412-419`：`info.foreign_loops[0] = server->loop`，`LWS_SERVER_OPTION_EXPLICIT_VHOSTS`）。
- 核心设计哲学：**一切都是"推"而不是"拉"** —— 没有轮询、没有线程池、没有显式队列，只有"事件到达 → 回调 → 唤醒（`lws_callback_on_writable`）→ 事件循环写"。

```text
                 ┌─────────────────────────── ttyd 单进程 ───────────────────────────┐
                 │                        libuv 事件循环 (server->loop)               │
  PTY 子进程 ────►│  uv_pipe_t out ──► read_cb ──► process_read_cb ──► pss->pty_buf ──┼──►  pss_tty (per-WS 状态)
                 │                                                                    │        │
                 │  uv_pipe_t in  ◄── uv_write ── pty_write ◄── callback_tty(RECEIVE) ◄──┘   lws_write
                 │                                                                    │        │
                 │  uv_async (exit) ──► exit_cb ──► lws_close_status                 │        ▼
                 └────────────────────────────────────────────────────────────────────┘   WebSocket 客户端
```

---

## 1. PTY 与 WebSocket 的数据流

### 1.1 输出流：PTY → 浏览器（单通道，逐段转发）

**环节 1：PTY 读** —— `pty.c:65-77` 的 `read_cb`（libuv stream 回调）：

```c
static void read_cb(uv_stream_t *stream, ssize_t n, const uv_buf_t *buf) {
  uv_read_stop(stream);                                  // ← 关键：读到一块就立刻暂停读
  ...
  process->read_cb(process, pty_buf_init(buf->base, (size_t) n), false);  // 交给上层回调
done:
  free(buf->base);
}
```

注意 `uv_read_stop` 在第一次读回调就调用 —— ttyd 采用**"读一块、停一块、发一块"**的严格流控（背压），绝不让 PTY 输出无界堆积。

**环节 2：上层回调** —— `protocol.c:82-94` 的 `process_read_cb`：

```c
static void process_read_cb(pty_process *process, pty_buf_t *buf, bool eof) {
  pty_ctx_t *ctx = (pty_ctx_t *)process->ctx;
  if (ctx->ws_closed) { pty_buf_free(buf); return; }      // WS 已关 → 丢弃
  if (eof && !process_running(process))
    ctx->pss->lws_close_status = process->exit_code == 0 ? 1000 : 1006;
  else
    ctx->pss->pty_buf = buf;                              // ← 暂存到 per-连接 状态
  lws_callback_on_writable(ctx->pss->wsi);                // ← 唤醒 WS 写回调
}
```

**环节 3：WS 写** —— `protocol.c:257-284` 的 `LWS_CALLBACK_SERVER_WRITEABLE`：

```c
if (pss->pty_buf != NULL) {
  wsi_output(wsi, pss->pty_buf);      // protocol.c:171-181: 前缀 OUTPUT 字节 + 原始字节，LWS_WRITE_BINARY
  pty_buf_free(pss->pty_buf);
  pss->pty_buf = NULL;
  pty_resume(pss->process);           // ← 写完才恢复 PTY 读（背压闭环）
}
```

**环节 4：编码** —— `protocol.c:171-181` 的 `wsi_output`：

```c
*ptr = OUTPUT;                        // 单字节命令前缀 '0'
memcpy(ptr + 1, buf->base, buf->len);
if (lws_write(wsi, (unsigned char *)ptr, n, LWS_WRITE_BINARY) < n) ...
```

### 1.2 输入流：浏览器 → PTY（单通道，经 WS 帧直接写）

**环节 1：WS 收** —— `protocol.c:287-364` 的 `LWS_CALLBACK_RECEIVE`：先累积到 `pss->buffer`（处理分片，`protocol.c:288-299`），判断 `lws_remaining_packet_payload`/`lws_is_final_fragment`（`protocol.c:307-310`）后按首字节命令分发。

**环节 2：写 PTY** —— `protocol.c:312-320`：

```c
case INPUT:
  if (!server->writable) break;        // 默认只读！需 -W 开启
  int err = pty_write(pss->process, pty_buf_init(pss->buffer + 1, pss->len - 1));
```

**环节 3：uv_write** —— `pty.c:137-146` 的 `pty_write`：

```c
uv_buf_t b = uv_buf_init(buf->base, buf->len);
uv_write_t *req = xmalloc(sizeof(uv_write_t));
req->data = buf;
return uv_write(req, (uv_stream_t *) process->in, &b, 1, write_cb);   // 写完后 write_cb 释放 buf+req
```

### 1.3 单通道还是多通道？

**输入是单通道**：所有客户端的键盘输入经同一条 WebSocket 连接、同一个 `pty_write` 写入**同一个** `process->in` 管道。**没有按客户端分通道** —— 这是共享终端语义（见 §2）。

**输出是"1→N 广播式共享通道"**：PTY 输出只有一份，但**没有**真正广播 —— 每个连接各自持有 `pss->pty_buf`，各自在 `SERVER_WRITEABLE` 时发送。但由于 PTY 只属于第一个连接建立的进程（`spawn_process` 在 `JSON_DATA` 消息时启动，`protocol.c:332-353`），后续连接共享同一个进程、看到的是同一份输出流。

**关键设计**：PTY 输出到 WS 之间只允许**一个在途 buffer**（`pss->pty_buf` 单槽）。这正是"暂停读 → 发 → 恢复读"流控的前提：任何时刻最多有一块输出等待发送，不可能乱序或堆积。

---

## 2. 并发控制：多客户端连接一个 PTY

### 2.1 进程生命周期：第一个客户端"认领"PTY

- WS 建立后**不会立刻**启动进程（`protocol.c:235-256`，`LWS_CALLBACK_ESTABLISHED` 只做初始化）。
- 客户端必须发一条 `JSON_DATA`（`{`，携带 `columns`/`rows`）消息，服务端才调用 `spawn_process`（`protocol.c:332-353`）。
- `spawn_process`（`protocol.c:154-168`）创建**一个** PTY 进程，并把 `pss->process` 挂到该连接上。后续连接没有自己的进程 —— 它们**复用**第一个进程（`JSON_DATA` 在 `pss->process != NULL` 时直接 `break` 跳过，`protocol.c:332`：`if (pss->process != NULL) break;`）。

### 2.2 数量限制：连接级仲裁

`protocol.c:222-234`（`LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION`）：

```c
if (server->once && server->client_count > 0) return 1;              // --once：只允许 1 个
if (server->max_clients > 0 && server->client_count == server->max_clients) return 1;  // --max-clients
```

`--once` 模式 = 严格单客户端；默认模式 = 共享终端（像 `tmux attach` 一样多客户端看同一终端）。

### 2.3 写 PTY 的并发：无锁，靠事件循环串行化

**ttyd 没有任何 mutex/lock，也没有输入队列。** 原因：libwebsockets 的 WS 回调与 libuv 的 PTY 回调运行在**同一个线程、同一个事件循环**上（`server.c:412-419` foreign loop 集成），因此：

- 所有 `pty_write` 都发生在事件循环线程内 → **天然串行**，无需锁；
- `uv_write` 本身是异步的，但 uv 保证同一 stream 上的 write 按调用顺序排队 → 输入字节顺序由 libuv 保证。

**这是单线程事件循环架构的核心优势：用"单线程"替代"锁"**。ttyd 的并发语义是"协作式"的：任何时刻只有一个回调在执行，共享状态（`pss->pty_buf`、`pss->process`）天然互斥。

### 2.4 断开连接时的仲裁：杀掉共享进程

`protocol.c:366-395`（`LWS_CALLBACK_CLOSED`）：任意客户端断开都会 `pty_kill(pss->process, server->sig_code)` 杀掉**整个共享进程**（默认 SIGHUP，`pty.c:155-165`）。这是共享终端模型的代价：一个客户端断开，所有客户端都没了终端。（除非 `--once`/`--exit-no-conn` 才退出服务本身。）

---

## 3. 输出顺序保证：没有 buffer 堆积，只有单槽背压

### 3.1 顺序如何保证

ttyd **没有输出队列、没有去重、没有重读机制**。顺序保证来自三层：

1. **PTY 语义本身**：PTY（伪终端）是一个字节流设备，内核保证读到的字节序就是进程写入的字节序；
2. **单槽流控**：`read_cb` 读一块 → `uv_read_stop` 暂停 → 发 WS → `pty_resume` 恢复（`pty.c:65-66, 130-135`）。任何时刻 PTY→WS 只有**一个在途 buffer**，物理上不可能乱序；
3. **TCP/WS 语义**：libwebsockets 保证 WS 帧按发送顺序到达。

### 3.2 背压（backpressure）的具体实现

```c
// pty.c:124-128  —— 暂停
void pty_pause(pty_process *process) {
  if (process->paused) return;
  uv_read_stop((uv_stream_t *) process->out);
}
// pty.c:130-135  —— 恢复
void pty_resume(pty_process *process) {
  if (!process->paused) return;
  process->out->data = process;
  uv_read_start((uv_stream_t *) process->out, alloc_cb, read_cb);
}
```

读侧：`read_cb` 第一行 `uv_read_stop`（`pty.c:66`）→ 暂停；`protocol.c:283` 写完 WS 后 `pty_resume` → 恢复。
写侧：还有显式的客户端 PAUSE/RESUME 消息（`protocol.c:326-330`）供前端在检测到网络拥塞时调用。

### 3.3 掉队处理

`process_read_cb` 开头（`protocol.c:84-86`）：`if (ctx->ws_closed) { pty_buf_free(buf); return; }` —— WS 关闭后 PTY 输出的处理是**直接丢弃**，不做任何重读/补发。**ttyd 完全没有"重放/重读/去重"机制**，它的定位是实时终端，不是可靠传输。

---

## 4. 完成检测：没有同步 execute 语义

### 4.1 直接回答

**ttyd 不支持"执行命令并等待完成"的同步语义**（没有 command/response、没有 job id、没有 exit 事件消息）。它只有两类"生命周期"信号：

1. **进程退出**：`pty.c:404-424`（POSIX `wait_cb` 线程）或 `pty.c:293-311`（Windows `RegisterWaitForSingleObject`）→ `uv_async_send` → `async_cb` → `process_exit_cb`（`protocol.c:96-112`）：

```c
static void process_exit_cb(pty_process *process) {
  ...
  ctx->pss->process = NULL;
  ctx->pss->lws_close_status = process->exit_code == 0 ? 1000 : 1006;   // WS 关闭码
  lws_callback_on_writable(ctx->pss->wsi);
}
```

退出码**只编码进 WebSocket Close 码**（0→1000，非 0→1006），随后连接关闭。没有"exit code 消息"送达前端再保持连接的概念。

2. **EOF**：`process_read_cb` 收到 `eof=true` 且进程已退出时同样只设置 close 码（`protocol.c:87-90`）。

### 4.2 它的交互协议设计（异步、事件驱动、无请求-响应）

- **单条长连接**承载所有事件，消息按"首字节命令 + 载荷"区分（见 §6）；
- 服务端→客户端只有 3 种消息：`OUTPUT`、`SET_WINDOW_TITLE`、`SET_PREFERENCES`（`server.h:11-14`）；
- 客户端→服务端有 5 种：`INPUT`、`RESIZE_TERMINAL`、`PAUSE`、`RESUME`、`JSON_DATA`（`server.h:4-9`）；
- **没有任何"命令完成"应答**：输入只是字节，输出只是字节流，是否"执行完"由终端内容（prompt 出现）自行判断。这是**纯异步、无请求-响应、无事务**协议。

### 4.3 与"AI 同步 execute 语义"的关键差异

| 维度 | ttyd（实时终端） | AI 同步 execute 语义 |
|---|---|---|
| 交互模型 | 推送式字节流，无请求-响应 | 请求→执行→完成→返回，有明确边界 |
| 完成判定 | 无（只能靠 WS close 码 / 终端内容） | 必须有明确的 exit code + 完成事件 |
| 输出归因 | 无法区分"哪条命令产生哪些输出" | 每次 execute 有独立 stdout/stderr 缓冲 |
| 并发命令 | 单进程单 PTY，天然串行 | 需要 per-command 隔离或队列仲裁 |
| 可靠性 | 丢弃式背压，无重放 | 需要完整捕获（可重放） |
| 多客户端 | 共享同一终端（广播式） | 通常 per-session 隔离 |

**ttyd 的哲学**：它把自己定位为"键盘+屏幕"的透传层（像 `telnet`/`ssh` 的 Web 版），把"命令边界、完成判定、输出归因"全部推给用户/上层工具。AI 若要同步 execute，必须在 ttyd 之上再加一层（如 ttyd 的兄弟项目 `ttyd.api` / 用 `--once` 每次命令起一个进程，或像 xterm.js 客户端那样自己解析 shell prompt）。

---

## 5. Windows ConPTY 支持

### 5.1 初始化：运行时动态加载 ConPTY API

`pty.c:170-202` 的 `conpty_init()`：用 `uv_dlopen("kernel32.dll")` + `uv_dlsym` 动态查找 `CreatePseudoConsole` / `ResizePseudoConsole` / `ClosePseudoConsole` 三个导出函数，**避免编译期依赖**（兼容 Win10 1809 之前的系统）。`server.c:73-77`（`main` 开头）调用并失败即退出：

```c
#ifdef _WIN32
  if (!conpty_init()) {
    fprintf(stderr, "ERROR: ConPTY init failed! Make sure you are on Windows 10 1809 or later.");
    return 1;
  }
#endif
```

### 5.2 conpty_setup：创建伪终端 + 命名管道

`pty.c:221-290` 的 `conpty_setup` 完整流程：

```c
static bool conpty_setup(HPCON *hnd, COORD size, STARTUPINFOEXW *si_ex,
                         char **in_name, char **out_name) {
  ...
  snprintf(buf, sizeof(buf), "\\\\.\\pipe\\ttyd-term-in-%d-%d", pid, count);   // 唯一命名管道
  snprintf(buf, sizeof(buf), "\\\\.\\pipe\\ttyd-term-out-%d-%d", pid, count);
  in_pipe = CreateNamedPipeA(*in_name, open_mode, pipe_mode, 1, 0, 0, 30000, &sa);   // pty.c:239
  out_pipe = CreateNamedPipeA(*out_name, open_mode, pipe_mode, 1, 0, 0, 30000, &sa);  // pty.c:240
  ...
  HRESULT hr = pCreatePseudoConsole(size, in_pipe, out_pipe, 0, &pty);  // pty.c:246: ConPTY 接管两条管道
  ...
  InitializeProcThreadAttributeList(...);                                // pty.c:258-266
  UpdateProcThreadAttribute(si_ex->lpAttributeList, 0,
      PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pty, sizeof(HPCON), NULL, NULL);  // pty.c:269-272
}
```

要点：
- **两条命名管道**（in/out）分别作为 ConPTY 的输入/输出，模式 `PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT`（字节流、阻塞服务端侧）；
- 通过 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 属性列表把 ConPTY 句柄传给子进程（`STARTUPINFOEXW` 扩展启动信息）；
- 管道名用 `pid + 递增 count` 保证唯一（`pty.c:229-233`）。

### 5.3 管道读写：libuv 连接命名管道

`pty.c:312-375` 的 `pty_spawn`（Windows 分支）：

```c
process->in = xmalloc(sizeof(uv_pipe_t));
process->out = xmalloc(sizeof(uv_pipe_t));
uv_pipe_init(process->loop, process->in, 0);
uv_pipe_init(process->loop, process->out, 0);
uv_pipe_connect(in_req, process->in, in_name, connect_cb);   // pty.c:330
uv_pipe_connect(out_req, process->out, out_name, connect_cb);  // pty.c:331
...
CreateProcessW(NULL, cmdline, NULL, NULL, FALSE, flags, NULL, cwd,
               &process->si.StartupInfo, &pi);                 // pty.c:351
```

- 创建管道后 **libuv 作为客户端连接**这两条命名管道（服务端句柄是 ConPTY 那边的 `in_pipe`/`out_pipe`，创建后即关闭，`pty.c:283-287`）；
- 之后读写完全复用同一套 `process->in`/`process->out` + `read_cb`/`pty_write` 逻辑，**与 POSIX 分支完全同构**（POSIX 是 `forkpty` + `uv_pipe_open`，`pty.c:427-490`）；
- **进程退出检测**：`RegisterWaitForSingleObject(&process->wait, pi.hProcess, conpty_exit, ...)`（`pty.c:366`），内核线程池回调 `conpty_exit`（`pty.c:293-296`）→ `uv_async_send(&process->async)` 安全地回到 libuv 线程执行 `async_cb`（`pty.c:298-311`，取 `GetExitCodeProcess` 后调 `exit_cb` + `process_free`）。**跨线程信号传递用 uv_async 这个标准模式**；
- 窗口大小调整走 `pResizePseudoConsole(process->pty, size)`（`pty.c:148-153`，POSIX 是 `ioctl(TIOCSWINSZ)`）；
- 杀进程用 `TerminateProcess(process->handle, 1)`（`pty.c:160-164`，POSIX 是 `uv_kill(-pid, sig)`）。

---

## 6. 协议设计

### 6.1 消息格式：**二进制**（首字节命令 + 原始载荷），非 JSON

协议常量定义在 `server.h:4-14`：

```c
// client message
#define INPUT '0'
#define RESIZE_TERMINAL '1'
#define PAUSE '2'
#define RESUME '3'
#define JSON_DATA '{'

// server message
#define OUTPUT '0'
#define SET_WINDOW_TITLE '1'
#define SET_PREFERENCES '2'
```

- 每条 WS 消息是**单字节命令前缀 + 载荷**（`LWS_WRITE_BINARY` 二进制帧，`protocol.c:180`）；
- **INPUT/OUTPUT 载荷是原始终端字节流**，不做任何转义或 base64 —— 终端输出必须逐字节透传（ANSI 转义序列不能被破坏）；
- **唯一使用 JSON 的地方**是两条控制消息：`JSON_DATA`（客户端发 `{"columns":N,"rows":N}` 触发进程启动，`protocol.c:332-353` + `parse_window_size` `protocol.c:38-48`）和 `RESIZE_TERMINAL`（`{"columns","rows"}`，`protocol.c:322-325`）；
- 帧边界：每条 WS 消息 = 一次 `uv_write`（输入）或一次 `read_cb` 输出块（输出），无应用层分割。

### 6.2 输入输出是否同一条连接？

**是，完全同一条 WebSocket 连接、同一个协议**（"tty" protocol，`server.c:88` 注册）。没有单独的 control/data 通道。方向靠"服务端写 / 客户端写"天然区分，命令靠首字节区分。所有客户端共用这一个协议（`server.c:86-90` 的 `protocols[]` 数组只有 http + tty 两个协议）。

### 6.3 连接建立时序（握手）

1. HTTP GET `/ws` → `LWS_CALLBACK_ESTABLISHED`（`protocol.c:235`）→ 登记客户端、`client_count++`；
2. 客户端发 `JSON_DATA` → `spawn_process` 启动 PTY 进程（`protocol.c:353`）；
3. `LWS_CALLBACK_SERVER_WRITEABLE`（`protocol.c:257`）先发两条初始化消息：`SET_WINDOW_TITLE`（hostname + 命令）和 `SET_PREFERENCES`（`protocol.c:17-34`），**全部发完**才 `pty_resume` 开始读 PTY（`protocol.c:261`）—— 保证客户端先收到配置再收到输出；
4. 之后就是纯 INPUT/OUTPUT 流。

### 6.4 鉴权与会话

- Basic auth（`-c`）/ auth proxy header（`-H`）在 `LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION` 检查（`protocol.c:222` → `check_auth` `protocol.c:189-202`）；
- 若开了 credential，客户端还要在 `JSON_DATA` 里带 `AuthToken`（`protocol.c:336-347`）才算 `authenticated`，`INPUT` 命令在未认证时被拒（`protocol.c:301-305`）；
- 多客户端共享同一鉴权，无 per-client 会话隔离。

---

## 7. 架构模式与设计哲学总结

### 7.1 核心模式

1. **单线程事件循环 + 回调**（libuv + libwebsockets foreign loop）：没有线程池、没有锁、没有显式队列。所有并发通过"同一线程内串行回调"解决。
2. **单槽背压**（pause/resume + 单 `pty_buf` 槽位）：用"停读→发送→续读"实现流控，任何时刻只有一个在途输出块，天然有序。
3. **推模式而非拉模式**：没有轮询，全部靠 `uv_read_start` 事件 + `lws_callback_on_writable` 唤醒。
4. **PTY 抽象统一**：POSIX `forkpty` 与 Windows ConPTY 收敛为同一套 `pty_process` 接口（in/out 两个 `uv_pipe_t` + async 退出），上层协议代码零平台差异。
5. **字节透传哲学**：终端是字节流设备，协议保持逐字节透传，只在控制消息用 JSON。

### 7.2 与"AI 需要同步 execute 语义"的差异（设计哲学层面）

ttyd 代表的是**终端透传哲学**：它假设对面是"人 + 键盘 + xterm.js"，因此：

- 没有命令边界概念 —— 输入输出都是无界字节流；
- 没有完成事件 —— 完成只能靠进程退出（编码成 WS close 码）或人工看 prompt；
- 没有输出归因 —— 无法回答"这段输出是哪条命令产生的"；
- 多客户端共享一个 PTY —— 无法为每个 AI 会话隔离；
- 背压策略是"丢"不是"存" —— 无法保证输出完整捕获。

**AI 同步 execute 需要的是"事务哲学"**：请求-响应配对、明确的完成信号（exit code）、per-command 输出缓冲、可重放的完整输出、命令级并发仲裁。这意味着不能直接拿 ttyd 当 AI 执行器 —— 要么在 ttyd 之上加协议层（如每次 execute 启动独立 `--once` 进程并用自定义分隔符标记输出边界），要么改用专为自动化设计的 PTY 库（如 Rust 的 `portable-pty` + 自定义事务协议）。ttyd 的价值在于：它证明了"1 PTY : N WS"的共享终端模型与单线程背压流控的简洁性，其 `pty_process` 抽象（in/out 管道 + async 退出回调）是值得 AI 执行器借鉴的底层模式。

---

## 附录：关键代码位置速查表

| 关注点 | 位置 |
|---|---|
| PTY 读回调（暂停式） | `src/pty.c:65-77` |
| PTY 写（uv_write） | `src/pty.c:137-146` |
| 暂停/恢复（背压） | `src/pty.c:124-135` |
| 进程退出（POSIX wait 线程） | `src/pty.c:404-424` |
| 进程退出（uv_async 回调） | `src/pty.c:419-424` |
| PTY 输出 → WS | `src/protocol.c:82-94`（process_read_cb）、`171-181`（wsi_output） |
| WS 写回调（含初始化消息） | `src/protocol.c:257-284` |
| WS 收回调（命令分发） | `src/protocol.c:287-364` |
| 进程启动（JSON_DATA 触发） | `src/protocol.c:154-168, 332-353` |
| 连接仲裁（once/max-clients/auth） | `src/protocol.c:222-234` |
| 断开清理（杀共享进程） | `src/protocol.c:366-395` |
| ConPTY 动态加载 | `src/pty.c:170-202` |
| ConPTY 创建（命名管道） | `src/pty.c:221-290` |
| ConPTY spawn + 管道连接 | `src/pty.c:312-375` |
| 消息协议常量 | `src/server.h:4-14` |
| 事件循环集成（foreign loop） | `src/server.c:412-419` |
| 协议注册 | `src/server.c:86-90` |
