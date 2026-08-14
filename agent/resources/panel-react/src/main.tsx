import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// The panel mounts into #root (the agent's index.html hosts it). React 18
// createRoot replaces the old DOM-manipulation bootstrap.
const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
