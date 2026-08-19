import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, ApiError, type RouteInfo } from "../api/client.ts";

function maskToken(tok: string) {
  if (!tok) return "";
  if (tok.length <= 8) return tok[0] + "…" + tok.slice(-3);
  return tok.slice(0, 6) + "…" + tok.slice(-4);
}

export default function Overview() {
  const { user, refreshUser } = useAuth();
  const { t } = useTranslation();
  const { toast } = useToast();
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [tokenNote, setTokenNote] = useState("");
  const [routes, setRoutes] = useState<RouteInfo[]>([]);

  const loadRoutes = useCallback(async () => {
    try {
      const data = await api.getPublicRoutes();
      setRoutes(data.routes || []);
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    loadRoutes();
  }, [loadRoutes]);

  const handleCopy = async () => {
    if (!user?.token) return;
    try {
      await navigator.clipboard.writeText(user.token);
      toast(t("token.copied"));
    } catch {
      toast(t("token.copyFail"), true);
    }
  };

  const handleRegenerate = async () => {
    const warn =
      user?.role === "admin"
        ? t("token.regenerateConfirm")
        : t("token.regenerateConfirm").split("\n")[0];
    if (!confirm(warn)) return;
    try {
      const data = await api.regenerateToken();
      if (data.token) {
        await refreshUser();
        setTokenRevealed(true);
        setTokenNote(t("token.regenerated"));
        toast(t("btn.regenerate"));
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : t("token.regenerateFail");
      toast(msg, true);
    }
  };

  const tokenDisplay = tokenRevealed ? user?.token || "" : maskToken(user?.token || "");

  // Switchboard rendering
  const ROUTE_KEY: Record<string, string> = {
    "og/": "og",
    "ds/": "ds",
    "qw/": "qw",
    "or/": "or",
    none: "none",
  };

  return (
    <div>
      <h1>{t("overview.title")}</h1>
      <p className="lede">{t("overview.lede")}</p>

      <div className="card">
        <div className="card-head">
          <h2>{t("token.title")}</h2>
          <span className={`badge ${user?.role === "admin" ? "admin" : "user"}`}>
            {t(user?.role === "admin" ? "role.admin" : "role.user")}
          </span>
        </div>
        <p className="muted" dangerouslySetInnerHTML={{ __html: t("token.desc") }} />
        <div className="token-row">
          <code className="token mono">{tokenDisplay}</code>
          <button className="btn-primary" onClick={handleCopy}>
            {t("btn.copy")}
          </button>
          <button className="btn-ghost" onClick={() => setTokenRevealed(!tokenRevealed)}>
            {tokenRevealed ? t("btn.hide") : t("btn.show")}
          </button>
        </div>
        <div className="token-actions">
          <button className="btn-ghost danger-text" onClick={handleRegenerate}>
            {t("btn.regenerate")}
          </button>
        </div>
        {tokenNote && <p className="note">{tokenNote}</p>}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t("routes.title")}</h2>
        </div>
        <div className="switchboard">
          {routes.map((r) => {
            const key = ROUTE_KEY[r.prefix] || "none";
            const laneClass = { og: "og", ds: "ds", or: "or" }[key] || "def";
            const portLabel = key === "none" ? t("route.none.label" as any) : r.prefix.replace("/", "");
            const backend = t(`route.${key}.backend` as any) || r.backend;
            const desc = t(`route.${key}.desc` as any) || r.desc;
            return (
              <div className={`lane lane-${laneClass}`} key={r.prefix}>
                <div className="lane-port">{portLabel}</div>
                <div className="lane-arrow">▸</div>
                <div className="lane-body">
                  <div className="backend">{backend}</div>
                  <div className="desc">{desc}</div>
                </div>
                <div className="lane-models">
                  {(r.models || []).map((m) => (
                    <span className="model-tag" key={m}>{m}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
