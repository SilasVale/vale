//! tools/ — device TRANSPORT libraries, layered UNDER the terminal plugin's
//! backends (boundary map, architecture review 2026-09-06):
//!
//!   tools/ssh.rs            russh client transport (SshHandler/SshSession)
//!   tools/serial.rs         serial port transport (SerialPool)
//!   tools/terminal/         TermBackend ADAPTERS over those transports
//!                           (pty/ssh/serial/stub) + TerminalManager,
//!                           secrets, shell integration, connections
//!
//! The two ssh.rs files are transport vs adapter, not duplicates; plugins/
//! consume the adapters (and files.rs dials the ssh transport directly for
//! SFTP). Dependency direction: plugins -> tools/terminal -> tools/*
//! transports. No cycles (verified by the use-crate tally).

pub mod serial;
#[cfg(feature = "terminal")]
pub mod ssh;
pub mod terminal;
