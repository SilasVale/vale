import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, ApiError } from "../api/client.ts";
import { maskToken } from "../lib/format.ts";
import { Card, PageHeader, Badge, CopyButton, StatusChip } from "../components/ui.tsx";

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

export default function Overview() {
  const { user, refreshUser } = useAuth();
  const { t } = useTranslation();
  const { toast } = useToast();
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [tokenNote, setTokenNote] = useState("");

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

  // Backend key status strip — a compact "is each channel usable" readout.
  const keyEntries = KEY_ORDER.map((name) => ({
    name,
    info: user?.keys?.[name],
  }));
  const configuredCount = keyEntries.filter((k) => k.info?.configured).length;

  return (
    <div>
      <PageHeader
        title={t("overview.title")}
        description={t("overview.lede")}
        actions={
          <Badge tone={user?.role === "admin" ? "info" : "muted"}>
            {t(user?.role === "admin" ? "role.admin" : "role.user")}
          </Badge>
        }
      />

      <Card
        title={t("token.title")}
        description={<span dangerouslySetInnerHTML={{ __html: t("token.desc") }} />}
        headerExtra={
          <Badge tone={configuredCount > 0 ? "muted" : "warning"}>
            {configuredCount}/{keyEntries.length}
          </Badge>
        }
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
      </Card>

      <Card title={t("keys.title")}>
        <p className="muted" style={{ marginBottom: 12 }}>
          {t("overview.keysHint")}{" "}
          <Link to="/keys">{t("nav.keys")} →</Link>
        </p>
        <div className="row">
          {keyEntries.map(({ name, info }) => (
            <StatusChip key={name} state={info?.configured ? "ok" : "off"}>
              {keyLabel(name)}
            </StatusChip>
          ))}
        </div>
      </Card>
    </div>
  );
}
