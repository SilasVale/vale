import { useEffect, useState } from "react";
import { callApi } from "../lib/api";

// SettingsPage — device settings as a first-class page (both densities).
// Cards: Session buffer, Gateway (optional cloud config — register the device
// with a gateway console + optional free cloudflared tunnel), Memory,
// Terminal, Transport.
export function SettingsPage({ onOpenMemory }: { onOpenMemory?: () => void }) {
  const [bufferMb, setBufferMb] = useState("8");
  const [status, setStatus] = useState("");

  // Desktop-app card (Electron shell only): auto-launch on login.
  const desktopBridge = (window as any).valeDesktop;
  const [hasDesktopBridge] = useState(!!desktopBridge?.getAutoLaunch);
  const [autoLaunch, setAutoLaunchState] = useState(false);
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(false);
  const [autoLaunchStatus, setAutoLaunchStatus] = useState("");

  useEffect(() => {
    if (!desktopBridge?.getAutoLaunch) return;
    desktopBridge.getAutoLaunch().then((j: any) => {
      if (j?.ok) setAutoLaunchState(!!j.enabled);
    }).catch(() => setAutoLaunchStatus("desktop bridge unavailable"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setAutoLaunch(enabled: boolean) {
    if (!desktopBridge?.setAutoLaunch) return;
    setAutoLaunchBusy(true);
    setAutoLaunchStatus("");
    try {
      const j = await desktopBridge.setAutoLaunch(enabled);
      if (j?.ok) { setAutoLaunchState(!!j.enabled); setAutoLaunchStatus(j.enabled ? "enabled — Vale Desktop starts at login" : "disabled"); }
      else setAutoLaunchStatus(j?.error || "failed");
    } catch (e: any) { setAutoLaunchStatus(e?.message || "failed"); }
    finally { setAutoLaunchBusy(false); }
  }

  // Gateway card state
  const [gwUrl, setGwUrl] = useState("");
  const [gwKey, setGwKey] = useState("");
  const [gwTunnel, setGwTunnel] = useState(false);
  const [gwStatus, setGwStatus] = useState("");
  const [gwBusy, setGwBusy] = useState(false);

  useEffect(() => {
    callApi("/api/settings")
      .then((j: any) => {
        if (j && typeof j.buffer_mb === "number") setBufferMb(String(j.buffer_mb));
        if (j && typeof j.console_url === "string" && j.console_url) {
          setGwUrl(j.console_url);
          // Persisted gateway state — show it, don't blank the card.
          const parts = ["connected"];
          if (j.tunnel_configured) parts.push(j.tunnel_running ? "tunnel: running" : "tunnel: configured");
          setGwStatus(parts.join(" · "));
        }
      })
      .catch(() => setStatus("read failed"));
  }, []);

  async function save() {
    const mb = Number(bufferMb);
    if (!Number.isFinite(mb) || mb < 1 || mb > 64) { setStatus("enter 1-64"); return; }
    try {
      const j = await callApi("/api/settings", { method: "PUT", body: JSON.stringify({ buffer_mb: mb }) });
      if (j && j.ok) setStatus("saved");
      else setStatus("save failed");
    } catch { setStatus("save failed"); }
  }

  // Save gateway config + register + optional tunnel, one click.
  async function connectGateway() {
    if (!gwUrl.trim()) { setGwStatus("gateway URL required"); return; }
    setGwBusy(true);
    setGwStatus("connecting…");
    try {
      const j = await callApi("/api/gateway/connect", {
        method: "POST",
        body: JSON.stringify({
          console_url: gwUrl.trim(),
          reg_key: gwKey.trim(),
          tunnel: gwTunnel,
        }),
      });
      if (j && j.ok) {
        const parts = [
          j.registered ? "registered" : "not registered",
          `tunnel: ${j.tunnel || "skipped"}`,
        ];
        setGwStatus(parts.join(" · "));
      } else {
        setGwStatus(j?.error || "connect failed");
      }
    } catch (e: any) {
      setGwStatus(e?.message || "connect failed");
    } finally {
      setGwBusy(false);
    }
  }

  return (
    <div className="desktop-settings">
      <h2>Settings</h2>
      <p className="muted">Device: local agent on 127.0.0.1:18080</p>

      <div className="settings-section">
        <h3>Gateway</h3>
        <p className="muted">
          Optional — connect this device to a Vale gateway console so remote clients can use its
          terminal / browser / memory. Pure local mode needs none of this.
        </p>
        <div className="settings-gw-form">
          <input
            className="settings-input"
            placeholder="Gateway URL (e.g. https://api.saisi.online)"
            value={gwUrl}
            onChange={(e) => setGwUrl(e.target.value)}
            aria-label="Gateway URL"
          />
          <input
            className="settings-input"
            placeholder="Registration key (optional — generate at the console)"
            value={gwKey}
            onChange={(e) => setGwKey(e.target.value)}
            aria-label="Registration key"
          />
          <label className="settings-check">
            <input type="checkbox" checked={gwTunnel} onChange={(e) => setGwTunnel(e.target.checked)} />
            <span>Public access (free cloudflared tunnel)</span>
          </label>
          <div className="settings-actions">
            <button className="btn btn-ghost btn-mini" onClick={connectGateway} disabled={gwBusy}>
              {gwBusy ? "Connecting…" : "Save & connect"}
            </button>
          </div>
        </div>
        {gwStatus && <p className="hint settings-status">{gwStatus}</p>}
      </div>

      <div className="settings-section">
        <h3>Session buffer</h3>
        <p className="muted">
          Output recall per terminal session (memory + spill file, ~2x this). 1-64.
          Applies to new output; persisted across restarts.
        </p>
        <div className="settings-row-bar">
          <input
            className="settings-input settings-input-narrow"
            type="number"
            min={1}
            max={64}
            step={1}
            value={bufferMb}
            onChange={(e) => setBufferMb(e.target.value)}
            aria-label="Session buffer MiB"
          />
          <button className="btn btn-ghost btn-mini" onClick={save}>Save</button>
        </div>
        {status && <p className="hint">{status}</p>}
      </div>

      {/* Desktop-app card — only in the Electron shell (window.valeDesktop bridge). */}
      <div className="settings-section">
        <h3>Desktop app</h3>
        <p className="muted">
          Start Vale Desktop automatically when you log in to this machine.
        </p>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={autoLaunch}
            disabled={autoLaunchBusy || !hasDesktopBridge}
            onChange={(e) => setAutoLaunch(e.target.checked)}
          />
          <span>Start on login{!hasDesktopBridge ? " (desktop app only)" : ""}</span>
        </label>
        {autoLaunchStatus && <p className="hint">{autoLaunchStatus}</p>}
      </div>

      <div className="settings-section">
        <h3>Memory</h3>
        <p className="muted">
          Memory entries live in <code>&lt;install&gt;/memory/memory.jsonl</code>, shared across
          AI clients (Claude Code / DSH / this desktop). Capacity is configured in
          config.yaml <code>memory:</code> (max_entries / max_bytes / retention_days).
          AI clients save knowledge via <code>memory_save</code> and query via
          <code> memory_search</code>.
        </p>
        {onOpenMemory && <button className="btn btn-ghost btn-mini" onClick={onOpenMemory}>Open Memory</button>}
      </div>

      <div className="settings-section">
        <h3>Terminal</h3>
        <p className="muted">
          Sessions (PTY/SSH/serial) are held by the agent service — closing this
          window or refreshing never kills a running session. Reconnect via the
          + buttons or <code>terminal_connect_saved</code>.
        </p>
      </div>

      <div className="settings-section">
        <h3>Transport</h3>
        <p className="muted">
          The desktop shell talks to the agent over loopback HTTP/WS with the
          device token. No cloud dependency — saisi.online endpoints are optional.
        </p>
      </div>
    </div>
  );
}
