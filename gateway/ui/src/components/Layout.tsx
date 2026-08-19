import { useState } from "react";
import { useAuth } from "../contexts/AuthContext.tsx";
import Auth from "./Auth.tsx";
import Sidebar from "./Sidebar.tsx";
import Overview from "../views/Overview.tsx";
import Keys from "../views/Keys.tsx";
import Routes from "../views/Routes.tsx";
import Users from "../views/Users.tsx";
import DevicesPanel from "../views/DevicesPanel.tsx";

export default function Layout() {
  const { user, loading } = useAuth();
  const [panel, setPanel] = useState("overview");

  if (loading) {
    return (
      <div className="auth-wrap">
        <div className="brand-lg" style={{ justifyContent: "center", flexDirection: "column", alignItems: "center" }}>
          <span className="brand-mark lg">V</span>
          <div style={{ marginTop: 16 }}>
            <div className="brand-name" style={{ fontSize: 18 }}>Vale</div>
          </div>
          <div className="loading-spinner" style={{ marginTop: 20 }} />
        </div>
      </div>
    );
  }

  if (!user) {
    return <Auth />;
  }

  return (
    <div className="app">
      <Sidebar activePanel={panel} onPanelChange={setPanel} />
      <main className="content">
        {panel === "overview" && <Overview />}
        {panel === "keys" && <Keys />}
        {panel === "routes" && <Routes />}
        {panel === "users" && user.role === "admin" && <Users />}
        {panel === "devices" && user.role === "admin" && <DevicesPanel />}
      </main>
    </div>
  );
}
