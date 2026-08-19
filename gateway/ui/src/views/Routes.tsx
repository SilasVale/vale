import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, type HealthChannel } from "../api/client.ts";

export default function Routes() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const { toast } = useToast();
  const [channels, setChannels] = useState<HealthChannel[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [apiHost, setApiHost] = useState("");
  const [loading, setLoading] = useState(true);
  const [usproxyOn, setUsproxyOn] = useState(false);
  const [usproxyLoading, setUsproxyLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  const loadChannels = useCallback(async () => {
    try {
      const [health, route, publicInfo, proxy] = await Promise.all([
        api.getHealth().catch(() => null),
        api.getRoute().catch(() => null),
        api.getPublicRoutes().catch(() => null),
        api.getUsProxy().catch(() => null),
      ]);

      if (health?.channels) setChannels(health.channels);
      if (route?.effective) setCurrent(route.effective);
      else if (route?.model) setCurrent(route.model);
      if (publicInfo?.apiHost) setApiHost(publicInfo.apiHost);
      if (proxy?.enabled !== undefined) setUsproxyOn(proxy.enabled);
    } catch {
      toast(t("route.loadFail"), true);
    }
    setLoading(false);
  }, [toast, t]);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  const handleSwitch = async (model: string) => {
    setSwitching(model);
    try {
      await api.setRoute(model);
      toast(t("route.switched"));
      await loadChannels();
    } catch {
      toast(t("route.fail"), true);
      await loadChannels();
    }
    setSwitching(null);
  };

  const handleClearRoute = async () => {
    try {
      await api.setRoute(null);
      toast(t("route.switched"));
      await loadChannels();
    } catch {
      toast(t("route.fail"), true);
    }
  };

  const handleToggleProxy = async () => {
    setUsproxyLoading(true);
    try {
      await api.setUsProxy(!usproxyOn);
      toast(t("usproxy.switched"));
      setUsproxyOn(!usproxyOn);
    } catch {
      toast(t("usproxy.fail"), true);
    }
    setUsproxyLoading(false);
  };

  // Client example
  const modelKeys = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ];
  const base = apiHost ? `https://${apiHost}` : "https://api.saisi.online";
  const token = user?.token || "<your gateway token>";
  const envConfig: Record<string, string> = { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: token };
  for (const k of modelKeys) envConfig[k] = "auto[1m]";
  const clientExample = JSON.stringify({ env: envConfig }, null, 2);

  if (loading) {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">{t("nav.routes")}</h1>
        </div>
        <div className="card">
          <div className="muted">{t("loading")}</div>
        </div>
      </div>
    );
  }

  // Group channels by prefix
  const grouped = channels.reduce((acc, ch) => {
    const prefix = ch.id;
    if (!acc[prefix]) acc[prefix] = [];
    acc[prefix].push(ch);
    return acc;
  }, {} as Record<string, HealthChannel[]>);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t("nav.routes")}</h1>
        <p className="page-description">{t("routes.lede")}</p>
      </div>

      {/* US Proxy toggle */}
      {user?.role === "admin" && (
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">{t("usproxy.title")}</div>
              <div className="card-description">{t("usproxy.desc")}</div>
            </div>
            <span className={`badge ${usproxyOn ? "badge-success" : "badge-warning"}`}>
              {usproxyOn ? t("usproxy.on") : t("usproxy.off")}
            </span>
          </div>
          <button
            className="btn btn-primary"
            disabled={usproxyLoading}
            onClick={handleToggleProxy}
          >
            {t("usproxy.toggle")}
          </button>
        </div>
      )}

      {/* Auto-discovered models */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">{t("route.title")}</div>
            <div className="card-description">{t("route.desc")}</div>
          </div>
          <button className="btn btn-secondary" onClick={handleClearRoute}>
            {t("route.auto")}
          </button>
        </div>

        {/* Channel groups */}
        {Object.entries(grouped).map(([prefix, models]) => (
          <div key={prefix} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--dsw-text-muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {prefix.toUpperCase()}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {models.map((ch) => {
                const isCurrent = current === ch.model;
                const laneClass = prefix.startsWith("og") ? "lane-og"
                  : prefix.startsWith("ds") ? "lane-ds"
                  : prefix.startsWith("or") ? "lane-or"
                  : prefix.startsWith("qw") ? "lane-qw"
                  : "lane-def";
                return (
                  <div className={`lane ${laneClass}`} key={ch.model}>
                    <div className="lane-port">{prefix}</div>
                    <div className="lane-body">
                      <div className="lane-backend">
                        {ch.model}
                        {isCurrent && <span className="badge badge-success" style={{ marginLeft: 8 }}>{t("route.current")}</span>}
                      </div>
                    </div>
                    {ch.ok ? (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={switching === ch.model}
                        onClick={() => handleSwitch(ch.model)}
                      >
                        {switching === ch.model ? "..." : t("route.use")}
                      </button>
                    ) : (
                      <span className="badge badge-error">{ch.reason || t("route.bad")}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Client example */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">{t("client.title")}</div>
        </div>
        <pre style={{ marginTop: 12, fontSize: 12 }}>
          <code>{clientExample}</code>
        </pre>
        <div
          className="muted"
          style={{ marginTop: 12 }}
          dangerouslySetInnerHTML={{ __html: t("client.note") }}
        />
      </div>
    </div>
  );
}
