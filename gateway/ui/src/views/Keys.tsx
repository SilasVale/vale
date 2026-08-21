import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, ApiError } from "../api/client.ts";
import { PageHeader, Badge, CopyButton } from "../components/ui.tsx";

const KEY_NAMES = ["DEEPSEEK_API_KEY", "OPENCODE_GO_API_KEY", "OPENROUTER_API_KEY"];

interface KeyInfo {
  configured: boolean;
  masked: string;
}

function getKeyShortName(name: string) {
  return name.replace("_API_KEY", "").toLowerCase();
}

export default function Keys() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [keys, setKeys] = useState<Record<string, KeyInfo | undefined>>({});
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [resultBox, setResultBox] = useState<{ name: string; ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const me = await api.me();
      setKeys(me.keys || {});
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleSave = async (name: string) => {
    if (!editValue.trim()) {
      setResultBox({ name, ok: false, msg: t("key.emptyValue") });
      return;
    }
    try {
      await api.saveKey(name, editValue.trim());
      setEditingName(null);
      setEditValue("");
      toast(`${t("key.saved")} ${name}`);
      await loadKeys();
    } catch (err) {
      setResultBox({ name, ok: false, msg: err instanceof ApiError ? err.message : t("key.saveFail") });
    }
  };

  const handleTest = async (name: string) => {
    setTesting(name);
    try {
      const data = await api.testKey(name);
      setResultBox({
        name,
        ok: data.ok,
        msg: data.ok
          ? t("key.testOk", { status: String(data.status || 200) }) + (data.detail ? ` · ${data.detail}` : "")
          : t("key.testFail", { detail: data.detail || "…" }),
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "…";
      setResultBox({ name, ok: false, msg: t("key.testFail", { detail: msg }) });
    }
    setTesting(null);
  };

  const handleUsage = async (name: string) => {
    setUsageLoading(name);
    try {
      const data = await api.usageKey(name);
      if (!data.ok) {
        setResultBox({ name, ok: false, msg: data.detail || t("key.usageFail") });
      } else {
        const money = (v: number | undefined) =>
          typeof v === "number" && Number.isFinite(v) ? `$${v.toFixed(4)}` : t("key.usageUnavailable");
        const parts: string[] = [];
        if (data.label) parts.push(`${t("key.usageAccount")}: ${data.label}`);
        // OpenCode Go multi-window response
        if (data.windows && typeof data.windows === "object") {
          const winLabels: Record<string, string> = { "5h": "5h", weekly: "周", monthly: "月" };
          for (const [wk, wv] of Object.entries(data.windows) as [string, any][]) {
            const label = winLabels[wk] || wk;
            const pct =
              typeof wv.used === "number" && typeof wv.limit === "number" && wv.limit > 0
                ? ` ${Math.round((wv.used / wv.limit) * 100)}%`
                : "";
            const remain =
              typeof wv.remaining === "number" ? ` · ${t("key.usageRemaining")}: ${money(wv.remaining)}` : "";
            const reset = wv.resetAt ? ` · ${wv.resetAt}` : "";
            parts.push(
              `${label}: ${money(wv.used)} / ${wv.limit === null ? t("key.usageUnlimited") : money(wv.limit)}${pct}${remain}${reset}`,
            );
          }
        } else {
          // Single-value response (OpenRouter / flat OpenCode Go)
          parts.push(`${t("key.usageUsed")}: ${money(data.usage)}`);
          parts.push(
            `${t("key.usageLimit")}: ${data.limit === null ? t("key.usageUnlimited") : money(data.limit)}`,
          );
          if (typeof data.usage === "number" && typeof data.limit === "number")
            parts.push(`${t("key.usageRemaining")}: ${money(Math.max(0, data.limit - data.usage))}`);
          if (typeof data.balance === "number") parts.push(`余额: ${money(data.balance)}`);
        }
        if (data.rateLimit?.limit != null)
          parts.push(
            `${t("key.usageRateLimit")}: ${data.rateLimit.limit}${data.rateLimit.interval ? `/${data.rateLimit.interval}` : ""}`,
          );
        setResultBox({ name, ok: true, msg: parts.join(" · ") });
      }
    } catch (err) {
      setResultBox({ name, ok: false, msg: err instanceof ApiError ? err.message : t("key.usageFail") });
    }
    setUsageLoading(null);
  };

  const handleClear = async (name: string) => {
    if (!confirm(t("key.clearConfirm", { name }))) return;
    try {
      await api.deleteKey(name);
      toast(`${t("key.cleared")} ${name}`);
      await loadKeys();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("key.saveFail"), true);
    }
  };

  return (
    <div>
      <PageHeader title={t("keys.title")} description={t("keys.lede")} />
      <div className="cards">
        {KEY_NAMES.map((name) => {
          const info = keys[name];
          const configured = !!(info && info.configured);
          const shortName = getKeyShortName(name);
          const backend = t(`key.${shortName}.backend` as any);
          const hint = t(`key.${shortName}.hint` as any);
          const isEditing = editingName === name;
          const result = resultBox?.name === name ? resultBox : null;

          return (
            <div className="key-card" key={name}>
              <div className="key-card-top">
                <div>
                  <div className="key-card-name">{name}</div>
                  <div className="key-card-desc">
                    {backend} · {hint}
                  </div>
                </div>
                <Badge tone={configured ? "success" : "muted"}>
                  {configured ? t("key.configured") : t("key.notConfigured")}
                </Badge>
              </div>

              <div className="row">
                <code className="token" style={{ flex: 1 }}>
                  {info?.masked || t("key.notConfigured")}
                </code>
                {configured && <CopyButton text={info?.masked || ""} small />}
              </div>

              <div className="key-card-actions">
                <button
                  className="btn btn-primary btn-mini"
                  onClick={() => {
                    setEditingName(name);
                    setEditValue("");
                    setResultBox(null);
                  }}
                >
                  {t("btn.edit")}
                </button>
                <button
                  className="btn btn-ghost btn-mini"
                  disabled={testing === name}
                  onClick={() => handleTest(name)}
                >
                  {testing === name ? t("btn.testing") : t("btn.test")}
                </button>
                {(name === "OPENROUTER_API_KEY" || name === "OPENCODE_GO_API_KEY") && (
                  <button
                    className="btn btn-ghost btn-mini"
                    disabled={usageLoading === name}
                    onClick={() => handleUsage(name)}
                  >
                    {usageLoading === name ? t("btn.usageLoading") : t("btn.usage")}
                  </button>
                )}
                <button className="btn btn-danger btn-mini" onClick={() => handleClear(name)}>
                  {t("btn.clear")}
                </button>
              </div>

              {isEditing && (
                <div className="input-row">
                  <input
                    className="form-input"
                    type="text"
                    placeholder="sk-…"
                    autoComplete="off"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSave(name)}
                    autoFocus
                  />
                  <button className="btn btn-primary btn-mini" onClick={() => handleSave(name)}>
                    {t("btn.save")}
                  </button>
                  <button
                    className="btn btn-ghost btn-mini"
                    onClick={() => {
                      setEditingName(null);
                      setEditValue("");
                    }}
                  >
                    {t("btn.cancel")}
                  </button>
                </div>
              )}

              {result && <div className={`test-result ${result.ok ? "ok" : "err"}`}>{result.msg}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
