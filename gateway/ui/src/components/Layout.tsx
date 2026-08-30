import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useTranslation } from "../i18n.ts";
import { getTheme, toggleTheme } from "../lib/theme.ts";
import { useEffect, useRef, useState } from "react";

/* Nav icons — 18px stroke set, currentColor (v2 control-deck rail). */
const icons = {
  overview: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
  ),
  key: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
  ),
  route: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
  ),
  users: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  ),
  device: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
  ),
} as const;

type IconName = keyof typeof icons;

interface NavItem {
  to: string;
  labelKey: string;
  icon: IconName;
}

/*
 * v2 "control deck" layout: ONE 68px icon rail owns everything — brand,
 * main + admin nav clusters, then theme / language and the identity avatar
 * (click → popover with name, role, logout). There is no topbar: the page
 * header carries the title, and the horizontal space belongs to the data.
 */
export default function Layout() {
  const { user, logout } = useAuth();
  const { t, lang, setLang } = useTranslation();
  const [theme, setThemeState] = useState(getTheme());

  const mainItems: NavItem[] = [
    { to: "/", labelKey: "nav.overview", icon: "overview" },
    { to: "/keys", labelKey: "nav.keys", icon: "key" },
    { to: "/routes", labelKey: "nav.routes", icon: "route" },
  ];
  const adminItems: NavItem[] = [
    { to: "/users", labelKey: "nav.users", icon: "users" },
    { to: "/devices", labelKey: "nav.devices", icon: "device" },
  ];

  const isAdmin = user?.role === "admin";
  const userInitial = user?.username?.charAt(0).toUpperCase() || "U";
  const [userOpen, setUserOpen] = useState(false);
  const userRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!userOpen) return;
    const close = (e: MouseEvent) => {
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [userOpen]);

  const railBtn = (item: NavItem) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.to === "/"}
      title={t(item.labelKey as never)}
      aria-label={t(item.labelKey as never)}
      className={({ isActive }) => `rail-btn${isActive ? " active" : ""}`}
    >
      {icons[item.icon]}
    </NavLink>
  );

  return (
    <div className="app">
      <aside className="rail">
        <NavLink to="/" className="rail-brand" title="Vale Gate">
          <img className="brand-img" src="/favicon.svg" alt="Vale" width={30} height={30} />
        </NavLink>

        <nav className="rail-nav">
          <div className="rail-cluster">{mainItems.map(railBtn)}</div>
          {isAdmin && <div className="rail-cluster">{adminItems.map(railBtn)}</div>}
        </nav>

        <div className="rail-foot">
          <button
            className="rail-btn rail-util"
            title={theme === "dark" ? t("theme.light") : t("theme.dark")}
            aria-label="theme"
            onClick={() => setThemeState(toggleTheme())}
          >
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </button>
          <button
            className="rail-btn rail-util rail-lang"
            title="Language"
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          >
            {lang === "zh" ? "EN" : "中"}
          </button>
          <div className="rail-sep" />
          <div ref={userRef}>
            <button
              className="rail-avatar"
              title={user?.username}
              onClick={() => setUserOpen((o) => !o)}
            >
              {userInitial}
            </button>
          </div>
        </div>
      </aside>

      <div className="main-col">
        <main className="content">
          <Outlet />
        </main>
      </div>

      {userOpen && (
        <div className="user-pop" ref={userRef}>
          <div className="user-pop-head">
            <div className="topbar-avatar">{userInitial}</div>
            <div>
              <div className="user-pop-name">{user?.username}</div>
              <div className="user-pop-role">
                {t(user?.role === "admin" ? "role.admin" : "role.user")}
              </div>
            </div>
          </div>
          <button className="user-pop-logout" onClick={() => logout()}>
            {t("btn.logout")}
          </button>
        </div>
      )}
    </div>
  );
}
