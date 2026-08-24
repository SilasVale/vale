/**
 * BrowserPane — LIVE interactive remote browser (round-135 M1, round-137 方案 C).
 *
 * Primary path: one WebSocket to /api/browser/ws (ticket-authenticated).
 * Binary frames = JPEG screenshots pushed by bridge.js (screencast + idle
 * capture); input events and tab queries ride the same socket, queries
 * correlated by an incrementing id echoed in a text frame.
 *
 * Degraded path: after repeated WS failures the pane falls back to legacy
 * HTTP polling (/api/browser/frame + /api/browser/input) so a tunnel that
 * mangles upgrades degrades to "slow" instead of "broken".
 *
 * Security: the long-lived device token never appears in a URL. The ticket
 * is fetched via Bearer-authed POST and is single-use/30s; the old
 * `&t=<token>` query parameter is gone.
 *
 * Coordinates are mapped from displayed CSS px to the bridge viewport
 * (1280x800).
 */
import { useState, useEffect, useRef, useCallback } from "react";

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
const POLL_FRAME_MS = 250; // degraded-mode frame rate (~4fps)
const MAX_WS_ATTEMPTS = 5; // before falling back to HTTP polling

interface TabInfo { i: number; url: string }

function httpInputUrl(apiBase: string, ev: unknown): string {
  const d = encodeURIComponent(JSON.stringify(ev));
  return `${apiBase}/api/browser/input?d=${d}`;
}

export default function BrowserPane({ apiBase, token }: Props) {
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

  const applyFrame = useCallback((blob: Blob | ArrayBuffer) => {
    const img = imgRef.current;
    if (!img || document.hidden) return; // hidden tab: skip decode work
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
    let mode: "ws" | "polling" = "ws";
    let attempts = 0;
    let reconnectTimer: number | undefined;
    let pollTimer: number | undefined;
    let tabsTimer: number | undefined;

    const httpFetchJson = async (ev: unknown): Promise<any> => {
      try {
        return await (await fetch(httpInputUrl(apiBase, ev), { headers: { Authorization: `Bearer ${token}` } })).json();
      } catch { return {}; }
    };

    const startPollingFallback = () => {
      if (mode === "polling" || disposed) return;
      mode = "polling";
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
      const tick = () => {
        if (!aliveRef.current || !imgRef.current || document.hidden) return;
        fetch(`${apiBase}/api/browser/frame`, { headers: { Authorization: `Bearer ${token}` } })
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
          .then((b) => { if (!disposed && !document.hidden) applyFrame(b); })
          .catch((e) => setError(e.message === "401" ? "认证失败" : e.message));
      };
      tick();
      pollTimer = window.setInterval(tick, POLL_FRAME_MS);
    };

    const connectWs = () => {
      if (disposed || mode !== "ws") return;
      attempts++;
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
            if (disposed || mode !== "ws") return;
            scheduleReconnect();
          };
          ws.onerror = () => { /* onclose follows */ };
          wsRef.current = ws;
        })
        .catch(() => {
          if (disposed || mode !== "ws") return;
          scheduleReconnect();
        });
    };

    const scheduleReconnect = () => {
      if (attempts > MAX_WS_ATTEMPTS) {
        setError("实时通道不可用 — 已切换轮询模式");
        startPollingFallback();
        return;
      }
      const delay = Math.min(500 * 2 ** attempts, 8000);
      reconnectTimer = window.setTimeout(connectWs, delay);
    };

    // Request WITH correlated response. Socket first; HTTP GET as fallback
    // (the bridge answers GET /input with handleInput's return value).
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
      return httpFetchJson(ev);
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
      } else if (mode === "ws" && !wsRef.current && !disposed) {
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
      if (pollTimer) window.clearInterval(pollTimer);
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
    void fetch(httpInputUrl(apiBase, ev), { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }, [apiBase, token]);

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

  return (
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
  );
}
