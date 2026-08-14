// react-jsx: no React import needed
import type { Session } from "../hooks/useSessions";

export function StatusBar({ sessions, status, sseState }: {
  sessions: Session[];
  status: string;
  sseState: "connected" | "down" | "connecting";
}) {
  const live = sessions.filter((s) => !s.closed).length;
  return (
    <div id="statusbar">
      <span id="status" className={status.startsWith("error") || status.startsWith("open failed") ? "error" : ""}>{status}</span>
      <span id="session-count" className={live ? "" : "hidden"}>{live} session{live === 1 ? "" : "s"}</span>
      {sseState === "down" && <span id="sse-status">reconnecting…</span>}
    </div>
  );
}
