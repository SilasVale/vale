// react-jsx: no React import needed
import "./lib/theme"; // theme applies before any render (light default)
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

// The panel mounts into #root (the agent's index.html hosts it). React 18
// createRoot replaces the old DOM-manipulation bootstrap. The boundary
// catches render crashes in any page — a broken page must never take the
// whole panel down to a silent white screen (round-161).
const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}
