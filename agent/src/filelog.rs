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

struct Inner {
    file: std::fs::File,
    path: PathBuf,
    written: u64,
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
        Ok(Self { inner: Arc::new(Mutex::new(Inner { file, path, written })) })
    }
}

/// Per-event writer returned by `make_writer` (flushed on drop by the
/// fmt layer). Lock is taken once per write — logging volume here is low.
pub struct Sink {
    inner: Arc<Mutex<Inner>>,
}

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if g.written.saturating_add(buf.len() as u64) > MAX_BYTES {
            let old = g.path.with_extension("log.old");
            let _ = std::fs::rename(&g.path, old);
            g.file = std::fs::OpenOptions::new().create(true).append(true).open(&g.path)?;
            g.written = 0;
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
        // 20 × 64 KiB = 1.25 MiB crossed the cap at least once → .old exists
        // and the live file restarted (size < cap).
        assert!(dir.join("agent.log.old").exists(), "rotation must produce agent.log.old");
        let live = std::fs::metadata(&path).unwrap().len();
        assert!(live > 0 && live <= MAX_BYTES, "live log stays bounded: {live}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
