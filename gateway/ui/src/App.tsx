import { HashRouter, Routes, Route, Navigate, Link } from "react-router-dom";
import { useAuth } from "./contexts/AuthContext.tsx";
import { useTranslation } from "./i18n.ts";
import Auth from "./components/Auth.tsx";
import Layout from "./components/Layout.tsx";
import Overview from "./views/Overview.tsx";
import Keys from "./views/Keys.tsx";
import RoutesView from "./views/Routes.tsx";
import Users from "./views/Users.tsx";
import DevicesPanel from "./views/DevicesPanel.tsx";

/**
 * Hash routing: the worker serves the SPA from static assets without a
 * history-API fallback (not_found_handling: "none"), so #/routes keep
 * deep links + refresh working without server-side support.
 */
function AuthedApp() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Overview />} />
        <Route path="/keys" element={<Keys />} />
        <Route path="/routes" element={<RoutesView />} />
        <Route path="/users" element={<AdminOnly view={<Users />} />} />
        <Route path="/devices" element={<AdminOnly view={<DevicesPanel />} />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

/* Off-map stop — the empty-pass vignette at page scale, with a way home. */
function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="empty empty-hero">
      <div className="empty-code">404</div>
      <div className="empty-title">{t("notfound.title")}</div>
      <p>{t("notfound.lede")}</p>
      <Link className="btn btn-secondary" to="/">
        {t("notfound.back")}
      </Link>
    </div>
  );
}

function AdminOnly({ view }: { view: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== "admin") return <Navigate to="/" replace />;
  return view;
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading" role="status" aria-label="loading">
        <div className="loading-sun" aria-hidden="true" />
      </div>
    );
  }

  if (!user) return <Auth />;

  return (
    <HashRouter>
      <AuthedApp />
    </HashRouter>
  );
}
