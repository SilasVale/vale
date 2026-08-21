import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";
import { getTheme, toggleTheme } from "../lib/theme.ts";
import { Logo } from "./ui.tsx";
import { useState } from "react";

/* Sidebar icons — 16px stroke set, currentColor. */
const icons = {
  overview: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
  ),
  key: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
  ),
  route: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
  ),
  users: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  ),
  device: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
  ),
} as const;

type IconName = keyof typeof icons;

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}

export default function Layout() {
  const { user, logout } = useAuth();
  const { t, lang, setLang } = useTranslation();
  const [theme, setThemeState] = useState(getTheme());

  const generalItems: NavItem[] = [
    { to: "/", label: t("nav.overview"), icon: "overview" },
    { to: "/keys", label: t("nav.keys"), icon: "key" },
    { to: "/routes", label: t("nav.routes"), icon: "route" },
  ];

  const adminItems: NavItem[] = [
    { to: "/users", label: t("nav.users"), icon: "users" },
    { to: "/devices", label: t("nav.devices"), icon: "device" },
  ];

  const isAdmin = user?.role === "admin";
  const userInitial = user?.username?.charAt(0).toUpperCase() || "U";

  const renderItem = (item: NavItem) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) => `sidebar-link${isActive ? " active" : ""}`}
    >
      <span className="sidebar-icon">{icons[item.icon]}</span>
      <span>{item.label}</span>
    </NavLink>
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <Logo size={34} />
            <div>
              <div className="sidebar-title">Vale</div>
              <div className="sidebar-subtitle">{t("app.sub")}</div>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-section">{t("nav.section.general")}</div>
          {generalItems.map(renderItem)}
          {isAdmin && (
            <>
              <div className="sidebar-section">{t("nav.section.admin")}</div>
              {adminItems.map(renderItem)}
            </>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-avatar">{userInitial}</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">{user?.username}</div>
              <div className="sidebar-user-role">
                {t(user?.role === "admin" ? "role.admin" : "role.user")}
              </div>
            </div>
          </div>
          <div className="sidebar-actions">
            <button
              className="icon-btn"
              title={theme === "dark" ? t("theme.light") : t("theme.dark")}
              onClick={() => setThemeState(toggleTheme())}
            >
              {theme === "dark" ? (
                /* sun */
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              ) : (
                /* moon */
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              )}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => logout()}>
              {t("btn.logout")}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
              {lang === "zh" ? "EN" : "中文"}
            </button>
          </div>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
