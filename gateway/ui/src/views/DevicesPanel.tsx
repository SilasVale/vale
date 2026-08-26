import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, ApiError, type Device, type DeviceStatus } from "../api/client.ts";
import { maskToken } from "../lib/format.ts";
import { Card, PageHeader, Badge, CopyButton, Empty } from "../components/ui.tsx";

export default function DevicesPanel() {
  const { user, refreshUser } = useAuth();
  const { t } = useTranslation();
  const { toast } = useToast();
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceStatuses, setDeviceStatuses] = useState<Record<string, DeviceStatus>>({});

  const loadDevices = useCallback(async () => {
    try {
      const data = await api.getDevices();
      setDevices(data.devices || []);
    } catch {
      /* noop */
    }
    await refreshUser();
  }, [refreshUser]);


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
  }, [loadDevices]);

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

  const openPanel = async (name: string) => {
    try {
      const data = await api.getDeviceMcp(name);
      const cfg = JSON.parse(data.mcp.json);
      const auth = cfg.mcpServers["vale-agent"].headers.Authorization; // "Bearer <device_token>"
      const tok = auth.replace("Bearer ", "");
      window.open(`https://${name}.agent.saisi.online/panel/?token=${tok}`, "_blank");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("devices.saveFail"), true);
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

      {/* Install new device (npm route) */}
      <Card title={t("devices.npmTitle")} description={t("devices.npmDesc")}>
        <p className="muted mt-12">{t("devices.npmStep1")}</p>
        <pre className="mt-8">
          <code>{`npm i -g https://agent.saisi.online/vale-agent/vale-agent-1.2.84.tgz`}</code>
        </pre>
        <div className="row mt-8">
          <CopyButton text={`npm i -g https://agent.saisi.online/vale-agent/vale-agent-1.2.84.tgz`} small onCopied={() => toast(t("devices.mcpCopied"))} />
        </div>
        <p className="muted mt-12">{t("devices.npmStep2")}</p>
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
                    <button
                      className="btn btn-ghost btn-mini"
                      onClick={() => openPanel(d.name)}
                    >
                      {t("devices.open")}
                    </button>
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
    </div>
  );
}
