/**
 * BrowserPane — LIVE interactive remote browser, dual view (round-159).
 *
 * Live view (default): ONE WebSocket to /api/browser/ws (ticket-authenticated
 * via POST /api/browser/ws-ticket). Binary frames = JPEG screencast pushed by
 * bridge.js (127.0.0.1:9224 — playwright-core + CDP screencast at up to 15fps,
 * change-driven with an idle-frame fallback). Input events (mouse/keyboard/
 * wheel/tabs/nav) ride the same socket, queries correlated by an incrementing
 * id echoed in a text frame. Reconnect: capped exponential backoff, visible
 * "reconnecting" state; the legacy HTTP-polling fallback stays removed
 * (round-141: polling felt bad — desktop/localhost is fast, WS is the path).
 *
 * Evidence view: AI screenshot evidence stream (round-154) — screenshots the
 * AI drops into <install>/pwout via browser_run_script / playwright scripts
 * auto-sync every 3s: latest large + thumbnail timeline. Consistent with
 * Claude/Codex step-screenshot display.
 *
 * Security: the long-lived device token never appears in a URL. The ticket is
 * fetched via Bearer-authed POST, single-use, 30s TTL.
 *
 * Coordinates map from displayed CSS px to the bridge viewport (1280x800).
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface BrowserSessionData {
  sid: string;
  url: string;
  active: boolean;
}

interface Props {
  session: BrowserSessionData;
  apiBase: string; // "" (same-origin) or gateway proxy base
  token: string;
}

const VIEW_W = 1280;
const VIEW_H = 800;
const TABS_MS = 1500;
const MAX_WS_BACKOFF_MS = 8000;
const POLL_MS = 3000;

type View = "live" | "evidence";

interface TabInfo { i: number; url: string }

interface Shot {
  name: string;
  mtime_ms: number;
}

export default function BrowserPane({ apiBase, token }: Props) {
  const [view, setView] = useState<View>("live");
  const [url, setUrl] = useState("https://www.wikipedia.org");
  const [error, setError] = useState("");
  const [fps, setFps] = useState(0);
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [sel, setSel] = useState(0);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const aliveRef = useRef(true);
  const pendingRef = useRef(new Map<number, (v: any) => void>());
  const nextIdRef = useRef(1);
  const counters = useRef({ n: 0, t: 0 });
  const viewRef = useRef<View>("live");
  viewRef.current = view;

  const applyFrame = useCallback((blob: Blob | ArrayBuffer) => {
    const img = imgRef.current;
    if (!img || document.hidden || viewRef.current !== "live") return; // hidden/evidence: skip decode work
    const part = blob instanceof Blob ? blob : new Blob([blob], { type: "image/jpeg" });
    const old = img.src;
    img.src = URL.createObjectURL(part);
    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
    setError("");
    const c = counters.current; c.n++;
    const now = Date.now();
    if (now - c.t >= 1000) { setFps(Math.round((c.n * 1000) / (now - c.t))); c.n = 0; c.t = now; }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    let disposed = false;
    let attempts = 0;
    let reconnectTimer: number | undefined;
    let tabsTimer: number | undefined;

    const connectWs = () => {
      if (disposed) return;
      attempts++;
      // Show the reconnect state only from the second failure so the happy
      // path never flashes a warning.
      if (attempts > 1) setError("实时通道重连中…");
      fetch(`${apiBase}/api/browser/ws-ticket`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(({ ticket }) => {
          if (disposed) return;
          if (!ticket) throw new Error("no ticket");
          const proto = location.protocol === "https:" ? "wss:" : "ws:";
          const ws = new WebSocket(
            `${proto}//${location.host}${apiBase}/api/browser/ws?ticket=${encodeURIComponent(ticket)}`,
          );
          ws.binaryType = "blob";
          ws.onopen = () => {
            attempts = 0;
            setError("");
            void refreshTabs();
          };
          ws.onmessage = (m) => {
            if (typeof m.data === "string") {
              try {
                const o = JSON.parse(m.data);
                if (typeof o.id !== "undefined") {
                  const cb = pendingRef.current.get(o.id);
                  if (cb) { pendingRef.current.delete(o.id); cb(o); }
                }
              } catch { /* non-JSON text frame */ }
              return;
            }
            applyFrame(m.data as Blob);
          };
          ws.onclose = () => {
            wsRef.current = null;
            if (disposed) return;
            scheduleReconnect();
          };
          ws.onerror = () => { /* onclose follows */ };
          wsRef.current = ws;
        })
        .catch(() => {
          if (disposed) return;
          scheduleReconnect();
        });
    };

    const scheduleReconnect = () => {
      const delay = Math.min(500 * 2 ** attempts, MAX_WS_BACKOFF_MS);
      reconnectTimer = window.setTimeout(connectWs, delay);
    };

    // Request WITH correlated response over the socket. No HTTP fallback —
    // when the socket is down the query simply times out into {}.
    const requestNow = (ev: Record<string, unknown>): Promise<any> => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        return new Promise((resolve) => {
          const id = nextIdRef.current++;
          pendingRef.current.set(id, resolve);
          try { ws.send(JSON.stringify({ ...ev, id })); } catch { pendingRef.current.delete(id); resolve({}); }
          window.setTimeout(() => { if (pendingRef.current.delete(id)) resolve({}); }, 2000);
        });
      }
      return Promise.resolve({});
    };

    const refreshTabs = async () => {
      const r = await requestNow({ t: "tabs" });
      if (Array.isArray(r.tabs)) { setTabs(r.tabs); setSel(r.sel ?? 0); }
    };

    connectWs();
    tabsTimer = window.setInterval(refreshTabs, TABS_MS);

    // Hidden tab: drop the socket entirely so the device stops capturing for
    // nobody; visible again → reconnect fresh.
    const onVisibility = () => {
      if (document.hidden) {
        try { wsRef.current?.close(); } catch {}
        wsRef.current = null;
      } else if (!wsRef.current && !disposed) {
        attempts = 0;
        connectWs();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      aliveRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (tabsTimer) window.clearInterval(tabsTimer);
      pendingRef.current.forEach((resolve) => resolve({}));
      pendingRef.current.clear();
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, token]);

  const send = useCallback((ev: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(ev)); return; }
    // Socket down: drop the event (the reconnect loop is already running).
    // No HTTP fallback per round-141 — no more polling.
  }, []);

  const newTab = async () => { send({ t: "tabnew", url: "about:blank" }); };
  const selTab = async (i: number) => { send({ t: "tabsel", i }); };
  const closeTab = async (i: number) => { send({ t: "tabclose", i }); };

  const mapXY = (e: React.MouseEvent): { x: number; y: number } => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * VIEW_W),
      y: Math.round(((e.clientY - r.top) / r.height) * VIEW_H),
    };
  };

  const onMouse = (k: "move" | "down" | "up") => (e: React.MouseEvent) => {
    const { x, y } = mapXY(e);
    send({ t: "m", x, y, k });
  };

  const onWheel = (e: React.WheelEvent) => {
    const { x, y } = mapXY(e as unknown as React.MouseEvent);
    send({ t: "wheel", x, y, dx: e.deltaX, dy: e.deltaY });
    e.preventDefault();
  };

  const onKey = (down: boolean) => (e: React.KeyboardEvent) => {
    e.preventDefault();
    const printable = down && e.key.length === 1;
    send({
      t: "k", down,
      key: e.key, code: e.code, vk: e.keyCode,
      text: printable ? e.key : undefined,
    });
  };

  const navigate = () => {
    const u = url.startsWith("http") ? url : `https://${url}`;
    setUrl(u);
    send({ t: "nav", url: u });
  };

  // ---- Evidence view (AI screenshot stream, round-154) ----
  const [shots, setShots] = useState<Shot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [shotUrls, setShotUrls] = useState<Record<string, string>>({});
  const seenLoaded = useRef<Set<string>>(new Set());

  const auth = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  useEffect(() => {
    if (view !== "evidence") return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${apiBase}/api/browser/pwshots`, { headers: auth() });
        if (!r.ok) return;
        const data = await r.json();
        if (!alive || !Array.isArray(data.shots)) return;
        const list: Shot[] = data.shots;
        setShots(list);
        setSelected((cur) => cur && list.some((s) => s.name === cur) ? cur : (list[0]?.name ?? null));
        const missing = list.filter((s) => !seenLoaded.current.has(s.name));
        for (const shot of missing) {
          fetch(`${apiBase}/api/browser/pwshot?name=${encodeURIComponent(shot.name)}`, { headers: auth() })
            .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
            .then((blob) => {
              if (!alive) return;
              seenLoaded.current.add(shot.name);
              setShotUrls((prev) => ({ ...prev, [shot.name]: URL.createObjectURL(blob) }));
            })
            .catch(() => {});
        }
        setShotUrls((prev) => {
          const next = { ...prev };
          const keep = new Set(list.map((s) => s.name));
          for (const k of Object.keys(next)) {
            if (!keep.has(k)) { URL.revokeObjectURL(next[k]); delete next[k]; }
          }
          return next;
        });
      } catch { /* transient */ }
    };
    void tick();
    const t = window.setInterval(tick, POLL_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, [apiBase, auth, view]);

  return (
    <div className="browser-pane">
      {/* View switch: Live ↔ Evidence */}
      <div className="browser-view-switch" role="tablist" aria-label="Browser view">
        <button
          type="button"
          className={`view-switch-btn${view === "live" ? " active" : ""}`}
          onClick={() => setView("live")}
        >Live</button>
        <button
          type="button"
          className={`view-switch-btn${view === "evidence" ? " active" : ""}`}
          onClick={() => setView("evidence")}
        >Evidence</button>
      </div>

      {view === "live" ? (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 0 }}>
          {/* Tab strip */}
          <div style={{ display: "flex", gap: 4, padding: "4px 8px", background: "#eef0f3", borderBottom: "1px solid #dee2e6", overflowX: "auto" }}>
            {tabs.map((tb) => (
              <span key={tb.i} onClick={() => selTab(tb.i)}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, maxWidth: 180, padding: "3px 8px", borderRadius: 6,
                  background: tb.i === sel ? "#fff" : "transparent", border: `1px solid ${tb.i === sel ? "#c9ced6" : "transparent"}`,
                  fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden" }}
                title={tb.url}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{tb.url.replace(/^https?:\/\//, "") || "空白页"}</span>
                <span onClick={(e) => { e.stopPropagation(); void closeTab(tb.i); }} style={{ color: "#98a2b3", cursor: "pointer" }}>×</span>
              </span>
            ))}
            <span onClick={() => newTab()} title="New tab"
              style={{ padding: "3px 8px", borderRadius: 6, fontSize: 12, cursor: "pointer", border: "1px dashed #c9ced6" }}>+</span>
          </div>

          {/* URL bar */}
          <div style={{ display: "flex", gap: 6, padding: "6px 10px", background: "#f8f9fa", borderBottom: "1px solid #dee2e6" }}>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && navigate()}
              placeholder="Enter URL and press Go — the page below is live and clickable"
              style={{ flex: 1, padding: "5px 8px", border: "1px solid #ced4da", borderRadius: 6, fontSize: 12 }}
            />
            <button onClick={navigate} style={{ padding: "4px 10px", cursor: "pointer" }}>Go</button>
            <span title="frames per second" style={{ alignSelf: "center", fontSize: 11, color: "#6b7280", minWidth: 34, textAlign: "right" }}>{fps}fps</span>
          </div>

          {/* Live viewport */}
          <div style={{ flex: 1, overflow: "auto", background: "#1a1b1e", position: "relative" }}>
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
            <img
              ref={imgRef}
              alt="Remote browser"
              tabIndex={0}
              onMouseMove={onMouse("move")}
              onMouseDown={onMouse("down")}
              onMouseUp={onMouse("up")}
              onWheel={onWheel}
              onKeyDown={onKey(true)}
              onKeyUp={onKey(false)}
              style={{ width: "100%", display: "block", cursor: "text", outline: "none" }}
              onError={() => setError("frame unreachable")}
              onLoad={() => { setError(""); imgRef.current?.focus(); }}
            />
          </div>

          {error && <div style={{ color: "#dc2626", fontSize: 11, padding: "4px 8px" }}>{error}</div>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <div style={{ flex: 1, minHeight: 0, background: "#1a1b1e", position: "relative", overflow: "hidden" }}>
            {selected && shotUrls[selected] ? (
              <img
                src={shotUrls[selected]}
                alt="AI browser evidence"
                style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
              />
            ) : (
              <div style={{ display: "grid", placeItems: "center", height: "100%", color: "#98a2b3", fontSize: 12, padding: 20, textAlign: "center" }}>
                还没有截图 — AI 通过 browser_run_script 工作时自动出现在这里
              </div>
            )}
          </div>

          {/* Evidence timeline */}
          <div style={{ flex: "0 0 auto", borderTop: "1px solid #dee2e6", background: "#fff", padding: "6px 8px" }}>
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>
              AI 截图证据（{shots.length}）— pwout 目录自动同步，每 3s 刷新
            </div>
            {shots.length === 0 ? (
              <div style={{ fontSize: 11, color: "#98a2b3", padding: "4px 0" }}>暂无截图</div>
            ) : (
              <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
                {shots.map((s) => (
                  <div
                    key={s.name}
                    title={`${s.name} · ${new Date(s.mtime_ms).toLocaleTimeString()}`}
                    onClick={() => setSelected(s.name)}
                    style={{
                      flex: "0 0 auto", cursor: "pointer", borderRadius: 6, overflow: "hidden",
                      border: selected === s.name ? "2px solid var(--accent, #d9480f)" : "2px solid #e9ebee",
                      position: "relative",
                    }}
                  >
                    {shotUrls[s.name] ? (
                      <img
                        src={shotUrls[s.name]}
                        alt={s.name}
                        style={{ width: 96, height: 60, objectFit: "cover", display: "block" }}
                        loading="lazy"
                      />
                    ) : (
                      <div style={{ width: 96, height: 60, background: "#eef0f3", display: "grid", placeItems: "center", fontSize: 10, color: "#98a2b3" }}>加载中…</div>
                    )}
                    <span style={{ position: "absolute", left: 3, bottom: 2, fontSize: 9, color: "#fff", background: "rgba(0,0,0,.5)", borderRadius: 3, padding: "0 3px" }}>
                      {new Date(s.mtime_ms).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
