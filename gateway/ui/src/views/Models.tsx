// Models — the catalogue this gateway ADVERTISES, which until now the console
// fetched and threw away.
//
// WHY THIS PAGE EXISTS. `/api/admin/public` returns `ROUTE_INFO`: every channel
// with its `prefix`, `backend`, `desc` and a `models` list DERIVED from
// `MODEL_REGISTRY` (so it cannot drift from what `/v1/models` serves). The Routes
// page has always requested it — and used exactly one field, `apiHost`. So the
// console showed a route SWITCHER and never the catalogue itself: you could pick
// a model if you already knew its name, and you could not see the 22 advertised
// ids, which channel each belongs to, or whether that channel is up.
//
// THE DATA IS THEREFORE ALREADY ON THE WIRE; this only renders it. Model ids come
// from the server, never from a list typed here — a hand-maintained second copy is
// what `channels.ts` records as the FIFTH drifted copy of the catalogue.
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, type RouteInfo, type HealthChannel } from "../api/client.ts";
import { Card, PageHeader, Badge } from "../components/ui.tsx";

/** The lane colour for a channel prefix — the same mapping the Routes page uses,
 *  so a channel looks the same wherever it appears. */
function laneClass(prefix: string): string {
  const p = prefix.replace(/\/$/, "");
  if (p === "og") return "lane-og";
  if (p === "ds") return "lane-ds";
  if (p === "or") return "lane-or";
  if (p === "qw") return "lane-qw";
  if (p === "nv") return "lane-nv";
  if (p === "gmi") return "lane-gmi";
  if (p === "cm") return "lane-cm";
  if (p === "amd") return "lane-amd";
  return "lane-def";
}

/** The channel part of an advertised id: everything before the first `/`.
 *  The no-prefix default channel has no slash at all and reports as "none". */
function channelOf(id: string): string {
  const i = id.indexOf("/");
  return i < 0 ? "none" : id.slice(0, i);
}

export default function ModelsView() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [health, setHealth] = useState<HealthChannel[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [info, health, route] = await Promise.all([
        api.getPublicRoutes().catch(() => null),
        api.getHealth().catch(() => null),
        api.getRoute().catch(() => null),
      ]);
      if (info?.routes) setRoutes(info.routes);
      // A catalogue that could not be read must SAY SO. An empty page here would
      // claim the gateway advertises nothing, which is a different fact.
      else setFailed(true);
      if (health?.channels) setHealth(health.channels);
      if (route?.effective) setCurrent(route.effective);
      else if (route?.model) setCurrent(route.model);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const switchTo = useCallback(async (model: string) => {
    setSwitching(model);
    try {
      await api.setRoute(model);
      setCurrent(model);
      toast(t("models.switched"));
    } catch {
      toast(t("route.fail"));
    } finally {
      setSwitching(null);
    }
  }, [t, toast]);

  const total = routes.reduce((n, r) => n + (r.models?.length || 0), 0);
  // Health is reported per channel PREFIX; the catalogue is the authority on which
  // channels exist, so an id with no health entry is "not checked", not "down".
  const healthFor = (prefix: string) =>
    health.find((h) => h.id === prefix || h.id === prefix.replace(/\/$/, ""));

  return (
    <>
      <PageHeader
        title={t("nav.models")}
        description={t("models.lede")}
        actions={<Badge tone="muted">{loading ? t("loading") : `${total} ${t("models.count")}`}</Badge>}
      />

      {failed && <Card><p className="models-failed">{t("models.unavailable")}</p></Card>}

      {!loading && !failed && routes.map((r) => {
        const h = healthFor(r.prefix);
        const models = r.models || [];
        return (
          <Card key={r.prefix} className="models-card">
            <div className="models-head">
              <span className={`models-prefix ${laneClass(r.prefix)}`}>{r.prefix}</span>
              <span className="models-backend">{r.backend}</span>
              {h ? (
                <span className={`models-health ${h.ok ? "ok" : "bad"}`} title={h.reason || h.model}>
                  {h.ok ? t("models.up") : t("models.down")}
                </span>
              ) : (
                <span className="models-health unknown">{t("models.notChecked")}</span>
              )}
              <span className="models-n">{models.length}</span>
            </div>
            <p className="models-desc">{r.desc}</p>
            <div className="models-list">
              {models.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`model-chip${current === id ? " current" : ""}`}
                  disabled={switching !== null}
                  title={current === id ? t("models.isCurrent") : t("models.setCurrent")}
                  onClick={() => void switchTo(id)}
                >
                  {id}
                </button>
              ))}
            </div>
          </Card>
        );
      })}
    </>
  );
}

export { channelOf };
