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
    { key: "overview", label: t("nav.overview"), icon: "◈" },
    { key: "keys", label: t("nav.keys"), icon: "🔑" },
    { key: "routes", label: t("nav.routes"), icon: "⇄" },
  ];

  const adminItems = [
    { key: "users", label: t("nav.users"), icon: "👥" },
    { key: "devices", label: t("nav.devices"), icon: "💻" },
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
            <span className="sidebar-icon">{item.icon}</span>
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
                <span className="sidebar-icon">{item.icon}</span>
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
