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
  // Boot transport (round-83): migrate the vanilla loadConfig bootstrap —
  // same-origin (/panel) + proxy (/api/devices/<n>/proxy/panel) modes, token
  // precedence (injected > URL ?token= > stored), and ?token= scrub from the
  // address bar. The old code read localStorage only, so a reload or a proxy
  // visit (extension Terminal button) showed a permanently empty panel.
  const [connError, setConnError] = useState("");
  const [connected, setConnected] = useState(() => {
    const sameOrigin = location.pathname.startsWith("/panel") || /\/proxy\/panel/.test(location.pathname);
    if (sameOrigin) {
      const isProxy = /\/proxy\/panel/.test(location.pathname);
      const urlToken = new URLSearchParams(location.search).get("token") || "";
      const injected = (isProxy ? "" : (window as any).__PANEL_TOKEN__) || "";
      const stored = localStorage.getItem(LS_TOKEN) || "";
      const host = location.host;
      const tok = isProxy ? (urlToken || "") : (injected || urlToken || stored);
      localStorage.setItem(LS_HOST, host);
      if (tok) localStorage.setItem(LS_TOKEN, tok);
      // round-86: a same-origin visit with NO token (LAN IP / non-allowlisted
      // host, empty storage) must show the conn form — the old code booted
      // connected=true with a placeholder token, silently dead (every call
      // 401'd into a noop, form unreachable). Proxy-mode cookie boot (no
      // token) stays connected — the cookie is the credential there.
      if (!tok && !isProxy) return false;
      initTransport(host, tok || " ", () => { authFailed.current = true; });
      if (urlToken) { try { history.replaceState(null, "", location.pathname); } catch {} }
      return true;
    }
    const h = localStorage.getItem(LS_HOST);
    const t = localStorage.getItem(LS_TOKEN);
    if (h && t) initTransport(h, t, () => { authFailed.current = true; });
    return !!(h && t);
  });
  // round-88: a stored token that expires/rotates 401'd into a noop — the
  // panel stayed 'connected' with everything dead and the conn form
  // unreachable. The 401 callback sets this flag; a render effect drops the
  // session back to the conn form.
  const authFailed = useRef(false);
  if (authFailed.current) {
    authFailed.current = false;
    setConnected(false);
    setConnError("session expired — re-enter token");
  }
  const [modalKind, setModalKind] = useState<"ssh" | "serial" | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const sessions = useSessions(connected);
  // SSE: per-session xterm write callbacks registered by TerminalPane.
  const writeCallbacks = useRef(new Map<string, { write: (bytes: Uint8Array) => void; getRendered: () => number }>());
  const registerWrite = useMemo(() =>
    (sid: string, fn: (bytes: Uint8Array) => void, getRendered: () => number) => { writeCallbacks.current.set(sid, { write: fn, getRendered }); },
  []);
  // round-86: stable getLiveSids ref — an inline arrow recreated the SSE
  // effect every 3s poll (stream teardown/re-establish, dropped frames).
  const getLiveSidsRef = useRef(() => sessions.sessions.filter((s) => !s.closed).map((s) => s.sid));
  getLiveSidsRef.current = () => sessions.sessions.filter((s) => !s.closed).map((s) => s.sid);
  const sseState = useSSE(connected, writeCallbacks, getLiveSidsRef);

  function connect() {
    // round-83: normalize the host — pasting 'https://d1…' or a trailing
    // slash built 'https://https://d1…' fetches (silent empty panel).
    const h = host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!h || !token) { setConnError("host + token required"); return; }
    localStorage.setItem(LS_HOST, h);
    localStorage.setItem(LS_TOKEN, token);
    initTransport(h, token, () => { setConnected(false); setConnError("session expired — re-enter token"); });
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
      <TabBar sessions={sessions.sessions} activeSid={sessions.activeSid} onActivate={sessions.activate} onClose={sessions.closeSession} onExport={sessions.exportSession} />
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
