// hooks/useBrowser.ts — the ONE frontend seam to the remote-browser protocol
// (Playwright containment: the UI never talks to playwright directly; it only
// consumes these HTTP/WS endpoints, which are agent-side contracts).
//
// Extracted VERBATIM from the pre-refactor BrowserPane (round-159 semantics):
//   POST /api/browser/ws-ticket (Bearer, single-use 30s TTL) → WS to
//   /api/browser/ws?ticket=… ; binary frames = JPEG screencast; text frames =
//   correlated query responses (incrementing id). Reconnect = capped
//   exponential backoff; Evidence = 3s poll of /api/browser/pwshots +
//   /api/browser/pwshot?name=…
//
// See docs/superpowers/specs/2026-08-28-vale-desktop-core-design.md §5.
import { useCallback, useEffect, useRef, useState } from "react";

export interface TabInfo { i: number; url: string }
export interface Shot { name: string; mtime_ms: number }
export type BrowserView = "live" | "evidence";
export interface BrowserSessionData {
  sid: string;
  url: string;
  active: boolean;
}

export const VIEW_W = 1280;
export const VIEW_H = 800;
const MAX_WS_BACKOFF_MS = 8000;
const POLL_MS = 3000;

interface UseBrowserOpts {
  apiBase: string; // "" (same-origin) or gateway proxy base
  token: string;
}

export function useBrowser({ apiBase, token }: UseBrowserOpts) {
  const [view, setView] = useState<BrowserView>("live");
  const [url, setUrl] = useState("https://www.wikipedia.org");
  const [error, setError] = useState("");
  const [fps, setFps] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [sel, setSel] = useState(0);
  // Browserless-style controls: viewport zoom (% of frame width) and the
  // locally-remembered URL history (native datalist dropdown).
  const [zoom, setZoom] = useState(100);
  const [urlHistory, setUrlHistory] = useState<string[]>(() => {
    try {
      const h = JSON.parse(localStorage.getItem("valeUrlHistory") || "[]");
      return Array.isArray(h) ? h : [];
    } catch { return []; }
  });

  // Evidence state
  const [shots, setShots] = useState<Shot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [shotUrls, setShotUrls] = useState<Record<string, string>>({});

  const imgRef = useRef<HTMLImageElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const aliveRef = useRef(true);
  const pendingRef = useRef(new Map<number, (v: any) => void>());
  const nextIdRef = useRef(1);
  const counters = useRef({ n: 0, t: 0 });
  const hasFrameRef = useRef(false);
  const viewRef = useRef<BrowserView>("live");
  viewRef.current = view;
  const seenLoaded = useRef<Set<string>>(new Set());

  // AI-activity signal (Browserless "watching sessions" pattern): the AI's
  // browser_run_script drops screenshots into pwout — a fresh mtime means
  // the AI drove (or is driving) the browser. Derived at render time.
  const aiActive = shots.some((s) => Date.now() - s.mtime_ms < 90000);

  const applyFrame = useCallback((blob: Blob | ArrayBuffer) => {
    const img = imgRef.current;
    if (!img || document.hidden || viewRef.current !== "live") return; // hidden/evidence: skip decode work
    const part = blob instanceof Blob ? blob : new Blob([blob], { type: "image/jpeg" });
    const old = img.src;
    img.src = URL.createObjectURL(part);
    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
    setError("");
    // round-fix: focus the frame ONCE on the first frame (keyboard goes
    // straight to the remote browser), but NEVER on later frames — the old
    // onLoad={() => img.focus()} re-fired on EVERY frame and stole focus
    // from the URL bar mid-typing (a >1s pause in the address bar dropped
    // all further keystrokes into the remote page). The user takes focus
    // back by clicking the frame.
    if (!hasFrameRef.current) {
      hasFrameRef.current = true;
      setHasFrame(true);
      img.focus();
    }
    const c = counters.current; c.n++;
    const now = Date.now();
    if (now - c.t >= 1000) { setFps(Math.round((c.n * 1000) / (now - c.t))); c.n = 0; c.t = now; }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    let disposed = false;
    let attempts = 0;
    let reconnectTimer: number | undefined;

    const connectWs = () => {
      if (disposed) return;
      attempts++;
      // Show the reconnect state only from the second failure so the happy
      // path never flashes a warning.
      if (attempts > 1) setError("Live channel reconnecting…");
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
                // round-163: unsolicited bridge pushes — the tab list arrives
                // when it CHANGES (open/close/select/navigate), replacing the
                // 1.5s tabs poll.
                if (o.ev === "tabs" && Array.isArray(o.tabs)) {
                  setTabs(o.tabs);
                  setSel(typeof o.sel === "number" ? o.sel : 0);
                  return;
                }
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
    // round-163: no tabs timer — the bridge pushes the tab list on every
    // change; ws.onopen still fetches the initial snapshot.

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

  const newTab = useCallback(() => { send({ t: "tabnew", url: "about:blank" }); }, [send]);
  const selTab = useCallback((i: number) => { send({ t: "tabsel", i }); }, [send]);
  const closeTab = useCallback((i: number) => { send({ t: "tabclose", i }); }, [send]);

  const mapXY = useCallback((el: HTMLElement, clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(((clientX - r.left) / r.width) * VIEW_W),
      y: Math.round(((clientY - r.top) / r.height) * VIEW_H),
    };
  }, []);

  const navigate = useCallback(() => {
    const u = url.startsWith("http") ? url : `https://${url}`;
    setUrl(u);
    send({ t: "nav", url: u });
    // Remember the URL locally (dedup, newest first, cap 20).
    setUrlHistory((prev) => {
      const next = [u, ...prev.filter((x) => x !== u)].slice(0, 20);
      try { localStorage.setItem("valeUrlHistory", JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, [url, send]);

  const auth = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  // ---- Evidence + AI-activity polling (round-154, extended round-160) ----
  // Runs in BOTH views: the evidence timeline needs the shots, and the live
  // view derives the "AI is operating" indicator from the newest mtime.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${apiBase}/api/browser/pwshots`, { headers: auth() });
        if (!r.ok) return;
        const data = await r.json();
        if (!alive || !Array.isArray(data.shots)) return;
        const list: Shot[] = data.shots;
        setShots(list);
        if (viewRef.current === "evidence") {
          setSelected((cur) => cur && list.some((s) => s.name === cur) ? cur : (list[0]?.name ?? null));
        }
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
  }, [apiBase, auth]);

  return {
    view, setView,
    url, setUrl, navigate, urlHistory,
    zoom, setZoom,
    error, fps, tabs, sel,
    newTab, selTab, closeTab,
    imgRef, mapXY, send,
    shots, selected, setSelected, shotUrls,
    aiActive, hasFrame,
  };
}
