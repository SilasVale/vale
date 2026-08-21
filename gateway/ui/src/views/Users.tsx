import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, ApiError, type User } from "../api/client.ts";
import { maskToken } from "../lib/format.ts";
import { Card, PageHeader, Badge } from "../components/ui.tsx";

export default function Users() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [pwSet, setPwSet] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);

  const loadUsers = useCallback(async () => {
    try {
      const data = await api.getUsers();
      setUsers(data.users || []);
    } catch {
      /* noop */
    }
    try {
      const pw = await api.getAdminPassword();
      setPwSet(!!pw.set);
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleToggle = async (id: string, currentEnabled: boolean) => {
    try {
      await api.setEnabled(id, !currentEnabled);
      toast(currentEnabled ? t("user.disableToast") : t("user.enableToast"));
      await loadUsers();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "…", true);
    }
  };

  const handleChangePw = async () => {
    setPwMsg("");
    if (newPw.length < 8) {
      setPwMsg(t("adminpw.short"));
      return;
    }
    try {
      await api.setAdminPassword(newPw);
      setPwSet(true);
      setNewPw("");
      setPwMsg(t("adminpw.changed"));
      toast(`${t("adminpw.title")} ${t("key.saved")}`);
    } catch (err) {
      setPwMsg(err instanceof ApiError ? err.message : t("adminpw.changeFail"));
    }
  };

  const handleGenerateInvite = async () => {
    setInviteLoading(true);
    try {
      const data = await api.generateInvite();
      if (data.code) {
        setInviteCode(data.code);
        navigator.clipboard?.writeText(data.code).catch(() => {});
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("invite.genFail"), true);
    }
    setInviteLoading(false);
  };

  return (
    <div>
      <PageHeader title={t("nav.users")} description={t("users.lede")} />

      <Card title={t("adminpw.title")} description={t("adminpw.desc")}>
        <div className="token-row">
          <code className="token">{pwSet ? "•••••• (set)" : "— (not set)"}</code>
        </div>
        <div className="input-row mt-12">
          <input
            className="form-input"
            type="password"
            placeholder={t("adminpw.placeholder")}
            autoComplete="new-password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleChangePw()}
          />
          <button className="btn btn-primary" onClick={handleChangePw}>
            {t("adminpw.change")}
          </button>
        </div>
        {pwMsg && <p className="form-msg ok">{pwMsg}</p>}
      </Card>

      <Card
        title={t("invite.title")}
        headerExtra={
          <button className="btn btn-primary btn-sm" disabled={inviteLoading} onClick={handleGenerateInvite}>
            {t("invite.gen")}
          </button>
        }
      >
        {inviteCode ? (
          <div className="note tip">
            {t("invite.new")} <code className="mono">{inviteCode}</code>
          </div>
        ) : (
          <p className="muted">{t("invite.gen")} →</p>
        )}
      </Card>

      <Card title={t("users.list")}>
        <div className="list">
          {users.map((u) => (
            <div className="list-row" key={u.id}>
              <div className="list-main">
                <div className="list-line">
                  <span className="list-title">{u.username}</span>
                  {u.role === "admin" && <Badge tone="info">{t("role.admin")}</Badge>}
                </div>
                <div className="list-sub">{maskToken(u.token)}</div>
              </div>
              <div className="list-actions">
                <Badge tone={u.enabled ? "success" : "muted"}>
                  {u.enabled ? t("user.enabled") : t("user.disabled")}
                </Badge>
                {u.role !== "admin" && (
                  <button className="btn btn-ghost btn-mini" onClick={() => handleToggle(u.id, u.enabled)}>
                    {u.enabled ? t("btn.disable") : t("btn.enable")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
