import { useEffect, useRef, useState } from "react";
import { callApi } from "../lib/api";

// SSH / Serial connection modal (migrated from vanilla panel.js showModal/
// connectModal). Includes the round-70 "Saved connections" dropdown that
// pre-fills the fields from the device's connection memory.
export function ConnModal({ kind, onClose, onConnect }: {
  kind: "ssh" | "serial";
  onClose: () => void;
  onConnect: (target: string, extra: Record<string, unknown>) => Promise<unknown>;
}) {
  const [saved, setSaved] = useState<any[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // ssh fields
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [keyPath, setKeyPath] = useState("");
  // serial fields
  const [sport, setSport] = useState("");
  const [baud, setBaud] = useState("115200");
  // P4b: serial auto-reconnect (unplug / device reboot → re-open same port)
  const [autoReconnect, setAutoReconnect] = useState(false);

  // Load saved connections once (best-effort — the modal works without them).
  useEffect(() => {
    callApi("/api/tools/terminal_saved_connections", { method: "POST", body: "{}" })
      .then((j: any) => {
        const list = (j && j.result && j.result.connections) || [];
        setSaved(list.filter((c: any) => (c.kind || "").startsWith(kind)));
      })
      .catch(() => {});
  }, [kind]);

  // round-102: serial framing params (parity/data/stop) ride in the saved
  // connection's params — remember them on pick and merge into the connect.
  const savedParams = useRef<Record<string, unknown>>({});

  function pickSaved(id: string) {
    const c = saved.find((s) => s.id === id);
    if (!c || !c.target) return;
    savedParams.current = (c.params && typeof c.params === "object" ? c.params : {}) as Record<string, unknown>;
    if (kind === "ssh") {
      // round-102: portless targets ('user@host') never matched the
      // port-required regex and the pick failed silently. Port defaults to 22.
      const m = /^(.*)@(.*?)(?::(\d+))?$/.exec(c.target);
      if (m) { setHost(m[2]); setPort(m[3] || "22"); setUser(m[1]); }
      // key_path rides in the saved params (a path, not a secret — the
      // password is stripped server-side before persisting).
      const kp = savedParams.current.key_path;
      setKeyPath(typeof kp === "string" ? kp : "");
    } else {
      setSport(c.target.split("?")[0]);
      const b = /baud=(\d+)/.exec(c.target || "");
      if (b) setBaud(b[1]);
    }
  }

  async function connect() {
    if (busy) return;
    setBusy(true);
    try {
      if (kind === "ssh") {
        if (!host || !user) { setStatus("host + username required"); setBusy(false); return; }
        const target = `${user}@${host}:${port}`;
        // key_path set → public-key auth server-side; the password field
        // doubles as the key passphrase.
        const extra: Record<string, unknown> = { password: pass };
        if (keyPath.trim()) extra.key_path = keyPath.trim();
        await onConnect(target, extra);
      } else {
        if (!sport) { setStatus("port required"); setBusy(false); return; }
        // round-102: replay the saved framing params (parity/data/stop) so a
        // reconnect preserves the link config.
        const extra: Record<string, unknown> = { ...savedParams.current };
        delete extra.password; // never send credentials through here
        if (autoReconnect) extra.auto_reconnect = true;
        await onConnect(`${sport}?baud=${baud}`, extra);
      }
      onClose();
    } catch (e: any) {
      setStatus(e.message || "connect failed");
    } finally {
      setBusy(false);
    }
  }

  const mkField = (label: string, value: string, set: (v: string) => void, placeholder: string, type = "text") => (
    <>
      {/* panel audit #3: label association via aria-label (ids would collide
          across the several mkField calls in one modal). */}
      <label>{label}</label>
      <input aria-label={label} value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} type={type} autoComplete="off" />
    </>
  );

  return (
    <div id="conn-modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card">
        <h2>{kind === "ssh" ? "New SSH" : "New Serial"}</h2>
        {saved.length > 0 && (
          <>
            <label>Saved connections</label>
            <select id="saved-conn" onChange={(e) => pickSaved(e.target.value)} defaultValue="">
              <option value="">— pick a saved connection —</option>
              {saved.map((c) => (
                <option key={c.id} value={c.id}>{c.label || c.target} ({c.id})</option>
              ))}
            </select>
          </>
        )}
        {kind === "ssh" ? (
          <>
            {mkField("Host", host, setHost, "host.example.com")}
            {mkField("Port", port, setPort, "22")}
            {mkField("Username", user, setUser, "user")}
            {mkField("Private key path (optional)", keyPath, setKeyPath, "C:\\Users\\me\\.ssh\\id_ed25519")}
            {mkField(keyPath.trim() ? "Key passphrase (optional)" : "Password (optional)", pass, setPass, keyPath.trim() ? "leave empty for unencrypted key" : "leave empty for keychain", "password")}
          </>
        ) : (
          <>
            {mkField("Port", sport, setSport, "COM3 or /dev/ttyUSB0")}
            {mkField("Baud rate", baud, setBaud, "115200")}
            <label className="settings-check">
              <input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} />
              <span>Auto-reconnect (reconnect after cable unplug or device restart)</span>
            </label>
          </>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={connect} disabled={busy}>Connect</button>
        </div>
        <div id="modal-status" className={status.startsWith("host") || status.startsWith("port") ? "error" : ""}>{status}</div>
      </div>
    </div>
  );
}
