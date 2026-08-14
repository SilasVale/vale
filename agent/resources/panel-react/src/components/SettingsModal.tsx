import { useEffect, useState } from "react";
import { callApi } from "../lib/api";

// Settings modal (round-69): session buffer size, read/written via the
// agent's /api/settings (persisted to config.yaml by the agent).
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [bufferMb, setBufferMb] = useState("8");
  const [status, setStatus] = useState("");

  useEffect(() => {
    callApi("/api/settings")
      .then((j: any) => { if (j && typeof j.buffer_mb === "number") setBufferMb(String(j.buffer_mb)); })
      .catch(() => setStatus("read failed"));
  }, []);

  async function save() {
    const mb = Number(bufferMb);
    if (!Number.isFinite(mb) || mb < 1 || mb > 64) { setStatus("enter 1-64"); return; }
    try {
      const j = await callApi("/api/settings", { method: "PUT", body: JSON.stringify({ buffer_mb: mb }) });
      if (j && j.ok) onClose();
      else setStatus("save failed");
    } catch { setStatus("save failed"); }
  }

  return (
    <div id="settings-modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card">
        <h2>Settings</h2>
        <label>Session buffer (MiB per session)</label>
        <input id="settings-buffer" type="number" min={1} max={64} step={1} value={bufferMb} onChange={(e) => setBufferMb(e.target.value)} />
        <div className="hint">Output recall per terminal session (memory + spill file, ~2x this). 1-64. Applies to new output; persisted across restarts.</div>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
        <div id="settings-status">{status}</div>
      </div>
    </div>
  );
}
