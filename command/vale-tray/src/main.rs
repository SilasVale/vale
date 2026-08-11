//! Vale Agent system tray controller.
#![windows_subsystem = "windows"]
//!
//! Windows-native tray app (no window) for the headless vale-agent server,
//! which runs as the `ValeAgent` scheduled task (same install dir as this
//! exe). Features:
//!
//!   - Status: server running / subdomain / masked auth token (read from
//!     config.yaml in the install dir)
//!   - Switch: start / stop / restart the ValeAgent scheduled task
//!   - Copy MCP config (Claude Code snippet) to the clipboard
//!   - Open the console (gateway device page) in the default browser
//!   - Open a local terminal (PowerShell in the install dir) for logs/testing
//!   - Updates: manual 检查更新 (dialog) + checkable 自动更新 (silent hourly
//!     check, auto-installs newer ValeAgent-Setup.exe — toggle persisted in
//!     %APPDATA%\ValeAgent\auto-update, progress in vale-update.log)
//!
//! The install dir is located from this exe's own path; the subdomain comes
//! from `vale-agent.hostname` (written by the setup script) and the console
//! URL from `vale-agent.console` (fallback: https://console.saisi.online/).

use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
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
        .unwrap_or_else(|| PathBuf::from("C:\\vale-agent"))
}

/// The device subdomain for this install, from vale-agent.hostname (falls
/// back to the legacy vale-command.hostname name from before the rename).
fn device_hostname() -> String {
    let dir = install_dir();
    std::fs::read_to_string(dir.join("vale-agent.hostname"))
        .or_else(|_| std::fs::read_to_string(dir.join("vale-command.hostname")))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// The console URL — explicit `vale-agent.console` file wins, else the
/// default console host.
fn console_url() -> String {
    std::fs::read_to_string(install_dir().join("vale-agent.console"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://ai.saisi.online/".to_string())
}

/// The device panel URL — the terminal web panel served by vale-command at
/// /panel/. The page is public (like the status page); the user enters the
/// device token in the browser (remembered in localStorage).
fn panel_url() -> String {
    let host = device_hostname();
    if host.is_empty() {
        console_url()
    } else {
        format!("https://{host}/panel/")
    }
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

/// Full device token from config.yaml. Prefers the new `device_token:` field,
/// falls back to the legacy `auth_token:` name (0.8.4 and earlier).
fn auth_token() -> String {
    config_value("device_token")
        .or_else(|| config_value("auth_token"))
        .map(|v| v.trim_matches('"').to_string())
        .unwrap_or_default()
}

/// Directory holding the tray's own state (auto-update toggle, busy marker).
/// Lives in %APPDATA% because the tray runs as the logged-on user and the
/// install dir (C:\vale-agent) is not reliably user-writable.
fn auto_update_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|p| p.join("ValeAgent"))
        .unwrap_or_else(install_dir)
}

/// Is the 自动更新 toggle on? Persisted as "1"/"0" in APPDATA so it survives
/// upgrades and logon/logoff.
fn auto_update_enabled() -> bool {
    std::fs::read_to_string(auto_update_dir().join("auto-update"))
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

fn set_auto_update(enabled: bool) {
    let dir = auto_update_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("auto-update"), if enabled { "1" } else { "0" });
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

/// Launch a `schtasks` command that controls the ValeAgent scheduled task.
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
        "{{ \"mcpServers\": {{ \"vale-agent\": {{ \"type\": \"http\", \
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
            "\"Vale Agent\"",
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
        .args(["/c", "schtasks /End /TN ValeAgent & timeout /t 2 /nobreak >nul & schtasks /Run /TN ValeAgent"])
        .spawn();
}

/// Full auto-upgrade: check the download server for a newer vale-agent and,
/// if one exists, download the installer into the install dir and run it
/// silently (elevated via the runas verb). The silent installer kills
/// vale-agent.exe, copies the new binaries and relaunches a fresh tray via
/// the ValeAgentTray scheduled task; this tray exits right after spawning
/// the PowerShell so the old instance never lingers next to the relaunched
/// one. On any failure (user declined, network, UAC cancel, installer error)
/// the PowerShell script restores the tray itself.
///
/// Uses PowerShell (Windows built-in, no new deps). LOCAL_VERSION must be
/// bumped alongside command/Cargo.toml and index/src/index.js when a new
/// installer is shipped.
const LOCAL_VERSION: &str = "0.9.7";
const VERSION_URL: &str = "https://agent.saisi.online/api/version";

fn check_for_update() {
    let dir = install_dir();
    let ps = format!(
        r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$log = Join-Path '{2}' 'vale-update.log'
function Log($m) {{ try {{ (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m | Out-File -FilePath $log -Append -Encoding utf8 }} catch {{}} }}
function Restore-Tray {{
  try {{ schtasks /Run /TN ValeAgentTray 2>$null | Out-Null; Start-Sleep -Seconds 1 }} catch {{}}
  if (-not (Get-Process vale-tray -ErrorAction SilentlyContinue)) {{
    Start-Process -FilePath '{2}\vale-tray.exe'
  }}
}}
try {{
  Log 'check: start'
  $j = Invoke-RestMethod -Uri '{0}' -TimeoutSec 10
  $remote = [version]$j.version
  $local = [version]'{1}'
  if ($remote -le $local) {{
    Log 'check: up to date'
    [System.Windows.Forms.MessageBox]::Show("已是最新版本 {1}。", "Vale Agent 更新", 'OK')
    return
  }}
  Log "check: newer $($j.version) available"
  $r = [System.Windows.Forms.MessageBox]::Show(
    "发现新版本 $($j.version)（当前 {1}）。是否立即升级？", "Vale Agent 更新", 'YesNo')
  if ($r -ne 'Yes') {{ Log 'check: declined'; return }}
  [System.Windows.Forms.MessageBox]::Show(
    "正在下载更新并静默升级，约需 1 分钟。期间服务会短暂中断，完成后托盘将自动重启。",
    "Vale Agent 更新", 'OK')
  # The old tray must be gone before the installer relaunches a fresh one,
  # otherwise two tray icons appear. Kill it now — the installer restarts it
  # via the ValeAgentTray scheduled task once the new binaries are in place.
  Get-Process vale-tray -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 500
  $installer = Join-Path '{2}' 'ValeAgent-Setup.exe'
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
  Log 'update: downloading'
  Invoke-WebRequest -Uri $j.download -OutFile $installer -TimeoutSec 300
  Log 'update: downloaded, running silent installer'
  $p = Start-Process -FilePath $installer -ArgumentList '/S', "/D={2}" -Verb RunAs -PassThru -Wait
  if ($p.ExitCode -ne 0) {{ throw "安装程序退出码 $($p.ExitCode)" }}
  Log 'update: install ok'
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
  [System.Windows.Forms.MessageBox]::Show(
    "升级完成！已更新到 $($j.version)。", "Vale Agent 更新", 'OK')
}} catch {{
  Log "update: FAILED - $($_.Exception.Message)"
  [System.Windows.Forms.MessageBox]::Show("升级失败：$($_.Exception.Message)", "Vale Agent 更新", 'OK')
  Restore-Tray
}}
"#,
        VERSION_URL, LOCAL_VERSION, dir.display(),
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps])
        .spawn();
    // Do NOT exit here — the tray stays alive. In the upgrade path the
    // PowerShell kills this tray (Stop-Process vale-tray) before running the
    // installer, which relaunches a fresh one; in the "up to date" / "declined"
    // paths this tray keeps running. (Exiting unconditionally made the tray
    // vanish even when the user only clicked "check for updates" on an
    // already-current install.)
}

/// How often the tray re-checks for updates while the 自动更新 toggle is on.
const AUTO_CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Silent auto-update: like `check_for_update()` but with no dialogs at all —
/// query the version endpoint and, if newer, download + run the silent
/// installer. Every step goes to vale-update.log in the install dir (a log
/// endpoint reads it back instead of asking the user to open files). A busy
/// marker in APPDATA guards against two updates racing (the hourly auto check
/// vs a manual 检查更新 click).
fn auto_update_check() {
    let dir = install_dir();
    let ps = format!(
        r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$log = Join-Path '{2}' 'vale-update.log'
function Log($m) {{ try {{ (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m | Out-File -FilePath $log -Append -Encoding utf8 }} catch {{}} }}
$busy = Join-Path $env:APPDATA 'ValeAgent\update-busy'
if (Test-Path $busy) {{ Log 'auto: another update in progress, skip'; return }}
New-Item -ItemType File -Path $busy -Force | Out-Null
function Restore-Tray {{
  try {{ schtasks /Run /TN ValeAgentTray 2>$null | Out-Null; Start-Sleep -Seconds 1 }} catch {{}}
  if (-not (Get-Process vale-tray -ErrorAction SilentlyContinue)) {{
    Start-Process -FilePath '{2}\vale-tray.exe'
  }}
}}
try {{
  Log 'auto: check'
  $j = Invoke-RestMethod -Uri '{0}' -TimeoutSec 10
  $remote = [version]$j.version
  $local = [version]'{1}'
  if ($remote -le $local) {{ Log 'auto: up to date'; return }}
  Log "auto: newer $($j.version) available, silent upgrade"
  # Kill this tray before the installer relaunches a fresh one via the
  # ValeAgentTray task (otherwise two tray icons appear). This PowerShell is a
  # detached child of the tray, so it survives the kill.
  Get-Process vale-tray -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 500
  $installer = Join-Path '{2}' 'ValeAgent-Setup.exe'
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
  Log 'auto: downloading'
  Invoke-WebRequest -Uri $j.download -OutFile $installer -TimeoutSec 300
  Log 'auto: running silent installer'
  $p = Start-Process -FilePath $installer -ArgumentList '/S', "/D={2}" -Verb RunAs -PassThru -Wait
  if ($p.ExitCode -ne 0) {{ throw "安装程序退出码 $($p.ExitCode)" }}
  Log 'auto: install ok'
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
}} catch {{
  Log "auto: FAILED - $($_.Exception.Message)"
  Restore-Tray
}} finally {{
  Remove-Item $busy -Force -ErrorAction SilentlyContinue
}}
"#,
        VERSION_URL, LOCAL_VERSION, dir.display(),
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
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
        let _ = tray.set_tooltip(Some(format!("Vale Agent — {status}")));
    }
}

/// Build the tray icon + menu, retrying until Explorer's tray area accepts it.
///
/// The `ValeAgentTray` at-logon scheduled task can fire before Explorer's
/// tray exists (Shell_NotifyIcon then fails). The old `.expect()` on the first
/// attempt killed the process silently, so the icon never came back after a
/// reboot. Retry for up to ~60s instead.
fn create_tray(png: &[u8]) -> Option<(TrayIcon, TrayUi, CheckMenuItem)> {
    for attempt in 0..20 {
        let img = image::load_from_memory(png).expect("decode tray icon").to_rgba8();
        let (w, h) = img.dimensions();
        let icon = Icon::from_rgba(img.into_raw(), w, h).expect("build tray icon");

        let menu = Menu::new();
        let header = MenuItem::new("Vale Agent", false, None);
        let status_item = MenuItem::new("状态：--", false, None);
        let host_item = MenuItem::new("域名：--", false, None);
        let token_item = MenuItem::new("Token：--", false, None);
        let copy_mcp = MenuItem::with_id("copy_mcp", "复制 MCP 配置", true, None);
        let open_panel = MenuItem::with_id("open_panel", "打开设备面板", true, None);
        let open_console = MenuItem::with_id("open_console", "打开控制台", true, None);
        let open_terminal = MenuItem::with_id("open_terminal", "本地终端", true, None);
        let check_update = MenuItem::with_id("check_update", "检查更新", true, None);
        let auto_update = CheckMenuItem::with_id(
            "auto_update",
            "自动更新",
            true,
            auto_update_enabled(),
            None,
        );
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
        menu.append(&open_panel).expect("menu open_panel");
        menu.append(&open_console).expect("menu open_console");
        menu.append(&open_terminal).expect("menu open_terminal");
        menu.append(&check_update).expect("menu check_update");
        menu.append(&auto_update).expect("menu auto_update");
        menu.append(&sep).expect("menu sep2");
        menu.append(&start).expect("menu start");
        menu.append(&stop).expect("menu stop");
        menu.append(&restart).expect("menu restart");
        menu.append(&sep).expect("menu sep3");
        menu.append(&quit).expect("menu quit");

        let ui = TrayUi { status_item, host_item, token_item, start_item: start, stop_item: stop };

        match TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("Vale Agent")
            .with_icon(icon)
            .build()
        {
            Ok(t) => {
                ui.refresh(&t);
                return Some((t, ui, auto_update));
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

/// Take a Windows named mutex so only ONE tray instance runs — otherwise
/// every update/setup run spawns another tray (AtLogOn task + NSIS relaunch +
/// manual start) and the taskbar shows one icon per process. A second launch
/// sees `ERROR_ALREADY_EXISTS`, shows a toast, and exits; the handle is kept
/// alive for the process lifetime (dropped on exit).
fn single_instance_guard() -> Result<(), ()> {
    use std::ptr::null;
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    const MUTEX_NAME: &str = "Local\\ValeAgentTraySingleInstance";
    let wide: Vec<u16> = MUTEX_NAME.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let h = CreateMutexW(null(), 0, wide.as_ptr());
        if h == 0 { return Err(()); }
        let already = GetLastError() == ERROR_ALREADY_EXISTS;
        if already {
            // Another instance holds the mutex. Close this duplicate handle
            // and report "already running".
            windows_sys::Win32::Foundation::CloseHandle(h);
            Err(())
        } else {
            // Keep the handle alive for the process lifetime by leaking it —
            // the OS reclaims it on exit.
            std::mem::forget(Box::new(h as *mut c_void));
            Ok(())
        }
    }
}

fn main() {
    if single_instance_guard().is_err() {
        // Another tray is already running — flash a toast instead of a second
        // icon, then exit. (No user-visible window, so a MessageBox is the
        // cheapest honest signal.)
        let _ = std::process::Command::new("powershell")
            .args(["-c", "[System.Windows.Forms.MessageBox]::Show('Vale Agent 托盘已在运行。', 'Vale Agent', 'OK', 'Information')"])
            .spawn();
        std::process::exit(0);
    }

    let png = include_bytes!("tray-icon.png");
    let Some((tray, ui, auto_update)) = create_tray(png) else { return };
    let _tray_rx = TrayIconEvent::receiver();

    // --- Event loop ---
    let event_loop = winit::event_loop::EventLoop::new().expect("create event loop");
    let menu_rx = MenuEvent::receiver();
    let mut last_refresh = Instant::now() - REFRESH_INTERVAL;
    // First auto-update check ~60s after tray start (network is often not up
    // right at logon). Only advances when the check actually runs, so toggling
    // 自动更新 on triggers one within a minute.
    let mut last_auto_check = Instant::now() - AUTO_CHECK_INTERVAL + Duration::from_secs(60);

    event_loop
        .run(move |_event, el| {
            // Poll-based loop; wake up at the next refresh tick or on input.
            let next = last_refresh + REFRESH_INTERVAL;
            el.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(next));
            if last_refresh.elapsed() >= REFRESH_INTERVAL {
                ui.refresh(&tray);
                last_refresh = Instant::now();
            }
            if auto_update_enabled() && last_auto_check.elapsed() >= AUTO_CHECK_INTERVAL {
                auto_update_check();
                last_auto_check = Instant::now();
            }
            while let Ok(ev) = menu_rx.try_recv() {
                match ev.id.0.as_str() {
                    "copy_mcp" => copy_mcp_config(),
                    "open_panel" => open_url(&panel_url()),
                    "open_console" => open_url(&console_url()),
                    "open_terminal" => open_local_terminal(),
                    "check_update" => check_for_update(),
                    // The OS toggled the checkmark already — persist whatever
                    // the box now shows (checked → auto-update on).
                    "auto_update" => set_auto_update(auto_update.is_checked()),
                    "start" => schtasks(&["/Run", "/TN", "ValeAgent"]),
                    "stop" => schtasks(&["/End", "/TN", "ValeAgent"]),
                    "restart" => restart_task(),
                    "quit" => std::process::exit(0),
                    _ => {}
                }
            }
        })
        .expect("run event loop");
}
