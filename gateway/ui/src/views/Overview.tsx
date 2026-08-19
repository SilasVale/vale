import { useState } from "react";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, ApiError } from "../api/client.ts";

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
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!user?.token) return;
    try {
      await navigator.clipboard.writeText(user.token);
      setCopied(true);
      toast(t("token.copied"));
      setTimeout(() => setCopied(false), 2000);
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
            {copied ? "✓" : t("btn.copy")}
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
    </div>
  );
}
