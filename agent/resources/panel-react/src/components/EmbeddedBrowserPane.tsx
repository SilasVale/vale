// EmbeddedBrowserPane — the Electron-shell REAL browser (round-246).
//
// The classic BrowserPane shows the bridge's headless chromium as a JPEG
// screencast (lossy, never as sharp as a real browser). In the Vale Desktop
// shell the main process owns a REAL WebContentsView (window.valeEmbedded
// bridge) whose webContents is a CDP target on :9333 — the SAME endpoint AI
// drives. This pane is the SPA-side controller for that view:
//   - renders an empty slot the main process overlays the view onto
//   - reports the slot's bounds (position:relative to the window content)
//     on mount / resize / page switch, so the view tracks the layout
//   - routes the address bar + nav buttons to the embedded view (IPC)
//
// Plain-browser contexts (no window.valeEmbedded) never mount this — they
// keep the screenshot BrowserPane.
import { useEffect, useRef, useState, useCallback } from "react";
import { Icon } from "../ui/Icon";

interface EmbeddedBridge {
  navigate: (url: string) => Promise<unknown>;
  place: (bounds: { x: number; y: number; width: number; height: number } | null) => Promise<unknown>;
  state: () => Promise<{ ok: boolean; url?: string; visible?: boolean }>;
}

function bridge(): EmbeddedBridge | null {
  return (window as any).valeEmbedded as EmbeddedBridge | null || null;
}

const slotId = "vale-embedded-browser-slot";

export function EmbeddedBrowserPane({ token }: { token: string }) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState("https://www.wikipedia.org");
  const [ready, setReady] = useState(false);

  // Report the slot bounds to the main process so it can position the real
  // WebContentsView over it. Bounds are relative to the window content — the
  // slot's getBoundingClientRect IS that space (the SPA fills the window).
  const reportBounds = useCallback(() => {
    const el = slotRef.current;
    const b = bridge();
    if (!el || !b) return;
    const r = el.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) { void b.place(null); return; }
    void b.place({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
  }, []);

  // Register the slot once; a ResizeObserver keeps the view glued to the
  // layout when the panel resizes / the drawer opens. (Event-driven: no
  // polling — the observer fires only on actual layout changes.)
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    void b.state().then((s) => { if (s?.ok) setReady(true); });
    reportBounds();
    const el = slotRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => reportBounds());
    ro.observe(el);
    window.addEventListener("resize", reportBounds);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", reportBounds);
      // Leaving the page: hide the embedded view so it does not linger over
      // other SPA pages.
      void b.place(null);
    };
  }, [reportBounds]);

  const navigate = useCallback(() => {
    const b = bridge();
    if (!b) return;
    const u = /^(https?|about|data):/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    setUrl(u);
    void b.navigate(u);
  }, [url]);

  return (
    <div className="browser-pane" style={{ position: "relative" }}>
      {/* Chrome-style toolbar: address row (no bridge tabs — the embedded
          view is a single real page; back/fwd live inside it natively). */}
      <div className="browser-toolbar">
        <div className="browser-urlbar">
          <span className="browser-url-secure" title={url.startsWith("https") ? "Secure" : "Not secure"}>
            {url.startsWith("https") ? "🔒" : "🌐"}
          </span>
          <input
            className="browser-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && navigate()}
            placeholder="Enter a URL — rendered live by the real embedded browser"
            spellCheck={false}
          />
          <button className="btn btn-mini browser-go" onClick={navigate}>Go</button>
        </div>
      </div>

      {/* The slot the main process overlays its WebContentsView onto. The
          img-free real browser lives above this div (native window child);
          this div only reserves the space and reports bounds. */}
      <div
        id={slotId}
        ref={slotRef}
        className="browser-viewport browser-embedded-slot"
        data-ready={ready ? "1" : "0"}
      >
        {!ready && (
          <div className="browser-placeholder">
            <Icon name="browser" size={30} />
            <p>Starting embedded browser…</p>
          </div>
        )}
      </div>

      <div className="browser-statusbar">
        <div className="browser-status-left">
          <span className="browser-fps" title="Real browser view (no screenshot stream)">
            ● {ready ? "live (native render)" : "waiting"}
          </span>
        </div>
        <div className="browser-status-right">
          <span className="browser-embedded-badge" title="This page is the real Chromium view — text is rendered natively, not screenshotted">
            native
          </span>
        </div>
      </div>
    </div>
  );
}
