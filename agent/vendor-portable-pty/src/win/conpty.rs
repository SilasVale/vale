use crate::cmdbuilder::CommandBuilder;
use crate::win::psuedocon::PsuedoCon;
use crate::{Child, MasterPty, PtyPair, PtySize, PtySystem, SlavePty};
use anyhow::Error;
use filedescriptor::{FileDescriptor, Pipe};
use std::io;
use std::sync::{Arc, Mutex};
use winapi::shared::minwindef::DWORD;
use winapi::um::namedpipeapi::PeekNamedPipe;
use winapi::um::wincon::COORD;

/// Non-blocking reader over the ConPTY output pipe. Windows anonymous pipes
/// cannot be put into non-blocking mode (only sockets can), and the pipe
/// never EOFs while the HPCON lives — so a plain blocking ReadFile would
/// hang forever after the shell exits. PeekNamedPipe queries the pipe buffer
/// without blocking: no data → WouldBlock (the pty.rs reader polls on that);
/// data available → ReadFile returns it immediately. stage-n.
struct ConPtyReader {
    inner: FileDescriptor,
}

impl ConPtyReader {
    fn new(inner: FileDescriptor) -> Self {
        Self { inner }
    }
}

impl io::Read for ConPtyReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        use winapi::um::winnt::HANDLE;
        use std::os::windows::io::AsRawHandle;
        let mut avail: DWORD = 0;
        let h = self.inner.as_raw_handle() as HANDLE;
        // PeekNamedPipe never blocks: reports how many bytes are buffered
        // (0 = no output yet → WouldBlock so the caller polls).
        let ok = unsafe {
            PeekNamedPipe(
                h,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut avail,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        if avail == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "no data in ConPTY pipe",
            ));
        }
        // Data is available — a blocking read returns immediately.
        self.inner.read(buf)
    }
}

#[derive(Default)]
pub struct ConPtySystem {}

impl PtySystem for ConPtySystem {
    fn openpty(&self, size: PtySize) -> anyhow::Result<PtyPair> {
        let stdin = Pipe::new()?;
        let stdout = Pipe::new()?;

        let con = PsuedoCon::new(
            COORD {
                X: size.cols as i16,
                Y: size.rows as i16,
            },
            stdin.read,
            stdout.write,
        )?;

        let master = ConPtyMasterPty {
            inner: Arc::new(Mutex::new(Inner {
                con,
                readable: stdout.read,
                writable: Some(stdin.write),
                size,
            })),
        };

        let slave = ConPtySlavePty {
            inner: master.inner.clone(),
        };

        Ok(PtyPair {
            master: Box::new(master),
            slave: Box::new(slave),
        })
    }
}

struct Inner {
    con: PsuedoCon,
    readable: FileDescriptor,
    writable: Option<FileDescriptor>,
    size: PtySize,
}

impl Inner {
    pub fn resize(
        &mut self,
        num_rows: u16,
        num_cols: u16,
        pixel_width: u16,
        pixel_height: u16,
    ) -> Result<(), Error> {
        self.con.resize(COORD {
            X: num_cols as i16,
            Y: num_rows as i16,
        })?;
        self.size = PtySize {
            rows: num_rows,
            cols: num_cols,
            pixel_width,
            pixel_height,
        };
        Ok(())
    }
}

#[derive(Clone)]
pub struct ConPtyMasterPty {
    inner: Arc<Mutex<Inner>>,
}

pub struct ConPtySlavePty {
    inner: Arc<Mutex<Inner>>,
}

impl MasterPty for ConPtyMasterPty {
    fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.resize(size.rows, size.cols, size.pixel_width, size.pixel_height)
    }

    fn get_size(&self) -> Result<PtySize, Error> {
        let inner = self.inner.lock().unwrap();
        Ok(inner.size.clone())
    }

    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        let r = self.inner.lock().unwrap().readable.try_clone()?;
        // stage-n: ConPTY's output pipe never EOFs while the HPCON lives —
        // a blocking reader would hang forever after a natural shell exit
        // (`exit`), leaving the session 'live' until the sweeper. ConPtyReader
        // makes the read pollable via PeekNamedPipe (Windows pipes cannot be
        // set non-blocking — only sockets can): no data → WouldBlock, so the
        // pty.rs reader polls. The reaper drops the reader handle on child
        // exit and the polling loop sees the handle gone within one poll
        // interval. (ClosePseudoConsole is NOT used — it terminates every
        // process attached to the pseudo console, which on a shared console
        // host takes down unrelated processes; node-pty never closes the
        // HPCON on child exit either.)
        Ok(Box::new(ConPtyReader::new(r)))
    }

    fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
        Ok(Box::new(
            self.inner
                .lock()
                .unwrap()
                .writable
                .take()
                .ok_or_else(|| anyhow::anyhow!("writer already taken"))?,
        ))
    }
}

impl SlavePty for ConPtySlavePty {
    fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<Box<dyn Child + Send + Sync>> {
        let inner = self.inner.lock().unwrap();
        let child = inner.con.spawn_command(cmd)?;
        Ok(Box::new(child))
    }
}
