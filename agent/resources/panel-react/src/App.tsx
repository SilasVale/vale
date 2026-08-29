import { useEffect, useMemo, useRef, useState } from "react";
import { initTransport } from "./lib/api";
import { computeBoot } from "./lib/boot";
import { useSessions } from "./hooks/useSessions";
import { useCommandEvents } from "./hooks/useCommandEvents";
import { useSSE } from "./hooks/useSSE";
import { usePlugins } from "./hooks/usePlugins";
import { PanelApp } from "./components/PanelApp";
import { DesktopShell } from "./components/DesktopShell";
import { BrandMark } from "./ui/Icon";
import type { SessionView } from "./components/TabBar";

// App — the slim root: connection bootstrap + shell selection (panel vs
// desktop density) + shared domain hooks. All page-local state lives in the
// page components (TerminalWorkspace etc.), per the core design doc
// (docs/superpowers/specs/2026-08-28-vale-desktop-core-design.md).

const LS_HOST = "valeHost";
const LS_TOKEN = "valeToken";

function isDesktopPath() {
  return location.pathname.startsWith("/desktop");
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
  const [browserActive, setBrowserActive] = useState(false);
  const BROWSER_SID = "__browser__";
  const plugins = usePlugins(connected);
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

  // Per-session main-area view (terminal | trajectory) — keyed per sid.
  // State lives here (App) so both shells share the same view per session.
  const [sessionViews, setSessionViews] = useState<Record<string, SessionView>>({});
  const changeView = (sid: string, v: SessionView) => {
    setSessionViews((m) => ({ ...m, [sid]: v }));
  };

  // round-132/133: refit the xterm when the terminal un-hides — the refit
  // effect skips while display:none, so a window resize while in another
  // view leaves a stale grid on switch-back. The dispatch must run
  // POST-commit (the R131 render-body version fired while still hidden).
  const termVisible = !browserActive && !(sessions.activeSid && sessionViews[sessions.activeSid] === "trajectory");
  const prevTermVisible = useRef(termVisible);
  useEffect(() => {
    if (!prevTermVisible.current && termVisible) {
      window.dispatchEvent(new Event("resize"));
    }
    prevTermVisible.current = termVisible;
  }, [termVisible]);

  // round-133: inject a Browser session row while a playwright-mcp hosted
  // instance is running — clicking it opens the live preview (BrowserPane).
  // Activation is managed by browserActive, mutually exclusive with terminal
  // sessions (the main area shows only one panel at a time).
  const allSessions = useMemo(() => {
    // round-161: PRESERVE each session's active flag — the old map wiped it
    // to false, so every TerminalPane stayed display:none (blank pane).
    const base = sessions.sessions.map((s) => ({ ...s }));
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
  // audit log; the cards/events are shared by the Logs drawer + trajectory.
  const cmdEvents = useCommandEvents(connected && sessions.activeSid ? sessions.activeSid : null);
  // Switching sessions resets the details column — handled inside
  // TerminalWorkspace via selectedCmdId keyed to the session.

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
        <div className="conn-brand"><BrandMark size={44} /></div>
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

  const shared = {
    sessions: allSessions as typeof sessions.sessions,
    activeSid: effectiveActiveSid,
    onActivate: activateWrap,
    onClose: (sid: string) => {
      if (sid === BROWSER_SID) { setBrowserActive(false); return; }
      sessions.closeSession(sid);
    },
    onExport: sessions.exportSession,
    onViewChange: changeView,
    registerWrite,
    browserActive,
    token,
    cmdEvents: { cards: cmdEvents.cards, events: cmdEvents.events },
  };

  if (isDesktopPath()) {
    return (
      <DesktopShell
        {...shared}
        onNewSession={(kind, target, extra) => { setBrowserActive(false); if (kind === "pty") sessions.openSession("pty", target ?? "").catch(() => {}); else setModalKind(kind); }}
        sseState={sseState}
        plugins={plugins}
      />
    );
  }

  return (
    <PanelApp
      {...shared}
      onNewSession={(kind) => newSessionWrap(kind)}
      onOpenConn={(kind) => setModalKind(kind)}
      status={sessions.status}
      sseState={sseState}
      plugins={plugins}
      connModal={modalKind}
      onConnClose={() => setModalKind(null)}
      onConnConnect={(kind, target, extra) => sessions.openSession(kind, target, extra)}
    />
  );
}
