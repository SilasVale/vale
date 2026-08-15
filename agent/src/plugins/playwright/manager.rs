//! playwright-mcp 进程管理 — 按需启停,用设备 Edge(round-admin-ui)。
//!
//! 管理界面(panel 插件页)经 /api/plugins/playwright/start|stop 启停捆绑的
//! playwright-mcp;per-launch secret 通过 argv 传给 playwright-mcp(防端口
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

/// 捆绑的 playwright-mcp 入口脚本(dist/cli.js)。
fn bundled_mcp_entry() -> Result<PathBuf, DeviceError> {
    let p = install_dir().join("playwright").join("dist").join("cli.js");
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

/// 随机 per-launch secret:16 字节 CSPRNG hex(与 config.rs 的 token 生成
/// 同风格;getrandom 失败绝不回退到可猜测值,直接报错)。
fn random_hex(bytes: usize) -> Result<String, DeviceError> {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf)
        .map_err(|e| DeviceError::Internal { message: format!("failed to generate playwright secret: {e}") })?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
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
    pub async fn status(&self) -> serde_json::Value {
        let guard = recover_guard(&self.inner);
        match guard.as_ref() {
            Some(m) => serde_json::json!({
                "running": true,
                "port": m.port,
                "started_at": m.started_at,
                "healthy": true,
            }),
            None => serde_json::json!({ "running": false }),
        }
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
        if recover_guard(&self.inner).is_some() {
            return Ok(serde_json::json!({ "status": "already_running" }));
        }
        // per-launch secret:随机 16 字节 hex,经 --mcp-token 传给
        // playwright-mcp(无 token 时同端口上的其他客户端可直接调用)。
        let secret = random_hex(16)?;
        let port = MCP_PORT;
        let node = bundled_node()?;
        let entry = bundled_mcp_entry()?;
        let mut child = tokio::process::Command::new(&node)
            .arg(&entry)
            .arg("--port").arg(port.to_string())
            .arg("--browser").arg("msedge")
            .arg("--mcp-token").arg(&secret)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| DeviceError::Internal { message: format!("spawn playwright-mcp: {e}") })?;
        // 健康轮询(最多 10s):GET /mcp 有响应即活着 — playwright-mcp 只收
        // POST,GET 返回 4xx,但连接已建立(端口 squatting 同样有响应,
        // 只是拿不到 MCP 数据;token 校验在请求层)。超时杀进程并报错。
        let mut ok = false;
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if reqwest::Client::new()
                .get(format!("http://127.0.0.1:{port}/mcp"))
                .send()
                .await
                .is_ok()
            {
                ok = true;
                break;
            }
        }
        if !ok {
            let _ = child.kill().await;
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
                *guard = Some(ManagedPlaywright { child, port, secret: secret.clone(), started_at: now_ms(), _kill_tx: kill_tx });
            }
        }
        if let Some(mut child) = loser {
            let _ = child.kill().await;
            return Ok(serde_json::json!({ "status": "already_running" }));
        }
        Ok(serde_json::json!({ "status": "started", "port": port, "secret": secret }))
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
            }
        }
        Ok(serde_json::json!({ "status": "stopped" }))
    }
}
