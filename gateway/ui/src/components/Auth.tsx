import { useState, type FormEvent } from "react";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";
import { ApiError } from "../api/client.ts";
import { Logo } from "./ui.tsx";

type Tab = "login" | "register" | "reset";

export default function Auth() {
  const { login, register, resetPassword } = useAuth();
  const { t, lang, setLang } = useTranslation();
  const [tab, setTab] = useState<Tab>("login");

  // Form fields
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [regUser, setRegUser] = useState("");
  const [regPass, setRegPass] = useState("");
  const [regInvite, setRegInvite] = useState("");
  const [resetKey, setResetKey] = useState("");
  const [resetNewPass, setResetNewPass] = useState("");

  // Messages
  const [loginMsg, setLoginMsg] = useState("");
  const [regMsg, setRegMsg] = useState("");
  const [resetMsg, setResetMsg] = useState("");

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setLoginMsg("");
    try {
      await login(loginUser, loginPass);
    } catch (err) {
      setLoginMsg(err instanceof ApiError ? err.message : t("auth.loginFail"));
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setRegMsg("");
    try {
      await register(regUser, regPass, regInvite);
    } catch (err) {
      setRegMsg(err instanceof ApiError ? err.message : t("auth.registerFail"));
    }
  }

  async function handleReset(e: FormEvent) {
    e.preventDefault();
    setResetMsg("");
    try {
      await resetPassword(resetKey, resetNewPass);
      setTab("login");
      setLoginMsg(t("auth.resetOk"));
    } catch (err) {
      setResetMsg(err instanceof ApiError ? err.message : t("auth.resetFail"));
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-lang">
          <button className="lang-btn" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
            {lang === "zh" ? "EN" : "中文"}
          </button>
        </div>
        <div className="auth-brand">
          <Logo size={46} />
          <div>
            <h1>Vale</h1>
            <p>{t("app.sub")}</p>
          </div>
        </div>

        <div className="auth-tabs" role="tablist">
          <button
            className={`auth-tab ${tab === "login" ? "active" : ""}`}
            onClick={() => setTab("login")}
          >
            {t("auth.login")}
          </button>
          <button
            className={`auth-tab ${tab === "register" ? "active" : ""}`}
            onClick={() => setTab("register")}
          >
            {t("auth.register")}
          </button>
          <button
            className={`auth-tab ${tab === "reset" ? "active" : ""}`}
            onClick={() => setTab("reset")}
          >
            {t("auth.resetTab")}
          </button>
        </div>

        {tab === "login" && (
          <form className="auth-form" onSubmit={handleLogin} autoComplete="off">
            <label>
              <span>{t("auth.username")}</span>
              <input
                name="username"
                placeholder={t("auth.usernamePh")}
                required
                autoComplete="username"
                value={loginUser}
                onChange={(e) => setLoginUser(e.target.value)}
              />
            </label>
            <label>
              <span>{t("auth.password")}</span>
              <input
                name="password"
                type="password"
                placeholder={t("auth.passwordPh")}
                required
                autoComplete="current-password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
              />
            </label>
            {loginMsg && <p className="form-msg">{loginMsg}</p>}
            <button type="submit" className="btn btn-accent btn-block">
              {t("auth.loginBtn")}
            </button>
          </form>
        )}

        {tab === "register" && (
          <form className="auth-form" onSubmit={handleRegister} autoComplete="off">
            <label>
              <span>{t("auth.username")}</span>
              <input
                name="username"
                placeholder={t("auth.usernamePhReg")}
                required
                autoComplete="username"
                value={regUser}
                onChange={(e) => setRegUser(e.target.value)}
              />
            </label>
            <label>
              <span>{t("auth.password")}</span>
              <input
                name="password"
                type="password"
                placeholder={t("auth.passwordPhReg")}
                required
                autoComplete="new-password"
                value={regPass}
                onChange={(e) => setRegPass(e.target.value)}
              />
            </label>
            <label>
              <span>{t("auth.inviteCode")}</span>
              <input
                name="inviteCode"
                placeholder={t("auth.invitePh")}
                required
                value={regInvite}
                onChange={(e) => setRegInvite(e.target.value)}
              />
            </label>
            {regMsg && <p className="form-msg">{regMsg}</p>}
            <button type="submit" className="btn btn-accent btn-block">
              {t("auth.registerBtn")}
            </button>
          </form>
        )}

        {tab === "reset" && (
          <form className="auth-form" onSubmit={handleReset} autoComplete="off">
            <p className="muted">{t("auth.resetHint")}</p>
            <label>
              <span>{t("auth.adminKey")}</span>
              <input
                name="adminKey"
                type="password"
                placeholder="admin key"
                required
                autoComplete="off"
                value={resetKey}
                onChange={(e) => setResetKey(e.target.value)}
              />
            </label>
            <label>
              <span>{t("auth.newPassword")}</span>
              <input
                name="newPassword"
                type="password"
                placeholder="New password (≥8 chars)"
                required
                autoComplete="new-password"
                value={resetNewPass}
                onChange={(e) => setResetNewPass(e.target.value)}
              />
            </label>
            {resetMsg && <p className="form-msg">{resetMsg}</p>}
            <button type="submit" className="btn btn-accent btn-block">
              {t("auth.resetBtn")}
            </button>
          </form>
        )}
      </div>
      <p className="auth-foot">{t("auth.foot")}</p>
    </div>
  );
}
