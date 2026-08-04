//! Integration tests for vale_command — lib crate, so we can import vale_command types.

use vale_command::config::Config;
use vale_command::events::AppEventBus;
use vale_command::EventBus;

// ═══════════════════════════════════════════════════════════════
// Config parsing
// ═══════════════════════════════════════════════════════════════

#[test]
fn config_full() {
    let yaml = r#"
server:
  host: "127.0.0.1"
  port: 9999
  name: "vale-command"
serial:
  default_baud_rate: 9600
  default_timeout_ms: 500
browser:
  page_load_timeout_secs: 15
"#;
    let config: Config = serde_yaml::from_str(yaml).unwrap();
    assert_eq!(config.server.host, "127.0.0.1");
    assert_eq!(config.server.port, 9999);
    assert_eq!(config.serial.default_baud_rate, 9600);
    assert_eq!(config.serial.default_timeout_ms, 500);
    assert_eq!(config.browser.page_load_timeout_secs, 15);
}

#[test]
fn config_partial_loads_with_defaults() {
    // #[serde(default)] on every section — a partial config.yaml is valid
    let yaml = "server:\n  port: 4000\n";
    let config: Config = serde_yaml::from_str(yaml).unwrap();
    assert_eq!(config.server.port, 4000);
    assert_eq!(config.server.host, "0.0.0.0"); // default
    assert_eq!(config.serial.default_baud_rate, 115200); // whole section defaulted
    assert_eq!(config.browser.page_load_timeout_secs, 30);
}

#[test]
fn config_ignores_legacy_fields() {
    // Old config.yaml files (pre-0.6) carry ssh.default_timeout_secs and
    // browser.chrome_cdp_url — unknown fields must not break loading
    let yaml = "server:\n  port: 3000\nssh:\n  default_timeout_secs: 30\nbrowser:\n  chrome_cdp_url: \"ws://x\"\n  page_load_timeout_secs: 20\n";
    let config: Config = serde_yaml::from_str(yaml).unwrap();
    assert_eq!(config.browser.page_load_timeout_secs, 20);
}

#[test]
fn config_default_yaml_embedded() {
    // The embedded default config must parse to Config
    let _: Config = serde_yaml::from_str(vale_command::DEFAULT_CONFIG_YAML)
        .expect("DEFAULT_CONFIG_YAML must be valid Config");
}

#[test]
fn config_default_impl() {
    let c = Config::default();
    assert_eq!(c.server.port, 3000);
    assert_eq!(c.server.name, "vale-command");
}

// ═══════════════════════════════════════════════════════════════
// Auth token — ensure_token contract
// ═══════════════════════════════════════════════════════════════

#[test]
fn ensure_token_is_64_hex_chars() {
    use vale_command::config::ServerConfig;
    let mut c = ServerConfig::default();
    let token = c.ensure_token().unwrap().expect("token generated");
    assert_eq!(token.len(), 64);
    // lowercase hex only — digits '0'-'9' and 'a'-'f'
    assert!(token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
}

#[test]
fn ensure_token_idempotent() {
    use vale_command::config::ServerConfig;
    let mut c = ServerConfig::default();
    let t1 = c.ensure_token().unwrap().unwrap();
    let again = c.ensure_token().unwrap();
    assert!(again.is_none(), "second call must not regenerate");
    assert_eq!(c.auth_token.as_deref(), Some(t1.as_str()));
}

#[test]
fn ensure_token_unique_across_configs() {
    use vale_command::config::ServerConfig;
    let mut a = ServerConfig::default();
    let mut b = ServerConfig::default();
    let ta = a.ensure_token().unwrap().unwrap();
    let tb = b.ensure_token().unwrap().unwrap();
    assert_ne!(ta, tb, "two fresh configs must not share a token");
}

#[test]
fn ensure_token_serialization_roundtrip() {
    let mut c = Config::default();
    let token = c.server.ensure_token().unwrap().unwrap();
    let yaml = serde_yaml::to_string(&c).unwrap();
    let back: Config = serde_yaml::from_str(&yaml).unwrap();
    assert_eq!(back.server.auth_token.as_deref(), Some(token.as_str()));
}

// ═══════════════════════════════════════════════════════════════
// EventBus — seq-numbered contract
// ═══════════════════════════════════════════════════════════════

#[test]
fn eventbus_emit_and_recent() {
    let bus = AppEventBus::new();
    let ev = vale_command::AgentEvent::ShellExec { command: "ls".into() };
    let seq = bus.emit(&ev);
    assert_eq!(seq, 1);

    let recent = bus.recent(0);
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].seq, 1);
    let json = serde_json::to_value(&recent[0]).unwrap();
    // SeqEvent envelope: {"seq": n, "event": {...}}
    assert_eq!(json["event"]["type"].as_str().unwrap(), "ShellExec");
}

#[test]
fn eventbus_seq_monotonic() {
    let bus = AppEventBus::new();
    let mut last = 0;
    for i in 0..10 {
        let seq = bus.emit(&vale_command::AgentEvent::ShellExec { command: format!("cmd{i}") });
        assert_eq!(seq, last + 1);
        last = seq;
    }
}

#[test]
fn eventbus_after_filter() {
    let bus = AppEventBus::new();
    for i in 0..5 {
        bus.emit(&vale_command::AgentEvent::ShellExec { command: format!("cmd{i}") });
    }
    // recent(0) returns everything retained
    let all = bus.recent(0);
    assert_eq!(all.len(), 5);
    // recent(3) returns only events with seq > 3
    let tail = bus.recent(3);
    assert_eq!(tail.len(), 2);
    assert_eq!(tail[0].seq, 4);
    assert_eq!(tail[1].seq, 5);
}

#[test]
fn eventbus_ring_cap_and_resume() {
    let bus = AppEventBus::new();
    // Cap is 200; emit 250 events — ring evicts oldest, seq keeps counting
    for i in 0..250 {
        bus.emit(&vale_command::AgentEvent::ShellExec { command: format!("cmd{i}") });
    }
    let all = bus.recent(0);
    assert_eq!(all.len(), 200);
    assert_eq!(all[0].seq, 51); // seq 1–50 evicted
    assert_eq!(all[199].seq, 250);
    // A poller that saw seq 240 resumes with exactly the new 10 —
    // this is the bug the old skip(count)-on-ring design broke after 200 events.
    let tail = bus.recent(240);
    assert_eq!(tail.len(), 10);
    assert_eq!(tail[0].seq, 241);
}

#[test]
fn eventbus_hook_receives_seq() {
    let bus = AppEventBus::new();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = seen.clone();
    bus.set_hook(move |seq, _ev| {
        sink.lock().unwrap().push(seq);
    });
    bus.emit(&vale_command::AgentEvent::ShellExec { command: "a".into() });
    bus.emit(&vale_command::AgentEvent::ShellExec { command: "b".into() });
    assert_eq!(*seen.lock().unwrap(), vec![1u64, 2]);
}

#[test]
fn eventbus_term_hook() {
    let bus = AppEventBus::new();
    let called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = called.clone();

    bus.set_term_hook(move |_v| {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    });

    // emit_term_output should trigger the hook
    let output = serde_json::json!({"session_id": "term-0", "data": [104, 101, 108, 108, 111]});
    bus.emit_term_output(output);

    assert!(called.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn eventbus_term_output_broadcasts() {
    let bus = AppEventBus::new();
    let mut rx = bus.subscribe_term_output();
    let output = serde_json::json!({"session_id": "term-0", "data": [104, 105]});
    bus.emit_term_output(output);
    let got = rx.try_recv().expect("subscriber must receive term output");
    assert_eq!(got["session_id"], "term-0");
    assert_eq!(got["data"], serde_json::json!([104, 105]));
}

// ═══════════════════════════════════════════════════════════════
// require_str helper (tests the real pub fn, not a hand copy)
// ═══════════════════════════════════════════════════════════════

#[test]
fn require_str_ok() {
    use serde_json::json;
    let params = json!({"name": "test", "count": 42});
    let val = vale_command::plugins::require_str(&params, "name").unwrap();
    assert_eq!(val, "test");
}

#[test]
fn require_str_missing() {
    use serde_json::json;
    let params = json!({"other": 1});
    let err = vale_command::plugins::require_str(&params, "name").unwrap_err();
    assert!(err.to_string().contains("name"));
}

// ═══════════════════════════════════════════════════════════════
// clean_terminal_output (tests the real pub fn, not a hand copy)
// ═══════════════════════════════════════════════════════════════

use vale_command::plugins::terminal::clean_terminal_output;

#[test]
fn clean_ansi_strip() {
    let input = b"\x1b[32mhello\x1b[0m world";
    assert_eq!(clean_terminal_output(input), "hello world");
}

#[test]
fn clean_crlf() {
    let input = b"line1\r\nline2\rline3\nline4";
    assert_eq!(clean_terminal_output(input), "line1\nline2\nline3\nline4");
}

#[test]
fn clean_utf8_multibyte() {
    // Chinese characters spanning multiple bytes
    let input = "你好世界".as_bytes();
    assert_eq!(clean_terminal_output(input), "你好世界");
}

#[test]
fn clean_mixed() {
    let input = b"\x1b[1mBold:\x1b[0m progress\r100%\r\nDone.";
    assert_eq!(clean_terminal_output(input), "Bold: progress\n100%\nDone.");
}

#[test]
fn clean_empty() {
    assert_eq!(clean_terminal_output(b""), "");
}

// ═══════════════════════════════════════════════════════════════
// SessionBuf — cursor + absolute-offset clamp logic
// ═══════════════════════════════════════════════════════════════

use vale_command::plugins::terminal::SessionBuf;

#[test]
fn sessionbuf_end_abs_and_slice() {
    let mut b = SessionBuf::new();
    b.data.extend_from_slice(b"hello world");
    assert_eq!(b.end_abs(), 11);
    assert_eq!(b.slice_from(0), b"hello world");
    assert_eq!(b.slice_from(6), b"world");
    // Past-the-end clamps to empty, never panics
    assert_eq!(b.slice_from(999), b"");
}

#[test]
fn sessionbuf_slice_clamps_after_eviction() {
    // Simulate eviction: 100 bytes dropped from the front, 10 retained.
    // Absolute offsets [100, 110) map onto data[0..10).
    let mut b = SessionBuf::new();
    b.dropped = 100;
    b.data.extend_from_slice(b"0123456789");
    assert_eq!(b.end_abs(), 110);
    assert_eq!(b.slice_from(105), b"56789");
    // A stale reader position from before the eviction clamps to the
    // start of retained data (bounded duplication) — never out-of-range.
    assert_eq!(b.slice_from(50), b"0123456789");
    assert_eq!(b.slice_from(0), b"0123456789");
}

// ═══════════════════════════════════════════════════════════════
// SerialPool unit tests (no desktop feature needed)
// ═══════════════════════════════════════════════════════════════

#[test]
fn serial_pool_new() {
    // SerialPool is always compiled (not feature-gated)
    let pool = vale_command::tools::serial::SerialPool::new(115200, 1000);
    let ports = pool.list_open_ports();
    assert!(ports.is_empty()); // no ports open yet
}

#[test]
fn serial_pool_list_ports_does_not_panic() {
    let pool = vale_command::tools::serial::SerialPool::new(115200, 1000);
    // list_ports may fail if no serial ports exist, but shouldn't panic
    let _ = pool.list_ports();
}

// ═══════════════════════════════════════════════════════════════
// CDP_PORT constant
// ═══════════════════════════════════════════════════════════════

#[test]
fn cdp_port_is_19623() {
    assert_eq!(vale_command::tools::cdp::CDP_PORT, 19623);
}
