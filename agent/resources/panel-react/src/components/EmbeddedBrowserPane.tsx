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
//   - routes the address bar + back/fwd/reload to the embedded view (IPC)
//   - the address bar + button disabled-states FOLLOW the real page via
//     main-process navigation events (round-247) — event-driven, no polling
//
// Plain-browser contexts (no window.valeEmbedded) never mount this — they
// keep the screenshot BrowserPane.
import { useEffect, useRef, useState, useCallback } from "react";
import { Icon } from "../ui/Icon";
import { useAiActivityPulse } from "../hooks/useAiActivityPulse";
import { EvidenceDrawer } from "./EvidenceDrawer";

interface EmbeddedNavState {
  url: string;
  canBack: boolean;
  canFwd: boolean;
  title: string;
}
interface EmbeddedBridge {
  navigate: (url: string) => Promise<unknown>;
  back: () => Promise<unknown>;
  fwd: () => Promise<unknown>;
  reload: () => Promise<unknown>;
  zoom: (factor: number) => Promise<unknown>;
  place: (bounds: { x: number; y: number; width: number; height: number } | null) => Promise<unknown>;
  state: () => Promise<{ ok: boolean; url?: string; canBack?: boolean; canFwd?: boolean; visible?: boolean }>;
  recover: () => Promise<unknown>;
  onNav: (handler: (s: EmbeddedNavState) => void) => () => void;
  onGone: (handler: (d: { reason: string; exitCode: number }) => void) => () => void;
}

function bridge(): EmbeddedBridge | null {
  return (window as any).valeEmbedded as EmbeddedBridge | null || null;
}

const slotId = "vale-embedded-browser-slot";

export function EmbeddedBrowserPane({ token }: { token: string }) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const [url, setUrl] = useState("");
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
  const [ready, setReady] = useState(false);
  // round-251: zoom the REAL view (webContents zoom factor via IPC).
  const [zoom, setZoomState] = useState(100);
  const urlEditingRef = useRef(false);
  // round-253: event-driven "AI is operating" pulse (SSE browser-actions-
  // changed / playwright-changed — no polling).
  const aiActive = useAiActivityPulse("", token);
  // round-260: attention flash — when the AI STARTS a new burst (idle →
  // active transition), glow the Evidence toggle so the user notices even
  // while not watching. Pure UI state; fades by itself.
  const [aiFlash, setAiFlash] = useState(false);
  const prevAiActiveRef = useRef(false);
  useEffect(() => {
    if (aiActive && !prevAiActiveRef.current) {
      setAiFlash(true);
      const t = setTimeout(() => setAiFlash(false), 4000);
      prevAiActiveRef.current = true;
      return () => clearTimeout(t);
    }
    prevAiActiveRef.current = aiActive;
    return undefined;
  }, [aiActive]);
  // round-255: AI evidence drawer (screenshots + action log) — on-demand.
  const [evOpen, setEvOpen] = useState(false);
  // round-256: the embedded view's renderer crashed (reason text for the
  // recovery banner).
  const [goneReason, setGoneReason] = useState<string | null>(null);
  // Rejected-scheme notice: the main-process validator (sanitizeBrowserUrl)
  // only honors http/https — navigating anywhere else would load
  // about:blank with no error, so reject here with a visible error instead.
  const [navError, setNavError] = useState<string | null>(null);

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
  // layout when the panel resizes. (Event-driven: no polling — the observer
  // fires only on actual layout changes.)
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    // Initial state + real-navigation subscription (round-247): the main
    // process pushes url/canBack/canFwd/title after EVERY actual navigation,
    // so the address bar and button states mirror the real page.
    void b.state().then((s) => {
      if (s?.ok) {
        setReady(true);
        if (s.url) setUrl(s.url);
        if (typeof s.canBack === "boolean") setCanBack(s.canBack);
        if (typeof s.canFwd === "boolean") setCanFwd(s.canFwd);
      }
    });
    const offNav = b.onNav((s) => {
      if (!urlEditingRef.current && s.url) setUrl(s.url);
      setCanBack(s.canBack);
      setCanFwd(s.canFwd);
      // A nav event after a crash means the view recovered — clear the banner.
      setGoneReason(null);
    });
    // round-256: renderer crash → show the recovery banner.
    const offGone = b.onGone((d) => {
      setGoneReason(d.reason || `exit ${d.exitCode}`);
      setReady(false);
    });
    reportBounds();
    const el = slotRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => reportBounds());
    ro.observe(el);
    window.addEventListener("resize", reportBounds);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", reportBounds);
      offNav();
      offGone();
      // Leaving the page: hide the embedded view so it does not linger over
      // other SPA pages.
      void b.place(null);
    };
  }, [reportBounds]);

  // round-256: user taps the recovery button → main process force-recreates
  // the view and navigates to the last URL. After recovery, re-query state
  // so the toolbar flips back to live (a fresh view's nav push may race the
  // recovery; state() is authoritative and idempotent).
  const recover = useCallback(() => {
    setGoneReason(null);
    setReady(false);
    const b = bridge();
    if (!b) return;
    void b.recover().then(() => b.state()).then((s) => {
      if (s?.ok) {
        setReady(true);
        if (s.url) setUrl(s.url);
        if (typeof s.canBack === "boolean") setCanBack(s.canBack);
        if (typeof s.canFwd === "boolean") setCanFwd(s.canFwd);
      }
    }).catch(() => { /* state() rejects only on frame loss */ });
  }, []);

  const navigate = useCallback((fromSubmit?: boolean) => {
    const b = bridge();
    if (!b) return;
    const raw = url.trim();
    if (/^(about|data):/i.test(raw) && raw.toLowerCase() !== "about:blank") {
      setNavError("Only http(s) URLs are supported in the embedded browser");
      if (fromSubmit) urlInputRef.current?.blur();
      return;
    }
    setNavError(null);
    // about:blank is the one non-http(s) target the main-process validator
    // honors — pass it through untouched.
    const u = /^https?:/i.test(raw) || raw.toLowerCase() === "about:blank" ? raw : `https://${raw}`;
    setUrl(u);
    void b.navigate(u);
    // round-254 (user: "回车不能代替 Go 吗"): pressing Enter in the address
    // bar is the primary submit — release the focus so the real URL (pushed
    // by did-navigate) updates the bar and the view is clickable right away,
    // exactly like Chrome's address bar.
    if (fromSubmit) urlInputRef.current?.blur();
  }, [url]);
  const goBack = useCallback(() => { void bridge()?.back(); }, []);
  const goForward = useCallback(() => { void bridge()?.fwd(); }, []);
  const reload = useCallback(() => { void bridge()?.reload(); }, []);
  // round-251: zoom selector → real webContents zoom factor (event-driven:
  // only fires on user change, no polling).
  const setZoom = useCallback((z: number) => {
    setZoomState(z);
    void bridge()?.zoom(z / 100);
  }, []);

  return (
    <div className="browser-pane" style={{ position: "relative" }}>
      {/* Chrome-style toolbar: nav buttons + address row. Back/fwd disabled
          states mirror the REAL page history (main-process pushes). */}
      <div className="browser-toolbar">
        <div className="browser-urlbar">
          <span className="browser-navbtns">
            <button className="btn btn-mini browser-nav" onClick={goBack} title="Back" disabled={!canBack}>←</button>
            <button className="btn btn-mini browser-nav" onClick={goForward} title="Forward" disabled={!canFwd}>→</button>
            <button className="btn btn-mini browser-nav" onClick={reload} title="Reload" disabled={!ready}>↻</button>
          </span>
          <span className="browser-url-secure" title={url.startsWith("https") ? "Secure" : "Not secure"}>
            {url.startsWith("https") ? "🔒" : "🌐"}
          </span>
          <input
            className="browser-url"
            ref={urlInputRef}
            value={url}
            onChange={(e) => { setUrl(e.target.value); setNavError(null); }}
            onFocus={() => { urlEditingRef.current = true; }}
            onBlur={() => { urlEditingRef.current = false; }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); navigate(true); } }}
            placeholder="Enter a URL and press Enter — rendered live by the real embedded browser"
            spellCheck={false}
          />
          <button className="btn btn-mini browser-go" onClick={() => navigate()}>Go</button>
          <span className="browser-tools">
            <select
              className="browser-zoom"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              title="Zoom"
              aria-label="Zoom"
            >
              {[75, 100, 125, 150, 200].map((z) => <option key={z} value={z}>{z}%</option>)}
            </select>
          </span>
        </div>
      </div>

      {/* Rejected-scheme notice (reuses the crash-banner styling — no new CSS). */}
      {navError && (
        <div className="browser-crash-banner" role="alert">
          <div>
            <strong>Cannot open this address</strong>
            <span className="browser-crash-reason">{navError}</span>
          </div>
        </div>
      )}

      {/* The slot the main process overlays its WebContentsView onto. The
          img-free real browser lives above this div (native window child);
          this div only reserves the space and reports bounds. When the
          evidence drawer opens we SHRINK the slot (width -= 340px) so the
          native view never extends underneath the SPA drawer (which always
          paints above the web content). */}
      <div
        id={slotId}
        ref={slotRef}
        className={`browser-viewport browser-embedded-slot${evOpen ? " drawer-open" : ""}`}
        data-ready={ready ? "1" : "0"}
      >
        {!ready && !goneReason && (
          <div className="browser-placeholder">
            <Icon name="browser" size={30} />
            <p>Starting embedded browser…</p>
          </div>
        )}
        {/* round-256: renderer crash — recovery banner (the main process
            hides the dead native view so this SPA overlay shows through). */}
        {goneReason && (
          <div className="browser-crash-banner">
            <Icon name="browser" size={24} />
            <div>
              <strong>The embedded browser crashed</strong>
              <span className="browser-crash-reason">reason: {goneReason}</span>
            </div>
            <button className="btn btn-mini browser-crash-recover" onClick={recover}>Reload browser</button>
          </div>
        )}
      </div>

      <div className="browser-statusbar">
        <div className="browser-status-left">
          <span className="browser-fps" title="Real browser view (no screenshot stream)">
            ● {ready ? "live (native render)" : "waiting"}
          </span>
          {/* round-253: event-driven AI-activity pulse — lights while the
              agent pushes browser-actions-changed (no polling), fades after
              a few seconds. Lives in the SPA chrome (the native view covers
              the viewport, so the indicator sits in the status strip). */}
          {aiActive && (
            <span className="browser-ai-chip" title="AI is operating this browser">
              <span className="browser-ai-dot" />
              AI operating
            </span>
          )}
          {/* round-255: Evidence drawer toggle — AI screenshots + action log,
              fetched on demand (open) + SSE-refreshed, no polling. */}
          <button
            type="button"
            className={`browser-ev-toggle${evOpen ? " active" : ""}${aiFlash ? " flash" : ""}`}
            onClick={() => setEvOpen((v) => !v)}
            title="AI screenshot evidence (drawer)"
          >
            🖼 Evidence
            {aiActive && <span className="browser-ev-live" aria-hidden />}
          </button>
        </div>
        <div className="browser-status-right">
          <span className="browser-embedded-badge" title="This page is the real Chromium view — text is rendered natively, not screenshotted">
            native
          </span>
        </div>
      </div>

      {/* round-255: AI evidence drawer (right side) — event-driven parity with
          the screenshot pane's Evidence drawer. */}
      <EvidenceDrawer apiBase="" token={token} open={evOpen} onClose={() => setEvOpen(false)} />
    </div>
  );
}
