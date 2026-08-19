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
    { key: "users", label: t("nav.users"), icon: "👥", adminOnly: true },
    { key: "devices", label: t("nav.devices"), icon: "💻", adminOnly: true },
  ];

  const isAdmin = user?.role === "admin";

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">V</span>
        <span className="sidebar-title">Vale</span>
      </div>
      <nav className="sidebar-nav">
        {navItems
          .filter((item) => !item.adminOnly || isAdmin)
          .map((item) => (
            <button
              key={item.key}
              className={`sidebar-link ${activePanel === item.key ? "active" : ""}`}
              onClick={() => onPanelChange(item.key)}
            >
              <span className="sidebar-icon">{item.icon}</span>
              <span className="sidebar-label">{item.label}</span>
            </button>
          ))}
      </nav>
      <div className="sidebar-foot">
        {user && (
          <div className="side-user">
            <div className="name">{user.username}</div>
            <div className="role">
              {t(user.role === "admin" ? "role.admin" : "role.user")}
            </div>
          </div>
        )}
        <button className="btn-ghost btn-block" onClick={() => logout()}>
          {t("btn.logout")}
        </button>
        <div className="lang-toggle" style={{ marginTop: 8 }}>
          <button className="lang-btn" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
            {lang === "zh" ? "EN" : "中文"}
          </button>
        </div>
      </div>
    </aside>
  );
}
