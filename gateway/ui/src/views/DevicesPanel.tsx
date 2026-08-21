import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, ApiError, type Device, type DeviceStatus } from "../api/client.ts";
import { maskToken } from "../lib/format.ts";
import { Card, PageHeader, Badge, CopyButton, Modal, Empty } from "../components/ui.tsx";

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

  const loadDevices = useCallback(async () => {
    try {
      const data = await api.getDevices();
      setDevices(data.devices || []);
    } catch {
      /* noop */
    }
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

  // Poll device status every 60s (KV-budget friendly; manual refresh anytime)
  useEffect(() => {
    loadDeviceStatus();
    const poll = setInterval(loadDeviceStatus, 60000);
    return () => clearInterval(poll);
  }, [loadDeviceStatus]);

  // Gateway MCP config (uses the current account's token)
  const gwMcpJson = {
    mcpServers: {
      "vale-gate": {
        type: "http",
        url: `${window.location.origin}/mcp`,
        headers: { Authorization: `Bearer ${user?.token || ""}` },
      },
    },
  };

  const handleGenerateRegKey = async () => {
    setRegKeyLoading(true);
    try {
      const data = await api.generateRegKey();
      setRegKey(data.key);
      navigator.clipboard?.writeText(data.key).catch(() => {});
      toast(t("devices.genKey"));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("devices.genKeyFail"), true);
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
      setDevMsg(err instanceof ApiError ? err.message : t("devices.saveFail"));
    }
  };

  const handleDeleteDevice = async (name: string) => {
    if (!confirm(t("devices.deleteConfirm", { name }))) return;
    try {
      await api.deleteDevice(name);
      toast(`${t("devices.deleted")} ${name}`);
      await loadDevices();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("devices.saveFail"), true);
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
      toast(err instanceof ApiError ? err.message : t("devices.saveFail"), true);
    }
  };

  const handlePair = async (name: string) => {
    try {
      const data = await api.pairDevice(name);
      setPairModal({ name, code: data.code });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("devices.pairFail"), true);
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
      setCfMsg(err instanceof ApiError ? err.message : t("devices.saveFail"));
    }
  };

  return (
    <div>
      <PageHeader title={t("nav.devices")} description={t("devices.lede")} />

      {/* Gateway MCP config */}
      <Card
        title={t("gwMcp.title")}
        description={t("gwMcp.desc")}
        headerExtra={
          <CopyButton
            text={JSON.stringify(gwMcpJson, null, 2)}
            label={t("gwMcp.copy")}
            tone="primary"
            small
            onCopied={() => toast(t("devices.mcpCopied"))}
          />
        }
      >
        <pre>
          <code>{JSON.stringify(gwMcpJson, null, 2)}</code>
        </pre>
      </Card>

      {/* Browser extension */}
      <Card
        title={t("ext.title")}
        description={t("ext.desc")}
        headerExtra={
          <a className="btn btn-secondary btn-sm" href="https://agent.saisi.online/vale-agent/vale-browser-control.zip" download>
            {t("ext.download")}
          </a>
        }
      />

      {/* Install new device */}
      <Card
        title={t("devices.regKeyTitle")}
        description={<span dangerouslySetInnerHTML={{ __html: t("devices.regKeyDesc") }} />}
        headerExtra={
          <div className="install-flow-btns">
            <a className="btn btn-secondary btn-sm" href="https://agent.saisi.online/vale-agent/ValeAgent-Setup.exe" download>
              {t("devices.downloadInstall")}
            </a>
            <button className="btn btn-primary btn-sm" disabled={regKeyLoading} onClick={handleGenerateRegKey}>
              {t("devices.genKey")}
            </button>
          </div>
        }
      >
        {regKey && (
          <div>
            <div className="note tip">
              {t("devices.keyGenerated", { code: "" })}
            </div>
            <div className="input-row">
              <code className="token">{regKey}</code>
              <CopyButton text={regKey} onCopied={() => toast(t("devices.keyCopied"))} />
            </div>
            <p className="muted mt-12">{t("devices.regKeyCmd")}</p>
            <pre className="mt-8">
              <code>{`$env:VALE_REG_KEY = "${regKey}"; irm https://agent.saisi.online/vale-agent/vale-agent-setup.ps1 | iex`}</code>
            </pre>
            <div className="row mt-8">
              <CopyButton
                text={`$env:VALE_REG_KEY = "${regKey}"; irm https://agent.saisi.online/vale-agent/vale-agent-setup.ps1 | iex`}
                small
                onCopied={() => toast(t("devices.keyCopied"))}
              />
            </div>
          </div>
        )}
      </Card>

      {/* Add / update device */}
      <Card title={t("devices.addTitle")}>
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
          <button className="btn btn-primary" onClick={handleAddDevice}>
            {t("btn.save")}
          </button>
        </div>
        {devMsg && <p className="form-msg">{devMsg}</p>}
      </Card>

      {/* CF tunnel credential */}
      <Card
        title={t("cf.title")}
        description={t("cf.desc")}
        headerExtra={
          <Badge tone={cfConfigured ? "success" : "muted"}>
            {cfConfigured ? `${t("cf.configured")} ${cfMasked}` : t("cf.notConfigured")}
          </Badge>
        }
      >
        <div className="input-row">
          <input
            className="form-input"
            type="password"
            placeholder="cfat_…"
            autoComplete="off"
            value={cfInput}
            onChange={(e) => setCfInput(e.target.value)}
          />
          <button className="btn btn-primary" onClick={handleSaveCfToken}>
            {t("btn.save")}
          </button>
        </div>
        {cfMsg && <p className="form-msg ok">{cfMsg}</p>}
      </Card>

      {/* Device list */}
      <Card title={t("devices.listTitle")}>
        {devices.length === 0 ? (
          <Empty>{t("devices.empty")}</Empty>
        ) : (
          <div className="list">
            {devices.map((d) => {
              const st = deviceStatuses[d.name] || {};
              const agentUp = !!st.agent_up;
              const extUp = !!st.online;
              const online = agentUp && extUp;

              return (
                <div className="list-row" key={d.name}>
                  <div className="list-main">
                    <div className="list-line">
                      <span className={`dot ${online ? "online" : "offline"}`} />
                      <span className="list-title">{d.name}</span>
                      <Badge tone={online ? "success" : "muted"} dot>
                        {online ? t("devices.online") : t("devices.offline")}
                      </Badge>
                    </div>
                    <div className="list-sub">
                      {d.hostname} · {maskToken(d.token)}
                    </div>
                  </div>
                  <div className="list-actions">
                    <button className="btn btn-ghost btn-mini" onClick={() => handlePair(d.name)}>
                      {t("devices.pair")}
                    </button>
                    <a
                      className="btn btn-ghost btn-mini"
                      href={`https://${d.hostname}/panel/`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t("devices.open")}
                    </a>
                    <button className="btn btn-ghost btn-mini" onClick={() => handleCopyMcp(d.name)}>
                      {t("devices.copyMcp")}
                    </button>
                    <button className="btn btn-danger btn-mini" onClick={() => handleDeleteDevice(d.name)}>
                      {t("btn.clear")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Pair modal */}
      {pairModal && (
        <Modal title={`${t("devices.pair")} · ${pairModal.name}`} onClose={() => setPairModal(null)}>
          <p className="muted" style={{ marginBottom: 12 }}>
            {t("devices.pairFor", { name: pairModal.name })}
          </p>
          <div className="modal-code">{pairModal.code}</div>
          <p className="muted" style={{ marginBottom: 14 }}>
            {t("devices.pairHint")}
          </p>
          <div className="modal-actions">
            <CopyButton
              text={pairModal.code}
              tone="primary"
              onCopied={() => toast(t("devices.pairCopied"))}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
