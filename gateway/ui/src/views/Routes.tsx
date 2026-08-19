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
        <h1>{t("nav.routes")}</h1>
        <p className="muted">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div>
      <h1>{t("nav.routes")}</h1>
      <p className="lede" dangerouslySetInnerHTML={{ __html: t("routes.lede") }} />

      <div className="card">
        <div className="card-head">
          <h2>{t("route.title")}</h2>
        </div>
        <div className="card-body">
          <p className="muted" dangerouslySetInnerHTML={{ __html: t("route.desc") }} />

          {/* US Proxy toggle (admin only) */}
          {user?.role === "admin" && (
            <div className="key-card" style={{ marginBottom: 16 }}>
              <div className="top">
                <div>
                  <div className="key-name">{t("usproxy.title")}</div>
                  <div className="key-desc">{t("usproxy.desc")}</div>
                </div>
                <span className={`badge ${usproxyOn ? "ok" : "off"}`}>
                  {usproxyOn ? t("usproxy.on") : t("usproxy.off")}
                </span>
              </div>
              <div className="key-actions">
                <button
                  className="btn-primary btn-mini"
                  disabled={usproxyLoading}
                  onClick={handleToggleProxy}
                >
                  {t("usproxy.toggle")}
                </button>
              </div>
            </div>
          )}

          {/* Channel cards */}
          <div className="cards">
            {channels.map((ch) => {
              const isCurrent = current === ch.model;
              return (
                <div className="key-card" key={ch.model} style={{ margin: 0 }}>
                  <div className="top">
                    <div>
                      <div className="key-name">
                        {ch.id + "/"}
                        {isCurrent && <span className="badge ok"> {t("route.current")}</span>}
                      </div>
                      <div className="key-desc">{ch.model}</div>
                    </div>
                    {ch.ok ? (
                      <span className="badge ok">{t("route.use")}</span>
                    ) : (
                      <span className="badge off">{esc(ch.reason || t("route.bad"))}</span>
                    )}
                  </div>
                  <div className="key-actions">
                    <button
                      className="btn-primary btn-mini"
                      disabled={!ch.ok || switching === ch.model}
                      onClick={() => handleSwitch(ch.model)}
                    >
                      {switching === ch.model ? t("route.switching") : t("route.use")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <button className="btn-ghost" style={{ marginTop: 12 }} onClick={handleClearRoute}>
            {t("route.auto")}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t("client.title")}</h2>
        </div>
        <pre>
          <code>{clientExample}</code>
        </pre>
        <div
          className="note"
          dangerouslySetInnerHTML={{ __html: t("client.note") }}
        />
      </div>
    </div>
  );
}
