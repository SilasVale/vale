import { useEffect, useMemo, useRef, useState } from "react";
import { initTransport } from "./lib/api";
import { useSessions } from "./hooks/useSessions";
import { useCommandEvents } from "./hooks/useCommandEvents";
import { useSSE } from "./hooks/useSSE";
import { AppFrame } from "./components/AppFrame";
import { IconRail } from "./components/IconRail";
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
import { StatusBar } from "./components/StatusBar";
import { ConnModal } from "./components/ConnModal";
import { SettingsModal } from "./components/SettingsModal";

const LS_HOST = "valeHost";
const LS_TOKEN = "valeToken";

/** Resolved bootstrap values shared by every App state initializer. */
interface Boot {
  host: string;
  tok: string;
  connected: boolean;
}

// round-139 FIX: ONE bootstrap pass feeds host/token/connected alike. The old
// code resolved token precedence (injected > URL ?token= > stored) inside the
// `connected` initializer and gave it ONLY to initTransport — React's `token`
// state stayed "" whenever localStorage was empty at first paint. Terminal/
// SSE kept working (transport had the real token) but BrowserPane builds its
// own Bearer from the `token` PROP, so a first visit via ?token= (fresh
// browser, or console-proxy visits which delete valeToken per round-122/124)
// 401'd every /api/browser/* call: blank viewport, 0fps, no tabs, red
// auth failed — fixed by one manual reload. Now the same resolved value seeds
// both the transport and React state.
function computeBoot(onAuthFail: () => void): Boot {
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
    if (!tok && !isProxy) return { host, tok: stored, connected: false };
    initTransport(host, tok || " ", onAuthFail);
    if (urlToken) { try { history.replaceState(null, "", location.pathname); } catch {} }
    return { host, tok, connected: true };
  }
  const h = localStorage.getItem(LS_HOST);
  const t = localStorage.getItem(LS_TOKEN);
  if (h && t) initTransport(h, t, onAuthFail);
  return { host: h || "", tok: t || "", connected: !!(h && t) };
}

export function App() {
  const authFailed = useRef(false);
  const boot = useMemo(() => computeBoot(() => { authFailed.current = true; }), []);
  const [host, setHost] = useState(boot.host);
  const [token, setToken] = useState(boot.tok);
  const [connError, setConnError] = useState("");
  const [connected, setConnected] = useState(boot.connected);
  // round-88: a stored token that expires/rotates 401'd into a noop — the
  // panel stayed 'connected' with everything dead and the conn form
  // unreachable. The 401 callback sets this flag; a render effect drops the
  // session back to the conn form.
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
  // round-133: status polling is now always-on — the Browser session row in
  // the Sessions view depends on it.
  const plugins = usePlugins(connected);
  const BROWSER_SID = "__browser__";

  const sessions = useSessions(connected);

  // round-157: when the panel opens with no active session, auto-activate the
  // first live session — otherwise every .term-session stays display:none
  // and the terminal area is blank (users repeatedly reported "not covering
  // / blank"). Skipped while browserActive (Browser view takes priority).
  useEffect(() => {
    if (browserActive || sessions.activeSid) return;
    const live = sessions.sessions.find((s) => !s.closed);
    if (live) sessions.activate(live.sid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.sessions, sessions.activeSid, browserActive]);

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

  // round-133: inject a Browser session row while a playwright-mcp hosted
  // instance is running — clicking it opens the live preview (BrowserPane).
  // Activation is managed by browserActive, mutually exclusive with terminal
  // sessions (the main area shows only one panel at a time).
  const allSessions = useMemo(() => {
    const base = sessions.sessions.map((s) => ({ ...s, active: false }));
    return [...base, { sid: BROWSER_SID, label: "Browser", kind: "browser", closed: false, savedOnly: false, active: browserActive, openedAt: Date.now(), closedAt: null }] as typeof sessions.sessions;
  }, [sessions.sessions, browserActive]);

  const effectiveActiveSid = browserActive ? BROWSER_SID : sessions.activeSid;

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

  // round-147: dsh-style app shell — icon rail | session rail | full canvas.
  // The command stream moved OUT of the canvas into the right drawer, so the
  // terminal/browser panes own 100% of the remaining space. The details
  // column (selected command) rides inside the same drawer. Light theme.
  return (
    <AppFrame
      iconRail={
        <IconRail
          view={view}
          onViewChange={switchView}
          onShowSettings={() => setShowSettings(true)}
          connected={connected}
        />
      }
      sessionRail={
        <>
          <Sidebar
            sessions={allSessions as typeof sessions.sessions}
            activeSid={effectiveActiveSid}
            onActivate={activateWrap}
            view={view}
            onViewChange={switchView}
            onNewSession={newSessionWrap}
            plugins={plugins}
          />
          <StatusBar sessions={sessions.sessions} status={sessions.status} sseState={sseState} />
        </>
      }
      canvas={(
        <>
        {/* round-admin-ui Task 6: the session workspace is HIDDEN, not
            unmounted, while the plugins page is up — xterm instances and
            SSE streams keep running, so switching back restores the exact
            terminal state. */}
        <div id="panel-main" className={view === "plugins" ? "hidden" : undefined}>
          {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
          {modalKind && (
            <ConnModal
              kind={modalKind}
              onClose={() => setModalKind(null)}
              onConnect={(target, extra) => sessions.openSession(modalKind, target, extra)}
            />
          )}
          {/* round-147: one compact canvas header row — session chips, view
              switch, export/settings/commands. Nothing stacks below it. */}
          <div id="canvas-top">
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
            {/* round-148: slimmed down — Export/Settings removed from the
                 canvas header (Settings is in the icon rail; per-session
                 export is on the session chip's ⇩); the header keeps only
                 session chips + view switch + Logs. */}
            <button
              id="cmd-toggle"
              className={detailsOpen ? "active" : ""}
              title="Command log"
              onClick={() => {
                if (detailsOpen) { setDetailsOpen(false); setSelectedCmdId(null); }
                else setDetailsOpen(true);
              }}
            >Logs</button>
          </div>
          {/* round-admin-ui Task 5: trajectory mode hides the terminal
              CONTAINER (inline display:none), not the panes — xterm instances
              stay mounted and keep streaming, so switching back restores the
              exact terminal state. round-131: the refit effect skips while
              hidden — fire a resize when un-hiding so the grid (local xterm +
              backend cols/rows) refits to the now-visible size. */}
          {/* round-138 FIX: never hide #term-container while browserActive —
              BrowserPane is rendered inside it; the old condition set it to
              display:none, making the browser session permanently invisible
              (WS/frames all fine — pure CSS accident). Only the trajectory
              hiding path remains. */}
          {trajOpen && sessions.activeSid ? (
            <TrajectoryView key={sessions.activeSid} events={cmdEvents.events} />
          ) : (
            <div id="term-container" style={!browserActive ? undefined : undefined}>
              {/* round-145: BrowserPane is mounted from PAGE LOAD (always, not
                  lazily) and hidden via display:none when inactive — its socket
                  stays open and frames keep arriving, so clicking the Browser
                  tab is ALWAYS instant with the latest frame already on screen
                  (no black re-mount window, not even the first click). The
                  terminal branch renders whenever the browser pane is NOT
                  active — both panes coexist while hidden. */}
              <div className="browser-wrap" style={{ display: browserActive ? undefined : "none" }}>
                <BrowserPane key={BROWSER_SID} session={{ sid: BROWSER_SID, url: "", active: true }} apiBase="" token={token} />
              </div>
              {!browserActive && (sessions.sessions.length === 0 ? (
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
              ))}
            </div>
          )}
        </div>
        {view === "plugins" && <PluginsView plugins={plugins} />}
        </>
      )}
      drawer={detailsOpen ? (
        <div id="drawer-inner">
          <div id="drawer-head">
            <span>Commands</span>
            <button title="Close" onClick={() => { setDetailsOpen(false); setSelectedCmdId(null); }}>✕</button>
          </div>
          <DetailsPanel card={selectedCard} onClose={() => setSelectedCmdId(null)} />
          <CommandStream
            cards={cmdEvents.cards}
            selectedId={selectedCmdId}
            // Clicking the selected card again closes the detail view.
            onSelect={(id) => {
              if (id === selectedCmdId) { setSelectedCmdId(null); }
              else { setSelectedCmdId(id); }
            }}
          />
        </div>
      ) : null}
    />
  );
}
