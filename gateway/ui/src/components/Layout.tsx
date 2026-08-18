import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar.tsx";
import TopBar from "./TopBar.tsx";

export default function Layout() {
  return (
    <div className="layout">
      <Sidebar />
      <div className="layout-main">
        <TopBar />
        <main className="layout-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
