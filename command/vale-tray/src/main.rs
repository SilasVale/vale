//! Vale Command system tray controller.
#![windows_subsystem = "windows"]
//!
//! Windows-native tray app (no window) for the headless vale-command server,
//! which runs as the `ValeCommand` scheduled task (same install dir as this
//! exe). Features:
//!
//!   - Status: server running / subdomain / masked auth token (read from
//!     config.yaml in the install dir)
//!   - Switch: start / stop / restart the ValeCommand scheduled task
//!   - Copy MCP config (Claude Code snippet) to the clipboard
//!   - Open the console (gateway device page) in the default browser
//!   - Open a local terminal (PowerShell in the install dir) for logs/testing
//!
//! The install dir is located from this exe's own path; the subdomain comes
//! from `vale-command.hostname` (written by the setup script) and the console
//! URL from `vale-command.console` (fallback: https://console.saisi.online/).

use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};

/// Refresh the status line items every this often.
const REFRESH_INTERVAL: Duration = Duration::from_secs(3);
/// Fallback port when config.yaml has no `server.port`.
const DEFAULT_PORT: u16 = 18080;

/// The directory this exe lives in (the install dir).
fn install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("C:\\vale-command"))
}

/// The device subdomain for this install, from vale-command.hostname.
fn device_hostname() -> String {
    std::fs::read_to_string(install_dir().join("vale-command.hostname"))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// The console URL — explicit `vale-command.console` file wins, else the
/// default console host.
fn console_url() -> String {
    std::fs::read_to_string(install_dir().join("vale-command.console"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://console.saisi.online/".to_string())
}

/// First value of the given key in config.yaml (flat `key: value` lines).
fn config_value(key: &str) -> Option<String> {
    let cfg = std::fs::read_to_string(install_dir().join("config.yaml")).ok()?;
    cfg.lines()
        .map(|l| l.trim())
        .find_map(|l| l.strip_prefix(key)?.trim().strip_prefix(':').map(|v| v.trim().to_string()))
}

/// Server port from config.yaml (server.port), else the default.
fn server_port() -> u16 {
    config_value("port").and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_PORT)
}

/// Full auth token from config.yaml (auth_token:), or empty.
fn auth_token() -> String {
    config_value("auth_token")
        .map(|v| v.trim_matches('"').to_string())
        .unwrap_or_default()
}

/// Masked token for display: `a1b2…ef34` (empty → "未找到").
/// Char-safe: the token may be hand-edited into non-ASCII text, and byte
/// slicing would panic on a non-char-boundary — killing the refresh loop.
fn token_mask() -> String {
    let tok = auth_token();
    let chars: Vec<char> = tok.chars().collect();
    if chars.len() >= 8 {
        let head: String = chars[..4].iter().collect();
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("{head}…{tail}")
    } else {
        tok
    }
}

/// Is the local server actually listening? TCP probe on the config port.
fn server_running(port: u16) -> bool {
    let addr = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port);
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Launch a `schtasks` command that controls the ValeCommand scheduled task.
fn schtasks(args: &[&str]) {
    let _ = Command::new("schtasks").args(args).spawn();
}

/// Open a URL in the default browser.
fn open_url(url: &str) {
    let _ = Command::new("cmd").args(["/c", "start", "", url]).spawn();
}

/// Copy the Claude Code MCP config snippet to the clipboard via PowerShell
/// (env var handoff — no quoting/escaping issues on the JSON).
fn copy_mcp_config() {
    let host = device_hostname();
    let token = auth_token();
    if host.is_empty() || token.is_empty() {
        return;
    }
    let json = format!(
        "{{ \"mcpServers\": {{ \"vale-command\": {{ \"type\": \"http\", \
         \"url\": \"https://{host}/mcp\", \"headers\": {{ \"Authorization\": \
         \"Bearer {token}\" }} }} }} }}"
    );
    let _ = Command::new("powershell")
        .env("VALE_MCP_JSON", &json)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Set-Clipboard -Value $env:VALE_MCP_JSON",
        ])
        .spawn();
}

/// Open a local PowerShell window in the install dir (logs / manual testing,
/// independent of the extension).
fn open_local_terminal() {
    let dir = install_dir();
    let _ = Command::new("cmd")
        .args([
            "/c",
            "start",
            "\"Vale Command\"",
            "powershell",
            "-NoExit",
            "-Command",
            &format!("Set-Location -LiteralPath '{}'", dir.display()),
        ])
        .spawn();
}

/// Restart the scheduled task: end, wait for the shutdown, run again.
fn restart_task() {
    let _ = Command::new("cmd")
        .args(["/c", "schtasks /End /TN ValeCommand & timeout /t 2 /nobreak >nul & schtasks /Run /TN ValeCommand"])
        .spawn();
}

/// Handles of the dynamic menu items, so the status lines and start/stop
/// enabled-state can be refreshed without rebuilding the tray.
struct TrayUi {
    status_item: MenuItem,
    host_item: MenuItem,
    token_item: MenuItem,
    start_item: MenuItem,
    stop_item: MenuItem,
}

impl TrayUi {
    fn refresh(&self, tray: &TrayIcon) {
        let port = server_port();
        let running = server_running(port);
        let status = if running { "运行中" } else { "已停止" };
        self.status_item.set_text(format!("状态：{status}"));
        self.start_item.set_enabled(!running);
        self.stop_item.set_enabled(running);
        let host = device_hostname();
        self.host_item.set_text(format!("域名：{}", if host.is_empty() { "未知" } else { &host }));
        let mask = token_mask();
        self.token_item.set_text(format!("Token：{}", if mask.is_empty() { "未找到" } else { &mask }));
        let _ = tray.set_tooltip(Some(format!("Vale Command — {status}")));
    }
}

/// Build the tray icon + menu, retrying until Explorer's tray area accepts it.
///
/// The `ValeCommandTray` at-logon scheduled task can fire before Explorer's
/// tray exists (Shell_NotifyIcon then fails). The old `.expect()` on the first
/// attempt killed the process silently, so the icon never came back after a
/// reboot. Retry for up to ~60s instead.
fn create_tray(png: &[u8]) -> Option<(TrayIcon, TrayUi)> {
    for attempt in 0..20 {
        let img = image::load_from_memory(png).expect("decode tray icon").to_rgba8();
        let (w, h) = img.dimensions();
        let icon = Icon::from_rgba(img.into_raw(), w, h).expect("build tray icon");

        let menu = Menu::new();
        let header = MenuItem::new("Vale Command", false, None);
        let status_item = MenuItem::new("状态：--", false, None);
        let host_item = MenuItem::new("域名：--", false, None);
        let token_item = MenuItem::new("Token：--", false, None);
        let copy_mcp = MenuItem::with_id("copy_mcp", "复制 MCP 配置", true, None);
        let open_console = MenuItem::with_id("open_console", "打开控制台", true, None);
        let open_terminal = MenuItem::with_id("open_terminal", "本地终端", true, None);
        let start = MenuItem::with_id("start", "启动", true, None);
        let stop = MenuItem::with_id("stop", "停止", true, None);
        let restart = MenuItem::with_id("restart", "重启", true, None);
        let quit = MenuItem::with_id("quit", "退出", true, None);
        let sep = PredefinedMenuItem::separator();
        menu.append(&header).expect("menu header");
        menu.append(&status_item).expect("menu status");
        menu.append(&host_item).expect("menu host");
        menu.append(&token_item).expect("menu token");
        menu.append(&sep).expect("menu sep1");
        menu.append(&copy_mcp).expect("menu copy_mcp");
        menu.append(&open_console).expect("menu open_console");
        menu.append(&open_terminal).expect("menu open_terminal");
        menu.append(&sep).expect("menu sep2");
        menu.append(&start).expect("menu start");
        menu.append(&stop).expect("menu stop");
        menu.append(&restart).expect("menu restart");
        menu.append(&sep).expect("menu sep3");
        menu.append(&quit).expect("menu quit");

        let ui = TrayUi { status_item, host_item, token_item, start_item: start, stop_item: stop };

        match TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("Vale Command")
            .with_icon(icon)
            .build()
        {
            Ok(t) => {
                ui.refresh(&t);
                return Some((t, ui));
            }
            Err(e) => {
                eprintln!("[vale-tray] tray icon failed (attempt {}): {e:?}", attempt + 1);
                if attempt < 19 {
                    std::thread::sleep(Duration::from_secs(3));
                }
            }
        }
    }
    None
}

fn main() {
    let png = include_bytes!("tray-icon.png");
    let Some((tray, ui)) = create_tray(png) else { return };
    let _tray_rx = TrayIconEvent::receiver();

    // --- Event loop ---
    let event_loop = winit::event_loop::EventLoop::new().expect("create event loop");
    let menu_rx = MenuEvent::receiver();
    let mut last_refresh = Instant::now() - REFRESH_INTERVAL;

    event_loop
        .run(move |_event, el| {
            // Poll-based loop; wake up at the next refresh tick or on input.
            let next = last_refresh + REFRESH_INTERVAL;
            el.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(next));
            if last_refresh.elapsed() >= REFRESH_INTERVAL {
                ui.refresh(&tray);
                last_refresh = Instant::now();
            }
            while let Ok(ev) = menu_rx.try_recv() {
                match ev.id.0.as_str() {
                    "copy_mcp" => copy_mcp_config(),
                    "open_console" => open_url(&console_url()),
                    "open_terminal" => open_local_terminal(),
                    "start" => schtasks(&["/Run", "/TN", "ValeCommand"]),
                    "stop" => schtasks(&["/End", "/TN", "ValeCommand"]),
                    "restart" => restart_task(),
                    "quit" => std::process::exit(0),
                    _ => {}
                }
            }
        })
        .expect("run event loop");
}
