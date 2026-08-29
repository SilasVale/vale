/**
 * BrowserPane — pure VIEW over the useBrowser hook (the single seam to the
 * remote-browser protocol). All protocol/WS/evidence logic lives in
 * hooks/useBrowser.ts; this component only renders state and forwards input
 * events. Styling is CSS classes (styles/components.css), English UI copy.
 */
import { useBrowser, type BrowserSessionData } from "../hooks/useBrowser";

export interface BrowserPaneProps {
  session: BrowserSessionData;
  apiBase: string; // "" (same-origin) or gateway proxy base
  token: string;
}

export default function BrowserPane({ apiBase, token }: BrowserPaneProps) {
  const b = useBrowser({ apiBase, token });

  return (
    <div className="browser-pane">
      {/* View switch: Live ↔ Evidence */}
      <div className="browser-view-switch" role="tablist" aria-label="Browser view">
        <button
          type="button"
          className={`view-switch-btn${b.view === "live" ? " active" : ""}`}
          onClick={() => b.setView("live")}
        >Live</button>
        <button
          type="button"
          className={`view-switch-btn${b.view === "evidence" ? " active" : ""}`}
          onClick={() => b.setView("evidence")}
        >Evidence</button>
      </div>

      {b.view === "live" ? (
        <div className="browser-live">
          {/* Tab strip */}
          <div className="browser-tabstrip">
            {b.tabs.map((tb) => (
              <span key={tb.i} className={`browser-tab${tb.i === b.sel ? " sel" : ""}`} onClick={() => b.selTab(tb.i)} title={tb.url}>
                <span className="browser-tab-label">{tb.url.replace(/^https?:\/\//, "") || "blank"}</span>
                <span className="browser-tab-close" onClick={(e) => { e.stopPropagation(); void b.closeTab(tb.i); }}>×</span>
              </span>
            ))}
            <span className="browser-tab-new" onClick={() => void b.newTab()} title="New tab">+</span>
          </div>

          {/* URL bar */}
          <div className="browser-urlbar">
            <input
              className="browser-url"
              value={b.url}
              onChange={(e) => b.setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && b.navigate()}
              placeholder="Enter URL and press Enter — the page below is live and clickable"
            />
            <button className="btn btn-mini browser-go" onClick={b.navigate}>Go</button>
            <span className="browser-fps" title="frames per second">{b.fps}fps</span>
          </div>

          {/* Live viewport */}
          <div className="browser-viewport">
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
            <img
              ref={b.imgRef}
              className="browser-frame"
              alt="Remote browser"
              tabIndex={0}
              onMouseMove={(e) => { const { x, y } = b.mapXY(e.currentTarget, e.clientX, e.clientY); b.send({ t: "m", x, y, k: "move" }); }}
              onMouseDown={(e) => { const { x, y } = b.mapXY(e.currentTarget, e.clientX, e.clientY); b.send({ t: "m", x, y, k: "down" }); }}
              onMouseUp={(e) => { const { x, y } = b.mapXY(e.currentTarget, e.clientX, e.clientY); b.send({ t: "m", x, y, k: "up" }); }}
              onWheel={(e) => {
                const { x, y } = b.mapXY(e.currentTarget, e.clientX, e.clientY);
                b.send({ t: "wheel", x, y, dx: e.deltaX, dy: e.deltaY });
                e.preventDefault();
              }}
              onKeyDown={(e) => {
                e.preventDefault();
                const printable = e.key.length === 1;
                b.send({ t: "k", down: true, key: e.key, code: e.code, vk: e.keyCode, text: printable ? e.key : undefined });
              }}
              onKeyUp={(e) => {
                e.preventDefault();
                b.send({ t: "k", down: false, key: e.key, code: e.code, vk: e.keyCode });
              }}
              onError={() => b.setView === undefined && undefined}
              onLoad={() => { b.imgRef.current?.focus(); }}
            />
          </div>

          {b.error && <div className="browser-error">{b.error}</div>}
        </div>
      ) : (
        <div className="browser-live" style={{ minHeight: 0 }}>
          <div className="browser-ev-stage">
            {b.selected && b.shotUrls[b.selected] ? (
              <img src={b.shotUrls[b.selected]} className="browser-ev-img" alt="AI browser evidence" />
            ) : (
              <div className="browser-ev-empty">
                No screenshots yet — they appear here automatically when the AI works via browser_run_script
              </div>
            )}
          </div>

          {/* Evidence timeline */}
          <div className="browser-ev-timeline">
            <div className="browser-ev-head">
              AI screenshots ({b.shots.length}) — pwout directory auto-syncs every 3s
            </div>
            {b.shots.length === 0 ? (
              <div style={{ fontSize: 11, color: "#98a2b3", padding: "4px 0" }}>No screenshots</div>
            ) : (
              <div className="browser-ev-strip">
                {b.shots.map((s) => (
                  <div
                    key={s.name}
                    className={`browser-ev-thumb${b.selected === s.name ? " sel" : ""}`}
                    title={`${s.name} · ${new Date(s.mtime_ms).toLocaleTimeString()}`}
                    onClick={() => b.setSelected(s.name)}
                  >
                    {b.shotUrls[s.name] ? (
                      <img src={b.shotUrls[s.name]} alt={s.name} loading="lazy" />
                    ) : (
                      <div className="browser-ev-thumb-empty">Loading…</div>
                    )}
                    <span className="browser-ev-time">{new Date(s.mtime_ms).toLocaleTimeString()}</span>
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
