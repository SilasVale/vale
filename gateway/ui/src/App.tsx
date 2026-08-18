import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.tsx";
import Dashboard from "./views/Dashboard.tsx";
import Devices from "./views/Devices.tsx";
import Plugins from "./views/Plugins.tsx";
import Config from "./views/Config.tsx";
import SourceViewer from "./views/SourceViewer.tsx";

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/plugins" element={<Plugins />} />
        <Route path="/config" element={<Config />} />
        <Route path="/source" element={<SourceViewer />} />
      </Route>
    </Routes>
  );
}

export default App;
