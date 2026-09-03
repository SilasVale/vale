// EmbeddedBrowserPane — the Electron-shell REAL browser via <webview> (round-249).
//
// round-246-248 embedded a WebContentsView over the SPA slot; on d1 its
// renderer became unresponsive to CDP (Page.enable hangs on about:blank).
// Pivot (user direction): the SPA renders an Electron <webview> element —
// a REAL Chromium view inside the DOM (independent renderer, GPU
// compositing, native layout). The guest webContents is a CDP target on
// :9333, so AI drives EXACTLY the page the user sees.
//
// The <webview> exposes its own DOM API + events, so this pane is thin:
//   - renders <webview> with a start URL
//   - announces the guest (webContents id) to the main process so it can
//     route window.open in-view and pin the AI target
//   - the address bar / back/fwd/reload drive the element directly
//   - did-navigate / page-title-updated events keep the toolbar in sync
//     (event-driven — no polling)
//
// Plain-browser contexts (no window.valeEmbedded) never mount this — they
// keep the screenshot BrowserPane.
import { useEffect, useRef, useState, useCallback } from "react";
import { Icon } from "../ui/Icon";

interface EmbeddedBridge {
  announceGuest: (webContentsId: number) => Promise<unknown>;
  state: () => Promise<{ ok: boolean; hasGuest?: boolean; url?: string; title?: string; canBack?: boolean; canFwd?: boolean }>;
}

function bridge(): EmbeddedBridge | null {
  return (window as any).valeEmbedded as EmbeddedBridge | null || null;
}

/** The Electron <webview> element surface we use (typed loosely — the
 *  element exists only in Electron's renderer, not in plain browsers/jsdom). */
interface WebviewElement extends HTMLElement {
  loadURL: (url: string) => Promise<void>;
  getURL: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  getWebContentsId: () => number;
  addEventListener: (type: string, fn: (e: any) => void) => void;
  removeEventListener: (type: string, fn: (e: any) => void) => void;
  src: string;
}

export function EmbeddedBrowserPane({ token }: { token: string }) {
  const wvRef = useRef<WebviewElement | null>(null);
  const [url, setUrl] = useState("");
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
  const [ready, setReady] = useState(false);
  const urlEditingRef = useRef(false);

  const syncState = useCallback(() => {
    const wv = wvRef.current;
    if (!wv) return;
    try {
      const u = wv.getURL();
      if (u && !urlEditingRef.current) setUrl(u);
      setCanBack(wv.canGoBack());
      setCanFwd(wv.canGoForward());
      setReady(true);
    } catch { /* not attached yet */ }
  }, []);

  // Attach once the <webview> element mounts: wire its events + announce the
  // guest to the main process. (Event-driven: no polling.)
  useEffect(() => {
    const wv = wvRef.current;
    const b = bridge();
    if (!wv || !b) return;
    const onNav = () => syncState();
    const onTitle = () => syncState();
    // round-248 parity: target=_blank inside the guest must open in the SAME
    // webview (single-tab browser) — the main process routes window.open
    // in-view; the new-window event here is a belt-and-braces same-view nav.
    const onNewWindow = (e: any) => {
      try {
        if (e && e.url) { wv.loadURL(String(e.url)).catch(() => {}); }
      } catch { /* ignore */ }
    };
    wv.addEventListener("did-navigate", onNav);
    wv.addEventListener("did-navigate-in-page", onNav);
    wv.addEventListener("page-title-updated", onTitle);
    wv.addEventListener("new-window", onNewWindow);
    // Announce the guest (its webContents id) once it exists.
    try { void b.announceGuest(wv.getWebContentsId()); } catch { /* pre-attach */ }
    try { const u = wv.getURL(); if (u) setUrl(u); } catch { /* not ready */ }
    return () => {
      wv.removeEventListener("did-navigate", onNav);
      wv.removeEventListener("did-navigate-in-page", onNav);
      wv.removeEventListener("page-title-updated", onTitle);
      wv.removeEventListener("new-window", onNewWindow);
    };
  }, [syncState]);

  const navigate = useCallback(() => {
    const wv = wvRef.current;
    if (!wv) return;
    const u = /^(https?|about|data):/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    setUrl(u);
    wv.loadURL(u).catch(() => { /* did-fail-load surfaces via did-navigate */ });
  }, [url]);
  const goBack = useCallback(() => { try { wvRef.current?.goBack(); } catch { /* noop */ } }, []);
  const goForward = useCallback(() => { try { wvRef.current?.goForward(); } catch { /* noop */ } }, []);
  const reload = useCallback(() => { try { wvRef.current?.reload(); } catch { /* noop */ } }, []);

  return (
    <div className="browser-pane" style={{ position: "relative", display: "flex", flexDirection: "column" }}>
      {/* Chrome-style toolbar: nav buttons + address row. Back/fwd disabled
          states mirror the REAL page history (webview events). */}
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
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onFocus={() => { urlEditingRef.current = true; }}
            onBlur={() => { urlEditingRef.current = false; }}
            onKeyDown={(e) => e.key === "Enter" && navigate()}
            placeholder="Enter a URL — rendered live by the real embedded browser"
            spellCheck={false}
          />
          <button className="btn btn-mini browser-go" onClick={navigate}>Go</button>
        </div>
      </div>

      {/* The REAL browser: an Electron <webview>. In plain browsers this
          element is inert/absent and this pane never mounts. */}
      <div className="browser-viewport browser-embedded-slot">
        <webview
          ref={wvRef as any}
          id="vale-embedded-webview"
          className="browser-webview"
          src="https://www.wikipedia.org"
          partition="persist:vale-embedded"
          allowpopups
          style={{ width: "100%", height: "100%", display: "flex" }}
        />
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
