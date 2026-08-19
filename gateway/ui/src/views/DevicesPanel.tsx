import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation, esc } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, ApiError, type Device, type DeviceStatus } from "../api/client.ts";

function maskToken(tok: string) {
  if (!tok) return "";
  if (tok.length <= 8) return tok[0] + "…" + tok.slice(-3);
  return tok.slice(0, 6) + "…" + tok.slice(-4);
}

export default function DevicesPanel() {
  const { user, refreshUser } = useAuth();
  const { t } = useTranslation();
  const { toast } = useToast();
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceStatuses, setDeviceStatuses] = useState<Record<string, DeviceStatus>>({});
  const [cfConfigured, setCfConfigured] = useState(false);
  const [cfMasked, setCfMasked] = useState("");
  const [cfInput, setCfInput] = useState("");
  const [cfMsg, setCfMsg] = useState("");
  const [regKey, setRegKey] = useState("");
  const [regKeyLoading, setRegKeyLoading] = useState(false);
  const [devName, setDevName] = useState("");
  const [devHost, setDevHost] = useState("");
  const [devToken, setDevToken] = useState("");
  const [devMsg, setDevMsg] = useState("");
  const [pairModal, setPairModal] = useState<{ name: string; code: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const data = await api.getDevices();
      setDevices(data.devices || []);
    } catch {
      /* noop */
    }
    // Refresh user for MCP config
    await refreshUser();
  }, [refreshUser]);

  const loadCfToken = useCallback(async () => {
    try {
      const data = await api.getCfToken();
      setCfConfigured(!!data.configured);
      setCfMasked(data.masked || "");
    } catch {
      /* noop */
    }
  }, []);

  const loadDeviceStatus = useCallback(async () => {
    try {
      const data = await api.getPluginStatus();
      if (data.devices) setDeviceStatuses(data.devices);
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    loadDevices();
    loadCfToken();
  }, [loadDevices, loadCfToken]);

  // Poll device status every 30s
  useEffect(() => {
    loadDeviceStatus();
    pollRef.current = setInterval(loadDeviceStatus, 30000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadDeviceStatus]);

  // GW MCP config
  const gwMcpJson = {
    mcpServers: {
      "vale-gate": {
        type: "http",
        url: (typeof window !== "undefined" ? window.location.origin : "") + "/mcp",
        headers: { Authorization: `Bearer ${user?.token || ""}` },
      },
    },
  };

  const handleCopyGwMcp = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(gwMcpJson, null, 2));
      toast(t("devices.mcpCopied"));
    } catch {
      toast(`${t("devices.mcpCopied")} ⚠`, true);
    }
  };

  const handleGenerateRegKey = async () => {
    setRegKeyLoading(true);
    try {
      const data = await api.generateRegKey();
      setRegKey(data.key);
      navigator.clipboard?.writeText(data.key).catch(() => {});
      toast(t("devices.genKey"));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : t("devices.genKeyFail");
      toast(msg, true);
    }
    setRegKeyLoading(false);
  };

  const handleAddDevice = async () => {
    setDevMsg("");
    try {
      await api.saveDevice(devName.trim(), devHost.trim(), devToken.trim());
      setDevName("");
      setDevHost("");
      setDevToken("");
      toast(t("devices.saved"));
      await loadDevices();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : t("devices.saveFail");
      setDevMsg(msg);
    }
  };

  const handleDeleteDevice = async (name: string) => {
    if (!confirm(t("devices.deleteConfirm", { name }))) return;
    try {
      await api.deleteDevice(name);
      toast(`${t("devices.deleted")} ${name}`);
      await loadDevices();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : t("devices.saveFail");
      toast(msg, true);
    }
  };

  const handleCopyMcp = async (name: string) => {
    try {
      const data = await api.getDeviceMcp(name);
      if (data.mcp?.json) {
        await navigator.clipboard.writeText(data.mcp.json);
        toast(t("devices.mcpCopied"));
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : t("devices.saveFail");
      toast(msg, true);
    }
  };

  const handlePair = async (name: string) => {
    try {
      const data = await api.pairDevice(name);
      setPairModal({ name, code: data.code });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : t("devices.pairFail");
      toast(msg, true);
    }
  };

  const handleCopyPairCode = async () => {
    if (!pairModal?.code) return;
    try {
      await navigator.clipboard.writeText(pairModal.code);
      toast(t("devices.pairCopied"));
    } catch {
      toast(t("token.copyFail"), true);
    }
  };

  const handleSaveCfToken = async () => {
    setCfMsg("");
    try {
      await api.setCfToken(cfInput.trim());
      setCfMsg(cfInput.trim() ? t("cf.saved") : t("cf.empty"));
      setCfInput("");
      await loadCfToken();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : t("devices.saveFail");
      setCfMsg(msg);
    }
  };

  return (
    <div>
      <h1>{t("nav.devices")}</h1>
      <p className="lede">{t("devices.lede")}</p>

      {/* Gateway MCP config */}
      <div className="card">
        <div className="card-head">
          <h2>{t("gwMcp.title")}</h2>
          <button className="btn-primary" onClick={handleCopyGwMcp}>
            {t("gwMcp.copy")}
          </button>
        </div>
        <p className="muted">{t("gwMcp.desc")}</p>
        <pre>
          <code>{JSON.stringify(gwMcpJson, null, 2)}</code>
        </pre>
      </div>

      {/* Browser extension */}
      <div className="card">
        <div className="card-head">
          <h2>{t("ext.title")}</h2>
          <div className="install-flow-btns">
            <a
              className="btn-primary"
              href="https://agent.saisi.online/vale-agent/vale-browser-control.zip"
              download
            >
              {t("ext.download")}
            </a>
          </div>
        </div>
        <p className="muted">{t("ext.desc")}</p>
      </div>

      {/* Install new device */}
      <div className="card">
        <div className="card-head">
          <h2>{t("devices.regKeyTitle")}</h2>
          <div className="install-flow-btns">
            <a
              className="btn-primary"
              href="https://agent.saisi.online/vale-agent/ValeAgent-Setup.exe"
              download
            >
              {t("devices.downloadInstall")}
            </a>
            <button className="btn-ghost" disabled={regKeyLoading} onClick={handleGenerateRegKey}>
              {t("devices.genKey")}
            </button>
          </div>
        </div>
        <p className="muted" dangerouslySetInnerHTML={{ __html: t("devices.regKeyDesc") }} />
        {regKey && (
          <div>
            <div className="note tip">
              {t("devices.keyGenerated", { code: `<code class="mono">${esc(regKey)}</code>` })
                .split(/(<code[^>]*>.*?<\/code>)/)
                .map((part, i) =>
                  part.startsWith("<code") ? (
                    <span key={i} dangerouslySetInnerHTML={{ __html: part }} />
                  ) : (
                    <span key={i}>{part}</span>
                  ),
                )}
            </div>
            <div className="key-edit-row" style={{ marginTop: 8 }}>
              <code className="mono">{regKey}</code>
              <button
                className="btn-ghost"
                onClick={() => {
                  navigator.clipboard?.writeText(regKey).then(() => toast(t("devices.keyCopied")));
                }}
              >
                {t("btn.copy")}
              </button>
            </div>
            <div className="muted" style={{ marginTop: 8 }}>{t("devices.regKeyCmd")}</div>
            <div className="key-edit-row">
              <code className="mono">
                $env:VALE_REG_KEY = &quot;{esc(regKey)}&quot;; irm https://agent.saisi.online/vale-agent/vale-agent-setup.ps1 | iex
              </code>
            </div>
          </div>
        )}
      </div>

      {/* Add / update device */}
      <div className="card">
        <div className="card-head">
          <h2>{t("devices.addTitle")}</h2>
        </div>
        <div className="device-form">
          <input
            type="text"
            placeholder={t("devices.namePh")}
            autoComplete="off"
            value={devName}
            onChange={(e) => setDevName(e.target.value)}
          />
          <input
            type="text"
            placeholder={t("devices.hostPh")}
            autoComplete="off"
            value={devHost}
            onChange={(e) => setDevHost(e.target.value)}
          />
          <input
            type="password"
            placeholder={t("devices.tokenPh")}
            autoComplete="off"
            value={devToken}
            onChange={(e) => setDevToken(e.target.value)}
          />
          <button className="btn-primary" onClick={handleAddDevice}>
            {t("btn.save")}
          </button>
        </div>
        {devMsg && <p className="form-msg">{devMsg}</p>}
      </div>

      {/* CF tunnel credential */}
      <div className="card">
        <div className="card-head">
          <h2>{t("cf.title")}</h2>
          <span className={`badge ${cfConfigured ? "ok" : "empty"}`}>
            {cfConfigured ? `${t("cf.configured")} ${cfMasked}` : t("cf.notConfigured")}
          </span>
        </div>
        <p className="muted">{t("cf.desc")}</p>
        <div className="key-edit-row">
          <input
            type="password"
            placeholder="cfat_…（留空保存 = 清除）"
            autoComplete="off"
            value={cfInput}
            onChange={(e) => setCfInput(e.target.value)}
          />
          <button className="btn-primary" onClick={handleSaveCfToken}>
            {t("btn.save")}
          </button>
        </div>
        {cfMsg && <p className="form-msg">{cfMsg}</p>}
      </div>

      {/* Device list */}
      <div className="card">
        <div className="card-head">
          <h2>{t("devices.listTitle")}</h2>
        </div>
        <div className="users-list">
          {devices.length === 0 && (
            <div className="note">{t("devices.empty")}</div>
          )}
          {devices.map((d) => {
            const st = deviceStatuses[d.name] || {};
            const agentUp = !!st.agent_up;
            const extUp = !!st.online;
            let statusClass = "offline";
            let statusLabel = t("devices.offline");
            if (agentUp && extUp) {
              statusClass = "online";
              statusLabel = t("devices.online");
            } else if (agentUp) {
              statusClass = "empty";
              statusLabel = t("devices.offline");
            }

            return (
              <div className="user-row" key={d.name}>
                <div className="user-main">
                  <div className="u-line">
                    <span className="u-name">{d.name}</span>
                    <span className={`badge ${statusClass}`}>
                      <span className="dot" />{statusLabel}
                    </span>
                  </div>
                  <div className="u-sub mono">
                    {d.hostname} · {maskToken(d.token)}
                  </div>
                </div>
                <div className="user-actions">
                  <button className="btn-ghost btn-mini" onClick={() => handlePair(d.name)}>
                    {t("devices.pair")}
                  </button>
                  <a
                    className="btn-ghost btn-mini"
                    href={`https://${d.hostname}/panel/`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("devices.open")}
                  </a>
                  <button className="btn-ghost btn-mini" onClick={() => handleCopyMcp(d.name)}>
                    {t("devices.copyMcp")}
                  </button>
                  <button className="btn-danger btn-mini" onClick={() => handleDeleteDevice(d.name)}>
                    {t("btn.clear")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Pair modal */}
      {pairModal && (
        <div className="modal" onClick={(e) => e.target === e.currentTarget && setPairModal(null)}>
          <div className="modal-card">
            <div className="card-head">
              <h2>{t("devices.pair")}</h2>
              <button className="btn-ghost btn-mini" onClick={() => setPairModal(null)}>
                ✕
              </button>
            </div>
            <p className="muted">{t("devices.pairFor", { name: pairModal.name })}</p>
            <div className="pair-code mono">{pairModal.code}</div>
            <p className="muted">{t("devices.pairHint")}</p>
            <div className="key-actions">
              <button className="btn-primary" onClick={handleCopyPairCode}>
                {t("btn.copy")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
