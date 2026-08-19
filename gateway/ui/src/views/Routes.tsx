import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation, esc } from "../i18n.ts";
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
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: token };
  for (const k of modelKeys) env[k] = "auto[1m]";
  const clientExample = JSON.stringify({ env }, null, 2);

  if (loading) {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">{t("nav.routes")}</h1>
        </div>
        <p className="muted">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t("nav.routes")}</h1>
        <p className="page-description" dangerouslySetInnerHTML={{ __html: t("routes.lede") }} />
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">{t("route.title")}</div>
        </div>
        <p className="muted" dangerouslySetInnerHTML={{ __html: t("route.desc") }} />

        {/* US Proxy toggle (admin only) */}
        {user?.role === "admin" && (
          <div className="lane" style={{ marginTop: 16, marginBottom: 16 }}>
            <div className="lane-port" style={{ background: "var(--dsw-info)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
            </div>
            <div className="lane-body">
              <div className="lane-backend">{t("usproxy.title")}</div>
              <div className="lane-desc">{t("usproxy.desc")}</div>
            </div>
            <span className={`badge ${usproxyOn ? "badge-success" : "badge-warning"}`}>
              {usproxyOn ? t("usproxy.on") : t("usproxy.off")}
            </span>
            <button
              className="btn btn-primary btn-sm"
              disabled={usproxyLoading}
              onClick={handleToggleProxy}
            >
              {t("usproxy.toggle")}
            </button>
          </div>
        )}

        {/* Channel list */}
        <div style={{ marginTop: 16 }}>
          {channels.map((ch) => {
            const isCurrent = current === ch.model;
            const laneClass = ch.id.startsWith("og") ? "lane-og"
              : ch.id.startsWith("ds") ? "lane-ds"
              : ch.id.startsWith("or") ? "lane-or"
              : ch.id.startsWith("qw") ? "lane-qw"
              : "lane-def";
            return (
              <div className={`lane ${laneClass}`} key={ch.model} style={{ marginBottom: 8 }}>
                <div className="lane-port">{ch.id.replace("/", "")}</div>
                <div className="lane-arrow">→</div>
                <div className="lane-body">
                  <div className="lane-backend">
                    {ch.model}
                    {isCurrent && <span className="badge badge-success" style={{ marginLeft: 8 }}>{t("route.current")}</span>}
                  </div>
                  <div className="lane-desc">{ch.id}</div>
                </div>
                {ch.ok ? (
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={switching === ch.model}
                    onClick={() => handleSwitch(ch.model)}
                  >
                    {switching === ch.model ? t("route.switching") : t("route.use")}
                  </button>
                ) : (
                  <span className="badge badge-error">{esc(ch.reason || t("route.bad"))}</span>
                )}
              </div>
            );
          })}
        </div>

        <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={handleClearRoute}>
          {t("route.auto")}
        </button>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">{t("client.title")}</div>
        </div>
        <pre style={{ marginTop: 12 }}>
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
