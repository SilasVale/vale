//! Serial port pool — enumeration and port lifecycle.
//!
//! Terminal sessions take ports out of the pool via `take_port` and do raw
//! byte I/O on their own threads (no pool lock contention). The hex-encoded
//! read/write API that used to live here is gone — MCP speaks bytes directly.
//!
//! The pool's internal lock is a plain `std::sync::Mutex` — critical sections
//! are microseconds. Blocking work (device enumeration, port open) happens in
//! the callers' `spawn_blocking`, never under the lock.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use vale_agent_core::{recover_guard, DeviceError};

/// Monotonic port-id counter (uuid was overkill for session labels).
static NEXT_PORT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
pub struct SerialPortInfo {
    /// OS port name, e.g. /dev/ttyUSB0 or COM3.
    pub port_name: String,
    /// Hardware description if available.
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenPortInfo {
    pub id: String,
    pub port_name: String,
    pub baud_rate: u32,
}

// open()/take_port() only have callers in terminal-feature builds; the struct/fields
// exist in both so list_open_ports() works headless.
#[cfg_attr(not(feature = "terminal"), allow(dead_code))]
struct OpenPort {
    port: Box<dyn serialport::SerialPort>,
    port_name: String,
    baud_rate: u32,
}

pub struct SerialPool {
    ports: Mutex<HashMap<String, OpenPort>>,
    default_baud_rate: u32,
    default_timeout: Duration,
}

impl SerialPool {
    pub fn new(default_baud_rate: u32, default_timeout_ms: u64) -> Self {
        Self {
            ports: Mutex::new(HashMap::new()),
            default_baud_rate,
            default_timeout: Duration::from_millis(default_timeout_ms),
        }
    }

    /// Enumerate available serial ports. Blocking (device enumeration) —
    /// callers should run this via `spawn_blocking`.
    pub fn list_ports(&self) -> Result<Vec<SerialPortInfo>, DeviceError> {
        let ports = serialport::available_ports().map_err(|e| DeviceError::Internal {
            message: e.to_string(),
        })?;
        Ok(ports
            .into_iter()
            .map(|p| SerialPortInfo {
                port_name: p.port_name,
                description: None,
            })
            .collect())
    }

    /// Open a port and register it in the pool. Returns (port_id, baud_rate).
    /// Desktop terminal sessions immediately `take_port` it for exclusive use.
    /// Blocking (serialport open can stall on flaky hardware) — callers should
    /// run this via `spawn_blocking`.
    #[cfg_attr(not(feature = "terminal"), allow(dead_code))]
    pub fn open(
        &self,
        port_name: String,
        baud_rate: Option<u32>,
        data_bits: Option<u8>,
        parity: Option<String>,
        stop_bits: Option<u8>,
    ) -> Result<(String, u32), DeviceError> {
        let baud = baud_rate.unwrap_or(self.default_baud_rate);

        let mut builder = serialport::new(&port_name, baud).timeout(self.default_timeout);

        // Data bits
        if let Some(db) = data_bits {
            let db = match db {
                5 => serialport::DataBits::Five,
                6 => serialport::DataBits::Six,
                7 => serialport::DataBits::Seven,
                _ => serialport::DataBits::Eight,
            };
            builder = builder.data_bits(db);
        }

        // Parity
        if let Some(ref p) = parity {
            let parity = match p.to_lowercase().as_str() {
                "odd" => serialport::Parity::Odd,
                "even" => serialport::Parity::Even,
                _ => serialport::Parity::None,
            };
            builder = builder.parity(parity);
        }

        // Stop bits
        if let Some(sb) = stop_bits {
            let sb = match sb {
                2 => serialport::StopBits::Two,
                _ => serialport::StopBits::One,
            };
            builder = builder.stop_bits(sb);
        }

        let port = builder.open().map_err(|e| DeviceError::SerialPortNotFound {
            port: format!("{port_name}: {e}"),
        })?;

        let id = format!("port-{}", NEXT_PORT_ID.fetch_add(1, Ordering::Relaxed));
        recover_guard(&self.ports)
            .insert(
                id.clone(),
                OpenPort {
                    port,
                    port_name: port_name.clone(),
                    baud_rate: baud,
                },
            );

        Ok((id, baud))
    }

    /// Take ownership of a port, removing it from the pool.
    /// Used by terminal sessions that need exclusive port access without pool lock contention.
    #[cfg_attr(not(feature = "terminal"), allow(dead_code))]
    pub fn take_port(&self, port_id: &str) -> Option<Box<dyn serialport::SerialPort>> {
        recover_guard(&self.ports)
            .remove(port_id)
            .map(|entry| entry.port)
    }

    pub fn list_open_ports(&self) -> Vec<OpenPortInfo> {
        recover_guard(&self.ports)
            .iter()
            .map(|(id, p)| OpenPortInfo {
                id: id.clone(),
                port_name: p.port_name.clone(),
                baud_rate: p.baud_rate,
            })
            .collect()
    }
}
