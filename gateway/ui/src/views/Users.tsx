import { useState, useEffect, useCallback } from "react";
import { useTranslation, esc } from "../i18n.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { api, ApiError, type User } from "../api/client.ts";

function maskToken(tok: string) {
  if (!tok) return "";
  if (tok.length <= 8) return tok[0] + "…" + tok.slice(-3);
  return tok.slice(0, 6) + "…" + tok.slice(-4);
}

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
      const msg = err instanceof ApiError ? err.message : "…";
      toast(msg, true);
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
      const msg = err instanceof ApiError ? err.message : t("adminpw.changeFail");
      setPwMsg(msg);
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
      const msg = err instanceof ApiError ? err.message : t("invite.genFail");
      toast(msg, true);
    }
    setInviteLoading(false);
  };

  return (
    <div>
      <h1>{t("nav.users")}</h1>
      <p className="lede">{t("users.lede")}</p>

      {/* Admin password */}
      <div className="card">
        <div className="card-head">
          <h2>{t("adminpw.title")}</h2>
        </div>
        <p className="muted">{t("adminpw.desc")}</p>
        <div className="token-row">
          <code className="token mono">
            {pwSet ? "•••••• (set)" : "— (not set)"}
          </code>
        </div>
        <div className="key-edit-row">
          <input
            type="password"
            placeholder={t("adminpw.placeholder")}
            autoComplete="new-password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
          />
          <button className="btn-primary" onClick={handleChangePw}>
            {t("adminpw.change")}
          </button>
        </div>
        {pwMsg && <p className="form-msg">{pwMsg}</p>}
      </div>

      {/* Invite codes */}
      <div className="card">
        <div className="card-head">
          <h2>{t("invite.title")}</h2>
          <button className="btn-primary" disabled={inviteLoading} onClick={handleGenerateInvite}>
            {t("invite.gen")}
          </button>
        </div>
        {inviteCode && (
          <div className="note tip">
            {t("invite.new", { code: `<code class="mono">${esc(inviteCode)}</code>` })
              .split(/(<code[^>]*>.*?<\/code>)/)
              .map((part, i) =>
                part.startsWith("<code") ? (
                  <span key={i} dangerouslySetInnerHTML={{ __html: part }} />
                ) : (
                  <span key={i}>{part}</span>
                ),
              )}
          </div>
        )}
      </div>

      {/* User list */}
      <div className="card">
        <div className="card-head">
          <h2>{t("users.list")}</h2>
        </div>
        <div className="users-list">
          {users.map((u) => (
            <div className="user-row" key={u.id}>
              <div className="user-main">
                <div className="u-line">
                  <span className="u-name">{u.username}</span>
                  {u.role === "admin" && <span className="badge admin">{t("role.admin")}</span>}
                </div>
                <span className="u-sub">{maskToken(u.token)}</span>
              </div>
              <div className="user-actions">
                <span className={`badge ${u.enabled ? "ok" : "off"}`}>
                  {u.enabled ? t("user.enabled") : t("user.disabled")}
                </span>
                {u.role !== "admin" && (
                  <button
                    className="btn-ghost btn-mini"
                    onClick={() => handleToggle(u.id, u.enabled)}
                  >
                    {u.enabled ? t("btn.disable") : t("btn.enable")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
