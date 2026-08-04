//! Vale Command system tray controller.
#![windows_subsystem = "windows"]
//!
//! Shows a tray icon (Tailscale-style) that controls the headless vale-command
//! server, which runs as the `ValeCommand` scheduled task. The scheduled task
//! and the tray live in the same install directory, so this binary locates the
//! install dir from its own exe path and reads the assigned subdomain from
//! `vale-command.hostname` (written by the setup script).

use std::path::PathBuf;
use std::process::Command;

use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};

/// The directory this exe lives in (the install dir).
fn install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("C:\\vale-command"))
}

/// The public panel URL for this install, from vale-command.hostname.
fn panel_url() -> String {
    let host = std::fs::read_to_string(install_dir().join("vale-command.hostname"))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "d1.command.saisi.online".to_string());
    format!("https://{}/", host)
}

/// Launch a `schtasks` command that controls the ValeCommand scheduled task.
fn schtasks(args: &[&str]) {
    let _ = Command::new("schtasks").args(args).spawn();
}

/// Build the tray icon + menu, retrying until Explorer's tray area accepts it.
///
/// The `ValeCommandTray` at-logon scheduled task can fire before Explorer's
/// tray exists (Shell_NotifyIcon then fails). The old `.expect()` on the first
/// attempt killed the process silently, so the icon never came back after a
/// reboot. Retry for up to ~60s instead.
fn create_tray(png: &[u8]) -> Option<TrayIcon> {
    for attempt in 0..20 {
        let img = image::load_from_memory(png).expect("decode tray icon").to_rgba8();
        let (w, h) = img.dimensions();
        let icon = Icon::from_rgba(img.into_raw(), w, h).expect("build tray icon");

        let menu = Menu::new();
        let status = MenuItem::new("Vale Command", false, None);
        let open = MenuItem::with_id("open", "打开面板", true, None);
        let start = MenuItem::with_id("start", "启动", true, None);
        let stop = MenuItem::with_id("stop", "停止", true, None);
        let quit = MenuItem::with_id("quit", "退出", true, None);
        let sep = PredefinedMenuItem::separator();
        menu.append(&status).expect("menu status");
        menu.append(&sep).expect("menu sep1");
        menu.append(&open).expect("menu open");
        menu.append(&start).expect("menu start");
        menu.append(&stop).expect("menu stop");
        menu.append(&sep).expect("menu sep2");
        menu.append(&quit).expect("menu quit");

        match TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("Vale Command")
            .with_icon(icon)
            .build()
        {
            Ok(t) => return Some(t),
            Err(e) => {
                eprintln!("[vale-tray] tray icon failed (attempt {}): {e:?}", attempt + 1);
                if attempt < 19 {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                }
            }
        }
    }
    None
}

fn main() {
    let png = include_bytes!("tray-icon.png");
    let _tray = create_tray(png);

    // --- Event loop ---
    let event_loop = winit::event_loop::EventLoop::new().expect("create event loop");
    let menu_rx = MenuEvent::receiver();
    let _tray_rx = TrayIconEvent::receiver();

    event_loop
        .run(move |_event, _el| {
            while let Ok(ev) = menu_rx.try_recv() {
                match ev.id.0.as_str() {
                    "open" => {
                        let _ = Command::new("cmd")
                            .args(["/c", "start", "", &panel_url()])
                            .spawn();
                    }
                    "start" => schtasks(&["/Run", "/TN", "ValeCommand"]),
                    "stop" => schtasks(&["/End", "/TN", "ValeCommand"]),
                    "quit" => std::process::exit(0),
                    _ => {}
                }
            }
        })
        .expect("run event loop");
}
