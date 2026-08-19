import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";

interface SidebarProps {
  activePanel: string;
  onPanelChange: (panel: string) => void;
}

export default function Sidebar({ activePanel, onPanelChange }: SidebarProps) {
  const { user, logout } = useAuth();
  const { t, lang, setLang } = useTranslation();

  const navItems = [
    { key: "overview", label: t("nav.overview"), icon: "overview" },
    { key: "keys", label: t("nav.keys"), icon: "key" },
    { key: "routes", label: t("nav.routes"), icon: "route" },
  ];

  const adminItems = [
    { key: "users", label: t("nav.users"), icon: "users" },
    { key: "devices", label: t("nav.devices"), icon: "device" },
  ];

  const isAdmin = user?.role === "admin";
  const userInitial = user?.username?.charAt(0).toUpperCase() || "U";

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <span className="sidebar-logo">V</span>
          <div>
            <div className="sidebar-title">Vale</div>
            <div className="sidebar-subtitle">AI Gateway Console</div>
          </div>
        </div>
      </div>

      <nav className="sidebar-nav">
        <div className="sidebar-section">Navigation</div>
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`sidebar-link ${activePanel === item.key ? "active" : ""}`}
            onClick={() => onPanelChange(item.key)}
          >
            <span className="sidebar-icon">
              {item.icon === "overview" && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>}
              {item.icon === "key" && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>}
              {item.icon === "route" && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>}
              {item.icon === "users" && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
              {item.icon === "device" && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>}
            </span>
            <span>{item.label}</span>
          </button>
        ))}

        {isAdmin && (
          <>
            <div className="sidebar-section">Admin</div>
            {adminItems.map((item) => (
              <button
                key={item.key}
                className={`sidebar-link ${activePanel === item.key ? "active" : ""}`}
                onClick={() => onPanelChange(item.key)}
              >
                <span className="sidebar-icon">
                  {item.icon === "users" && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
                  {item.icon === "device" && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>}
                </span>
                <span>{item.label}</span>
              </button>
            ))}
          </>
        )}
      </nav>

      <div className="sidebar-footer">
        {user && (
          <div className="sidebar-user">
            <div className="sidebar-avatar">{userInitial}</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">{user.username}</div>
              <div className="sidebar-user-role">
                {t(user.role === "admin" ? "role.admin" : "role.user")}
              </div>
            </div>
          </div>
        )}
        <div className="sidebar-actions">
          <button className="btn btn-secondary btn-sm btn-block" onClick={() => logout()}>
            {t("btn.logout")}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          >
            {lang === "zh" ? "EN" : "中文"}
          </button>
        </div>
      </div>
    </aside>
  );
}
