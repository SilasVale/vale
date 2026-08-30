import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, ApiError, type Device, type DeviceStatus, type HealthChannel } from "../api/client.ts";
import { maskToken } from "../lib/format.ts";
import { Card, PageHeader, CopyButton } from "../components/ui.tsx";

const KEY_ORDER = [
  "DEEPSEEK_API_KEY",
  "OPENCODE_GO_API_KEY",
  "QWEN_API_KEY",
  "OPENROUTER_API_KEY",
  "NVAPI_KEY",
  "GMI_API_KEY",
  "CMD_API_KEY",
];

// "DEEPSEEK_API_KEY" → "DEEPSEEK"; NVAPI_KEY has no "_API_KEY" suffix to strip.
const keyLabel = (name: string) => (name === "NVAPI_KEY" ? "NV" : name.replace("_API_KEY", ""));

function rel(ts?: number): string {
  if (!ts) return "—";
  const sec = Math.max(0, (Date.now() - ts) / 1000);
  if (sec < 90) return "<2m";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/*
 * Overview v2 — the control deck. Asymmetric dashboard grid: a hero stat
 * band (four live numbers) + the gateway-token side card, the fleet strip,
 * then channel health beside the key matrix.
 *
 * Data semantics (user-reported bug fix): "online" here means the AGENT is
 * reachable (`agent_up`) — the same field the devices page counts. The old
 * overview read `online`, which is the browser-extension flag, so a healthy
 * device with no paired extension showed "offline".
 */
export default function Overview() {
  const { user, refreshUser } = useAuth();
  const { t } = useTranslation();
  const { toast } = useToast();
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [tokenNote, setTokenNote] = useState("");

  const [devices, setDevices] = useState<Device[]>([]);
  const [status, setStatus] = useState<Record<string, DeviceStatus>>({});
  const [channels, setChannels] = useState<HealthChannel[]>([]);
  const [users, setUsers] = useState<number | null>(null);

  const loadDashboard = useCallback(async () => {
    api.getDevices().then((d) => setDevices(d.devices || [])).catch(() => {});
    api.getHealth().then((h) => setChannels(h.channels || [])).catch(() => {});
    if (user?.role === "admin") {
      api.getUsers().then((u) => setUsers(u.users?.length ?? null)).catch(() => {});
    }
    try {
      const s = await api.getPluginStatus(true);
      setStatus(s.devices || {});
    } catch {
      /* probe is best-effort — tiles keep their last value */
    }
  }, [user?.role]);

  useEffect(() => {
    loadDashboard();
    // Same 60s cadence as the devices page — the two pages can never drift.
    const poll = setInterval(loadDashboard, 60000);
    return () => clearInterval(poll);
  }, [loadDashboard]);

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
      toast(err instanceof ApiError ? err.message : t("token.regenerateFail"), true);
    }
  };

  const tokenDisplay = tokenRevealed ? user?.token || "" : maskToken(user?.token);

  const keyEntries = KEY_ORDER.map((name) => ({ name, info: user?.keys?.[name] }));
  const configuredCount = keyEntries.filter((k) => k.info?.configured).length;

  const onlineCount = devices.filter((d) => status[d.name]?.agent_up).length;
  const channelsOk = channels.filter((c) => c.ok).length;

  const stats = [
    { label: t("stat.devices"), value: `${onlineCount}/${devices.length}`, tone: onlineCount > 0 ? "ok" : "off", to: "/devices" },
    { label: t("stat.channels"), value: channels.length ? `${channelsOk}/${channels.length}` : "—", tone: channels.length && channelsOk === channels.length ? "ok" : channels.length ? "warn" : "off", to: "/keys" },
    { label: t("stat.keys"), value: `${configuredCount}/${keyEntries.length}`, tone: configuredCount > 0 ? "ok" : "off", to: "/keys" },
    { label: t("stat.users"), value: users === null ? "—" : String(users), tone: "info", to: users === null ? "/" : "/users" },
  ];

  return (
    <div>
      <PageHeader
        title={t("overview.title")}
        description={t("overview.lede")}
        actions={
          <button className="btn btn-secondary btn-sm" onClick={loadDashboard}>
            {t("btn.refresh")}
          </button>
        }
      />

      {/* ── hero: stat band + token side card ── */}
      <div className="ov-hero">
        <div className="stat-band">
          {stats.map((s) => (
            <Link key={s.label} to={s.to} className={`stat-card stat-${s.tone}`}>
              <span className="stat-value">{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </Link>
          ))}
        </div>

        <Card
          className="ov-token"
          title={t("token.title")}
          description={<span dangerouslySetInnerHTML={{ __html: t("token.desc") }} />}
        >
          <div className="token-row">
            <code className="token">{tokenDisplay}</code>
            <CopyButton
              text={user?.token || ""}
              tone="primary"
              onCopied={() => toast(t("token.copied"))}
            />
            <button className="btn btn-ghost" onClick={() => setTokenRevealed(!tokenRevealed)}>
              {tokenRevealed ? t("btn.hide") : t("btn.show")}
            </button>
          </div>
          <div className="token-actions">
            <button className="btn btn-danger btn-sm" onClick={handleRegenerate}>
              {t("btn.regenerate")}
            </button>
          </div>
          {tokenNote && <p className="form-message form-message-success">{tokenNote}</p>}
          <div className="ov-keychips">
            {keyEntries.map(({ name, info }) => (
              <span key={name} className={`kchip${info?.configured ? " on" : ""}`} title={name}>
                <span className="kchip-dot" />
                {keyLabel(name)}
              </span>
            ))}
          </div>
        </Card>
      </div>

      {/* ── fleet strip ── */}
      <Card
        title={t("overview.devicesTitle")}
        headerExtra={<Link className="card-link" to="/devices">{t("overview.viewAll")} →</Link>}
      >
        {devices.length === 0 ? (
          <p className="muted">{t("overview.devicesEmpty")}</p>
        ) : (
          <div className="dev-strip">
            {devices.map((d) => {
              const st = status[d.name] || {};
              const up = !!st.agent_up;
              return (
                <Link key={d.name} to="/devices" className={`dev-mini${up ? " online" : ""}`}>
                  <span className={`dev-mini-led${up ? " on" : ""}`} />
                  <span className="dev-mini-name">{d.name}</span>
                  <span className="dev-mini-meta">
                    {up ? `v${st.version || d.lastVersion || "?"} · ${rel(st.checked_at)}` : t("overview.offline")}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </Card>

      {/* ── health + keys ── */}
      <div className="ov-cols">
        <Card title={t("overview.healthTitle")}>
          {channels.length === 0 ? (
            <p className="muted">—</p>
          ) : (
            <div className="health-list">
              {channels.map((c) => (
                <div key={c.id} className="health-row">
                  <span className={`dot ${c.ok ? "ok" : "err"}`} />
                  <span className="health-id">{c.id}</span>
                  <span className="health-model">{c.model}</span>
                  <span className={`health-state ${c.ok ? "ok" : "err"}`}>
                    {c.ok ? t("overview.healthOk") : c.reason || t("overview.healthDown")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title={t("keys.title")}
          description={t("overview.keysHint")}
          headerExtra={<Link className="card-link" to="/keys">{t("nav.keys")} →</Link>}
        >
          <div className="ov-keylist">
            {keyEntries.map(({ name, info }) => (
              <div key={name} className="ov-keyrow">
                <span className={`ov-keyled${info?.configured ? " on" : ""}`} />
                <span className="ov-keyname">{keyLabel(name)}</span>
                <span className="ov-keystate">
                  {info?.configured ? t("key.configured") : t("key.notConfigured")}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
