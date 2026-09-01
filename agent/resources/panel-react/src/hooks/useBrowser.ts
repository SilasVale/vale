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

export interface TabInfo { i: number; url: string; title?: string }
export interface Shot { name: string; mtime_ms: number }
/** P2: one AI action = one browser_run_script execution (agent-written JSONL). */
export interface BrowserAction {
  ts: number;
  duration_ms?: number;
  exit_code?: number | null;
  timed_out?: boolean;
  script?: string;
  screenshots?: string[];
  stdout_tail?: string;
  stderr_tail?: string;
}
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
  // stage-n: navigation-history availability (bridge reports it in the
  // tabs push) — drives the disabled state of the back/forward buttons.
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
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
  // P2: AI-action timeline (polled with the evidence feed)
  const [actions, setActions] = useState<BrowserAction[]>([]);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
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
                  const sel = typeof o.sel === "number" ? o.sel : 0;
                  setTabs(o.tabs);
                  setSel(sel);
                  // stage-n: keep the address bar in sync with the ACTUAL
                  // selected tab — bridge pushes after nav/back/fwd/tab ops;
                  // without this the URL input shows a stale value while the
                  // tab strip (and the page) moved on.
                  const t = o.tabs[sel];
                  if (t && typeof t.url === "string" && t.url) setUrl(t.url);
                  // stage-n: navigation-history state for the back/forward
                  // buttons (disabled like a real browser when unavailable).
                  if (typeof o.canBack === "boolean") setCanBack(o.canBack);
                  if (typeof o.canFwd === "boolean") setCanFwd(o.canFwd);
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

  // stage-n: report the panel viewport size so the bridge streams at the
  // EXACT resolution needed — never downscaled, sharpest text. The SPA
  // registers its viewport container; a ResizeObserver fires on resize.
  const reportViewport = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w > 0 && h > 0) send({ t: "resize", w, h });
    };
    report();
    const ro = new ResizeObserver(() => report());
    ro.observe(el);
    // Keep the observer alive for the hook's lifetime.
    roRef.current = ro;
  }, [send]);

  const newTab = useCallback(() => { send({ t: "tabnew", url: "about:blank" }); }, [send]);
  const selTab = useCallback((i: number) => { send({ t: "tabsel", i }); }, [send]);
  const closeTab = useCallback((i: number) => { send({ t: "tabclose", i }); }, [send]);
  // stage-n: real-browser navigation controls (bridge handles back/fwd/reload).
  const goBack = useCallback(() => { send({ t: "back" }); }, [send]);
  const goForward = useCallback(() => { send({ t: "fwd" }); }, [send]);
  const reload = useCallback(() => { send({ t: "reload" }); }, [send]);

  const mapXY = useCallback((el: HTMLElement, clientX: number, clientY: number) => {
    // round-fix: the frame is rendered with object-fit: contain (letterboxed
    // 16:10 feed inside a wider/taller box) and optionally transform:scale'd
    // by the zoom control. getBoundingClientRect gives the VISUAL box (zoom
    // included); the image itself only covers the centered contain rect —
    // clicks must map through THAT, not the element box. The old element-box
    // math offset every click by up to ~54px + 8% horizontally (right-side
    // links fired middle-of-page targets, the letterbox bars were dead),
    // which the user experienced as "the page can't be clicked".
    const r = el.getBoundingClientRect();
    const img = el as HTMLImageElement;
    const nw = img.naturalWidth || VIEW_W;
    const nh = img.naturalHeight || VIEW_H;
    const k = Math.min(r.width / nw, r.height / nh);
    const iw = nw * k;
    const ih = nh * k;
    const ix = r.left + (r.width - iw) / 2;
    const iy = r.top + (r.height - ih) / 2;
    return {
      x: Math.round(((clientX - ix) / iw) * VIEW_W),
      y: Math.round(((clientY - iy) / ih) * VIEW_H),
      inside: clientX >= ix && clientX <= ix + iw && clientY >= iy && clientY <= iy + ih,
    };
  }, []);

  // round-fix (smoothness): mouse-move COALESCING. Every mousemove used to
  // send its own WS message (~60-120/s) through the cloudflared tunnel,
  // queueing ahead of / competing with click round-trips and screencast
  // frames — the "nothing happens when I click" lag the user reported. Now
  // at most one move per ~33ms (latest position wins); down/up still go
  // through immediately.
  const moveTimer = useRef(0);
  const movePending = useRef<{ x: number; y: number } | null>(null);
  const sendMove = useCallback((x: number, y: number) => {
    movePending.current = { x, y };
    if (moveTimer.current) return;
    moveTimer.current = window.setTimeout(() => {
      moveTimer.current = 0;
      const p = movePending.current;
      movePending.current = null;
      if (p) send({ t: "m", x: p.x, y: p.y, k: "move" });
    }, 33);
  }, [send]);
  useEffect(() => () => { if (moveTimer.current) window.clearTimeout(moveTimer.current); }, []);

  const navigate = useCallback(() => {
    // round-fix (P1): the old startsWith("http") check rewrote every
    // non-http URL — "data:text/html,…" became "https://data:text/html,…"
    // (and about:/blob:/chrome:/file: likewise). Schemes the remote browser
    // understands are kept verbatim; anything else gets the https:// default
    // (so "example.com" and "localhost:3000" still normalize correctly).
    const u = /^(https?|data|about|blob|file|chrome|chrome-extension|view-source|javascript|edge):/i.test(url.trim())
      ? url.trim()
      : `https://${url.trim()}`;
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
        // P2: AI-action timeline rides the same poll (independent failure —
        // the actions feed is additive and may lag the shots feed).
        fetch(`${apiBase}/api/browser/actions`, { headers: auth() })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((ad) => {
            if (alive && Array.isArray(ad.actions)) setActions(ad.actions);
          })
          .catch(() => {});
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
    newTab, selTab, closeTab, goBack, goForward, reload, canBack, canFwd,
    imgRef, mapXY, send, sendMove, reportViewport,
    shots, selected, setSelected, shotUrls,
    actions,
    aiActive, hasFrame,
  };
}
