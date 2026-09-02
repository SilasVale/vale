//! stage-n: device vitals for `/api/status` — CPU busy% and memory used%.
//!
//! Windows-only sources (kernel32 `GetSystemTimes` / `GlobalMemoryStatusEx`
//! via windows-sys); every other platform returns `None` so the endpoint
//! shape degrades gracefully (public call sites stay identical across
//! configs — same convention as the terminal feature gating).
//!
//! CPU is a DELTA metric: `GetSystemTimes` returns boot-relative counters,
//! so utilization is only computable between two samples. The previous
//! sample is kept in a static (poison-recovered `into_inner`). Callers that
//! poll the status endpoint (SPA strip, tray) naturally produce the pair.

#[cfg(windows)]
use std::sync::Mutex;

/// Snapshot of the vitals. `None` = not (yet) computable on this host.
#[derive(Debug, Clone, Copy, Default)]
pub struct Vitals {
    /// CPU busy percentage since the previous `sample()` (0..=100).
    pub cpu_pct: Option<f64>,
    /// Physical memory in use, percentage (0..=100).
    pub mem_pct: Option<f64>,
    /// Total physical memory, MiB.
    pub mem_total_mb: Option<u64>,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy)]
struct CpuTimes {
    idle: u64,
    kernel: u64, // kernel includes idle (Windows semantics)
    user: u64,
}

#[cfg(windows)]
static PREV_CPU: Mutex<Option<CpuTimes>> = Mutex::new(None);

/// Take one vitals sample. Cheap; safe to call per status request.
pub fn sample() -> Vitals {
    #[cfg(windows)]
    {
        windows_vitals()
    }
    #[cfg(not(windows))]
    {
        Vitals::default()
    }
}

#[cfg(windows)]
fn windows_vitals() -> Vitals {
    use std::mem::zeroed;
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::GetSystemTimes;

    let mut out = Vitals::default();

    // ── CPU: busy% between this call and the previous one ──────────────
    unsafe {
        let (mut idle, mut kernel, mut user): (
            windows_sys::Win32::Foundation::FILETIME,
            windows_sys::Win32::Foundation::FILETIME,
            windows_sys::Win32::Foundation::FILETIME,
        ) = (zeroed(), zeroed(), zeroed());
        if GetSystemTimes(&mut idle, &mut kernel, &mut user) != 0 {
            let to_u64 = |ft: &windows_sys::Win32::Foundation::FILETIME| {
                ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
            };
            let cur = CpuTimes {
                idle: to_u64(&idle),
                kernel: to_u64(&kernel),
                user: to_u64(&user),
            };
            let prev = PREV_CPU.lock().unwrap_or_else(|p| p.into_inner()).replace(cur);
            if let Some(prev) = prev {
                let d_idle = cur.idle.saturating_sub(prev.idle);
                let d_total = (cur.kernel.saturating_add(cur.user))
                    .saturating_sub(prev.kernel.saturating_add(prev.user));
                if d_total > 0 {
                    let busy = d_total.saturating_sub(d_idle) as f64 / d_total as f64 * 100.0;
                    out.cpu_pct = Some(round1(busy));
                }
            }
        }
    }

    // ── Memory: used% + total MiB ───────────────────────────────────────
    unsafe {
        let mut stat: MEMORYSTATUSEX = zeroed();
        stat.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut stat) != 0 {
            if stat.ullTotalPhys > 0 {
                let used = stat.ullTotalPhys - stat.ullAvailPhys;
                out.mem_pct = Some(round1(used as f64 / stat.ullTotalPhys as f64 * 100.0));
                out.mem_total_mb = Some(stat.ullTotalPhys / (1024 * 1024));
            }
        }
    }

    out
}

#[allow(dead_code)] // used by the Windows path; unit-tested on all hosts
fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_never_panics_and_round1_is_exact() {
        let v = sample();
        // Non-Windows: all None. Windows: values in range when present.
        if let Some(c) = v.cpu_pct {
            assert!((0.0..=100.0).contains(&c));
        }
        if let Some(m) = v.mem_pct {
            assert!((0.0..=100.0).contains(&m));
        }
        assert_eq!(round1(12.34), 12.3);
        assert_eq!(round1(12.36), 12.4);
        assert_eq!(round1(100.0), 100.0);
    }
}
