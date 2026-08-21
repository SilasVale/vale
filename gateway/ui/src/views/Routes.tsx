import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, type HealthChannel } from "../api/client.ts";
import { Card, PageHeader, Badge, CopyButton } from "../components/ui.tsx";

function laneClass(prefix: string): string {
  if (prefix.startsWith("og")) return "lane-og";
  if (prefix.startsWith("ds")) return "lane-ds";
  if (prefix.startsWith("or")) return "lane-or";
  if (prefix.startsWith("qw")) return "lane-qw";
  return "lane-def";
}

export default function RoutesView() {
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
        <PageHeader title={t("nav.routes")} />
        <Card>
          <p className="muted">{t("loading")}</p>
        </Card>
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
      <PageHeader title={t("nav.routes")} description={<span dangerouslySetInnerHTML={{ __html: t("routes.lede") }} />} />

      {/* US Proxy toggle */}
      {user?.role === "admin" && (
        <Card
          title={t("usproxy.title")}
          description={t("usproxy.desc")}
          headerExtra={
            <Badge tone={usproxyOn ? "success" : "warning"}>
              {usproxyOn ? t("usproxy.on") : t("usproxy.off")}
            </Badge>
          }
        >
          <button className="btn btn-secondary btn-sm" disabled={usproxyLoading} onClick={handleToggleProxy}>
            {t("usproxy.toggle")}
          </button>
        </Card>
      )}

      {/* Channel switch */}
      <Card
        title={t("route.title")}
        description={<span dangerouslySetInnerHTML={{ __html: t("route.desc") }} />}
        headerExtra={
          <button className="btn btn-ghost btn-sm" onClick={handleClearRoute}>
            {t("route.auto")}
          </button>
        }
      >
        {Object.entries(grouped).map(([prefix, models]) => (
          <div className="channel-group" key={prefix}>
            <div className="channel-label">{prefix}</div>
            <div className="switchboard">
              {models.map((ch) => {
                const isCurrent = current === ch.model;
                return (
                  <div className={`lane ${laneClass(prefix)}${isCurrent ? " current" : ""}`} key={ch.model}>
                    <div className="lane-port">{prefix.replace("/", "")}</div>
                    <div className="lane-body">
                      <div className="lane-backend">{ch.model}</div>
                    </div>
                    {isCurrent && <Badge tone="success">{t("route.current")}</Badge>}
                    {ch.ok ? (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={switching === ch.model}
                        onClick={() => handleSwitch(ch.model)}
                      >
                        {switching === ch.model ? t("route.switching") : t("route.use")}
                      </button>
                    ) : (
                      <Badge tone="error">{ch.reason || t("route.bad")}</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </Card>

      {/* Client example */}
      <Card title={t("client.title")}>
        <pre style={{ marginTop: 12 }}>
          <code>{clientExample}</code>
        </pre>
        <div className="row mt-12">
          <CopyButton text={clientExample} small onCopied={() => toast(t("token.copied"))} />
        </div>
        <p className="muted mt-12" dangerouslySetInnerHTML={{ __html: t("client.note") }} />
      </Card>
    </div>
  );
}
