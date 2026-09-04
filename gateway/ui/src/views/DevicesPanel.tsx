import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation, type TranslationKey } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import {
  api,
  ApiError,
  type Device,
  type DeviceStatus,
  type RegKeyInfo,
} from "../api/client.ts";
import { maskToken } from "../lib/format.ts";
import {
  Card,
  PageHeader,
  Badge,
  CopyButton,
  Empty,
  Modal,
} from "../components/ui.tsx";

// Fallback npm install URL when /api/devices/install-cmd cannot reach the
// download host. The agent version used for the "update available" badge is
// NOT fallback — it is only compared against live data from /api/version
// (agent/Cargo scheme, same as the device's /api/status version). Keep the
// URL in sync with /api/version in index/src/index.js.
const FALLBACK_DOWNLOAD = `https://agent.saisi.online/vale-agent/vale-agent-1.2.113.tgz`;

type ModalState =
  | null
  | { kind: "form"; device: Device | null }
  | { kind: "delete"; device: string }
  | { kind: "tunnelDown"; device: string };

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour12: false });
const fmtDateTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { hour12: false });
// Relative time for card metadata ("2 分钟前") — buckets: now/min/hours/days.
const fmtRel = (ts: number | undefined, t: (k: TranslationKey, v?: Record<string, string>) => string): string => {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return t("devices.relNow");
  const m = Math.floor(s / 60);
  if (m < 60) return t("devices.relMinutes", { n: String(m) });
  const h = Math.floor(m / 60);
  if (h < 24) return t("devices.relHours", { n: String(h) });
  return t("devices.relDays", { n: String(Math.floor(h / 24)) });
};

export default function DevicesPanel() {
  const { user, refreshUser } = useAuth();
  const { t } = useTranslation();
  const { toast } = useToast();

  const [devices, setDevices] = useState<Device[] | null>(null); // null = initial load
  const [loadError, setLoadError] = useState("");
  const [deviceStatuses, setDeviceStatuses] = useState<Record<string, DeviceStatus>>({});
  const [statusAt, setStatusAt] = useState<number | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [regKey, setRegKey] = useState("");
  const [regKeys, setRegKeys] = useState<RegKeyInfo[] | null>(null);
  const [install, setInstall] = useState<{
    version: string | null;
    download: string | null;
  } | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const loadDevices = useCallback(async () => {
    try {
      const data = await api.getDevices();
      setDevices(data.devices || []);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t("devices.loadFail"));
    }
    await refreshUser().catch(() => {});
  }, [refreshUser, t]);

  const loadStatus = useCallback(async (fresh = false) => {
    setStatusBusy(true);
    try {
      const data = await api.getPluginStatus(fresh);
      if (data.devices) setDeviceStatuses(data.devices);
      setStatusAt(Date.now());
    } catch {
      /* status poll is best-effort — the row keeps its last known chips */
    }
    setStatusBusy(false);
  }, []);

  const loadInstallCmd = useCallback(async () => {
    try {
      const data = await api.getInstallCmd();
      setInstall({ version: data.version, download: data.download });
    } catch {
      /* endpoint or upstream unreachable — the UI falls back below */
    }
  }, []);

  const loadRegKeys = useCallback(async () => {
    try {
      const data = await api.listRegKeys();
      setRegKeys(data.keys || []);
    } catch {
      /* admin-only listing — non-fatal for the page */
    }
  }, []);

  useEffect(() => {
    loadDevices();
    loadInstallCmd();
    loadRegKeys();
  }, [loadDevices, loadInstallCmd, loadRegKeys]);

  // Poll device status every 60s (KV-budget friendly; manual refresh anytime)
  useEffect(() => {
    loadStatus();
    const poll = setInterval(() => loadStatus(), 60000);
    return () => clearInterval(poll);
  }, [loadStatus]);

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

  // Full, copy-ready install commands (dynamic version, no placeholders).
  const downloadUrl = install?.download || FALLBACK_DOWNLOAD;
  const npmCmd = `npm i -g ${downloadUrl}`;

  const handleRefresh = async () => {
    await Promise.all([loadDevices(), loadStatus(false)]);
  };

  const handleDeleteDevice = async (name: string) => {
    try {
      await api.deleteDevice(name);
      toast(`${t("devices.deleted")} ${name}`);
      setModal(null);
      await Promise.all([loadDevices(), loadStatus(true), loadRegKeys()]);
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

  // Generate a one-time registration key (1h TTL) — fills the setup command
  // so the user copies a COMPLETE, runnable command (no placeholders).
  const handleGenRegKey = async () => {
    try {
      const data = await api.generateRegKey();
      if (data.key) {
        setRegKey(data.key);
        toast(t("devices.keyGenerated", { code: data.key }));
        await loadRegKeys();
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("devices.genKeyFail"), true);
    }
  };

  const handleRevokeAll = async () => {
    if (!regKeys || regKeys.length === 0) return;
    try {
      await Promise.all(regKeys.map((k) => api.revokeRegKey(k.code)));
      toast(t("devices.regKeysEmpty"));
      await loadRegKeys();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("devices.saveFail"), true);
    }
  };

  const handleRevokeRegKey = async (code: string) => {
    try {
      await api.revokeRegKey(code);
      toast(t("devices.revoked"));
      await loadRegKeys();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("devices.revokeFail"), true);
    }
  };

  // Open the device's panel at the device origin. The gateway 302s the
  // ?token= into a scoped cookie (round-124), so the token never lingers in
  // the omnibox. Blocked up-front when the tunnel is known to be down —
  // a pure-local device would otherwise open a dead hostname.
  const openPanel = async (name: string) => {
    const st = deviceStatuses[name];
    if (st && st.tunnel_up === false) {
      setModal({ kind: "tunnelDown", device: name });
      return;
    }
    try {
      const data = await api.getDeviceMcp(name);
      const cfg = JSON.parse(data.mcp.json);
      const auth = cfg.mcpServers["vale-agent"].headers.Authorization; // "Bearer <device_token>"
      const tok = auth.replace("Bearer ", "");
      const host = new URL(cfg.mcpServers["vale-agent"].url).hostname;
      window.open(`https://${host}/panel/?token=${tok}`, "_blank");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("devices.saveFail"), true);
    }
  };

  const handleFormSave = async (
    original: Device | null,
    name: string,
    hostname: string,
    token: string,
  ) => {
    try {
      if (original && !token.trim()) {
        // Edit without a token → rename / re-host only, credential preserved.
        await api.renameDevice(original.name, name.trim(), hostname.trim() || undefined);
        toast(t("devices.renamed"));
      } else {
        await api.saveDevice(name.trim(), hostname.trim(), token.trim());
        toast(t("devices.saved"));
      }
      setModal(null);
      await Promise.all([loadDevices(), loadStatus(true)]);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.status === 409
            ? t("devices.nameTaken")
            : err.message
          : t("devices.saveFail");
      toast(msg, true);
    }
  };

  return (
    <div>
      <PageHeader
        title={t("nav.devices")}
        description={t("devices.lede")}
        actions={
          <>
            <button className="btn btn-ghost" onClick={handleRefresh} disabled={statusBusy}>
              {statusBusy ? t("devices.checking") : t("devices.refresh")}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => setModal({ kind: "form", device: null })}
            >
              {t("devices.add")}
            </button>
          </>
        }
      />

      {loadError && (
        <div className="banner-error">
          <span>{t("devices.loadFail")} — {loadError}</span>
          <button className="btn btn-ghost btn-mini" onClick={loadDevices}>
            {t("devices.retry")}
          </button>
        </div>
      )}

      {/* Fleet stats strip — the at-a-glance summary above the cards */}
      {devices !== null && devices.length > 0 && (
        <div className="dev-stats">
          <span className="dev-stat"><b>{devices.length}</b>{t("devices.statTotal")}</span>
          <span className="dev-stat"><b>{devices.filter((d) => deviceStatuses[d.name]?.agent_up).length}</b>{t("devices.statOnline")}</span>
          <span className="dev-stat"><b>{devices.filter((d) => deviceStatuses[d.name]?.tunnel_up).length}</b>{t("devices.statTunnels")}</span>
          {regKeys && regKeys.length > 0 && (
            <span className="dev-stat"><b>{regKeys.length}</b>{t("devices.statKeys")}</span>
          )}
        </div>
      )}

      {/* Device cards — the page's primary block */}
      <Card
        title={t("devices.listTitle")}
        headerExtra={
          <>
            {statusAt && (
              <span className="muted-small">
                {t("devices.lastCheck", { time: fmtTime(statusAt) })}
              </span>
            )}
            <button
              className="btn btn-ghost btn-mini"
              onClick={() => loadStatus(true)}
              disabled={statusBusy}
            >
              {statusBusy ? t("devices.checking") : t("devices.checkNow")}
            </button>
          </>
        }
      >
        {devices === null ? (
          <div className="dev-grid">
            <div className="skeleton-card" />
            <div className="skeleton-card" />
          </div>
        ) : devices.length === 0 ? (
          <Empty>{t("devices.empty")}</Empty>
        ) : (
          <div className="dev-grid">
            {devices.map((d) => {
              const st = deviceStatuses[d.name];
              const agentUp = !!st?.agent_up;
              const tunnelUp = !!st?.tunnel_up;
              const outdated = !!d.lastVersion && !!install?.version && d.lastVersion !== install.version;
              const signals = [
                { label: t("devices.statusAgent"), ok: agentUp, err: !agentUp, state: agentUp ? t("devices.online") : t("devices.offline") },
                { label: t("devices.statusTunnel"), ok: tunnelUp, err: !tunnelUp, state: tunnelUp ? t("devices.tunnelUp") : t("devices.tunnelDown") },
              ];

              return (
                <div className="dev-card" key={d.name}>
                  <div className="dev-card-head">
                    <span className={`dev-led ${agentUp ? "on" : "off"}`} />
                    <span className="dev-name">{d.name}</span>
                    {outdated ? (
                      <Badge tone="warning">{t("devices.versionOutdated", { ver: install!.version! })}</Badge>
                    ) : (
                      <span className="dev-card-ver">
                        {d.lastVersion ? `v${d.lastVersion}` : t("devices.versionUnknown")}
                      </span>
                    )}
                  </div>
                  <div className="dev-signals">
                    {signals.map((s) => (
                      <div className="dev-sig" key={s.label}>
                        <span className={`sig-dot ${s.ok ? "ok" : s.err ? "err" : "off"}`} />
                        <span className="dev-sig-label">{s.label}</span>
                        <span className={`dev-sig-state ${s.ok ? "ok" : s.err ? "err" : "off"}`}>{s.state}</span>
                      </div>
                    ))}
                  </div>
                  <div className="dev-host">
                    <span className="dev-host-name">{d.hostname}</span>
                    {/* ShellHub-style dual path: the console cannot SSH, but the
                        LAN/direct command is one copy away. */}
                    <CopyButton text={`ssh ${d.hostname}`} small label="ssh" onCopied={() => toast(t("devices.copySsh"))} />
                  </div>
                  <div className="dev-meta">
                    {d.lastSeenAt ? t("devices.lastSeen", { date: fmtRel(d.lastSeenAt, t) }) : ""}
                    {d.registeredAt ? ` · ${t("devices.registeredAt", { date: fmtDateTime(d.registeredAt) })}` : ""}
                    {" · "}{maskToken(d.token)}
                  </div>
                  <div className="dev-actions">
                    <button className="btn btn-ghost btn-mini" onClick={() => openPanel(d.name)}>
                      {t("devices.open")}
                    </button>
                    <button className="btn btn-ghost btn-mini" onClick={() => handleCopyMcp(d.name)}>
                      {t("devices.copyMcp")}
                    </button>
                    <button
                      className="btn btn-ghost btn-mini"
                      onClick={() => setModal({ kind: "form", device: d })}
                    >
                      {t("devices.edit")}
                    </button>
                    <button
                      className="btn btn-danger btn-mini"
                      onClick={() => setModal({ kind: "delete", device: d.name })}
                    >
                      {t("devices.delete")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Install new device — pure local first, gateway optional */}
      <Card title={t("devices.installTitle")} description={t("devices.installDesc")}>
        <p className="muted mt-12">{t("devices.installStep1")}</p>
        <pre className="mt-8"><code>{npmCmd}</code></pre>
        <div className="row mt-8">
          <CopyButton text={npmCmd} small onCopied={() => toast(t("devices.mcpCopied"))} />
        </div>

        <p className="muted mt-12">{t("devices.installStep2")}</p>
        <pre className="mt-8"><code>{regKey ? `vale setup --reg-key ${regKey}` : `vale setup`}</code></pre>
        <div className="row mt-8">
          <button className="btn btn-ghost btn-mini" onClick={handleGenRegKey}>
            {t("devices.genKey")}
          </button>
          {regKey && (
            <>
              <CopyButton
                text={`vale setup --reg-key ${regKey}`}
                small
                onCopied={() => toast(t("devices.mcpCopied"))}
              />
              <CopyButton text={regKey} small onCopied={() => toast(t("devices.keyCopied"))} />
            </>
          )}
        </div>

        <p className="muted mt-12">{t("devices.installNote")}</p>

        {/* Outstanding registration keys — filtered server-side to live
            (unexpired) ones; each shows its remaining minutes. */}
        <div className="regkeys mt-16">
          <div className="regkeys-head">
            <span className="regkeys-title">{t("devices.regKeysTitle")}</span>
            <span className="muted-small">{t("devices.regkeyHint")}</span>
            {regKeys && regKeys.length > 0 && (
              <button
                className="btn btn-ghost btn-mini regkeys-clear"
                onClick={handleRevokeAll}
              >
                {t("devices.revokeAll")}
              </button>
            )}
          </div>
          {regKeys === null || regKeys.length === 0 ? (
            <p className="muted-small">
              {t("devices.regKeysEmpty")}
            </p>
          ) : (
            <div className="list">
              {regKeys.map((k) => (
                <div className="list-row" key={k.code}>
                  <div className="list-main">
                    <div className="list-line">
                      <span className="mono">{k.code}</span>
                    </div>
                    <div className="list-sub">
                      {t("devices.expiresIn", { min: String(Math.max(1, Math.ceil((k.expiresAt - Date.now()) / 60000))) })}
                    </div>
                  </div>
                  <div className="list-actions">
                    <button
                      className="btn btn-ghost btn-mini"
                      onClick={() => handleRevokeRegKey(k.code)}
                    >
                      {t("devices.revoke")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Account-level gateway MCP config — demoted to a collapsed advanced block */}
      <details className="adv-block mt-16">
        <summary>{t("devices.advSummary")}</summary>
        <div className="adv-body">
          <pre>
            <code>{JSON.stringify(gwMcpJson, null, 2)}</code>
          </pre>
          <div className="row mt-8">
            <CopyButton
              text={JSON.stringify(gwMcpJson, null, 2)}
              label={t("gwMcp.copy")}
              tone="primary"
              small
              onCopied={() => toast(t("devices.mcpCopied"))}
            />
          </div>
        </div>
      </details>

      {/* Add / edit device */}
      {modal?.kind === "form" && (
        <DeviceFormModal
          key={modal.device?.name || "__new__"}
          device={modal.device}
          tokenPh={modal.device ? t("devices.tokenKeepPh") : t("devices.tokenPh")}
          onClose={() => setModal(null)}
          onSave={handleFormSave}
        />
      )}

      {/* Delete confirmation (replaces the native confirm()) */}
      {modal?.kind === "delete" && (
        <Modal title={t("devices.deleteTitle")} onClose={() => setModal(null)}>
          <p className="modal-strong">
            {t("devices.deleteConfirm", { name: modal.device })}
          </p>
          <p className="muted">{t("devices.deleteNote")}</p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setModal(null)}>
              {t("devices.cancel")}
            </button>
            <button
              className="btn btn-danger"
              onClick={() => handleDeleteDevice(modal.device)}
            >
              {t("devices.delete")}
            </button>
          </div>
        </Modal>
      )}

      {/* Tunnel down — explain instead of opening a dead hostname */}
      {modal?.kind === "tunnelDown" && (
        <Modal title={t("devices.tunnelDownTitle")} onClose={() => setModal(null)}>
          <p className="muted">{t("devices.tunnelDownBody", { name: modal.device })}</p>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => setModal(null)}>
              {t("devices.cancel")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── Add / edit form ─────────────────────────────────────────────
 * One modal for both flows. Editing with an empty token routes to the
 * rename endpoint (credential preserved); filling the token does a full
 * upsert (credential overwritten — the note says so up-front). */

function DeviceFormModal({ device, tokenPh, onClose, onSave }: {
  device: Device | null;
  tokenPh: string;
  onClose: () => void;
  onSave: (original: Device | null, name: string, hostname: string, token: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(device?.name || "");
  const [hostname, setHostname] = useState(device?.hostname || "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const validName = /^[A-Za-z0-9_-]{1,32}$/.test(name.trim());
  const validHost = /^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(hostname.trim());

  const submit = async () => {
    if (!validName || !validHost || busy) return;
    setBusy(true);
    try {
      await onSave(device, name, hostname, token);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={device ? t("devices.editTitle") : t("devices.addTitle")} onClose={onClose}>
      <div className="form-group">
        <label>{t("devices.namePh")}</label>
        <input
          className="form-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="d1"
          autoComplete="off"
        />
      </div>
      <div className="form-group">
        <label>{t("devices.hostPh")}</label>
        <input
          className="form-input"
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          placeholder="d1.agent.saisi.online"
          autoComplete="off"
        />
      </div>
      <div className="form-group">
        <label>{tokenPh}</label>
        <input
          className="form-input"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      {device && <p className="form-hint">{t("devices.editNote")}</p>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          {t("devices.cancel")}
        </button>
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={busy || !validName || !validHost}
        >
          {t("devices.saveDevice")}
        </button>
      </div>
    </Modal>
  );
}
