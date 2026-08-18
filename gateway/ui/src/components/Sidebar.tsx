import { NavLink } from "react-router-dom";

const NAV_ITEMS = [
  { path: "/", label: "Dashboard", icon: "◈" },
  { path: "/devices", label: "Devices", icon: "⊡" },
  { path: "/plugins", label: "Plugins", icon: "⊞" },
  { path: "/config", label: "Config", icon: "⚙" },
  { path: "/source", label: "Source", icon: "⟨/⟩" },
];

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">V</span>
        <span className="sidebar-title">Vale Gate</span>
      </div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}
          >
            <span className="sidebar-icon">{item.icon}</span>
            <span className="sidebar-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
