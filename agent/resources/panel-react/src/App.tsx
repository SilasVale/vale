import { useEffect, useMemo, useRef, useState } from "react";
import { initTransport } from "./lib/api";
import { useSessions } from "./hooks/useSessions";
import { useCommandEvents } from "./hooks/useCommandEvents";
import { useSSE } from "./hooks/useSSE";
import { AppFrame } from "./components/AppFrame";
import { Sidebar } from "./components/Sidebar";
import { PluginsView } from "./components/PluginsView";
import { usePlugins } from "./hooks/usePlugins";
import { DetailsPanel } from "./components/DetailsPanel";
import { CommandStream } from "./components/CommandCard";
import { TrajectoryView } from "./components/TrajectoryView";
import { TerminalPane } from "./components/TerminalPane";
import BrowserPane from "./components/BrowserPane";
import { TabBar } from "./components/TabBar";
import type { SessionView } from "./components/TabBar";
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
      // round-122/124: in PROXY mode do NOT persist the token to
      // localStorage — the vale_pt cookie is the real credential there, and
      // persisting the plugin token made a plaintext 30-day device-control
      // credential readable by any script on the console origin. Also
      // DELETE any stale pre-R122 value: the proxy's Bearer would win over
      // the valid cookie and a rotated leftover token would 401 the SSE
      // stream into a permanent reconnect loop. Same-origin (LAN) mode
      // keeps the stored-token flow.
      if (isProxy) {
        localStorage.removeItem(LS_TOKEN);
      } else if (tok) {
        localStorage.setItem(LS_TOKEN, tok);
      }
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
  // Details column (round-admin-ui Task 3): closed until a command card is
  // selected (Task 4); the panel's ✕ closes it.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // round-admin-ui Task 6: main-area view switch — the sidebar nav toggles
  // between the session workspace and the plugins page.
  const [view, setView] = useState<"sessions" | "plugins">("sessions");
  const [browserActive, setBrowserActive] = useState(false);
  // round-133: 状态轮询改为常开——Sessions 视图的 Browser 会话行依赖它。
  const plugins = usePlugins(connected);
  const pwRunning = !!plugins.playwright?.running;
  const BROWSER_SID = "__browser__";

  const sessions = useSessions(connected);

  // round-admin-ui Task 5: per-session main-area view (terminal | trajectory).
  // Per-sid so each session keeps its own view; new sessions default to the
  // terminal (the map defaults).
  const [sessionViews, setSessionViews] = useState<Record<string, SessionView>>({});
  const sessionView: SessionView = (sessions.activeSid && sessionViews[sessions.activeSid]) || "terminal";
  const trajOpen = !!sessions.activeSid && sessionView === "trajectory";
  // round-132/133: refit the xterm when the terminal un-hides — the refit
  // effect skips while display:none, so a window resize while in the
  // trajectory OR plugins view leaves a stale grid on switch-back. The
  // dispatch must run POST-commit (the R131 render-body version fired while
  // still hidden — a no-op). Keyed on the terminal's derived visibility
  // (both hiding paths: #term-container display:none for trajectory and
  // #panel-main.hidden for the plugins view).
  const termVisible = view === "sessions" && !trajOpen;
  const prevTermVisible = useRef(termVisible);
  useEffect(() => {
    if (!prevTermVisible.current && termVisible) {
      window.dispatchEvent(new Event("resize"));
    }
    prevTermVisible.current = termVisible;
  }, [termVisible]);

  // A selected command card belongs to the sessions view — leaving it drops
  // the details column (a stale card would linger over the plugins page).
  const switchView = (v: "sessions" | "plugins") => {
    setView(v);
    if (v === "plugins") {
      setDetailsOpen(false);
      setSelectedCmdId(null);
    }
  };

  // round-133: playwright-mcp 托管实例运行时注入一个 Browser 会话行——
  // 点击打开实时预览(BrowserPane)。激活状态由 browserActive 管理,
  // 与终端会话互斥(同一时间主区只显示一个面板)。
  const allSessions = useMemo(() => {
    if (!pwRunning) return sessions.sessions.filter((s) => !s.closed || true);
    const base = sessions.sessions.map((s) => ({ ...s, active: false }));
    return [...base, { sid: BROWSER_SID, label: "Browser", kind: "browser", closed: false, savedOnly: false, active: browserActive, openedAt: Date.now(), closedAt: null }] as typeof sessions.sessions;
  }, [sessions.sessions, pwRunning, browserActive]);

  const effectiveActiveSid = browserActive && pwRunning ? BROWSER_SID : sessions.activeSid;

  const activateWrap = (sid: string) => {
    if (sid === BROWSER_SID) {
      setBrowserActive(true);
      return;
    }
    setBrowserActive(false);
    sessions.activate(sid);
  };

  const newSessionWrap = (kind: "pty" | "ssh" | "serial") => {
    setBrowserActive(false);
    if (kind === "pty") { sessions.openSession("pty", "").catch(() => {}); }
    else setModalKind(kind);
  };

  // Command card stream (round-admin-ui Task 4): poll the ACTIVE session's
  // audit log; the selected card id + derived card live here so the details
  // column always shows the card's freshest state.
  const cmdEvents = useCommandEvents(connected && sessions.activeSid ? sessions.activeSid : null);
  const [selectedCmdId, setSelectedCmdId] = useState<string | null>(null);
  const selectedCard = selectedCmdId ? cmdEvents.cards.find((c) => c.id === selectedCmdId) ?? null : null;
  // Switching sessions resets the details column — a selected card belongs
  // to the previous session's stream.
  useEffect(() => {
    setSelectedCmdId(null);
    setDetailsOpen(false);
  }, [sessions.activeSid]);

  // SSE: per-session xterm write callbacks registered by TerminalPane.
  const writeCallbacks = useRef(new Map<string, { write: (bytes: Uint8Array) => void; getRendered: () => number }>());
  const registerWrite = useMemo(() => {
    // round-99: a removable registration — without unregister, closed
    // session callbacks lived in the map forever and the sync loop polled
    // them every 5s (unbounded no-op polling as sessions accumulate).
    const reg = (sid: string, fn: (bytes: Uint8Array) => void, getRendered: () => number) => {
      writeCallbacks.current.set(sid, { write: fn, getRendered });
      return () => { writeCallbacks.current.delete(sid); };
    };
    reg.unregister = (sid: string) => { writeCallbacks.current.delete(sid); };
    return reg;
  }, []);
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
    // round-124: in proxy mode never persist the token — the vale_pt cookie
    // is the credential there; persisting the plugin token to console-origin
    // localStorage is a plaintext 30-day device-control credential readable
    // by any console-origin script. Same-origin (LAN) mode keeps it.
    const isProxy = /\/proxy\/panel/.test(location.pathname);
    if (!isProxy) localStorage.setItem(LS_TOKEN, token);
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

  // round-admin-ui Task 3: three-column AppFrame — session sidebar | main
  // (the existing terminal pane shell) | details column (placeholder until
  // Task 4). The toolbar/tabs/terminal/statusbar keep their exact DOM + CSS.
  return (
    <AppFrame
      sidebar={
        <Sidebar
          sessions={allSessions as typeof sessions.sessions}
          activeSid={effectiveActiveSid}
          onActivate={activateWrap}
          view={view}
          onViewChange={switchView}
          onNewSession={newSessionWrap}
          plugins={plugins}
        />
      }
      main={(
        <>
        {/* round-admin-ui Task 6: the session workspace is HIDDEN, not
            unmounted, while the plugins page is up — xterm instances and
            SSE streams keep running, so switching back restores the exact
            terminal state. */}
        <div id="panel-main" className={view === "plugins" ? "hidden" : undefined}>
          <Toolbar
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
          <TabBar
            sessions={allSessions as typeof sessions.sessions}
            activeSid={effectiveActiveSid}
            onActivate={activateWrap}
            onClose={(sid) => {
              if (sid === BROWSER_SID) { setBrowserActive(false); return; }
              sessions.closeSession(sid);
            }}
            onExport={sessions.exportSession}
            view={sessionView}
            onViewChange={(v) => {
              const sid = sessions.activeSid;
              if (sid) setSessionViews((m) => ({ ...m, [sid]: v }));
            }}
          />
          {/* round-admin-ui Task 5: trajectory mode hides the terminal
              CONTAINER (inline display:none), not the panes — xterm instances
              stay mounted and keep streaming, so switching back restores the
              exact terminal state. round-131: the refit effect skips while
              hidden — fire a resize when un-hiding so the grid (local xterm +
              backend cols/rows) refits to the now-visible size. */}
          <div id="term-container" style={browserActive ? { display: "none" } : (trajOpen ? { display: "none" } : undefined)}>
            {browserActive && pwRunning ? (
              <BrowserPane key={BROWSER_SID} session={{ sid: BROWSER_SID, url: "", active: true }} apiBase="" token={token} />
            ) : sessions.sessions.length === 0 ? (
              <div id="empty-state">
                <div className="empty-card">
                  <span className="empty-mark">V</span>
                  <p>No sessions yet</p>
                </div>
              </div>
            ) : (
              // round-113: closed sessions do NOT render a pane — the R99
              // unregister fix was dead code because closed panes never
              // unmounted, leaving their write callbacks in the 5s sync loop's
              // polling set forever. Unmounting releases the callback.
              sessions.sessions.filter((s) => !s.closed).map((s) =>
                s.kind === "browser"
                  ? <BrowserPane key={s.sid} session={{ sid: s.sid, url: "", active: s.active }} apiBase="" token={token} />
                  : <TerminalPane key={s.sid} session={s} registerWrite={registerWrite} />
              )
            )}
          </div>
          {/* round-admin-ui Task 4/5: command card stream for the ACTIVE
              session below the terminal; the trajectory tab replaces both.
              Clicking a card opens the details column. */}
          {trajOpen && sessions.activeSid ? (
            <TrajectoryView key={sessions.activeSid} events={cmdEvents.events} />
          ) : (
            <CommandStream
              cards={cmdEvents.cards}
              selectedId={selectedCmdId}
              // Clicking the selected card again closes the details column.
              onSelect={(id) => {
                if (id === selectedCmdId) { setSelectedCmdId(null); setDetailsOpen(false); }
                else { setSelectedCmdId(id); setDetailsOpen(true); }
              }}
            />
          )}
          <StatusBar sessions={sessions.sessions} status={sessions.status} sseState={sseState} />
        </div>
        {view === "plugins" && <PluginsView plugins={plugins} />}
        </>
      )}
      details={<DetailsPanel card={selectedCard} onClose={() => setDetailsOpen(false)} />}
      detailsOpen={detailsOpen}
    />
  );
}
