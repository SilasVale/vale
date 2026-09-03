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
  const viewportElRef = useRef<HTMLElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const aliveRef = useRef(true);
  const pendingRef = useRef(new Map<number, (v: any) => void>());
  const nextIdRef = useRef(1);
  const counters = useRef({ n: 0, t: 0 });
  const hasFrameRef = useRef(false);
  const viewRef = useRef<BrowserView>("live");
  viewRef.current = view;
  const seenLoaded = useRef<Set<string>>(new Set());
  // stage-n (client review): mirrors for teardown + focus/editing guards.
  const shotUrlsRef = useRef<Record<string, string>>({});
  const urlEditingRef = useRef(false);

  // AI-activity signal (Browserless "watching sessions" pattern): the AI's
  // browser_run_script drops screenshots into pwout — a fresh mtime means
  // the AI drove (or is driving) the browser. Derived at render time.
  // User-visible gap: the AI's recent VERIFICATION scripts (and plenty of
  // real automation) run WITHOUT screenshots — the 90s evidence window left
  // the panel silent while the actions feed was busy. Activity now follows
  // actions too (their ts is ms since epoch; abs() tolerates clock skew).
  const aiActive =
    shots.some((s) => Date.now() - s.mtime_ms < 90000) ||
    actions.some((a) => Math.abs(Date.now() - Number(a.ts)) < 90000);

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

    let connecting = false;
    const connectWs = () => {
      if (disposed || connecting) return;
      if (reconnectTimer) { window.clearTimeout(reconnectTimer); reconnectTimer = undefined; }
      connecting = true;
      attempts++;
      // Show the reconnect state only from the second failure so the happy
      // path never flashes a warning.
      if (attempts > 1) setError("Live channel reconnecting…");
      fetch(`${apiBase}/api/browser/ws-ticket`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(({ ticket }) => {
          connecting = false;
          if (disposed || document.hidden) return; // visible handler resumes
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
            // stage-n: the viewport may have been registered while the
            // socket was down — re-report its size so the bridge streams at
            // the right resolution immediately.
            if (viewportElRef.current) {
              const r = viewportElRef.current.getBoundingClientRect();
              const w = Math.round(r.width);
              const h = Math.round(r.height);
              if (w > 0 && h > 0) ws.send(JSON.stringify({ t: "resize", w, h }));
            }
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
                  if (t && typeof t.url === "string" && t.url && !urlEditingRef.current) setUrl(t.url);
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
          connecting = false;
          if (disposed) return;
          scheduleReconnect();
        });
    };

    const scheduleReconnect = () => {
      // A hidden tab must NOT stream to nobody: onVisibility drives the
      // resume, so the backoff loop stops at the next failure while hidden.
      if (document.hidden) return;
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
      // stage-n (client review): teardown must also release the object URLs
      // (live frame + cached evidence shots) and the viewport observer —
      // the pane re-mounts on every rail switch and used to leak per visit.
      roRef.current?.disconnect();
      roRef.current = null;
      const src = imgRef.current?.src;
      if (src && src.startsWith("blob:")) URL.revokeObjectURL(src);
      Object.values(shotUrlsRef.current).forEach((u) => URL.revokeObjectURL(u));
      shotUrlsRef.current = {};
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
    viewportElRef.current = el;
    const report = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w > 0 && h > 0) send({ t: "resize", w, h });
    };
    report();
    // ResizeObserver is absent in some test environments (jsdom) — report
    // once and skip live observation there.
    if (typeof ResizeObserver === "undefined") return;
    roRef.current?.disconnect(); // one live observer per hook, ever
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
      // stage-n (client review): OUTPUT coordinates are the page's own CSS
      // pixels — since 1.2.185 the stream follows the panel resolution
      // (naturalWidth == page viewport), so the old VIEW_W/VIEW_H scaling
      // multiplied clicks by 1280/nw — up to ~2x off on small panels.
      x: Math.round(((clientX - ix) / iw) * nw),
      y: Math.round(((clientY - iy) / ih) * nh),
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

  // ---- Evidence + AI-activity feed (round-154; round-252 event-driven) ----
  // The agent emits `browser-actions-changed` on the SSE channel whenever an
  // MCP browser action/screenshot is recorded — the feed refreshes on that
  // push so AI activity appears INSTANTLY. The 3s interval stays only as a
  // safety net for events that arrive while the SSE channel is down.
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
        // Cache key = name:mtime — a screenshot OVERWRITTEN under the same
        // name (new mtime) is refetched instead of serving the stale image.
        const keyOf = (x: Shot) => `${x.name}:${x.mtime_ms}`;
        const missing = list.filter((x) => !seenLoaded.current.has(keyOf(x)));
        for (const shot of missing) {
          const key = keyOf(shot);
          fetch(`${apiBase}/api/browser/pwshot?name=${encodeURIComponent(shot.name)}`, { headers: auth() })
            .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
            .then((blob) => {
              if (!alive) return;
              seenLoaded.current.add(key);
              setShotUrls((prev) => ({ ...prev, [key]: URL.createObjectURL(blob) }));
            })
            .catch(() => {});
        }
        setShotUrls((prev) => {
          const next = { ...prev };
          const keep = new Set(list.map(keyOf));
          for (const k of Object.keys(next)) {
            if (!keep.has(k)) { URL.revokeObjectURL(next[k]); delete next[k]; }
          }
          shotUrlsRef.current = next;
          return next;
        });
        // P2: AI-action timeline rides the same refresh (independent failure —
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
    // round-252: event-driven refresh — the agent pushes browser-actions-
    // changed (and playwright-changed) on /api/events when an MCP browser
    // action/screenshot is recorded. EventSource cannot send the Bearer
    // header, so use the fetch+ReadableStream pattern (same as useSSE).
    let evtAbort: AbortController | null = null;
    let evtRetry = 0;
    let evtDead = false;
    const evtConnect = async () => {
      if (evtDead) return;
      try {
        const ctl = new AbortController();
        evtAbort = ctl;
        const timer = setTimeout(() => ctl.abort(), 30000);
        const res = await fetch(`${apiBase}/api/events`, {
          headers: { authorization: `Bearer ${token}` },
          signal: ctl.signal,
        }).finally(() => clearTimeout(timer));
        if (!res.ok || !res.body) throw new Error(String(res.status));
        evtRetry = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!evtDead) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              const o = JSON.parse(line.slice(6));
              if (o?.ev === "browser-actions-changed" || o?.ev === "playwright-changed") void tick();
            } catch { /* non-JSON keepalive */ }
          }
        }
      } catch { /* fall through to retry */ }
      if (!evtDead) {
        evtRetry = Math.min(evtRetry + 1, 5);
        setTimeout(evtConnect, Math.min(2000 * 2 ** evtRetry, 30000));
      }
    };
    void evtConnect();
    return () => {
      alive = false;
      evtDead = true;
      window.clearInterval(t);
      try { evtAbort?.abort(); } catch { /* noop */ }
    };
  }, [apiBase, auth, token]);

  // Resolve a shot NAME (selected, stale-free UI identity) to the current
  // cache key name:mtime used by the poll (client-review fix 6).
  const shotKey = useCallback(
    (name: string): string => {
      const hit = shots.find((x) => x.name === name);
      return hit ? `${hit.name}:${hit.mtime_ms}` : name;
    },
    [shots],
  );

  return {
    view, setView,
    url, setUrl, navigate, urlHistory,
    zoom, setZoom,
    error, fps, tabs, sel,
    newTab, selTab, closeTab, goBack, goForward, reload, canBack, canFwd,
    imgRef, mapXY, send, sendMove, reportViewport, urlEditingRef,
    shots, selected, setSelected, shotUrls, shotKey,
    actions,
    aiActive, hasFrame,
  };
}
