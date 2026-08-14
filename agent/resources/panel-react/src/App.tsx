import { useMemo, useRef, useState } from "react";
import { initTransport } from "./lib/api";
import { useSessions } from "./hooks/useSessions";
import { useSSE } from "./hooks/useSSE";
import { TerminalPane } from "./components/TerminalPane";
import { TabBar } from "./components/TabBar";
import { Toolbar } from "./components/Toolbar";
import { StatusBar } from "./components/StatusBar";
import { ConnModal } from "./components/ConnModal";
import { SettingsModal } from "./components/SettingsModal";

const LS_HOST = "valeHost";
const LS_TOKEN = "valeToken";

export function App() {
  const [host, setHost] = useState(() => localStorage.getItem(LS_HOST) || "");
  const [token, setToken] = useState(() => localStorage.getItem(LS_TOKEN) || "");
  const [connected, setConnected] = useState(() => !!(localStorage.getItem(LS_HOST) && localStorage.getItem(LS_TOKEN)));
  const [connError, setConnError] = useState("");
  const [modalKind, setModalKind] = useState<"ssh" | "serial" | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const sessions = useSessions(connected);
  // SSE: per-session xterm write callbacks registered by TerminalPane.
  const writeCallbacks = useRef(new Map<string, (bytes: Uint8Array) => void>());
  const registerWrite = useMemo(() =>
    (sid: string, fn: (bytes: Uint8Array) => void) => { writeCallbacks.current.set(sid, fn); },
  []);
  const sseState = useSSE(connected, writeCallbacks);

  function connect() {
    if (!host || !token) { setConnError("host + token required"); return; }
    localStorage.setItem(LS_HOST, host);
    localStorage.setItem(LS_TOKEN, token);
    initTransport(host, token, () => { setConnected(false); setConnError("session expired — re-enter token"); });
    setConnected(true);
    setConnError("");
  }

  if (!connected) {
    return (
      <div id="conn-form">
        <h1>Vale Agent</h1>
        <label>Device hostname</label>
        <input id="host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="d1.agent.saisi.online" autoComplete="off" />
        <label>Auth token</label>
        <input id="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Bearer token from config.yaml" autoComplete="off" />
        <button onClick={connect}>Connect</button>
        <div className="hint">Credentials stay in this browser (localStorage); they are never sent elsewhere.</div>
        {connError && <div id="conn-status" className="error">{connError}</div>}
      </div>
    );
  }

  return (
    <div id="panel-main">
      <Toolbar
        onOpenPty={() => sessions.openSession("pty", "").catch(() => {})}
        onShowConn={(kind) => setModalKind(kind)}
        onExportAll={() => sessions.sessions.forEach((s) => sessions.exportSession(s.sid))}
        onShowSettings={() => setShowSettings(true)}
      />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {modalKind && (
        <ConnModal
          kind={modalKind}
          onClose={() => setModalKind(null)}
          onConnect={(target, extra) => sessions.openSession(modalKind, target, extra)}
        />
      )}
      <TabBar sessions={sessions.sessions} activeSid={sessions.activeSid} onActivate={sessions.activate} onClose={sessions.closeSession} />
      <div id="term-container">
        {sessions.sessions.length === 0 ? (
          <div id="empty-state">
            <div className="empty-card">
              <span className="empty-mark">V</span>
              <p>No sessions yet</p>
            </div>
          </div>
        ) : (
          sessions.sessions.map((s) => <TerminalPane key={s.sid} session={s} registerWrite={registerWrite} />)
        )}
      </div>
      <StatusBar sessions={sessions.sessions} status={sessions.status} sseState={sseState} />
    </div>
  );
}
