/**
 * BrowserPane — LIVE interactive remote browser (round-135 M1).
 *
 * Polls JPEG frames from the device bridge (/api/browser/frame, ~7fps) into
 * a canvas, and forwards mouse/keyboard/wheel/navigation as CDP-injected
 * events (/api/browser/input). Coordinates are mapped from displayed CSS px
 * to the bridge viewport (1280x800).
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
const FRAME_MS = 140;
const TABS_MS = 1500;

interface TabInfo { i: number; url: string }

function inputUrl(apiBase: string, token: string, ev: unknown): string {
  const d = encodeURIComponent(JSON.stringify(ev));
  return `${apiBase}/api/browser/input?d=${d}&t=${encodeURIComponent(token)}`;
}

export default function BrowserPane({ session, apiBase, token }: Props) {
  const [url, setUrl] = useState(session.url || "https://www.wikipedia.org");
  const [error, setError] = useState("");
  const [fps, setFps] = useState(0);
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [sel, setSel] = useState(0);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const aliveRef = useRef(true);
  const counters = useRef({ n: 0, t: 0 });

  // Frame pump: replace <img> src periodically (no-store server side).
  useEffect(() => {
    aliveRef.current = true;
    let timer: number | undefined;
    const tick = () => {
      if (!aliveRef.current || !imgRef.current) return;
      const t = Date.now();
      fetch(`${apiBase}/api/browser/frame`, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then((b) => {
          if (!aliveRef.current || !imgRef.current) return;
          const old = imgRef.current.src;
          imgRef.current.src = URL.createObjectURL(b);
          if (old.startsWith("blob:")) URL.revokeObjectURL(old);
          setError("");
          const c = counters.current; c.n++;
          if (t - c.t >= 1000) { setFps(Math.round((c.n * 1000) / (Date.now() - c.t))); c.n = 0; c.t = t; }
        })
        .catch((e) => setError(e.message === "401" ? "认证失败" : e.message));
      const c = counters.current;
      c.n++;
      if (t - c.t >= 1000) { setFps(Math.round((c.n * 1000) / (Date.now() - c.t))); c.n = 0; c.t = t; }
    };
    tick();
    timer = window.setInterval(tick, FRAME_MS);
    return () => { aliveRef.current = false; if (timer) window.clearInterval(timer); };
  }, [apiBase, token]);

  const send = useCallback(async (ev: unknown) => {
    try { await fetch(inputUrl(apiBase, token, ev), { headers: { Authorization: `Bearer ${token}` } }); } catch { /* transient */ }
  }, [apiBase, token]);

  const sendR = useCallback(async (ev: unknown): Promise<any> => {
    try { return await (await fetch(inputUrl(apiBase, token, ev), { headers: { Authorization: `Bearer ${token}` } })).json(); } catch { return {}; }
  }, [apiBase, token]);

  const refreshTabs = useCallback(async () => {
    const r = await sendR({ t: "tabs" });
    if (Array.isArray(r.tabs)) { setTabs(r.tabs); setSel(r.sel ?? 0); }
  }, [sendR]);

  useEffect(() => { refreshTabs(); const t = window.setInterval(refreshTabs, TABS_MS); return () => window.clearInterval(t); }, [refreshTabs]);

  const newTab = async () => { await send({ t: "tabnew", url: "about:blank" }); refreshTabs(); };
  const selTab = async (i: number) => { await send({ t: "tabsel", i }); refreshTabs(); };
  const closeTab = async (i: number) => { await send({ t: "tabclose", i }); refreshTabs(); };

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
    void send({ t: "m", x, y, k });
  };

  const onWheel = (e: React.WheelEvent) => {
    const { x, y } = mapXY(e as unknown as React.MouseEvent);
    void send({ t: "wheel", x, y, dx: e.deltaX, dy: e.deltaY });
    e.preventDefault();
  };

  const onKey = (down: boolean) => (e: React.KeyboardEvent) => {
    e.preventDefault();
    const printable = down && e.key.length === 1;
    void send({
      t: "k", down,
      key: e.key, code: e.code, vk: e.keyCode,
      text: printable ? e.key : undefined,
    });
  };

  const navigate = async () => {
    const u = url.startsWith("http") ? url : `https://${url}`;
    setUrl(u);
    await send({ t: "nav", url: u });
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
        <span onClick={newTab} title="New tab"
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
      <div ref={wrapRef} style={{ flex: 1, overflow: "auto", background: "#1a1b1e", position: "relative" }}>
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
