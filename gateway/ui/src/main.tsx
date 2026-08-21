import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "./contexts/AuthContext.tsx";
import { ToastProvider } from "./contexts/ToastContext.tsx";
import App from "./App.tsx";
// Theme first: applies body[data-theme] before the first paint (no flash).
import "./lib/theme.ts";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AuthProvider>
  </StrictMode>,
);
