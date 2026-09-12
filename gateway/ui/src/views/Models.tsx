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
import { useAuth } from "../contexts/AuthContext.tsx";
import { api, ApiError, type RouteInfo, type HealthChannel } from "../api/client.ts";
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
  const { user } = useAuth();
  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  // The PREFIXED catalogue (== /v1/models). Chips are rendered from this, never
  // from `routes[].models`, which is bare and would set the wrong channel.
  const [allModels, setAllModels] = useState<string[]>([]);
  const [health, setHealth] = useState<HealthChannel[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  // Admin-only: which models this console owns vs which are built-in-but-off, and the
  // panel that adds one. Non-admins never call it — the routes are admin-gated too.
  const [custom, setCustom] = useState<string[]>([]);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    prefix: "",
    id: "",
    wire: "",
    usEgress: false,
    search: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [info, health, route] = await Promise.all([
        api.getPublicRoutes().catch(() => null),
        api.getHealth().catch(() => null),
        api.getRoute().catch(() => null),
      ]);
      // A catalogue that could not be read must SAY SO. An empty page here would
      // claim the gateway advertises nothing, which is a different fact. The
      // AUTHORITATIVE list is `info.models`; without it there is nothing safe to
      // render chips from, so this is a failure rather than a fallback to the bare
      // per-channel names.
      if (info?.models?.length) {
        setAllModels(info.models);
        setRoutes(info.routes || []);
      } else setFailed(true);
      // Best-effort: the page is fully usable read-only, so a 403 here simply means
      // "no admin controls" rather than an error worth showing.
      void api
        .getModelState()
        .then((st) => {
          setCustom(st.custom || []);
          setDisabled(st.disabled || []);
        })
        .catch(() => {});
      if (health?.channels) setHealth(health.channels);
      if (route?.effective) setCurrent(route.effective);
      else if (route?.model) setCurrent(route.model);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchTo = useCallback(
    async (model: string) => {
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
    },
    [t, toast],
  );

  const isAdmin = user?.role === "admin";

  /** Delete a model this console owns, or disable a built-in — the server decides
   *  which, from the id; the console only asks for the action the user chose. */
  const removeModel = useCallback(
    async (id: string) => {
      const builtIn = !custom.includes(id);
      if (
        !confirm(builtIn ? t("models.disableConfirm", { id }) : t("models.deleteConfirm", { id }))
      )
        return;
      setBusy(id);
      try {
        await api.deleteModel(id);
        toast(builtIn ? t("models.disabled") : t("models.deleted"));
        await load();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : t("route.fail"), true);
      } finally {
        setBusy(null);
      }
    },
    [custom, load, t, toast],
  );

  const enableModel = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await api.enableModel(id);
        toast(t("models.enabled"));
        await load();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : t("route.fail"), true);
      } finally {
        setBusy(null);
      }
    },
    [load, t, toast],
  );

  const submitModel = useCallback(async () => {
    // The prefix is a SELECT, so the id cannot name a channel that does not exist —
    // the server validates it too, because a UI is not a guarantee.
    const id = draft.prefix + draft.id.trim();
    if (!draft.id.trim()) return;
    setAdding(true);
    try {
      await api.addModel({
        id,
        ...(draft.wire.trim() ? { wire: draft.wire.trim() } : {}),
        ...(draft.usEgress ? { usEgress: true } : {}),
        ...(draft.search ? { search: true } : {}),
      });
      toast(t("models.added"));
      setDraft({ prefix: draft.prefix, id: "", wire: "", usEgress: false, search: false });
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("route.fail"), true);
    } finally {
      setAdding(false);
    }
  }, [draft, load, t, toast]);

  const total = allModels.length;
  /**
   * The models belonging to one channel card.
   *
   * THE DEFAULT CHANNEL CANNOT BE DERIVED FROM THE PREFIXED CATALOGUE. `"none"` is the
   * server's sentinel for "no prefix -> Command Code (GOAT), model name passed through
   * as-is", and every advertised id in that catalogue is PREFIXED — so filtering it for
   * "ids matching no known prefix" always yields NOTHING. The card rendered `0` and an
   * empty list while the server's own entry for it lists models and the header badge
   * said 21.
   *
   * For that card the server's `routes[].models` ARE the right source, and they are the
   * right FORM too: they are bare names, and a bare name is exactly what routes there.
   * (For every other card, `routes[].models` is the trap — bare where the catalogue is
   * prefixed, which is what set the wrong channel in round 58.)
   */
  const modelsFor = (prefix: string, fallback: string[]): string[] =>
    prefix && prefix !== "none" ? allModels.filter((m) => m.startsWith(prefix)) : fallback;
  // Health is reported per channel PREFIX; the catalogue is the authority on which
  // channels exist, so an id with no health entry is "not checked", not "down".
  const healthFor = (prefix: string) =>
    health.find((h) => h.id === prefix || h.id === prefix.replace(/\/$/, ""));

  return (
    <>
      <PageHeader
        title={t("nav.models")}
        description={t("models.lede")}
        actions={
          <Badge tone="muted">{loading ? t("loading") : `${total} ${t("models.count")}`}</Badge>
        }
      />

      {failed && (
        <Card>
          <p className="models-failed">{t("models.unavailable")}</p>
        </Card>
      )}

      {/* ADD — the whole point of the catalogue being data. The CHANNEL is a select,
          so a new model cannot name a prefix that does not route, and the optional
          facets default to the conservative value. */}
      {isAdmin && !loading && !failed && (
        <Card title={t("models.addTitle")} description={t("models.addDesc")}>
          <div className="model-add">
            <select
              className="form-input model-add-prefix"
              value={draft.prefix}
              onChange={(e) => setDraft({ ...draft, prefix: e.target.value })}
            >
              <option value="">{t("models.pickChannel")}</option>
              {routes
                .filter((r) => r.prefix && r.prefix !== "none")
                .map((r) => (
                  <option key={r.prefix} value={r.prefix}>
                    {r.prefix} — {r.backend}
                  </option>
                ))}
            </select>
            <input
              className="form-input"
              placeholder={t("models.namePh")}
              value={draft.id}
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            />
            <input
              className="form-input"
              placeholder={t("models.wirePh")}
              value={draft.wire}
              onChange={(e) => setDraft({ ...draft, wire: e.target.value })}
            />
            <label className="model-add-check">
              <input
                type="checkbox"
                checked={draft.usEgress}
                onChange={(e) => setDraft({ ...draft, usEgress: e.target.checked })}
              />
              {t("models.usEgress")}
            </label>
            <label className="model-add-check">
              <input
                type="checkbox"
                checked={draft.search}
                onChange={(e) => setDraft({ ...draft, search: e.target.checked })}
              />
              {t("models.search")}
            </label>
            <button
              className="btn btn-primary btn-sm"
              disabled={adding || !draft.prefix || !draft.id.trim()}
              onClick={() => void submitModel()}
            >
              {adding ? t("models.adding") : t("models.add")}
            </button>
          </div>
          <p className="models-hint">{t("models.addHint")}</p>
        </Card>
      )}

      {!loading &&
        !failed &&
        routes.map((r) => {
          const h = healthFor(r.prefix);
          const models = modelsFor(r.prefix, r.models || []);
          return (
            <Card key={r.prefix} className="models-card">
              <div className="models-head">
                <span className={`models-prefix ${laneClass(r.prefix)}`}>
                  {r.prefix && r.prefix !== "none" ? r.prefix : t("models.noPrefix")}
                </span>
                <span className="models-backend">{r.backend}</span>
                {h ? (
                  <span
                    className={`models-health ${h.ok ? "ok" : "bad"}`}
                    title={h.reason || h.model}
                  >
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
                  <span key={id} className="model-chip-wrap">
                    <button
                      type="button"
                      className={`model-chip${current === id ? " current" : ""}`}
                      disabled={switching !== null}
                      title={current === id ? t("models.isCurrent") : t("models.setCurrent")}
                      onClick={() => void switchTo(id)}
                    >
                      {id}
                    </button>
                    {isAdmin && (
                      <button
                        type="button"
                        className="model-chip-x"
                        disabled={busy !== null}
                        title={custom.includes(id) ? t("models.delete") : t("models.disable")}
                        aria-label={`${custom.includes(id) ? t("models.delete") : t("models.disable")} ${id}`}
                        onClick={() => void removeModel(id)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </Card>
          );
        })}
      {isAdmin && disabled.length > 0 && (
        <Card title={t("models.disabledTitle")} description={t("models.disabledDesc")}>
          <div className="models-list">
            {disabled.map((id) => (
              <span key={id} className="model-chip-wrap">
                <span className="model-chip off">{id}</span>
                <button
                  className="btn btn-ghost btn-mini"
                  disabled={busy !== null}
                  onClick={() => void enableModel(id)}
                >
                  {t("models.enable")}
                </button>
              </span>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

export { channelOf };
