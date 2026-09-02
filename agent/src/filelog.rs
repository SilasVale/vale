//! stage-n: a tiny size-rotating file writer for `tracing`.
//!
//! The agent's `tracing::info!` lines went ONLY to stdout — in the
//! scheduled-task/service context stdout is a black hole, so runtime
//! operations (the 35 `tracing!` call sites: recovery notices, bridge
//! supervision, gateway events) were invisible on the device. `agent.log`
//! next to the exe fixes that; rotation mirrors the startup.log rule
//! (rename to `.log.old` once past 1 MB, so disk growth stays bounded).

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Soft cap: the file is rotated once a write would cross it.
const MAX_BYTES: u64 = 1_000_000;
/// stage-n: DAILY rotation on top of the size cap — a long-lived agent can
/// sit under 1 MB for days, and without day boundaries an incident's last
/// entries would mix weeks apart. Day change (UTC bucket) or size cap both
/// rotate; rotated files are `agent.log.<stamp>.old`, pruned to KEEP_OLD.
const KEEP_OLD: usize = 3;

fn day_bucket(secs: u64) -> u64 { secs / 86_400 }

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

struct Inner {
    file: std::fs::File,
    path: PathBuf,
    written: u64,
    day: u64,
}

/// Cloneable tracing `MakeWriter`: every `make_writer()` shares one
/// mutex-guarded file so the size accounting stays exact.
#[derive(Clone)]
pub struct RotatingFile {
    inner: Arc<Mutex<Inner>>,
}

impl RotatingFile {
    pub fn new(path: PathBuf) -> std::io::Result<Self> {
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self { inner: Arc::new(Mutex::new(Inner { file, path, written, day: day_bucket(unix_now()) })) })
    }
}

/// Rename the current log out of the way, reopen, sweep to KEEP_OLD .old files.
fn rotate_locked(g: &mut Inner) -> std::io::Result<()> {
    let stamp = unix_now();
    let old = g.path.with_extension(format!("log.{stamp}.old"));
    let _ = std::fs::rename(&g.path, &old);
    g.file = std::fs::OpenOptions::new().create(true).append(true).open(&g.path)?;
    g.written = 0;
    g.day = day_bucket(stamp);
    // prune: keep the newest KEEP_OLD rotated files (names embed the epoch
    // stamp, so a lexical sort of the ".old" siblings is chronological)
    if let Ok(rd) = std::fs::read_dir(g.path.parent().unwrap_or(std::path::Path::new("."))) {
        let prefix = format!("{}.", g.path.file_name().and_then(|n| n.to_str()).unwrap_or("agent.log").trim_end_matches(".log"));
        let mut olds: Vec<PathBuf> = rd.flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with(&prefix) && n.ends_with(".old"))
                    .unwrap_or(false)
            })
            .collect();
        olds.sort();
        while olds.len() > KEEP_OLD {
            let victim = olds.remove(0);
            let _ = std::fs::remove_file(victim);
        }
    }
    Ok(())
}

/// Per-event writer returned by `make_writer` (flushed on drop by the
/// fmt layer). Lock is taken once per write — logging volume here is low.
pub struct Sink {
    inner: Arc<Mutex<Inner>>,
}

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        // size cap OR day change (stage-n: daily rotation)
        if g.written.saturating_add(buf.len() as u64) > MAX_BYTES
            || day_bucket(unix_now()) != g.day
        {
            rotate_locked(&mut g)?;
        }
        let n = g.file.write(buf)?;
        g.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.file.flush()
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for RotatingFile {
    type Writer = Sink;
    fn make_writer(&'a self) -> Sink {
        Sink { inner: self.inner.clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_once_past_the_cap() {
        use tracing_subscriber::fmt::MakeWriter;
        let dir = std::env::temp_dir().join(format!("vale-filelog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.log");
        let w = RotatingFile::new(path.clone()).unwrap();

        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..20 {
            let mut s = w.make_writer();
            s.write_all(&chunk).unwrap();
        }
        // 20 × 64 KiB = 1.25 MiB crossed the cap at least once → a rotated
        // agent.log.<stamp>.old exists and the live file restarted bounded.
        let rotated = std::fs::read_dir(&dir).unwrap().flatten().any(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.starts_with("agent.log.") && n.ends_with(".old")
        });
        assert!(rotated, "rotation must produce agent.log.<stamp>.old");
        let live = std::fs::metadata(&path).unwrap().len();
        assert!(live > 0 && live <= MAX_BYTES, "live log stays bounded: {live}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
