//! playwright-mcp 进程管理 — 按需启停,用设备 Edge(round-admin-ui)。
//!
//! 管理界面(panel 插件页)经 /api/plugins/playwright/start|stop 启停捆绑的
//! playwright-mcp;127.0.0.1-only 绑定 + allowed-hosts(防端口
//! squatting:同端口无 token 的服务可被任意客户端直接调用)。
//!
//! 捆绑路径约定(Phase 3 打包):node.exe 与 playwright-mcp(dist/cli.js)
//! 都放在 install_dir/playwright/ 下 — 与 update 插件的 install_dir()
//! 同根;dev 构建没有捆绑,start 必须报明确错误而不是假装启动。

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use tokio::process::Child;
use tokio::sync::oneshot;
use vale_agent_core::{recover_guard, DeviceError};

/// 绑定的 playwright-mcp 固定端口 — 与 mcp_client 插件的
/// DEFAULT_URL (http://127.0.0.1:9229/mcp) 一致。
const MCP_PORT: u16 = 9229;

/// playwright-mcp 进程状态机:None = 未运行,Some = 运行中。
/// 所有操作经 recover_guard 拿锁(poison 恢复,与全库一致)。
pub struct PlaywrightManager {
    inner: Mutex<Option<ManagedPlaywright>>,
}

/// 一个运行中的 playwright-mcp 实例。
struct ManagedPlaywright {
    child: Child,
    port: u16,
    /// Kept for a later feature that needs the per-launch token again
    /// (e.g. auto-configuring mcp_client_connect) — start() returns it to
    /// the caller, nothing reads the field yet (round-admin-ui).
    #[allow(dead_code)]
    secret: String,
    started_at: u64,
    /// 保留(round-admin-ui):stop() 之前外部可请求优雅退出;当前只持发送端。
    _kill_tx: oneshot::Sender<()>,
}

/// The directory this exe lives in — where the installer lands and where the
/// NSIS /D= install root points. (Same pattern as update/tools.rs.)
fn install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("C:\\vale-agent"))
}

/// 捆绑的 node.exe — 路径不存在时给出明确错误(dev 构建无捆绑,
/// 测试期望 start 报错而不是静默失败)。
fn bundled_node() -> Result<PathBuf, DeviceError> {
    let p = install_dir().join("playwright").join("node.exe");
    if !p.exists() {
        return Err(DeviceError::Internal {
            message: format!(
                "playwright bundle not found: {} (node.exe missing — the agent installer \
                 bundles playwright-mcp under install_dir/playwright/)",
                p.display()
            ),
        });
    }
    Ok(p)
}

/// 捆绑的 playwright-mcp 入口脚本 — 0.0.79 的 bin 是包根 cli.js
/// (无 dist/;cli.js 相对 require 同目录的 package.json)。
fn bundled_mcp_entry() -> Result<PathBuf, DeviceError> {
    let p = install_dir().join("playwright").join("node_modules").join("@playwright").join("mcp").join("cli.js");
    if !p.exists() {
        return Err(DeviceError::Internal {
            message: format!(
                "playwright-mcp not found: {} (the agent installer bundles \
                 playwright-mcp under install_dir/playwright/)",
                p.display()
            ),
        });
    }
    Ok(p)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl PlaywrightManager {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self { inner: Mutex::new(None) })
    }

    /// Current state — running/port/started_at, or running:false.
    /// round-128: a dead child (crashed after start) must not report
    /// running/healthy — try_wait detects exit; the record is dropped so
    /// start() can recover.
    pub async fn status(&self) -> serde_json::Value {
        let mut guard = recover_guard(&self.inner);
        let Some(m) = guard.as_mut() else {
            return serde_json::json!({ "running": false });
        };
        let exited = m.child.try_wait().ok().flatten().is_some();
        if exited {
            let _ = guard.take(); // dead — clear so start() can relaunch
            return serde_json::json!({ "running": false, "error": "child exited" });
        }
        serde_json::json!({
            "running": true,
            "port": m.port,
            "started_at": m.started_at,
            "healthy": true,
        })
    }

    /// Spawn the bundled playwright-mcp and wait until it answers on
    /// 127.0.0.1:9229 (health poll, up to 10s). On failure the child is
    /// killed and an error is returned — a dead instance is never recorded
    /// as running.
    ///
    /// The Mutex is NEVER held across an await (clippy await_holding_lock):
    /// spawn + health poll run unlocked; the final store re-checks under the
    /// lock so a concurrent start that won the race keeps its child and this
    /// one kills its own — exactly one instance survives.
    pub async fn start(&self) -> Result<serde_json::Value, DeviceError> {
        // round-128: a stored-but-dead child must not block a relaunch —
        // try_wait detects exit; the record is dropped so start proceeds.
        {
            let mut guard = recover_guard(&self.inner);
            if let Some(m) = guard.as_mut() {
                if m.child.try_wait().ok().flatten().is_some() {
                    let _ = guard.take(); // dead — clear for relaunch
                } else {
                    return Ok(serde_json::json!({ "status": "already_running" }));
                }
            }
        }
        // round-129: @playwright/mcp 无 --mcp-token flag(实测 0.0.79 及更早
        // 版本都不接受,child 会立即退出)——per-launch secret 方案不可落地。
        // 防 squatting 改为:127.0.0.1-only 绑定(playwright-mcp 默认)+
        // --allowed-hosts 127.0.0.1(禁 DNS rebinding 的远程访问)。secret
        // 仅作连接信息展示,不再是安全边界。
        let port = MCP_PORT;
        let node = bundled_node()?;
        let entry = bundled_mcp_entry()?;
        let mut child = tokio::process::Command::new(&node)
            .arg(&entry)
            .arg("--port").arg(port.to_string())
            .arg("--browser").arg("msedge")
            // round-131: playwright-mcp 的 Host 比较是 RAW 串含端口 —
            // 非默认端口 9229 上必须写 "127.0.0.1:9229"(写 "127.0.0.1"
            // 永不匹配,所有请求 403,start 永远失败)。含 localhost 同义。
            .arg("--allowed-hosts").arg("127.0.0.1:9229,localhost:9229")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| DeviceError::Internal { message: format!("spawn playwright-mcp: {e}") })?;
        // 健康轮询(最多 10s):POST JSON-RPC initialize 到 /mcp 并验证响应体是
        // 合法的 JSON-RPC 结果。round-129: 旧的 probe.is_ok() 任何 HTTP 状态
        // 都过(GET /mcp 设计上就返回 4xx)——只有真正完成 MCP 握手的实例才算
        // 健康;squatter 无法回合法的 JSON-RPC initialize 响应。同时轮询中检查
        // child 是否已退出(端口被占 → 绑定失败 → 立即死亡)。探测有 2s 超时。
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|e| DeviceError::Internal { message: format!("http client: {e}") })?;
        let mut ok = false;
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            // Child died (bind failure on an occupied port) — fail fast.
            if child.try_wait().map_err(|e| DeviceError::Internal { message: format!("child wait: {e}") })?.is_some() {
                break;
            }
            let probe = client
                .post(format!("http://127.0.0.1:{port}/mcp"))
                .header("content-type", "application/json")
                // round-131: MCP 传输要求 Accept: application/json,
                // text/event-stream — 缺了返回 406,探测永远失败。
                .header("accept", "application/json, text/event-stream")
                .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"vale-agent","version":"1"}}}"#)
                .send()
                .await;
            if let Ok(resp) = probe {
                // Streamable HTTP keeps the response open for server-sent
                // events, so `resp.text().await` waits for EOF and always
                // times out after a successful initialize. Read only the
                // first response chunks; the initialize result is sent at
                // the beginning of the stream.
                let mut stream = resp.bytes_stream();
                let mut body = Vec::new();
                for _ in 0..4 {
                    match tokio::time::timeout(
                        std::time::Duration::from_millis(500),
                        futures::StreamExt::next(&mut stream),
                    )
                    .await
                    {
                        Ok(Some(Ok(chunk))) => {
                            body.extend_from_slice(&chunk);
                            if body.windows(10).any(|w| w == b"serverInfo")
                                && body.windows(8).any(|w| w == b"jsonrpc")
                            {
                                ok = true;
                                break;
                            }
                        }
                        _ => break,
                    }
                }
                if ok {
                    break;
                }
            }
        }
        if !ok {
            let _ = child.kill().await;
            #[cfg(not(windows))]
            let _ = child.wait().await; // reap the zombie (unix dev builds)
            return Err(DeviceError::Internal {
                message: format!("playwright-mcp did not become healthy on 127.0.0.1:{port}"),
            });
        }
        // Win/lose decided atomically under the lock; the loser's child is
        // taken OUT of the block and killed after the guard is released —
        // no await anywhere in the guard's scope (clippy await_holding_lock).
        let (kill_tx, _kill_rx) = oneshot::channel();
        let mut loser: Option<Child> = None;
        {
            let mut guard = recover_guard(&self.inner);
            if guard.is_some() {
                // A concurrent start landed while we polled — lose cleanly.
                loser = Some(child);
            } else {
                *guard = Some(ManagedPlaywright { child, port, secret: String::new(), started_at: now_ms(), _kill_tx: kill_tx });
            }
        }
        if let Some(mut child) = loser {
            let _ = child.kill().await;
            #[cfg(not(windows))]
            let _ = child.wait().await; // reap (round-129: loser path was missing this)
            return Ok(serde_json::json!({ "status": "already_running" }));
        }
        Ok(serde_json::json!({ "status": "started", "port": port }))
    }

    /// Kill the running instance: taskkill /T kills the whole tree on
    /// Windows (node forks Edge — killing only the parent would orphan it);
    /// plain kill on unix (dev). The instance is taken under the lock and
    /// killed WITHOUT holding it (clippy await_holding_lock).
    pub async fn stop(&self) -> Result<serde_json::Value, DeviceError> {
        let m = recover_guard(&self.inner).take();
        if let Some(m) = m {
            #[cfg(windows)]
            {
                let _ = tokio::process::Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &m.child.id().unwrap_or(0).to_string()])
                    .output().await;
            }
            #[cfg(not(windows))]
            {
                // SIGKILL needs &mut Child; the Windows branch above only
                // reads id(), so `mut` lives here, not on the binding.
                let mut m = m;
                let _ = m.child.kill().await;
                let _ = m.child.wait().await; // reap (round-128: zombie-free)
            }
        }
        Ok(serde_json::json!({ "status": "stopped" }))
    }
}
